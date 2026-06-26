import { App, MarkdownView, TFile } from "obsidian";
import {
  Grade,
  GRADES,
  SR_KEYS,
  FRONTMATTER_KEY,
  readSrState,
  schedule,
  daysSinceReviewed,
  formatInterval,
} from "./status";

const BAR_CLASS = "digital-garden-bar";

const GRADE_LABELS: Record<Grade, string> = {
  again: "Again",
  hard: "Hard",
  good: "Good",
  easy: "Easy",
};

export class ReviewBar {
  private refreshTimer: number | null = null;

  constructor(
    private app: App,
    private onGrade: (file: TFile, grade: Grade) => void | Promise<void>,
    private cooldownLeft: (file: TFile) => number,
  ) {}

  refreshAll(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView) this.inject(view);
    });
  }

  private inject(view: MarkdownView): void {
    const file = view.file;
    const host = view.contentEl;
    if (!file || file.extension !== "md") {
      host.querySelector(`:scope > .${BAR_CLASS}`)?.remove();
      return;
    }

    let bar = host.querySelector<HTMLElement>(`:scope > .${BAR_CLASS}`);
    if (!bar) {
      bar = host.createDiv({ cls: BAR_CLASS });
      host.prepend(bar);
    }
    this.render(bar, file);
  }

  private render(bar: HTMLElement, file: TFile): void {
    bar.empty();

    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const state = readSrState(fm);
    const cdLeft = this.cooldownLeft(file);
    const onCooldown = cdLeft > 0;
    bar.toggleClass("is-cooldown", onCooldown);

    const info = bar.createDiv({ cls: "rt-info" });
    info.setText(this.statusText(fm, state));

    const btns = bar.createDiv({ cls: "rt-buttons" });
    for (const grade of GRADES) {
      const preview = schedule(state, grade);
      const b = btns.createEl("button", { cls: `rt-btn rt-${grade}` });
      b.createSpan({ cls: "rt-grade", text: GRADE_LABELS[grade] });
      b.createSpan({ cls: "rt-int", text: formatInterval(preview.interval) });
      b.disabled = onCooldown;
      if (!onCooldown) {
        b.addEventListener("click", () => void this.onGrade(file, grade));
      }
    }

    if (onCooldown && this.refreshTimer === null) {
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null;
        this.refreshAll();
      }, cdLeft + 50);
    }
  }

  private statusText(fm: Record<string, unknown> | undefined, state: ReturnType<typeof readSrState>): string {
    const overdue = daysSinceReviewed(fm?.[SR_KEYS.due]);
    if (overdue === null) {
      const ago = daysSinceReviewed(fm?.[FRONTMATTER_KEY]);
      return ago !== null
        ? `Last reviewed ${ago}d ago · not scheduled — grade to start`
        : "Not scheduled yet — grade to start";
    }
    let when: string;
    if (overdue > 0) when = `due — ${overdue}d overdue`;
    else if (overdue === 0) when = "due today";
    else when = `next in ${-overdue}d`;
    return `Review: ${when}  ·  reps ${state.reps}  ·  ease ${state.ease.toFixed(2)}`;
  }

  removeAll(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    document.querySelectorAll(`.${BAR_CLASS}`).forEach((el) => el.remove());
  }
}
