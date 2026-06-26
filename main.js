"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const obsidian = require("obsidian");
const { Plugin, PluginSettingTab, Setting, MarkdownView, TFile, Notice, debounce } = obsidian;

const ALL_TIERS = ["green", "yellow", "orange", "red"];
const FRONTMATTER_KEY = "last_reviewed";
const STATUS_KEY = "review_status";

const SR_KEYS = {
  due: "sr_due",
  interval: "sr_interval",
  ease: "sr_ease",
  reps: "sr_reps",
  lapses: "sr_lapses",
};

const GRADES = ["again", "hard", "good", "easy"];

function tierClass(tier) {
  return "review-status-" + tier;
}

const DEFAULT_SETTINGS = {
  greenMaxDays: 3,
  yellowMaxDays: 7,
  orangeMaxDays: 14,
  useModifiedAsFallback: true,
  cooldownMinutes: 5,
  forceTextDateProps: true,
  writeStatusProperty: true,
};

const DEFAULT_SR_STATE = { ease: 2.5, interval: 0, reps: 0, lapses: 0 };

const SR = {
  minEase: 1.3,
  hardFactor: 1.2,
  easyBonus: 1.3,
  againEaseDelta: -0.2,
  hardEaseDelta: -0.15,
  easyEaseDelta: 0.15,
  graduate1: 1,
  graduate1Easy: 4,
  graduate2: 6,
};

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

function parseReviewedValue(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

function daysSinceReviewed(value, now) {
  if (now === undefined) now = new Date();
  const then = parseReviewedValue(value);
  if (!then) return null;
  const thenUTC = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  const nowUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((nowUTC - thenUTC) / 86400000);
}

function tierForDays(days, settings) {
  if (days <= settings.greenMaxDays) return "green";
  if (days <= settings.yellowMaxDays) return "yellow";
  if (days <= settings.orangeMaxDays) return "orange";
  return "red";
}

function resolveTier(frontmatter, fallbackMtime, settings) {
  const fm = frontmatter || {};
  const overdue = daysSinceReviewed(fm[SR_KEYS.due]);
  if (overdue !== null) return tierForDays(overdue, settings);
  let days = daysSinceReviewed(fm[FRONTMATTER_KEY]);
  if (days === null && settings.useModifiedAsFallback && typeof fallbackMtime === "number") {
    days = daysSinceReviewed(new Date(fallbackMtime));
  }
  if (days === null) return null;
  return tierForDays(days, settings);
}

function readSrState(fm) {
  const src = fm || {};
  const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);
  return {
    ease: Math.max(SR.minEase, num(src[SR_KEYS.ease], DEFAULT_SR_STATE.ease)),
    interval: num(src[SR_KEYS.interval], DEFAULT_SR_STATE.interval),
    reps: num(src[SR_KEYS.reps], DEFAULT_SR_STATE.reps),
    lapses: num(src[SR_KEYS.lapses], DEFAULT_SR_STATE.lapses),
  };
}

function schedule(state, grade) {
  let ease = state.ease;
  let interval = state.interval;
  let reps = state.reps;
  let lapses = state.lapses;

  if (grade === "again") {
    ease = Math.max(SR.minEase, ease + SR.againEaseDelta);
    return { ease: ease, interval: 1, reps: 0, lapses: lapses + 1 };
  }

  if (grade === "hard") ease = Math.max(SR.minEase, ease + SR.hardEaseDelta);
  if (grade === "easy") ease = ease + SR.easyEaseDelta;

  reps = reps + 1;

  let next;
  if (reps === 1) {
    next = grade === "easy" ? SR.graduate1Easy : SR.graduate1;
  } else if (reps === 2) {
    next = grade === "hard" ? SR.graduate1Easy : SR.graduate2;
  } else if (grade === "hard") {
    next = interval * SR.hardFactor;
  } else if (grade === "easy") {
    next = interval * ease * SR.easyBonus;
  } else {
    next = interval * ease;
  }

  return { ease: ease, interval: Math.max(1, Math.round(next)), reps: reps, lapses: lapses };
}

function addDays(from, days) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function formatInterval(days) {
  if (days < 1) return "<1d";
  if (days < 30) return Math.round(days) + "d";
  if (days < 365) return Math.round(days / 30) + "mo";
  return (days / 365).toFixed(1) + "y";
}

function formatRemaining(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? m + "m " + rem + "s" : m + "m";
}

const ALL_TIER_CLASSES = ALL_TIERS.map(tierClass);

function folderTier(greenRatio) {
  if (greenRatio >= 0.9) return "green";
  if (greenRatio >= 0.7) return "yellow";
  if (greenRatio >= 0.5) return "orange";
  return "red";
}

class ExplorerDecorator {
  constructor(app, getSettings) {
    this.app = app;
    this.getSettings = getSettings;
    this.folderTimer = null;
  }

  getExplorerView() {
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    return leaf ? leaf.view : null;
  }

  getRowEl(path) {
    const view = this.getExplorerView();
    const item = view && view.fileItems ? view.fileItems[path] : null;
    if (item && item.selfEl) return item.selfEl;
    return document.querySelector(
      '.nav-files-container .nav-file-title[data-path="' + CSS.escape(path) + '"]'
    );
  }

  getFolderEl(path) {
    const view = this.getExplorerView();
    const item = view && view.fileItems ? view.fileItems[path] : null;
    if (item && item.selfEl) return item.selfEl;
    return document.querySelector(
      '.nav-files-container .nav-folder-title[data-path="' + CSS.escape(path) + '"]'
    );
  }

  applyTier(el, tier) {
    el.classList.remove.apply(el.classList, ALL_TIER_CLASSES);
    if (tier) el.classList.add(tierClass(tier));
  }

  fileTier(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache ? cache.frontmatter : undefined;
    const mtime = file.stat ? file.stat.mtime : undefined;
    return resolveTier(fm, mtime, this.getSettings());
  }

  refreshFile(file) {
    if (file.extension !== "md") return;
    const el = this.getRowEl(file.path);
    if (el) this.applyTier(el, this.fileTier(file));
    this.scheduleFolderRefresh();
  }

  refreshAll() {
    const view = this.getExplorerView();
    if (!view) return;
    const files = this.app.vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const el = this.getRowEl(f.path);
      if (el) this.applyTier(el, this.fileTier(f));
    }
    this.refreshFolders();
  }

  refreshFolders() {
    if (!this.getExplorerView()) return;
    const total = {};
    const green = {};
    const files = this.app.vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isGreen = this.fileTier(file) === "green";
      let dir = file.parent;
      while (dir && dir.path && dir.path !== "/") {
        total[dir.path] = (total[dir.path] || 0) + 1;
        if (isGreen) green[dir.path] = (green[dir.path] || 0) + 1;
        dir = dir.parent;
      }
    }

    document
      .querySelectorAll(".nav-folder-title")
      .forEach((el) => el.classList.remove.apply(el.classList, ALL_TIER_CLASSES));

    const paths = Object.keys(total);
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const ratio = (green[path] || 0) / total[path];
      const el = this.getFolderEl(path);
      if (el) this.applyTier(el, folderTier(ratio));
    }
  }

  scheduleFolderRefresh() {
    if (this.folderTimer !== null) return;
    this.folderTimer = window.setTimeout(() => {
      this.folderTimer = null;
      this.refreshFolders();
    }, 200);
  }

  clearAll() {
    if (this.folderTimer !== null) {
      window.clearTimeout(this.folderTimer);
      this.folderTimer = null;
    }
    document
      .querySelectorAll(".nav-file-title, .nav-folder-title")
      .forEach((el) => el.classList.remove.apply(el.classList, ALL_TIER_CLASSES));
  }
}

const BAR_CLASS = "digital-garden-bar";
const GRADE_LABELS = { again: "Again", hard: "Hard", good: "Good", easy: "Easy" };

class ReviewBar {
  constructor(app, onGrade, cooldownLeft) {
    this.app = app;
    this.onGrade = onGrade;
    this.cooldownLeft = cooldownLeft;
    this.refreshTimer = null;
  }

  refreshAll() {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const self = this;
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView) self.inject(view);
    });
  }

  inject(view) {
    const file = view.file;
    const host = view.contentEl;
    const existing = host.querySelector(":scope > ." + BAR_CLASS);
    if (!file || file.extension !== "md") {
      if (existing) existing.remove();
      return;
    }
    let bar = existing;
    if (!bar) {
      bar = host.createDiv({ cls: BAR_CLASS });
      host.prepend(bar);
    }
    this.render(bar, file);
  }

  render(bar, file) {
    bar.empty();
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache ? cache.frontmatter : undefined;
    const state = readSrState(fm);
    const cdLeft = this.cooldownLeft(file);
    const onCooldown = cdLeft > 0;
    bar.toggleClass("is-cooldown", onCooldown);

    const info = bar.createDiv({ cls: "rt-info" });
    info.setText(this.statusText(fm, state));

    const btns = bar.createDiv({ cls: "rt-buttons" });
    const self = this;
    for (let i = 0; i < GRADES.length; i++) {
      const grade = GRADES[i];
      const preview = schedule(state, grade);
      const b = btns.createEl("button", { cls: "rt-btn rt-" + grade });
      b.createSpan({ cls: "rt-grade", text: GRADE_LABELS[grade] });
      b.createSpan({ cls: "rt-int", text: formatInterval(preview.interval) });
      b.disabled = onCooldown;
      if (!onCooldown) {
        b.addEventListener("click", () => { self.onGrade(file, grade); });
      }
    }

    if (onCooldown && this.refreshTimer === null) {
      this.refreshTimer = window.setTimeout(() => {
        self.refreshTimer = null;
        self.refreshAll();
      }, cdLeft + 50);
    }
  }

  statusText(fm, state) {
    const overdue = daysSinceReviewed(fm ? fm[SR_KEYS.due] : undefined);
    if (overdue === null) {
      const ago = daysSinceReviewed(fm ? fm[FRONTMATTER_KEY] : undefined);
      return ago !== null
        ? "Last reviewed " + ago + "d ago · not scheduled — grade to start"
        : "Not scheduled yet — grade to start";
    }
    let when;
    if (overdue > 0) when = "due — " + overdue + "d overdue";
    else if (overdue === 0) when = "due today";
    else when = "next in " + -overdue + "d";
    return "Review: " + when + "  ·  reps " + state.reps + "  ·  ease " + state.ease.toFixed(2);
  }

  removeAll() {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    document.querySelectorAll("." + BAR_CLASS).forEach((el) => el.remove());
  }
}

class ReviewTrackerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const containerEl = this.containerEl;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Digital Garden" });
    containerEl.createEl("p", {
      text: "Colors reflect how overdue a note is. Notes with no schedule fall back to last_reviewed or the file's modified date.",
      cls: "setting-item-description",
    });

    const s = this.plugin.settings;
    const self = this;

    const numberSetting = function (name, desc, get, set) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text
            .setPlaceholder("days")
            .setValue(String(get()))
            .onChange(async (raw) => {
              const v = Number(raw);
              if (!Number.isFinite(v) || v < 0) return;
              set(Math.floor(v));
              await self.plugin.saveSettings();
            })
        );
    };

    numberSetting("Green up to", "Overdue by at most this many days.",
      () => s.greenMaxDays, (v) => (s.greenMaxDays = v));
    numberSetting("Yellow up to", "Overdue by at most this many days.",
      () => s.yellowMaxDays, (v) => (s.yellowMaxDays = v));
    numberSetting("Orange up to", "Overdue by at most this many days. Older turns red.",
      () => s.orangeMaxDays, (v) => (s.orangeMaxDays = v));
    numberSetting("Grading cooldown (minutes)",
      "Lock a note's grade buttons for this long after grading. 0 disables it.",
      () => s.cooldownMinutes, (v) => (s.cooldownMinutes = v));

    new Setting(containerEl)
      .setName("Use modified date for un-reviewed notes")
      .setDesc("Color notes with no last_reviewed value by the file's modified date.")
      .addToggle((toggle) =>
        toggle.setValue(s.useModifiedAsFallback).onChange(async (v) => {
          s.useModifiedAsFallback = v;
          await self.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Write status property for graph colors")
      .setDesc("Maintain a review_status property so the graph view can color nodes via color groups.")
      .addToggle((toggle) =>
        toggle.setValue(s.writeStatusProperty).onChange(async (v) => {
          s.writeStatusProperty = v;
          await self.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Keep date fields as plain text")
      .setDesc("Force last_reviewed and sr_due to the Text property type.")
      .addToggle((toggle) =>
        toggle.setValue(s.forceTextDateProps).onChange(async (v) => {
          s.forceTextDateProps = v;
          await self.plugin.saveSettings();
        })
      );
  }
}

class ReviewTrackerPlugin extends Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.cooldowns = {};
  }

  async onload() {
    await this.loadSettings();

    this.decorator = new ExplorerDecorator(this.app, () => this.settings);
    this.reviewBar = new ReviewBar(
      this.app,
      (file, grade) => this.grade(file, grade),
      (file) => this.cooldownLeft(file)
    );
    this.refreshAllDebounced = debounce(() => this.decorator.refreshAll(), 150, true);

    this.addSettingTab(new ReviewTrackerSettingTab(this.app, this));

    for (let i = 0; i < GRADES.length; i++) {
      const grade = GRADES[i];
      this.addCommand({
        id: "review-grade-" + grade,
        name: "Review: " + grade.charAt(0).toUpperCase() + grade.slice(1),
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          const eligible = !!file && file.extension === "md";
          if (eligible && !checking) this.grade(file, grade);
          return eligible;
        },
      });
    }

    this.addCommand({
      id: "refresh-review-statuses",
      name: "Refresh all review statuses",
      callback: () => {
        this.syncAllStatuses().then(() => {
          this.decorator.refreshAll();
          new Notice("Review statuses refreshed.");
        });
      },
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => this.decorator.refreshFile(file))
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refreshAllDebounced())
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          if (this.cooldowns[oldPath] !== undefined) {
            this.cooldowns[file.path] = this.cooldowns[oldPath];
            delete this.cooldowns[oldPath];
            this.persist();
          }
          this.decorator.refreshFile(file);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.reviewBar.refreshAll())
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.reviewBar.refreshAll())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.reviewBar.refreshAll())
    );

    this.app.workspace.onLayoutReady(() => {
      this.ensurePropertyTypes();
      this.decorator.refreshAll();
      this.reviewBar.refreshAll();
      this.syncAllStatuses();
    });
  }

  onunload() {
    if (this.decorator) this.decorator.clearAll();
    if (this.reviewBar) this.reviewBar.removeAll();
  }

  ensurePropertyTypes() {
    if (!this.settings.forceTextDateProps) return;
    const mtm = this.app.metadataTypeManager;
    if (!mtm || typeof mtm.setType !== "function") return;
    const keys = [FRONTMATTER_KEY, SR_KEYS.due];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      try {
        let current;
        if (typeof mtm.getAssignedType === "function") {
          current = mtm.getAssignedType(key);
        } else if (mtm.types) {
          const entry = mtm.types[key.toLowerCase()];
          current = entry && entry.type ? entry.type : undefined;
        }
        if (current !== "text") mtm.setType(key, "text");
      } catch (e) {
        // ignore
      }
    }
  }

  cooldownLeft(file) {
    const cdMs = this.settings.cooldownMinutes * 60000;
    if (cdMs <= 0) return 0;
    const last = this.cooldowns[file.path];
    if (!last) return 0;
    return Math.max(0, last + cdMs - Date.now());
  }

  async grade(file, grade) {
    const remaining = this.cooldownLeft(file);
    if (remaining > 0) {
      new Notice("On cooldown — wait " + formatRemaining(remaining) + " before grading again.");
      return;
    }

    const today = new Date();
    const cache = this.app.metadataCache.getFileCache(file);
    const prev = readSrState(cache ? cache.frontmatter : undefined);
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
    new Notice(file.basename + ": next review in " + next.interval + "d (" + dueStr + ")");
  }

  async syncStatus(file) {
    if (!this.settings.writeStatusProperty || file.extension !== "md") return;
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache ? cache.frontmatter : undefined;

    const hasDue = !!fm && fm[SR_KEYS.due] !== undefined;
    const hasReviewed = !!fm && fm[FRONTMATTER_KEY] !== undefined;

    let seedDate;
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

  async syncAllStatuses() {
    if (!this.settings.writeStatusProperty) return;
    const files = this.app.vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i++) {
      await this.syncStatus(files[i]);
    }
  }

  async loadSettings() {
    const data = await this.loadData();
    if (data && data.settings) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
      this.cooldowns = data.cooldowns || {};
    } else {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
      this.cooldowns = {};
    }
  }

  async persist() {
    await this.saveData({ settings: this.settings, cooldowns: this.cooldowns });
  }

  async saveSettings() {
    await this.persist();
    this.decorator.refreshAll();
  }
}

exports.default = ReviewTrackerPlugin;
