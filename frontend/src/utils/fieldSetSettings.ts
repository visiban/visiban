/** Non-component helpers for Board Settings → Field sets (#2570). */
import type { CustomFieldSet } from "../types";

export const SET_CAP = 10;
/** Escape priority of the editor's delete / discard confirms (frontend/CLAUDE.md). */
export const FIELD_SET_CONFIRM_ESCAPE_PRIORITY = 40.8;

/** The server's `detail` (or first field error) when there is one, else `fallback`. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === "object") {
    const first = Object.values(data as Record<string, unknown>)[0];
    const msg = Array.isArray(first) ? first[0] : first;
    if (typeof msg === "string" && msg) return msg;
  }
  return fallback;
}

/** "Delete {name}? Its {n} fields move to Other fields. No field values are deleted." Extended by #1923. */
export function deleteSetPrompt(set: CustomFieldSet, extra: string[] = []): string {
  const n = set.field_ids.length;
  return [`Delete ${set.name}? Its ${n} field${n === 1 ? "" : "s"} move${n === 1 ? "s" : ""} to Other fields. No field values are deleted.`, ...extra].join(" ");
}
