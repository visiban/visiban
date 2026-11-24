/** Non-component helpers for Board Settings → Field sets (#2570). */
import type { CustomFieldDefinition, CustomFieldSet } from "../types";

export const SET_CAP = 10;
/** Escape priority of the editor's delete / discard confirms (frontend/CLAUDE.md). */
export const FIELD_SET_CONFIRM_ESCAPE_PRIORITY = 40.8;
/** Escape priority of the editor's Add field and Swimlanes menus: above the settings modal (40). */
export const FIELD_SET_MENU_ESCAPE_PRIORITY = 41;

const positionOf = (definitions: CustomFieldDefinition[], id: number) => definitions.find((d) => d.id === id)?.position ?? Number.MAX_SAFE_INTEGER;

/** A set's field ids in the board's field order, which is the order the card shows. */
export function sortByPosition(ids: number[], definitions: CustomFieldDefinition[]): number[] {
  return [...ids].sort((a, b) => positionOf(definitions, a) - positionOf(definitions, b));
}

/** Add `id` before the first field that follows it on the board, so adding alone never reorders. */
export function insertByPosition(ids: number[], id: number, definitions: CustomFieldDefinition[]): number[] {
  const at = ids.findIndex((x) => positionOf(definitions, x) > positionOf(definitions, id));
  return at === -1 ? [...ids, id] : [...ids.slice(0, at), id, ...ids.slice(at)];
}

/**
 * The board-wide field order that shows a set's fields as `ids`, or null when
 * it already does. Only the slots those fields hold move, so every other field
 * keeps its place.
 */
export function fieldOrderWith(definitions: CustomFieldDefinition[], ids: number[]): number[] | null {
  const current = sortByPosition(definitions.map((d) => d.id), definitions);
  const queue = ids.filter((id) => current.includes(id));
  const members = new Set(queue);
  const next = current.map((id) => (members.has(id) ? queue.shift()! : id));
  return next.some((id, i) => id !== current[i]) ? next : null;
}

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
