import React from "react";
import type { SavedFilter } from "../../types";

interface Props {
  savedFilters: SavedFilter[];
  /** id of currently-applied saved filter preset, or null when no preset is active */
  activeFilterId: number | null;
  onLoad: (saved: SavedFilter) => void;
  /** Called when the user clicks the "All" pill — parent should clear all filter dimensions */
  onClearAll: () => void;
  /** Called when the user clicks "+ Save current" — parent opens the save flow */
  onSaveCurrentClick: () => void;
  /** true when any filter dimension is non-empty (determines pill highlight and save affordance) */
  hasActiveFilters: boolean;
}

const activeClass = "bg-blue-600 text-white font-medium px-2.5 py-1 rounded";
const inactiveClass =
  "text-slate-400 hover:text-slate-200 px-2.5 py-1 rounded hover:bg-slate-700 transition";

/**
 * A compact row of tab pills that gives one-click access to saved filter presets,
 * living above the filter chip row. The SavedFiltersDropdown remains the canonical
 * affordance for save/delete operations; this component is purely a quick-load
 * complement.
 *
 * Only rendered when savedFilters.length > 0 — the parent may guard on that
 * condition, but this component also returns null when the list is empty so it is
 * safe to render unconditionally.
 */
export default function SavedFilterTabs({
  savedFilters,
  activeFilterId,
  onLoad,
  onClearAll,
  onSaveCurrentClick,
  hasActiveFilters,
}: Props) {
  if (savedFilters.length === 0) return null;

  // "All" is active when no preset is loaded and no filter dimensions are non-empty.
  const allIsActive = activeFilterId === null && !hasActiveFilters;

  // Show "+ Save current" when filters are active but not yet saved as a preset.
  const showSaveCurrent = hasActiveFilters && activeFilterId === null;

  return (
    <div
      role="tablist"
      aria-label="Saved filter presets"
      className="flex items-center gap-1 flex-wrap text-xs"
    >
      {/* "All" pill — clears every filter dimension */}
      <button
        role="tab"
        aria-selected={allIsActive}
        onClick={onClearAll}
        className={allIsActive ? activeClass : inactiveClass}
      >
        All
      </button>

      {/* One pill per saved filter */}
      {savedFilters.map((f) => {
        const isActive = f.id === activeFilterId;
        return (
          <button
            key={f.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onLoad(f)}
            title={f.name}
            className={`${isActive ? activeClass : inactiveClass} max-w-[10rem] truncate`}
          >
            {f.name}
          </button>
        );
      })}

      {/* Shown only when the user has active unsaved filters */}
      {showSaveCurrent && (
        <button
          onClick={onSaveCurrentClick}
          className="text-slate-500 hover:text-slate-300 px-2.5 py-1 rounded hover:bg-slate-700 transition"
        >
          + Save current
        </button>
      )}
    </div>
  );
}
