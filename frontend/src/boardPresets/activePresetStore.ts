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

function getSnapshot(): ActivePresetSnapshot | null {
  return snapshot;
}

export function useActivePreset(): ActivePresetSnapshot | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The window event the palette sends and `BoardView` handles. */
export const PRESET_COMMAND_EVENT = "visiban:preset-command";

export type PresetCommand = { kind: "apply"; presetId: BoardPresetId } | { kind: "reset" };
