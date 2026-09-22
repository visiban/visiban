import { useCallback, useState } from "react";
import {
  DEFAULT_LENS_SIDEBAR_WIDTH,
  MAX_LENS_COL_WIDTH,
  MAX_LENS_SIDEBAR_WIDTH,
  MIN_LENS_COL_WIDTH,
  MIN_LENS_SIDEBAR_WIDTH,
} from "../components/Board/Lens/lensDims";

export interface LensViewPrefs {
  /** Width of the swimlane-label (sidebar) column, shared by the corner cell
   *  and every swimlane row's label panel. */
  sidebarWidth: number;
  /**
   * Per-column widths, keyed by the pivot-derived column **key** (a string,
   * e.g. "in_review" or "closed") rather than a numeric ID — lens columns
   * are not board Column rows, they're derived from whichever dimension is
   * currently pivoted (#1065). A key absent here uses DEFAULT_LENS_COL_WIDTH.
   */
  columnWidths: Record<string, number>;
}

const DEFAULT_LENS_PREFS: LensViewPrefs = {
  sidebarWidth: DEFAULT_LENS_SIDEBAR_WIDTH,
  columnWidths: {},
};

function storageKey(boardId: number): string {
  return `board:${boardId}:lens-view-prefs`;
}

function load(boardId: number): LensViewPrefs {
  try {
    const raw = localStorage.getItem(storageKey(boardId));
    if (!raw) return DEFAULT_LENS_PREFS;
    const parsed = JSON.parse(raw) as Partial<LensViewPrefs>;
    return {
      sidebarWidth:
        typeof parsed.sidebarWidth === "number" ? parsed.sidebarWidth : DEFAULT_LENS_PREFS.sidebarWidth,
      columnWidths:
        typeof parsed.columnWidths === "object" &&
        parsed.columnWidths !== null &&
        !Array.isArray(parsed.columnWidths)
          ? (parsed.columnWidths as Record<string, number>)
          : {},
    };
  } catch {
    // Malformed JSON (or localStorage unavailable) — fail silently, defaults stand.
    return DEFAULT_LENS_PREFS;
  }
}

function save(boardId: number, prefs: LensViewPrefs): void {
  try {
    localStorage.setItem(storageKey(boardId), JSON.stringify(prefs));
  } catch {
    // localStorage unavailable (e.g. private browsing quota exceeded) — fail silently
  }
}

/**
 * Board-scoped, localStorage-persisted view state for the lens grid's resizable
 * sidebar and columns (#1065). This is deliberately a *separate* store from
 * `useViewPrefs` (the native board's), not an extension of it: the native hook's
 * `columnWidths` is keyed by numeric board Column IDs, while the lens's columns
 * are pivot-derived strings that can change shape entirely when the column
 * dimension is switched (e.g. "status" -> "state"). Reusing one store would mean
 * either overloading the key type or leaking board Column IDs into a view that
 * has none.
 */
export function useLensViewPrefs(boardId: number) {
  const [prefs, setPrefsState] = useState<LensViewPrefs>(() => load(boardId));

  const setPrefs = useCallback(
    (updater: LensViewPrefs | ((prev: LensViewPrefs) => LensViewPrefs)) => {
      setPrefsState((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        save(boardId, next);
        return next;
      });
    },
    [boardId],
  );

  const setSidebarWidth = useCallback(
    (width: number) =>
      setPrefs((prev) => ({
        ...prev,
        sidebarWidth: Math.max(MIN_LENS_SIDEBAR_WIDTH, Math.min(MAX_LENS_SIDEBAR_WIDTH, width)),
      })),
    [setPrefs],
  );

  const setColumnWidth = useCallback(
    (columnKey: string, width: number) =>
      setPrefs((prev) => ({
        ...prev,
        columnWidths: {
          ...prev.columnWidths,
          [columnKey]: Math.max(MIN_LENS_COL_WIDTH, Math.min(MAX_LENS_COL_WIDTH, width)),
        },
      })),
    [setPrefs],
  );

  return { prefs, setSidebarWidth, setColumnWidth };
}
