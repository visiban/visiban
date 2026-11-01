/**
 * Copy for card-placement refusals, shared by MoveBlockedToast and the inline
 * create/restore surfaces (#1428). Kept out of the component file so React
 * fast refresh keeps working (a component module must export only components).
 */
import type { MoveBlockedError } from "../../hooks/useBoard";

export function toastBody(error: MoveBlockedError): string {
  if (error.code === "version_conflict") {
    return "This card was modified by another user. The board has been refreshed.";
  }
  if (error.code === "permission_denied" || error.code === "maintenance_mode" || error.code === "move_failed") {
    return error.detail;
  }
  if (error.code === "wip_limit_exceeded" || error.code === "wip_hard_blocked") {
    const s = error.wip_limit !== 1 ? "s" : "";
    return `"${error.column_name}" is at its limit of ${error.wip_limit} card${s} (${error.current_count} active).`;
  }
  // Swimlane (row) limits (#1150) name the row, which is what the limit is on.
  if (error.code === "swimlane_wip_limit_exceeded" || error.code === "swimlane_wip_hard_blocked") {
    const s = error.wip_limit !== 1 ? "s" : "";
    return `Swimlane "${error.swimlane_name}" is at its limit of ${error.wip_limit} card${s} (${error.current_count} active).`;
  }
  const proposed = error.current_weight + error.card_weight;
  if (error.code === "swimlane_weight_limit_exceeded") {
    return `Swimlane "${error.swimlane_name}" has ${error.current_weight} weight — adding this card (+${error.card_weight}) would reach ${proposed} of ${error.weight_limit}.`;
  }
  return `"${error.column_name}" has ${error.current_weight} weight — adding this card (+${error.card_weight}) would reach ${proposed} of ${error.weight_limit}.`;
}

/** Codes of the six limit refusals (column and swimlane). */
const LIMIT_REFUSAL_CODES = new Set<string>([
  "wip_limit_exceeded", "wip_hard_blocked", "weight_limit_exceeded",
  "swimlane_wip_limit_exceeded", "swimlane_wip_hard_blocked", "swimlane_weight_limit_exceeded",
]);

/** True for the hard WIP refusals, which no role can override. */
export function isHardLimit(code: string): boolean {
  return code === "wip_hard_blocked" || code === "swimlane_wip_hard_blocked";
}

/** What a hard refusal is on, for the resolution hint: the column or the row. */
export function hardLimitContainer(error: MoveBlockedError): string | null {
  if (error.code === "wip_hard_blocked") return error.column_name;
  if (error.code === "swimlane_wip_hard_blocked") return error.swimlane_name;
  return null;
}

export function toastTitle(error: MoveBlockedError): string {
  if (error.code === "version_conflict") return "Card was updated";
  if (error.code === "move_failed") return "Move failed";
  if (error.code === "permission_denied") return "Cannot move this card";
  // Fixed, non-admin-authored lead sentence (#1127) — distinguishes an
  // instance-wide, temporary, systemic block from a personal permission
  // error. Do not let the operator's free-text `detail` (rendered in
  // toastBody below) stand in for this: a terse or generic operator
  // message must not read as "you personally did something wrong".
  if (error.code === "maintenance_mode") return "The instance is temporarily read-only";
  if (error.code === "wip_hard_blocked") return "Column at capacity — no exceptions";
  if (error.code === "swimlane_wip_hard_blocked") return "Swimlane at capacity — no exceptions";
  return error.code === "wip_limit_exceeded" || error.code === "swimlane_wip_limit_exceeded"
    ? "WIP limit reached"
    : "Weight limit reached";
}

/**
 * One-line reason for a WIP/weight-limit 409 on a non-move path (#1428).
 *
 * Card create and restore return the move endpoint's limit bodies verbatim,
 * so they reuse this toast's own title and body copy rather than inventing a
 * second wording. Returns null for anything that is not one of the six
 * limit codes, so callers keep their existing generic message for every other
 * failure. No override is offered: the inline surfaces have no force action.
 */
export function limitBlockedMessage(err: unknown): string | null {
  const data = limitRefusal(err);
  if (data === null) return null;
  return `${toastTitle(data)}: ${toastBody(data)}`;
}

/** The six limit refusal bodies (WIP soft, WIP hard, weight; column and swimlane). */
export type LimitRefusal = Extract<
  MoveBlockedError,
  {
    code:
      | "wip_limit_exceeded" | "wip_hard_blocked" | "weight_limit_exceeded"
      | "swimlane_wip_limit_exceeded" | "swimlane_wip_hard_blocked" | "swimlane_weight_limit_exceeded";
  }
>;

/**
 * The typed 409 body of a column-limit refusal, or null for anything else
 * (another 409 code, a non-409 status, a network error). Shared by
 * limitBlockedMessage and CardDetail's Move popover, which needs the body to
 * show the limit's numbers and decide whether to offer the admin override
 * (#1772).
 */
export function limitRefusal(err: unknown): LimitRefusal | null {
  const response = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (response?.status !== 409) return null;
  const data = response.data as MoveBlockedError | undefined;
  if (!data || !LIMIT_REFUSAL_CODES.has(data.code)) return null;
  return data as LimitRefusal;
}

/**
 * The numbers behind a limit refusal, for a surface that already names the
 * column in its own message (CardDetail's Move popover, #1772). Never repeats
 * the column name; pluralization matches toastBody.
 */
export function limitCounts(refusal: LimitRefusal): string {
  if (refusal.code === "swimlane_weight_limit_exceeded") {
    return `Swimlane "${refusal.swimlane_name}": weight would reach ${refusal.current_weight + refusal.card_weight} of ${refusal.weight_limit} (this card +${refusal.card_weight}).`;
  }
  if (refusal.code === "swimlane_wip_limit_exceeded" || refusal.code === "swimlane_wip_hard_blocked") {
    // The popover names the column, so the row is named here (#1150).
    const s = refusal.wip_limit !== 1 ? "s" : "";
    return `Swimlane "${refusal.swimlane_name}": limit ${refusal.wip_limit} card${s}, ${refusal.current_count} active.`;
  }
  if (refusal.code === "weight_limit_exceeded") {
    return `Weight would reach ${refusal.current_weight + refusal.card_weight} of ${refusal.weight_limit} (this card +${refusal.card_weight}).`;
  }
  const s = refusal.wip_limit !== 1 ? "s" : "";
  return `Limit ${refusal.wip_limit} card${s}, ${refusal.current_count} active.`;
}
