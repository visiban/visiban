import { useSyncExternalStore } from "react";
import type { BoardPresetId } from "../types";

/**
 * The open board's active preset, published by `useBoardPreset` (in `BoardView`)
 * for the shell-level ⌘K palette (`GlobalCommandPalette`), which sits outside the
 * board view and otherwise has no way to know it (#1146). In memory only.
 */
export interface ActivePresetSnapshot {
  boardId: number;
  activePresetId: BoardPresetId | null;
  modified: boolean;
}

let snapshot: ActivePresetSnapshot | null = null;
const listeners = new Set<() => void>();

export function publishActivePreset(next: ActivePresetSnapshot | null): void {
  if (
    snapshot === next ||
    (snapshot !== null &&
      next !== null &&
      snapshot.boardId === next.boardId &&
      snapshot.activePresetId === next.activePresetId &&
      snapshot.modified === next.modified)
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Synchronous read of the published snapshot (tests probe publish timing with it). */
export function getSnapshot(): ActivePresetSnapshot | null {
  return snapshot;
}

export function useActivePreset(): ActivePresetSnapshot | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether a card renders the pre-#871 ("Classic") face: the text urgency glyphs
 * and the untinted `text-warning` due-soon tone, byte for byte as before #871.
 *
 * The #871 card-face changes are gated out of Classic (#1146: Classic is current
 * behavior byte for byte, pinned by `boardPresetsBoardView.test.tsx`). That test
 * also pins Classic equal to a board with no preset, so "no preset active" and
 * "no board view published one" (a card rendered outside a board) keep the
 * Classic face too; only a non-Classic preset active on the card's own board
 * (`boardId`, when the caller knows it) gets the redesigned face.
 *
 * Reads the store `useBoardPreset` publishes rather than a prop, so the gate does
 * not thread through `SwimlaneRow` / `BoardCell` and CardItem's `arePropsEqual`.
 */
export function useClassicCardFace(boardId?: number): boolean {
  const active = useActivePreset();
  if (!active || active.activePresetId === null || active.activePresetId === "classic") return true;
  return boardId !== undefined && active.boardId !== boardId;
}

/** The window event the palette sends and `BoardView` handles. */
export const PRESET_COMMAND_EVENT = "visiban:preset-command";

export type PresetCommand = { kind: "apply"; presetId: BoardPresetId } | { kind: "reset" };
