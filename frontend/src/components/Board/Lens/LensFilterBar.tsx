import { useEffect, useState } from "react";
import SingleSelectDropdown from "../../Common/SingleSelectDropdown";

export type LensState = "all" | "open" | "closed";

interface Props {
  state: LensState;
  /** Milestone title, or "" for all. Free text — see note below. */
  milestone: string;
  /** Client-side text filter over title/number. */
  q: string;
  /** Autocomplete suggestions, derived from the fetched issues. */
  availableMilestones: string[];
  activeCount: number;
  onStateChange: (s: LensState) => void;
  onMilestoneChange: (m: string) => void;
  onQChange: (q: string) => void;
  onClear: () => void;
}

const STATE_OPTIONS = [
  { value: "all", label: "State: All" },
  { value: "open", label: "State: Open" },
  { value: "closed", label: "State: Closed" },
];

/**
 * Read-only lens filter row — State (server-side), Milestone (server-side), and
 * a client-side text filter. Sits below the lens toolbar, above the provenance
 * banner. Forked from the native FilterBar styling per the lens "forked, not
 * parameterized" rule; the milestone control is a free-text combobox rather than
 * a dropdown because the GitLab/GitHub milestones-LIST endpoints require auth even
 * for public repos — but the filter itself accepts any typed value server-side, so
 * a milestone outside the fetched window can still be scoped to.
 */
export default function LensFilterBar({
  state,
  milestone,
  q,
  availableMilestones,
  activeCount,
  onStateChange,
  onMilestoneChange,
  onQChange,
  onClear,
}: Props) {
  // Milestone is a server-side filter (refetch), so debounce the typed value —
  // committing per keystroke would fire a fetch (and a distinct cache key) for
  // every partial milestone. Selecting a datalist suggestion or typing both flow
  // through here; external changes (Clear, a shared URL) sync back in.
  const [mInput, setMInput] = useState(milestone);
  useEffect(() => {
    setMInput(milestone);
  }, [milestone]);
  useEffect(() => {
    if (mInput === milestone) return;
    const t = setTimeout(() => onMilestoneChange(mInput), 400);
    return () => clearTimeout(t);
  }, [mInput, milestone, onMilestoneChange]);

  return (
    <div
      role="search"
      aria-label="Lens filters"
      className="shrink-0 bg-surface border-b border-line flex items-center gap-2 px-3 py-1.5 flex-wrap"
    >
      <SingleSelectDropdown
        label="State: All"
        options={STATE_OPTIONS}
        selected={state === "all" ? null : state}
        onChange={(v) => onStateChange((v as LensState) ?? "all")}
      />

      <input
        list="lens-milestone-options"
        type="text"
        value={mInput}
        onChange={(e) => setMInput(e.target.value)}
        placeholder="Milestone…"
        aria-label="Filter by milestone"
        className={`bg-surface border rounded px-2 py-1 text-sm w-40 placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent ${
          mInput ? "border-primary-soft text-info" : "border-line text-fg-secondary"
        }`}
      />
      <datalist id="lens-milestone-options">
        {availableMilestones.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <input
        type="text"
        value={q}
        onChange={(e) => onQChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onQChange("");
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Filter by title or #number…"
        aria-label="Filter issues by title or number"
        className="bg-surface border border-line rounded px-2 py-1 text-sm text-fg-secondary placeholder-fg-muted w-44 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
      />

      {activeCount > 0 && (
        <span className="text-xs text-fg-muted flex items-center gap-1.5">
          {activeCount} filter{activeCount !== 1 ? "s" : ""} ·
          <button
            type="button"
            onClick={onClear}
            className="text-info hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Clear
          </button>
        </span>
      )}
    </div>
  );
}
