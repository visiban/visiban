import { useEffect, useRef, useState } from "react";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { FilterState } from "./FilterBar";
import { countActiveFilters } from "./FilterBar";
import type { SavedFilter } from "../../types";

interface Props {
  boardId: number;
  filters: FilterState;
  savedFilters: SavedFilter[];
  loading: boolean;
  /** Called with the selected SavedFilter; the parent is responsible for hydrating it into FilterState. */
  onLoad: (saved: SavedFilter) => void;
  onSave: (name: string) => Promise<{ error?: string }>;
  onDelete: (filterId: number) => void;
}

/**
 * A dropdown button in the filter bar that exposes three affordances:
 *   1. Load a previously saved filter preset in one click.
 *   2. Save the current filter state under a new name.
 *   3. Delete an existing saved filter.
 *
 * The component is intentionally small and self-contained — it owns only the
 * popover UI; all API state lives in useSavedFilters and is passed via props.
 */
export default function SavedFiltersDropdown({
  filters,
  savedFilters,
  loading,
  onLoad,
  onSave,
  onDelete,
}: Props) {
  const [open, setOpen] = useState(false);
  const [saveMode, setSaveMode] = useState(false);
  const [newName, setNewName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useDropdownEscape(open, () => { setOpen(false); setSaveMode(false); }, triggerRef);

  // Priority 27 — above useDropdownEscape (25) so save mode cancels first, keeping
  // the dropdown open. A second Escape then closes the dropdown via priority 25.
  useEscapeStack(() => {
    if (!saveMode) return false;
    setSaveMode(false);
    setSaveError(null);
  }, 27);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSaveMode(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus the name input whenever save mode is entered.
  useEffect(() => {
    if (saveMode && inputRef.current) {
      inputRef.current.focus();
    }
  }, [saveMode]);

  const hasActiveFilters = countActiveFilters(filters) > 0;

  function handleToggle() {
    if (open) {
      setOpen(false);
      setSaveMode(false);
    } else {
      setSaveMode(false);
      setSaveError(null);
      setNewName("");
      setOpen(true);
    }
  }

  async function handleSave() {
    const trimmed = newName.trim();
    if (!trimmed) {
      setSaveError("Filter name is required.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    const result = await onSave(trimmed);
    setSaving(false);
    if (result.error) {
      setSaveError(result.error);
    } else {
      setNewName("");
      setSaveMode(false);
      setOpen(false);
    }
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={triggerRef}
        onClick={handleToggle}
        title="Saved filters"
        aria-label="Saved filters"
        className={`bg-slate-800 border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-900 ${
          savedFilters.length > 0
            ? "border-slate-600 text-slate-300 hover:border-slate-400"
            : "border-slate-600 text-slate-500 hover:border-slate-400"
        }`}
      >
        {/* Bookmark icon */}
        <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 2h10v12l-5-3-5 3V2z" />
        </svg>
        <span className="text-xs">Saved</span>
        {savedFilters.length > 0 && (
          <span className="bg-blue-500/20 text-blue-400 rounded-full px-1.5 py-0.5 text-xs leading-none">
            {savedFilters.length}
          </span>
        )}
        <svg className="w-3 h-3 text-slate-500" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
        </svg>
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-lg py-1 w-64">
          {/* Save current filter section */}
          {saveMode ? (
            <div className="px-3 py-2">
              <p className="text-xs text-slate-400 mb-1.5">Save current filters as:</p>
              <input
                ref={inputRef}
                type="text"
                value={newName}
                onChange={(e) => { setNewName(e.target.value); setSaveError(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void handleSave(); }
                  // Escape is handled by useEscapeStack at priority 27 (exits save mode)
                  // followed by priority 25 (closes dropdown) on a second press.
                }}
                placeholder="Filter name…"
                maxLength={100}
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-300 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              {/* Reserve vertical space for error so the panel height is stable */}
              <p className="text-xs h-4 mt-1">
                {saveError && <span className="text-red-400">{saveError}</span>}
              </p>
              <div className="flex gap-2 mt-1">
                <button
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-sm rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40 transition"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => { setSaveMode(false); setSaveError(null); }}
                  className="text-slate-300 hover:text-white hover:bg-slate-700 px-3 py-1.5 text-sm rounded focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div>
              <button
                onClick={() => { if (hasActiveFilters) { setSaveMode(true); setSaveError(null); setNewName(""); } }}
                disabled={!hasActiveFilters}
                className={`w-full text-left px-3 py-1.5 text-sm transition flex items-center gap-2 ${
                  hasActiveFilters
                    ? "text-slate-300 hover:bg-slate-700 hover:text-white"
                    : "text-slate-600 cursor-not-allowed"
                }`}
                title={hasActiveFilters ? undefined : "Set at least one filter to save it"}
              >
                <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v10M3 8l5-5 5 5" />
                </svg>
                Save current filters…
              </button>

              {savedFilters.length > 0 && (
                <div role="separator" className="mx-4 my-0.5">
                  <div className="h-px bg-slate-900" />
                  <div className="h-px bg-slate-600/50" />
                </div>
              )}
            </div>
          )}

          {/* Saved filter list */}
          {!saveMode && (
            <>
              {loading && (
                <p className="px-3 py-2 text-xs text-slate-500 italic">Loading…</p>
              )}
              {!loading && savedFilters.length === 0 && (
                <p className="px-3 py-2 text-xs text-slate-500 italic">No saved filters yet.</p>
              )}
              {!loading && savedFilters.map((f, i) => (
                <div key={f.id}>
                  {i > 0 && (
                    <div role="separator" className="mx-4">
                      <div className="h-px bg-slate-900" />
                      <div className="h-px bg-slate-600/50" />
                    </div>
                  )}
                  <div className="flex items-center group px-1">
                    <button
                      onClick={() => { onLoad(f); setOpen(false); setSaveMode(false); }}
                      className="flex-1 text-left px-2 py-1.5 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded transition truncate"
                      title={f.name}
                    >
                      {f.name}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(f.id); }}
                      aria-label={`Delete saved filter "${f.name}"`}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 text-slate-500 hover:text-red-400 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M3 3l10 10M13 3L3 13" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
