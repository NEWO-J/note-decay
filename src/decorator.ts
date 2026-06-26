import { App, TFile, WorkspaceLeaf } from "obsidian";
import {
  ReviewTrackerSettings,
  StatusTier,
  ALL_TIERS,
  tierClass,
  resolveTier,
} from "./status";

interface FileItem {
  selfEl: HTMLElement;
  el: HTMLElement;
}
interface FileExplorerView {
  fileItems: Record<string, FileItem>;
}

const ALL_TIER_CLASSES = ALL_TIERS.map(tierClass);

function folderTier(greenRatio: number): StatusTier {
  if (greenRatio >= 0.9) return "green";
  if (greenRatio >= 0.7) return "yellow";
  if (greenRatio >= 0.5) return "orange";
  return "red";
}

export class ExplorerDecorator {
  private folderTimer: number | null = null;

  constructor(
    private app: App,
    private getSettings: () => ReviewTrackerSettings,
  ) {}

  private getExplorerView(): FileExplorerView | null {
    const leaf: WorkspaceLeaf | undefined =
      this.app.workspace.getLeavesOfType("file-explorer")[0];
    return leaf ? (leaf.view as unknown as FileExplorerView) : null;
  }

  private getRowEl(path: string): HTMLElement | null {
    const view = this.getExplorerView();
    const item = view?.fileItems?.[path];
    if (item?.selfEl) return item.selfEl;
    return activeDocument.querySelector<HTMLElement>(
      `.nav-files-container .nav-file-title[data-path="${CSS.escape(path)}"]`,
    );
  }

  private getFolderEl(path: string): HTMLElement | null {
    const view = this.getExplorerView();
    const item = view?.fileItems?.[path];
    if (item?.selfEl) return item.selfEl;
    return activeDocument.querySelector<HTMLElement>(
      `.nav-files-container .nav-folder-title[data-path="${CSS.escape(path)}"]`,
    );
  }

  private applyTier(el: HTMLElement, tier: StatusTier | null): void {
    el.classList.remove(...ALL_TIER_CLASSES);
    if (tier) el.classList.add(tierClass(tier));
  }

  private fileTier(file: TFile): StatusTier | null {
    const cache = this.app.metadataCache.getFileCache(file);
    return resolveTier(cache?.frontmatter, file.stat?.mtime, this.getSettings());
  }

  refreshFile(file: TFile): void {
    if (file.extension !== "md") return;
    const el = this.getRowEl(file.path);
    if (el) this.applyTier(el, this.fileTier(file));
    this.scheduleFolderRefresh();
  }

  refreshAll(): void {
    const view = this.getExplorerView();
    if (!view) return;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const el = this.getRowEl(file.path);
      if (el) this.applyTier(el, this.fileTier(file));
    }
    this.refreshFolders();
  }

  refreshFolders(): void {
    if (!this.getExplorerView()) return;

    const total: Record<string, number> = {};
    const green: Record<string, number> = {};

    for (const file of this.app.vault.getMarkdownFiles()) {
      const isGreen = this.fileTier(file) === "green";
      let dir = file.parent;
      while (dir && dir.path && dir.path !== "/") {
        total[dir.path] = (total[dir.path] ?? 0) + 1;
        if (isGreen) green[dir.path] = (green[dir.path] ?? 0) + 1;
        dir = dir.parent;
      }
    }

    activeDocument
      .querySelectorAll<HTMLElement>(".nav-folder-title")
      .forEach((el) => el.classList.remove(...ALL_TIER_CLASSES));

    for (const path of Object.keys(total)) {
      const ratio = (green[path] ?? 0) / total[path];
      const el = this.getFolderEl(path);
      if (el) this.applyTier(el, folderTier(ratio));
    }
  }

  private scheduleFolderRefresh(): void {
    if (this.folderTimer !== null) return;
    this.folderTimer = window.setTimeout(() => {
      this.folderTimer = null;
      this.refreshFolders();
    }, 200);
  }

  clearAll(): void {
    if (this.folderTimer !== null) {
      window.clearTimeout(this.folderTimer);
      this.folderTimer = null;
    }
    activeDocument
      .querySelectorAll<HTMLElement>(".nav-file-title, .nav-folder-title")
      .forEach((el) => el.classList.remove(...ALL_TIER_CLASSES));
  }
}
