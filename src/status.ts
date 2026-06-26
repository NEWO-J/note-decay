export type StatusTier = "green" | "yellow" | "orange" | "red";

export const ALL_TIERS: StatusTier[] = ["green", "yellow", "orange", "red"];

export const FRONTMATTER_KEY = "last_reviewed";
export const STATUS_KEY = "review_status";

export function tierClass(tier: StatusTier): string {
  return `review-status-${tier}`;
}

export interface ReviewTrackerSettings {
  greenMaxFraction: number;
  yellowMaxFraction: number;
  orangeMaxFraction: number;
  greenMaxDays: number;
  yellowMaxDays: number;
  orangeMaxDays: number;
  useModifiedAsFallback: boolean;
  cooldownMinutes: number;
  forceTextDateProps: boolean;
  writeStatusProperty: boolean;
}

export const DEFAULT_SETTINGS: ReviewTrackerSettings = {
  greenMaxFraction: 0.65,
  yellowMaxFraction: 0.85,
  orangeMaxFraction: 1,
  greenMaxDays: 3,
  yellowMaxDays: 7,
  orangeMaxDays: 14,
  useModifiedAsFallback: true,
  cooldownMinutes: 5,
  forceTextDateProps: true,
  writeStatusProperty: true,
};

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseReviewedValue(value: unknown): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const [, y, mo, d] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    return isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

export function daysSinceReviewed(value: unknown, now: Date = new Date()): number | null {
  const then = parseReviewedValue(value);
  if (!then) return null;
  const thenUTC = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  const nowUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((nowUTC - thenUTC) / 86_400_000);
}

export function tierForDays(days: number, settings: ReviewTrackerSettings): StatusTier {
  if (days <= settings.greenMaxDays) return "green";
  if (days <= settings.yellowMaxDays) return "yellow";
  if (days <= settings.orangeMaxDays) return "orange";
  return "red";
}

export function tierForProgress(progress: number, settings: ReviewTrackerSettings): StatusTier {
  if (progress < settings.greenMaxFraction) return "green";
  if (progress < settings.yellowMaxFraction) return "yellow";
  if (progress < settings.orangeMaxFraction) return "orange";
  return "red";
}

export function resolveTier(
  frontmatter: Record<string, unknown> | undefined,
  fallbackMtime: number | undefined,
  settings: ReviewTrackerSettings,
): StatusTier | null {
  const elapsed = daysSinceReviewed(frontmatter?.[FRONTMATTER_KEY]);
  const interval = readSrState(frontmatter).interval;

  // Graded note: color by how far it has ripened toward its due date.
  if (elapsed !== null && interval > 0) {
    return tierForProgress(elapsed / interval, settings);
  }

  // Ungraded note: no interval yet, fall back to raw days since the file date.
  let days = elapsed;
  if (days === null && settings.useModifiedAsFallback && typeof fallbackMtime === "number") {
    days = daysSinceReviewed(new Date(fallbackMtime));
  }
  if (days === null) return null;
  return tierForDays(days, settings);
}

export type Grade = "again" | "hard" | "good" | "easy";

export const GRADES: Grade[] = ["again", "hard", "good", "easy"];

export const SR_KEYS = {
  due: "sr_due",
  interval: "sr_interval",
  ease: "sr_ease",
  reps: "sr_reps",
  lapses: "sr_lapses",
} as const;

export interface SrState {
  ease: number;
  interval: number;
  reps: number;
  lapses: number;
}

export const DEFAULT_SR_STATE: SrState = { ease: 2.5, interval: 0, reps: 0, lapses: 0 };

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

export function readSrState(fm: Record<string, unknown> | undefined): SrState {
  const num = (v: unknown, d: number) =>
    typeof v === "number" && isFinite(v) ? v : d;
  return {
    ease: Math.max(SR.minEase, num(fm?.[SR_KEYS.ease], DEFAULT_SR_STATE.ease)),
    interval: num(fm?.[SR_KEYS.interval], DEFAULT_SR_STATE.interval),
    reps: num(fm?.[SR_KEYS.reps], DEFAULT_SR_STATE.reps),
    lapses: num(fm?.[SR_KEYS.lapses], DEFAULT_SR_STATE.lapses),
  };
}

export function schedule(state: SrState, grade: Grade): SrState {
  let { ease, interval, reps, lapses } = state;

  if (grade === "again") {
    ease = Math.max(SR.minEase, ease + SR.againEaseDelta);
    return { ease, interval: 1, reps: 0, lapses: lapses + 1 };
  }

  if (grade === "hard") ease = Math.max(SR.minEase, ease + SR.hardEaseDelta);
  if (grade === "easy") ease = ease + SR.easyEaseDelta;

  reps = reps + 1;

  let next: number;
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

  return { ease, interval: Math.max(1, Math.round(next)), reps, lapses };
}

export function addDays(from: Date, days: number): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

export function formatInterval(days: number): string {
  if (days < 1) return "<1d";
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function formatRemaining(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}
