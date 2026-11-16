/**
 * Board and group health status helpers (#1133): what to show, what to say.
 *
 * The server resolves the cascade (`effective_health_status`, and the group it
 * came from in `health_status_source`); the client never walks the tree
 * itself. These helpers only turn the three fields into display state and
 * copy, so the pill, the popover and the announcements say the same thing.
 */
import { healthLabel, type HealthDisplayValue, type HealthStatus } from "../constants/healthStatus";
import { DEMO_HEALTH_STATUS_REASON } from "../constants/demoCopy";
import type {
  Board, BoardFull, BoardHealthStatusOrigin, BoardUser, HealthComputedCounts, HealthStatusSource, Swimlane, SwimlaneHealthStatusOrigin,
} from "../types";
import { formatRelativeTime } from "./date";

export interface HealthFields {
  health_status: HealthStatus | null;
  effective_health_status: HealthStatus | null;
  health_status_source: HealthStatusSource | null;
  /**
   * #2245: where the effective value comes from, as the server resolved it.
   * Omitted by callers that predate auto health; then it is derived.
   */
  health_status_origin?: BoardHealthStatusOrigin | null;
}

/**
 * Which entity a health control edits. Boards and groups inherit through the
 * group tree (#1133); a swimlane (#2243) never inherits, so its null means "no
 * status" and its popover has no Inherit choice. On a board with auto health
 * on (#2245), a lane's status rolls up into the board's calculated status.
 */
export type HealthEntityKind = "board" | "group" | "swimlane";

/**
 * A swimlane's health as the shape the shared health components take. The pin
 * is `health_status` (#2243); on an auto-health board (#2245) the effective
 * value falls back to the computed one. There is never a source, so a lane
 * pill is never drawn as inherited (dashed). `effective_health_status` falls
 * back to the pin for a payload that predates #2245.
 */
export function laneHealthFields(
  lane: Pick<Swimlane, "health_status"> & Partial<Pick<Swimlane, "effective_health_status" | "health_status_origin">>,
): HealthFields {
  // The pin always wins, so a set pin is the effective value whatever the
  // payload's effective field says.
  const effective = lane.health_status ?? lane.effective_health_status ?? null;
  let origin: SwimlaneHealthStatusOrigin | null = lane.health_status !== null ? "manual" : null;
  if (origin === null && effective !== null) origin = lane.health_status_origin ?? "computed";
  return {
    health_status: lane.health_status,
    effective_health_status: effective,
    health_status_source: null,
    health_status_origin: origin,
  };
}

/**
 * The auto health facts for an entity on an auto-health board (#2245). Given
 * (non-null) only while auto health is on; null means the board is manual
 * only, and every health surface reads exactly as before #2245.
 */
export interface HealthAutoInfo {
  /** What the rule computed; null = no open cards, or never computed. */
  computed: HealthStatus | null;
  /** When it was last computed; null = never. */
  computedAt: string | null;
  counts: HealthComputedCounts | null;
}

export function boardHealthAuto(board: Pick<Board, "health_auto_enabled"> & Partial<Pick<Board, "computed_health_status" | "health_computed_at" | "health_computed_counts">>): HealthAutoInfo | null {
  if (!board.health_auto_enabled) return null;
  return {
    computed: board.computed_health_status ?? null,
    computedAt: board.health_computed_at ?? null,
    counts: board.health_computed_counts ?? null,
  };
}

export function laneHealthAuto(lane: Partial<Pick<Swimlane, "computed_health_status" | "health_computed_at" | "health_computed_counts">>, boardAutoEnabled: boolean): HealthAutoInfo | null {
  if (!boardAutoEnabled) return null;
  return {
    computed: lane.computed_health_status ?? null,
    computedAt: lane.health_computed_at ?? null,
    counts: lane.health_computed_counts ?? null,
  };
}

/** Every board health field, by name: the one list App.tsx merges from a health response (#2245). */
export const BOARD_HEALTH_FIELDS = [
  "health_status", "effective_health_status", "health_status_source", "health_status_changed_at",
  "health_status_changed_by", "health_status_note", "health_review_days", "health_review_due_at",
  "health_auto_enabled", "health_off_track_cards", "computed_health_status", "health_computed_at",
  "health_computed_counts", "health_status_origin",
] as const satisfies readonly (keyof Board)[];

/** Every lane health field, by name (#2243, #2245). */
export const LANE_HEALTH_FIELDS = [
  "health_status", "effective_health_status", "health_status_origin", "computed_health_status",
  "health_computed_at", "health_computed_counts",
] as const satisfies readonly (keyof Swimlane)[];

export function pickBoardHealth(board: Board): Pick<Board, typeof BOARD_HEALTH_FIELDS[number]> {
  const out: Partial<Board> = {};
  for (const key of BOARD_HEALTH_FIELDS) (out as Record<string, unknown>)[key] = board[key];
  return out as Pick<Board, typeof BOARD_HEALTH_FIELDS[number]>;
}

export function pickLaneHealth(lane: Swimlane): Pick<Swimlane, typeof LANE_HEALTH_FIELDS[number]> {
  const out: Partial<Swimlane> = {};
  for (const key of LANE_HEALTH_FIELDS) (out as Record<string, unknown>)[key] = lane[key];
  return out as Pick<Swimlane, typeof LANE_HEALTH_FIELDS[number]>;
}

export type HealthOrigin = BoardHealthStatusOrigin | null;

export interface HealthDisplay {
  value: HealthDisplayValue;
  label: string;
  /** Name of the ancestor group the value comes from; null when set here or none. */
  inheritedFrom: string | null;
  /** #2245: "manual" (set by hand, the pin), "computed", "inherited", or null for none. */
  origin: HealthOrigin;
}

export function getHealthDisplay(fields: HealthFields): HealthDisplay {
  const value: HealthDisplayValue = fields.effective_health_status ?? "none";
  // Inherited only when this entity sets nothing itself. A value explicitly
  // set equal to the parent's is "set here" (the server sends no source).
  const inheritedFrom = fields.health_status === null && fields.effective_health_status !== null
    ? fields.health_status_source?.name ?? null
    : null;
  let origin: HealthOrigin;
  if (fields.health_status_origin !== undefined) origin = fields.health_status_origin;
  else if (fields.health_status !== null) origin = "manual";
  else origin = inheritedFrom ? "inherited" : null;
  if (value === "none") origin = null;
  return { value, label: healthLabel(value), inheritedFrom: origin === "computed" ? null : inheritedFrom, origin };
}

/** "Computed 3h ago" / "Never computed" (#2245). Never presents a stale value as current. */
export function healthComputedWhen(computedAt: string | null): string {
  if (!computedAt) return "Never computed";
  const rel = formatRelativeTime(computedAt);
  return rel ? `Computed ${rel}` : "Never computed";
}

/** "12 open · 3 overdue · 2 stale · 1 blocked · 5 flagged": zero segments omitted, except open. */
export function healthCountsLine(counts: HealthComputedCounts | null): string {
  if (!counts) return "";
  const parts = [`${counts.open} open`];
  for (const key of ["overdue", "stale", "blocked", "flagged"] as const) {
    if (counts[key] > 0) parts.push(`${counts[key]} ${key}`);
  }
  return parts.join(" · ");
}

/** "1 overdue, 2 stale" for a title; "" when nothing is flagged. */
function countsPhrase(counts: HealthComputedCounts | null): string {
  if (!counts) return "";
  return (["overdue", "stale", "blocked"] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${k}`)
    .join(", ");
}

/** "At risk", or "No open cards" for a computed null that has run (#2245). */
export function healthComputedLabel(auto: HealthAutoInfo): string {
  if (auto.computed) return healthLabel(auto.computed);
  return auto.computedAt ? "No open cards" : "Never computed";
}

/**
 * The auto health clause of a pill title (#2245): "At risk: calculated
 * automatically. 1 overdue, 2 stale. Computed 3h ago." for a computed value,
 * "Off track: set by hand. The rule computed At risk." for a pin.
 */
export function healthAutoTitle(display: HealthDisplay, auto: HealthAutoInfo): string {
  if (display.origin === "manual") {
    const rule = auto.computedAt ? `The rule computed ${healthComputedLabel(auto)}.` : "Never computed.";
    return `${display.label}: set by hand. ${rule}`;
  }
  if (display.origin === "computed") {
    const phrase = countsPhrase(auto.counts);
    return `${display.label}: calculated automatically.${phrase ? ` ${phrase}.` : ""} ${healthComputedWhen(auto.computedAt)}.`;
  }
  if (display.origin === "inherited") return "";
  return `${healthComputedLabel(auto)}. ${healthComputedWhen(auto.computedAt)}.`;
}

/** The sr-only origin suffix after the pill's word (#2245). Glyph is never the only signal. */
export function healthOriginSuffix(display: HealthDisplay, auto: HealthAutoInfo | null): string {
  if (!auto) return "";
  if (display.origin === "manual") return ", set by hand";
  if (display.origin === "computed") return ", calculated automatically";
  if (display.value === "none" && auto.computedAt && !auto.computed) return ", no open cards";
  return "";
}

/** The message shown when Recompute now fails (#2245). */
export function healthRecomputeErrorMessage(err: unknown): string {
  const response = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)?.response;
  if (response?.status === 409 && response.data?.code === "health_auto_disabled") {
    return "Automatic health status is turned off for this board.";
  }
  if (response?.status === 429) return "Recompute is limited to 30 times per hour. Try again later.";
  return "Couldn't recompute. Try again.";
}

/** The last set or confirm of an entity's own status (#2242); all null when never recorded. */
export interface HealthAttribution {
  health_status_changed_at: string | null;
  health_status_changed_by: BoardUser | null;
  health_status_note: string | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** "3d ago" within a week, else "on Sep 14" (formatRelativeTime's date form). "" when unknown. */
export function healthSetWhen(changedAt: string | null): string {
  if (!changedAt) return "";
  const rel = formatRelativeTime(changedAt);
  if (!rel) return "";
  const age = Date.now() - new Date(changedAt).getTime();
  return age < WEEK_MS ? rel : `on ${rel}`;
}

/** Who set it: display name, else username; null (removed account or automatic) reads "System". */
export function healthSetterName(user: BoardUser | null): string {
  if (!user) return "System";
  return user.display_name || user.username;
}

/**
 * The ONLY builder of the health attribution copy (#2242; frontend/CLAUDE.md):
 * "Set 3d ago by Priya", "Set on Sep 14 by Priya", "Set 2h ago by System".
 * "" when `changedAt` is null (a status set before history existed): callers
 * omit the clause.
 */
export function healthSetLine(changedAt: string | null, changedBy: BoardUser | null): string {
  const when = healthSetWhen(changedAt);
  if (!when) return "";
  return `Set ${when} by ${healthSetterName(changedBy)}`;
}

/**
 * The review-cue fields (#2244). `health_review_due_at` is resolved by the
 * server from whoever owns the status shown (this entity, or the source group
 * of an inherited value); the client only compares it with now.
 */
export interface HealthReviewFields extends HealthFields {
  health_review_due_at?: string | null;
  health_status_changed_at?: string | null;
}

export interface HealthReviewCue {
  /** Whole days since the status shown was last set or confirmed. */
  days: number;
  /** "Not reviewed in 18 days": the visible cue and its accessible text. */
  text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The ONLY builder of the "not reviewed" cue (#2244): null while the status is
 * within its review window, when the setting is off, when no status applies,
 * or when its change time was never recorded (all of which the server sends as
 * a null `health_review_due_at`). The age is counted from the entity's own
 * `health_status_changed_at`, or from `health_status_source.changed_at` when
 * the value is inherited, so it always matches the "Set … ago" line.
 */
export function healthReviewCue(fields: HealthReviewFields, now: number = Date.now()): HealthReviewCue | null {
  const dueAt = fields.health_review_due_at;
  if (!dueAt || !fields.effective_health_status) return null;
  // #2245: a computed status is re-rated every night; it never needs review.
  if (fields.health_status_origin === "computed") return null;
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due) || now < due) return null;
  const inherited = fields.health_status === null;
  const since = inherited ? fields.health_status_source?.changed_at ?? null : fields.health_status_changed_at ?? null;
  const sinceMs = since ? new Date(since).getTime() : NaN;
  if (Number.isNaN(sinceMs)) return null;
  const days = Math.max(1, Math.floor((now - sinceMs) / DAY_MS));
  return { days, text: `Not reviewed in ${days} ${days === 1 ? "day" : "days"}` };
}

const TOOLTIP_NOTE_MAX = 120;

/**
 * `title` for a health pill: the trigger (interactive), a read-only pill, a
 * read-only trigger that opens the history (readonly), or the demo refusal.
 * `attribution` adds "Set 3d ago by Priya. Note: …" for a status set here,
 * and the source's time for an inherited one (#2242). `entityKind`
 * "swimlane" gives the lane wording (#2243).
 */
export function healthTitle(
  display: HealthDisplay,
  mode: "interactive" | "static" | "readonly" | "demo",
  attribution?: HealthAttribution | null,
  source?: HealthStatusSource | null,
  entityKind: HealthEntityKind = "board",
  auto: HealthAutoInfo | null = null,
): string {
  if (auto && mode !== "demo") {
    // #2245: on an auto board the title says where the value comes from.
    const autoBase = healthAutoTitle(display, auto);
    if (autoBase) {
      const base = entityKind === "swimlane" ? `Lane health status: ${autoBase}` : `Health status: ${autoBase}`;
      if (mode === "interactive") return `${base} Click to change.`;
      if (mode === "readonly") return `${base} Click for details.`;
      return base;
    }
  }
  if (mode === "demo") {
    const prefix = entityKind === "swimlane" ? "Lane health status" : "Health status";
    return `${prefix}: ${display.label}. ${DEMO_HEALTH_STATUS_REASON}`;
  }
  if (entityKind === "swimlane") {
    // Lanes (#2243): the title says the value is the lane's own, so a lane
    // pill next to the board's is never read as the board's status. Lanes
    // carry no attribution or history (#2242 is board/group only), so a
    // "readonly" lane reads exactly as a "static" one.
    if (display.value === "none") return "Set health status";
    const base = `Lane health status: ${display.label}. Separate from the board's status.`;
    return mode === "interactive" ? `${base} Click to change.` : base;
  }
  if (display.value === "none") {
    return mode === "interactive" ? "No status set. Click to set one." : "No status set.";
  }
  let base: string;
  if (display.inheritedFrom) {
    const when = healthSetWhen(source?.changed_at ?? null);
    base = when
      ? `Health status: ${display.label} (inherited from ${display.inheritedFrom}, set ${when}).`
      : `Health status: ${display.label} (inherited from ${display.inheritedFrom}).`;
  } else {
    base = `Health status: ${display.label}.`;
    if (attribution) {
      const line = healthSetLine(attribution.health_status_changed_at, attribution.health_status_changed_by);
      if (line) base += ` ${line}.`;
      const note = attribution.health_status_note;
      if (note) {
        base += ` Note: ${note.length > TOOLTIP_NOTE_MAX ? `${note.slice(0, TOOLTIP_NOTE_MAX)}…` : note}.`;
      }
    }
  }
  if (mode === "interactive") return `${base} Click to change.`;
  if (mode === "readonly") return `${base} Click for history.`;
  return base;
}

/** The group page caption (#2242): "Set 3d ago by Priya", or "Inherited from Eng · 3d ago". */
export function healthCaption(
  display: HealthDisplay,
  attribution: HealthAttribution | null | undefined,
  source: HealthStatusSource | null,
): string {
  if (display.inheritedFrom) {
    const when = healthSetWhen(source?.changed_at ?? null);
    return when ? `Inherited from ${display.inheritedFrom} · ${when}` : `Inherited from ${display.inheritedFrom}`;
  }
  if (display.value === "none" || !attribution) return "";
  return healthSetLine(attribution.health_status_changed_at, attribution.health_status_changed_by);
}

/** The message shown in the popover's error slot when a save fails. */
export function healthStatusErrorMessage(err: unknown): string {
  const response = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (response?.status === 403) return "Only admins can change health status.";
  if (response?.status === 400) {
    const data = response.data as { detail?: unknown; note?: unknown; status?: unknown } | null | undefined;
    const detail = data?.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    // POST health-status/ field errors (#2242): the first message of note or status.
    for (const field of [data?.note, data?.status]) {
      if (Array.isArray(field) && typeof field[0] === "string") return field[0];
    }
  }
  return "Could not save health status. Try again.";
}

/**
 * What the live region says after a successful save.
 *
 * `next` is the value just written (null = inherit / clear), `effective` the
 * server's resolved value after the write, `parentName` the group above the
 * entity (null at the root, where "inherit" means "clear").
 */
export function healthStatusAnnouncement(
  next: HealthStatus | null,
  effective: HealthStatus | null,
  parentName: string | null,
  lane?: { name: string },
): string {
  if (lane) {
    return next !== null
      ? `Lane ${lane.name} health status set to ${healthLabel(next)}.`
      : `Lane ${lane.name} health status cleared.`;
  }
  if (next !== null) return `Health status set to ${healthLabel(next)}.`;
  if (parentName !== null) return `Health status now follows ${parentName}: ${healthLabel(effective ?? "none")}.`;
  return "Health status cleared.";
}

/**
 * Merge a Recompute now response (#2245) into board state: the board's health
 * fields, and each lane's by id. Shared by the board header and Settings.
 * Lanes whose status did not change get no broadcast, so their new computed
 * time comes only from this response.
 */
export function applyHealthRecompute(
  result: { board: Board; swimlanes: Swimlane[] },
  mergeBoardState: (patch: Partial<BoardFull>) => void,
  updateSwimlane: (resolver: (board: BoardFull) => Swimlane) => void,
): void {
  mergeBoardState(pickBoardHealth(result.board));
  for (const lane of result.swimlanes) {
    updateSwimlane((b) => {
      const prior = b.swimlanes.find((s) => s.id === lane.id);
      return prior ? { ...prior, ...pickLaneHealth(lane) } : lane;
    });
  }
}
