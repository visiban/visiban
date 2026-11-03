import type { BoardPresetId, CardDensity } from "../types";
import { NONE_OVERLAY_ID, getGridOverlay, resolveGridOverlayId } from "../gridOverlays/registry";

/**
 * Board presets (#1146): a named bundle of how the board view presents a board —
 * card-face fields, density, grid overlay and default filter.
 *
 * In 1.3 presets are code-defined constants, never authored (#2047 owns authoring,
 * 1.4). Persisted state is ids and the existing keys only: `Board.default_preset` on
 * the server, the `?preset=` link parameter, the two existing per-user keys a preset
 * writes (`board:{id}:card-density-override`, `board:{id}:grid-overlay`), and a
 * per-user marker of which preset wrote them (`board:{id}:preset`, `useBoardPreset`).
 *
 * A preset is presentation state only. It never changes cards, columns or board
 * settings, so applying one is always safe and undoable, and it carries no domain
 * meaning: it names no field, label or business concept (non-goals of #1146).
 */

/**
 * Version of the bundle shape below. The shape becomes a public contract the moment
 * a preset is serialized outside this file (an authored preset in #2047, or a client
 * describing its presentation over the API), so a change to the meaning of any
 * element bumps this number instead of silently re-reading old data.
 */
export const BOARD_PRESET_SCHEMA_VERSION = 1 as const;

export type { BoardPresetId };

export interface BoardPresetBundle {
  /**
   * Card-face fields to pin, by custom-field definition id, in order (at most 2 at
   * rest). `null` = the board's own card-face configuration (`show_on_card`). A
   * preset references definitions by id and never defines one.
   */
  fields: number[] | null;
  /** A density tier, or `null` = follow the board's own `card_density`. */
  density: CardDensity | null;
  /**
   * A grid overlay id (`gridOverlays/registry.ts`). An id this build does not know
   * decays to `none` through `resolveGridOverlayId`, as a stored choice does.
   */
  overlay: string;
  /**
   * A default filter, or `null` = the preset sets none and leaves the filter bar
   * alone. Neither shipped preset sets one; the shape is reserved here so a later
   * version does not have to reinterpret `null`.
   */
  filter: Record<string, unknown> | null;
  /**
   * The board's "attention" choice, referenced by id (#871 urgency ruling).
   * Optional and empty in 1.3; when the attention strip lands it is a preset element.
   */
  attention: number | null;
}

export interface BoardPreset {
  schemaVersion: typeof BOARD_PRESET_SCHEMA_VERSION;
  /** Stable, serialized id. Never rename or remove a shipped id. */
  id: BoardPresetId;
  /** Picker label. Free to be reworded. */
  name: string;
  /** One sentence for Board Settings → Display. Free to be reworded. */
  description: string;
  bundle: BoardPresetBundle;
}

/**
 * Classic: the board exactly as it rendered before presets existed — the board's
 * own density, no overlay, the board's own card-face fields, no filter. It is the
 * escape hatch that keeps #871's redesign from regressing an existing install, so
 * it must stay a no-op bundle (pinned by `boardPresets.test.tsx`'s snapshot).
 */
const CLASSIC: BoardPreset = {
  schemaVersion: BOARD_PRESET_SCHEMA_VERSION,
  id: "classic",
  name: "Classic",
  description: "The board as it looked before presets: the board's own density, no overlay.",
  bundle: { fields: null, density: null, overlay: NONE_OVERLAY_ID, filter: null, attention: null },
};

/**
 * Default: the #871 direction. Its density is Standard, the tier #871 maps its
 * "Default" density to (2026-11-01 ruling); its attention reference ships empty.
 * #871 fills in the rest of the bundle when its card layout lands.
 */
const DEFAULT: BoardPreset = {
  schemaVersion: BOARD_PRESET_SCHEMA_VERSION,
  id: "default",
  name: "Default",
  description: "Standard density, no overlay.",
  bundle: { fields: null, density: "standard", overlay: NONE_OVERLAY_ID, filter: null, attention: null },
};

const PRESETS: readonly BoardPreset[] = [CLASSIC, DEFAULT];

export const BOARD_PRESET_IDS: readonly BoardPresetId[] = PRESETS.map((p) => p.id);

/** All presets in picker order. */
export function listBoardPresets(): readonly BoardPreset[] {
  return PRESETS;
}

/** The preset for an id, or `null` for null, unknown or stale ids. */
export function getBoardPreset(id: string | null | undefined): BoardPreset | null {
  if (!id) return null;
  return PRESETS.find((p) => p.id === id) ?? null;
}

/** What the board view renders for the two elements a 1.3 preset can change. */
export interface PresetDisplay {
  density: CardDensity;
  overlay: string;
}

/** The slice of the board that preset resolution reads. */
export interface PresetBoard {
  card_density: CardDensity;
  default_preset: string | null;
}

/** The two per-user keys, as their hooks hold them: `null` = key absent. */
export interface PresetUserState {
  densityOverride: CardDensity | null;
  localOverlay: string | null;
}

/** What a preset would render on this board. */
export function presetDisplay(preset: BoardPreset, board: PresetBoard): PresetDisplay {
  return {
    density: preset.bundle.density ?? board.card_density,
    overlay: resolveGridOverlayId(preset.bundle.overlay),
  };
}

/**
 * What the board renders, element by element: the user's own key when set, else
 * the board's default preset, else the board itself. Per element, so a member who
 * changes only the overlay keeps the board default preset's density.
 *
 * `?preset=` is not a layer here: opening a preset link *applies* the preset
 * (writes the keys, see `planPresetApply`), which is what makes the URL beat a
 * member's earlier choices and the member's choices beat the board default.
 */
export function effectiveDisplay(board: PresetBoard, user: PresetUserState): PresetDisplay {
  const boardDefault = getBoardPreset(board.default_preset);
  const base: PresetDisplay = boardDefault
    ? presetDisplay(boardDefault, board)
    : { density: board.card_density, overlay: NONE_OVERLAY_ID };
  return {
    density: user.densityOverride ?? base.density,
    overlay: user.localOverlay !== null ? resolveGridOverlayId(user.localOverlay) : base.overlay,
  };
}

/** How applying a preset writes the per-user keys: `null` removes a key. */
export interface PresetApplyPlan {
  densityOverride: CardDensity | null;
  localOverlay: string | null;
}

export function planPresetApply(preset: BoardPreset, board: PresetBoard): PresetApplyPlan {
  // Choosing the board's own default clears both keys, so the member follows the
  // board default again, including when an admin later changes it.
  if (preset.id === board.default_preset) return { densityOverride: null, localOverlay: null };
  const boardDefault = getBoardPreset(board.default_preset);
  // A null density means "the board's own card_density". Removing the key says
  // that only when no board default preset sits under it; otherwise the board
  // default's density would show through, so the board's value is written.
  const densityOverride =
    preset.bundle.density ?? (boardDefault?.bundle.density != null ? board.card_density : null);
  return { densityOverride, localOverlay: resolveGridOverlayId(preset.bundle.overlay) };
}

export type PresetElement = "density" | "overlay";

export interface PresetDifference {
  element: PresetElement;
  /** Display values, e.g. `"Dense"`, `"Card count"`. */
  current: string;
  preset: string;
}

const DENSITY_LABEL: Record<CardDensity, string> = {
  comfortable: "Comfortable",
  standard: "Standard",
  dense: "Dense",
};

export function densityLabel(density: CardDensity): string {
  return DENSITY_LABEL[density] ?? density;
}

export function overlayLabel(overlayId: string): string {
  if (overlayId === NONE_OVERLAY_ID) return "No overlay";
  return getGridOverlay(overlayId)?.label ?? "No overlay";
}

/** What differs between the board as rendered and the preset. Empty = not modified. */
export function presetDifferences(
  preset: BoardPreset,
  board: PresetBoard,
  current: PresetDisplay,
): PresetDifference[] {
  const target = presetDisplay(preset, board);
  const diffs: PresetDifference[] = [];
  if (current.density !== target.density) {
    diffs.push({ element: "density", current: densityLabel(current.density), preset: densityLabel(target.density) });
  }
  if (current.overlay !== target.overlay) {
    diffs.push({ element: "overlay", current: overlayLabel(current.overlay), preset: overlayLabel(target.overlay) });
  }
  return diffs;
}

/** One line for the picker menu: `Density: Dense (preset: Standard)`. */
export function formatPresetDifference(diff: PresetDifference): string {
  const name = diff.element === "density" ? "Density" : "Overlay";
  return `${name}: ${diff.current} (preset: ${diff.preset})`;
}

/**
 * Which preset is active: the one this member actually applied (recorded by the
 * per-user marker the apply writes, `board:{id}:preset`, see `useBoardPreset`),
 * else the board's default preset, else none.
 *
 * Never inferred from the density and overlay keys themselves: those predate
 * presets (#974, #1147), so a member's own 1.2 "Standard" density or a stored
 * `none` overlay is the member's setting, not a preset, even when the values
 * happen to match one. With a board default, the member's own keys show it as
 * modified where they differ.
 */
export function resolveActivePresetId(board: PresetBoard, appliedPresetId: string | null): BoardPresetId | null {
  return getBoardPreset(appliedPresetId)?.id ?? getBoardPreset(board.default_preset)?.id ?? null;
}

/** One-line picker summary: `Standard density · No overlay`. */
export function presetSummary(preset: BoardPreset): string {
  const density = preset.bundle.density === null ? "Board density" : `${densityLabel(preset.bundle.density)} density`;
  return `${density} · ${overlayLabel(resolveGridOverlayId(preset.bundle.overlay))}`;
}

/** A `?preset=` value this build can apply, or `null`. */
export function parsePresetParam(raw: string | null): BoardPresetId | null {
  return getBoardPreset(raw)?.id ?? null;
}
