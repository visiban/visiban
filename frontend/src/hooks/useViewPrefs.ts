import { useState, useCallback } from "react";

export interface ViewPrefs {
  hiddenColumnIds: number[];
  hiddenSwimlaneIds: number[];
  // Columns the user has explicitly collapsed. All others are expanded (open by default).
  collapsedColumnIds: number[];
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

export function useViewPrefs(boardId: number) {
  const [prefs, setPrefsState] = useState<ViewPrefs>(() => load(boardId));

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

  const setCardFieldPref = useCallback(
    (field: "hideLabels" | "hideDueDate" | "hideAssignee" | "hidePriority" | "hideLastMoved", value: boolean) => {
      setPrefs((prev) => ({ ...prev, [field]: value }));
    },
    [setPrefs],
  );

  return { prefs, toggleHiddenColumn, toggleCollapsedColumn, expandAllColumns, collapseAllColumns, toggleHiddenSwimlane, setSwimlaneColumnWidth, setColumnWidth, setSwimlaneHeight, setCardFieldPref };
}
