import { useState, useCallback } from "react";

export interface ViewPrefs {
  hiddenColumnIds: number[];
  hiddenSwimlaneIds: number[];
  // Columns the user has explicitly collapsed. All others are expanded (open by default).
  collapsedColumnIds: number[];
  // Swimlanes the user has explicitly collapsed. Seeded from swimlane.is_collapsed on first load.
  collapsedSwimlaneIds: number[];
  swimlaneColumnWidth: number;
  columnWidths: Record<number, number>;
  swimlaneHeights: Record<number, number>;
  hideLabels: boolean;
  hideDueDate: boolean;
  hideAssignee: boolean;
  hidePriority: boolean;
  hideLastMoved: boolean;
}

const DEFAULT_PREFS: ViewPrefs = {
  hiddenColumnIds: [],
  hiddenSwimlaneIds: [],
  collapsedColumnIds: [],
  collapsedSwimlaneIds: [],
  swimlaneColumnWidth: 220,
  columnWidths: {},
  swimlaneHeights: {},
  hideLabels: false,
  hideDueDate: false,
  hideAssignee: false,
  hidePriority: false,
  hideLastMoved: false,
};

function storageKey(boardId: number): string {
  return `board:${boardId}:view-prefs`;
}

function load(boardId: number): ViewPrefs {
  try {
    const raw = localStorage.getItem(storageKey(boardId));
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ViewPrefs> & { expandedColumnIds?: number[] };
    return {
      hiddenColumnIds: Array.isArray(parsed.hiddenColumnIds) ? parsed.hiddenColumnIds : [],
      hiddenSwimlaneIds: Array.isArray(parsed.hiddenSwimlaneIds) ? parsed.hiddenSwimlaneIds : [],
      collapsedColumnIds: Array.isArray(parsed.collapsedColumnIds) ? parsed.collapsedColumnIds : [],
      collapsedSwimlaneIds: Array.isArray(parsed.collapsedSwimlaneIds) ? parsed.collapsedSwimlaneIds : [],
      swimlaneColumnWidth: typeof parsed.swimlaneColumnWidth === "number" ? parsed.swimlaneColumnWidth : 220,
      columnWidths: (typeof parsed.columnWidths === "object" && parsed.columnWidths !== null && !Array.isArray(parsed.columnWidths)) ? parsed.columnWidths as Record<number, number> : {},
      swimlaneHeights: (typeof parsed.swimlaneHeights === "object" && parsed.swimlaneHeights !== null && !Array.isArray(parsed.swimlaneHeights)) ? parsed.swimlaneHeights as Record<number, number> : {},
      hideLabels: typeof parsed.hideLabels === "boolean" ? parsed.hideLabels : false,
      hideDueDate: typeof parsed.hideDueDate === "boolean" ? parsed.hideDueDate : false,
      hideAssignee: typeof parsed.hideAssignee === "boolean" ? parsed.hideAssignee : false,
      hidePriority: typeof parsed.hidePriority === "boolean" ? parsed.hidePriority : false,
      hideLastMoved: typeof parsed.hideLastMoved === "boolean" ? parsed.hideLastMoved : false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function save(boardId: number, prefs: ViewPrefs): void {
  try {
    localStorage.setItem(storageKey(boardId), JSON.stringify(prefs));
  } catch {
    // localStorage unavailable (e.g. private browsing quota exceeded) — fail silently
  }
}

/**
 * @param validColumnIds  – current column IDs on the board; any stored pref
 *   referencing an ID not in this set is silently dropped (stale localStorage
 *   from a previous database or deleted column).
 * @param validSwimlaneIds – same, for swimlane IDs.
 */
export function useViewPrefs(
  boardId: number,
  validColumnIds?: Set<number>,
  validSwimlaneIds?: Set<number>,
) {
  const [prefs, setPrefsState] = useState<ViewPrefs>(() => {
    const raw = load(boardId);
    if (!validColumnIds && !validSwimlaneIds) return raw;
    // Strip IDs that no longer exist in the board (e.g. stale localStorage
    // from a previous database or deleted columns/swimlanes).
    const pruned = { ...raw };
    if (validColumnIds) {
      pruned.hiddenColumnIds = raw.hiddenColumnIds.filter((id) => validColumnIds.has(id));
      pruned.collapsedColumnIds = raw.collapsedColumnIds.filter((id) => validColumnIds.has(id));
      pruned.columnWidths = Object.fromEntries(
        Object.entries(raw.columnWidths).filter(([id]) => validColumnIds.has(Number(id))),
      );
    }
    if (validSwimlaneIds) {
      pruned.hiddenSwimlaneIds = raw.hiddenSwimlaneIds.filter((id) => validSwimlaneIds.has(id));
      pruned.collapsedSwimlaneIds = raw.collapsedSwimlaneIds.filter((id) => validSwimlaneIds.has(id));
      pruned.swimlaneHeights = Object.fromEntries(
        Object.entries(raw.swimlaneHeights).filter(([id]) => validSwimlaneIds.has(Number(id))),
      );
    }
    // Persist the pruned version so stale IDs don't accumulate.
    if (JSON.stringify(pruned) !== JSON.stringify(raw)) save(boardId, pruned);
    return pruned;
  });

  const setPrefs = useCallback(
    (updater: ViewPrefs | ((prev: ViewPrefs) => ViewPrefs)) => {
      setPrefsState((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        save(boardId, next);
        return next;
      });
    },
    [boardId],
  );

  const toggleHiddenColumn = useCallback(
    (columnId: number) => {
      setPrefs((prev) => {
        const hidden = prev.hiddenColumnIds.includes(columnId)
          ? prev.hiddenColumnIds.filter((id) => id !== columnId)
          : [...prev.hiddenColumnIds, columnId];
        return { ...prev, hiddenColumnIds: hidden };
      });
    },
    [setPrefs],
  );

  const toggleCollapsedColumn = useCallback(
    (columnId: number) => {
      setPrefs((prev) => {
        const collapsed = prev.collapsedColumnIds.includes(columnId)
          ? prev.collapsedColumnIds.filter((id) => id !== columnId)
          : [...prev.collapsedColumnIds, columnId];
        return { ...prev, collapsedColumnIds: collapsed };
      });
    },
    [setPrefs],
  );

  const setSwimlaneColumnWidth = useCallback(
    (width: number) => setPrefs((prev) => ({ ...prev, swimlaneColumnWidth: Math.max(56, Math.min(400, width)) })),
    [setPrefs],
  );

  const setColumnWidth = useCallback(
    (columnId: number, width: number) =>
      setPrefs((prev) => ({
        ...prev,
        columnWidths: { ...prev.columnWidths, [columnId]: Math.max(160, Math.min(600, width)) },
      })),
    [setPrefs],
  );

  const setSwimlaneHeight = useCallback(
    (swimlaneId: number, height: number) =>
      setPrefs((prev) => ({
        ...prev,
        swimlaneHeights: { ...prev.swimlaneHeights, [swimlaneId]: Math.max(48, Math.min(800, height)) },
      })),
    [setPrefs],
  );

  // Expand all: clear the collapsed list so every column reverts to its default (open) state.
  const expandAllColumns = useCallback(
    () => setPrefs((prev) => ({ ...prev, collapsedColumnIds: [] })),
    [setPrefs],
  );

  // Collapse all: mark every current column as explicitly collapsed.
  const collapseAllColumns = useCallback(
    (columnIds: number[]) => setPrefs((prev) => ({ ...prev, collapsedColumnIds: columnIds })),
    [setPrefs],
  );

  const toggleHiddenSwimlane = useCallback(
    (swimlaneId: number) => {
      setPrefs((prev) => {
        const hidden = prev.hiddenSwimlaneIds.includes(swimlaneId)
          ? prev.hiddenSwimlaneIds.filter((id) => id !== swimlaneId)
          : [...prev.hiddenSwimlaneIds, swimlaneId];
        return { ...prev, hiddenSwimlaneIds: hidden };
      });
    },
    [setPrefs],
  );

  const toggleCollapsedSwimlane = useCallback(
    (swimlaneId: number) => {
      setPrefs((prev) => {
        const collapsed = prev.collapsedSwimlaneIds.includes(swimlaneId)
          ? prev.collapsedSwimlaneIds.filter((id) => id !== swimlaneId)
          : [...prev.collapsedSwimlaneIds, swimlaneId];
        return { ...prev, collapsedSwimlaneIds: collapsed };
      });
    },
    [setPrefs],
  );

  // Collapse all swimlanes: mark every swimlane in the provided list as explicitly collapsed.
  const collapseAllSwimlanes = useCallback(
    (swimlaneIds: number[]) => setPrefs((prev) => ({ ...prev, collapsedSwimlaneIds: swimlaneIds })),
    [setPrefs],
  );

  // Expand all swimlanes: clear the collapsed list so every swimlane reverts to its default (open) state.
  const expandAllSwimlanes = useCallback(
    () => setPrefs((prev) => ({ ...prev, collapsedSwimlaneIds: [] })),
    [setPrefs],
  );

  const setCardFieldPref = useCallback(
    (field: "hideLabels" | "hideDueDate" | "hideAssignee" | "hidePriority" | "hideLastMoved", value: boolean) => {
      setPrefs((prev) => ({ ...prev, [field]: value }));
    },
    [setPrefs],
  );

  return { prefs, toggleHiddenColumn, toggleCollapsedColumn, expandAllColumns, collapseAllColumns, toggleHiddenSwimlane, toggleCollapsedSwimlane, collapseAllSwimlanes, expandAllSwimlanes, setSwimlaneColumnWidth, setColumnWidth, setSwimlaneHeight, setCardFieldPref };
}
