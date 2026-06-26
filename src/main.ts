import { Plugin, TFile, Notice, debounce } from "obsidian";
import {
  ReviewTrackerSettings,
  DEFAULT_SETTINGS,
  FRONTMATTER_KEY,
  STATUS_KEY,
  SR_KEYS,
  Grade,
  GRADES,
  formatDate,
  formatRemaining,
  readSrState,
  resolveTier,
  schedule,
  addDays,
} from "./status";
import { ExplorerDecorator } from "./decorator";
import { ReviewBar } from "./reviewbar";
import { ReviewTrackerSettingTab } from "./settings";

interface MetadataTypeManager {
  setType(name: string, type: string): void;
  getAssignedType?(name: string): string | undefined;
  types?: Record<string, { type?: string } | undefined>;
}

export default class ReviewTrackerPlugin extends Plugin {
  settings: ReviewTrackerSettings = DEFAULT_SETTINGS;
  private cooldowns: Record<string, number> = {};
  private decorator!: ExplorerDecorator;
  private reviewBar!: ReviewBar;

  private refreshAllDebounced = debounce(() => this.decorator.refreshAll(), 150, true);

  async onload(): Promise<void> {
    await this.loadSettings();

    this.decorator = new ExplorerDecorator(this.app, () => this.settings);
    this.reviewBar = new ReviewBar(
      this.app,
      (file, grade) => this.grade(file, grade),
      (file) => this.cooldownLeft(file),
    );
    this.addSettingTab(new ReviewTrackerSettingTab(this.app, this));

    for (const grade of GRADES) {
      this.addCommand({
        id: `review-grade-${grade}`,
        name: `Review: ${grade[0].toUpperCase()}${grade.slice(1)}`,
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "md") return false;
          if (!checking) void this.grade(file, grade);
          return true;
        },
      });
    }

    this.addCommand({
      id: "refresh-review-statuses",
      name: "Refresh all review statuses",
      callback: () => {
        void this.syncAllStatuses().then(() => {
          this.decorator.refreshAll();
          new Notice("Review statuses refreshed.");
        });
      },
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => this.decorator.refreshFile(file)),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refreshAllDebounced()),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          if (this.cooldowns[oldPath] !== undefined) {
            this.cooldowns[file.path] = this.cooldowns[oldPath];
            delete this.cooldowns[oldPath];
            void this.persist();
          }
          this.decorator.refreshFile(file);
        }
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.reviewBar.refreshAll()),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.reviewBar.refreshAll()),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.reviewBar.refreshAll()),
    );

    this.app.workspace.onLayoutReady(() => {
      this.ensurePropertyTypes();
      this.decorator.refreshAll();
      this.reviewBar.refreshAll();
      void this.syncAllStatuses();
    });
  }

  onunload(): void {
    this.decorator?.clearAll();
    this.reviewBar?.removeAll();
  }

  private ensurePropertyTypes(): void {
    if (!this.settings.forceTextDateProps) return;
    const mtm = (this.app as unknown as { metadataTypeManager?: MetadataTypeManager })
      .metadataTypeManager;
    if (!mtm || typeof mtm.setType !== "function") return;

    for (const key of [FRONTMATTER_KEY, SR_KEYS.due]) {
      try {
        let current: string | undefined;
        if (typeof mtm.getAssignedType === "function") {
          current = mtm.getAssignedType(key);
        } else if (mtm.types) {
          const entry = mtm.types[key.toLowerCase()];
          current = entry && entry.type ? entry.type : undefined;
        }
        if (current !== "text") mtm.setType(key, "text");
      } catch {
        // type manager API unavailable in this version
      }
    }
  }

  private cooldownLeft(file: TFile): number {
    const cdMs = this.settings.cooldownMinutes * 60_000;
    if (cdMs <= 0) return 0;
    const last = this.cooldowns[file.path];
    if (!last) return 0;
    return Math.max(0, last + cdMs - Date.now());
  }

  async grade(file: TFile, grade: Grade): Promise<void> {
    const remaining = this.cooldownLeft(file);
    if (remaining > 0) {
      new Notice(`On cooldown — wait ${formatRemaining(remaining)} before grading again.`);
      return;
    }

    const today = new Date();
    const prev = readSrState(this.app.metadataCache.getFileCache(file)?.frontmatter);
    const next = schedule(prev, grade);
    const dueStr = formatDate(addDays(today, next.interval));

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[FRONTMATTER_KEY] = formatDate(today);
      fm[SR_KEYS.due] = dueStr;
      fm[SR_KEYS.interval] = next.interval;
      fm[SR_KEYS.ease] = Number(next.ease.toFixed(2));
      fm[SR_KEYS.reps] = next.reps;
      fm[SR_KEYS.lapses] = next.lapses;
      if (this.settings.writeStatusProperty) {
        const tier = resolveTier(fm, undefined, this.settings);
        if (tier) fm[STATUS_KEY] = tier;
      }
    });

    this.cooldowns[file.path] = Date.now();
    await this.persist();

    this.decorator.refreshFile(file);
    this.reviewBar.refreshAll();
    new Notice(`${file.basename}: next review in ${next.interval}d (${dueStr})`);
  }

  async syncStatus(file: TFile): Promise<void> {
    if (!this.settings.writeStatusProperty || file.extension !== "md") return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;

    const hasDue = !!fm && fm[SR_KEYS.due] !== undefined;
    const hasReviewed = !!fm && fm[FRONTMATTER_KEY] !== undefined;

    let seedDate: string | undefined;
    if (this.settings.useModifiedAsFallback && !hasDue && !hasReviewed && file.stat) {
      seedDate = formatDate(new Date(file.stat.mtime));
    }

    const effective = seedDate
      ? Object.assign({}, fm, { [FRONTMATTER_KEY]: seedDate })
      : fm;
    const tier = resolveTier(effective, undefined, this.settings);

    const currentStatus = fm ? fm[STATUS_KEY] : undefined;
    const needWrite =
      seedDate !== undefined || (tier || undefined) !== (currentStatus || undefined);
    if (!needWrite) return;

    await this.app.fileManager.processFrontMatter(file, (f) => {
      if (seedDate !== undefined && f[FRONTMATTER_KEY] === undefined) {
        f[FRONTMATTER_KEY] = seedDate;
      }
      if (tier) f[STATUS_KEY] = tier;
      else delete f[STATUS_KEY];
    });
  }

  async syncAllStatuses(): Promise<void> {
    if (!this.settings.writeStatusProperty) return;
    for (const file of this.app.vault.getMarkdownFiles()) {
      await this.syncStatus(file);
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as
      | { settings?: Partial<ReviewTrackerSettings>; cooldowns?: Record<string, number> }
      | Partial<ReviewTrackerSettings>
      | null;

    if (data && "settings" in data && data.settings) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
      this.cooldowns = data.cooldowns ?? {};
    } else {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
      this.cooldowns = {};
    }
  }

  private async persist(): Promise<void> {
    await this.saveData({ settings: this.settings, cooldowns: this.cooldowns });
  }

  async saveSettings(): Promise<void> {
    await this.persist();
    this.decorator.refreshAll();
  }
}
