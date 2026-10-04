/**
 * Copy for card-placement refusals, shared by MoveBlockedToast and the inline
 * create/restore surfaces (#1428). Kept out of the component file so React
 * fast refresh keeps working (a component module must export only components).
 */
import type { MoveBlockedError } from "../../hooks/useBoard";

export function toastBody(error: MoveBlockedError): string {
  if (error.code === "version_conflict") {
    return "This card was modified by another user while you were dragging it. The board has been refreshed.";
  }
  if (error.code === "permission_denied" || error.code === "maintenance_mode") {
    return error.detail;
  }
  if (error.code === "wip_limit_exceeded" || error.code === "wip_hard_blocked") {
    const s = error.wip_limit !== 1 ? "s" : "";
    return `"${error.column_name}" is at its limit of ${error.wip_limit} card${s} (${error.current_count} active).`;
  }
  const proposed = error.current_weight + error.card_weight;
  return `"${error.column_name}" has ${error.current_weight} weight — adding this card (+${error.card_weight}) would reach ${proposed} of ${error.weight_limit}.`;
}

export function toastTitle(error: MoveBlockedError): string {
  if (error.code === "version_conflict") return "Card was updated";
  if (error.code === "permission_denied") return "Cannot move this card";
  // Fixed, non-admin-authored lead sentence (#1127) — distinguishes an
  // instance-wide, temporary, systemic block from a personal permission
  // error. Do not let the operator's free-text `detail` (rendered in
  // toastBody below) stand in for this: a terse or generic operator
  // message must not read as "you personally did something wrong".
  if (error.code === "maintenance_mode") return "The instance is temporarily read-only";
  if (error.code === "wip_hard_blocked") return "Column at capacity — no exceptions";
  return error.code === "wip_limit_exceeded" ? "WIP limit reached" : "Weight limit reached";
}

/**
 * One-line reason for a WIP/weight-limit 409 on a non-move path (#1428).
 *
 * Card create and restore return the move endpoint's limit bodies verbatim,
 * so they reuse this toast's own title and body copy rather than inventing a
 * second wording. Returns null for anything that is not one of the three
 * limit codes, so callers keep their existing generic message for every other
 * failure. No override is offered: the inline surfaces have no force action.
 */
export function limitBlockedMessage(err: unknown): string | null {
  const response = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (response?.status !== 409) return null;
  const data = response.data as MoveBlockedError | undefined;
  if (
    data?.code !== "wip_limit_exceeded" &&
    data?.code !== "wip_hard_blocked" &&
    data?.code !== "weight_limit_exceeded"
  ) {
    return null;
  }
  return `${toastTitle(data)}: ${toastBody(data)}`;
}
