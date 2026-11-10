import { normalizeHex } from "./colorContrast";
import type { BoardFull } from "../types";

/** A color already in use on the board and where it is used, for the custom picker's "On this board" row. */
export interface BoardColor {
  /** Canonical `#RRGGBB`. */
  color: string;
  /** First use, e.g. `column To Do`; the picker's accessible name for the swatch. */
  usedBy: string;
}

/**
 * Colors in use on a board (#2098): columns, then swimlanes, then labels, in
 * board order, deduped on canonical hex and stable across renders so the row
 * does not shuffle. Derived client-side from `BoardFull`; no endpoint.
 * Custom-field choice colors are not included: they are stored as palette keys
 * (`CHOICE_COLOR_KEYS`), never hex, so they cannot be reused as a custom color.
 */
export function boardColorsInUse(
  board: Pick<BoardFull, "columns" | "swimlanes" | "labels">,
): BoardColor[] {
  const seen = new Set<string>();
  const out: BoardColor[] = [];
  const add = (raw: string | null | undefined, usedBy: string) => {
    const color = normalizeHex(raw);
    if (!color || seen.has(color)) return;
    seen.add(color);
    out.push({ color, usedBy });
  };
  for (const c of board.columns) add(c.color, `column ${c.name}`);
  for (const s of board.swimlanes) add(s.color, `swimlane ${s.name}`);
  for (const l of board.labels) add(l.color, `label ${l.name}`);
  return out;
}

/** The in-use colors that are not already a swatch in `presets`. */
export function boardColorsOutsidePalette(
  boardColors: readonly BoardColor[] | undefined,
  presets: readonly string[],
): BoardColor[] {
  if (!boardColors || boardColors.length === 0) return [];
  const preset = new Set(presets.map((p) => normalizeHex(p)));
  return boardColors.filter((b) => !preset.has(normalizeHex(b.color)));
}
