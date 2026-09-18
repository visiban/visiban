import { useEffect, useState } from "react";
import CheckboxDropdown from "../../Common/CheckboxDropdown";
import SingleSelectDropdown from "../../Common/SingleSelectDropdown";
import { LENS_NONE, MAX_LENS_LABELS } from "./lensDims";

export type LensState = "all" | "open" | "closed";

interface Props {
  state: LensState;
  /** Milestone title, the `__none__` sentinel, or "" for all. Free text — see note below. */
  milestone: string;
  /** AND-ed label names (server-side). */
  labels: string[];
  /** Single assignee username, or "" for all (server-side). */
  assignee: string;
  /** Client-side text filter over title/number. */
  q: string;
  /** Autocomplete suggestions, derived from the fetched issues. */
  availableMilestones: string[];
  availableLabels: string[];
  availableAssignees: string[];
  activeCount: number;
  onStateChange: (s: LensState) => void;
  onMilestoneChange: (m: string) => void;
  onLabelsChange: (l: string[]) => void;
  onAssigneeChange: (a: string) => void;
  onQChange: (q: string) => void;
  onClear: () => void;
}

const STATE_OPTIONS = [
  { value: "all", label: "State: All" },
  { value: "open", label: "State: Open" },
  { value: "closed", label: "State: Closed" },
];

/**
 * The display spelling of the `__none__` milestone sentinel. The milestone control
 * is a free-text combobox, so the sentinel needs a human-readable face — typing
 * `__none__` is not a discoverable way to ask for "issues with no milestone".
 * Matches the label the backend already puts on the synthetic "(no milestone)"
 * swimlane, so the filter and the lane read as the same concept.
 */
const NO_MILESTONE_LABEL = "(no milestone)";

const milestoneToInput = (m: string) => (m === LENS_NONE ? NO_MILESTONE_LABEL : m);
const milestoneFromInput = (v: string) =>
  v.trim() === NO_MILESTONE_LABEL ? LENS_NONE : v;

/**
 * Read-only lens filter row — State, Milestone, Label and Assignee (all
 * server-side) plus a client-side text filter. Sits below the lens toolbar, above
 * the provenance banner. Forked from the native FilterBar styling per the lens
 * "forked, not parameterized" rule.
 *
 * Milestone and Assignee are free-text comboboxes rather than dropdowns because
 * the GitLab/GitHub list endpoints for them require auth even on public repos — but
 * both filters accept any typed value server-side, so a value outside the fetched
 * window can still be scoped to, which is the entire point of filtering them
 * server-side. Label is a real multi-select because labels are an AND set, capped
 * at MAX_LENS_LABELS to match the server.
 */
export default function LensFilterBar({
  state,
  milestone,
  labels,
  assignee,
  q,
  availableMilestones,
  availableLabels,
  availableAssignees,
  activeCount,
  onStateChange,
  onMilestoneChange,
  onLabelsChange,
  onAssigneeChange,
  onQChange,
  onClear,
}: Props) {
  // Milestone and assignee are server-side filters (refetch), so debounce the
  // typed value — committing per keystroke would fire a fetch (and mint a distinct
  // cache key) for every partial value. Selecting a datalist suggestion or typing
  // both flow through here; external changes (Clear, a shared URL) sync back in.
  const [mInput, setMInput] = useState(() => milestoneToInput(milestone));
  useEffect(() => {
    setMInput(milestoneToInput(milestone));
  }, [milestone]);
  useEffect(() => {
    const next = milestoneFromInput(mInput);
    if (next === milestone) return;
    const t = setTimeout(() => onMilestoneChange(next), 400);
    return () => clearTimeout(t);
  }, [mInput, milestone, onMilestoneChange]);

  const [aInput, setAInput] = useState(assignee);
  useEffect(() => {
    setAInput(assignee);
  }, [assignee]);
  useEffect(() => {
    if (aInput === assignee) return;
    const t = setTimeout(() => onAssigneeChange(aInput), 400);
    return () => clearTimeout(t);
  }, [aInput, assignee, onAssigneeChange]);

  const atLabelCap = labels.length >= MAX_LENS_LABELS;
  const labelOptions = availableLabels.map((name) => ({ value: name, label: name }));

  /**
   * Enforce the label cap HERE, where the user clicks — never downstream.
   *
   * `serializeLensLabels` sorts and slices to MAX_LENS_LABELS, which is the right
   * behavior for a hand-edited URL but the wrong one for a click: at the cap it
   * drops whichever label sorts last, which is routinely a label the user never
   * touched, and the click looks like it succeeded. Refusing the addition instead
   * makes the cap honest — the checkbox visibly stays unchecked and nothing else
   * moves. Deselection is always allowed, so the control is never a dead end.
   */
  const handleLabelsChange = (next: string[]) => {
    if (next.length > labels.length && atLabelCap) return;
    onLabelsChange(next);
  };

  /** Escape clears a free-text filter and drops focus — parity across all three
   *  text inputs in this row, which a keyboard user reasonably expects. */
  const clearOnEscape = (reset: () => void) => (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    reset();
    (e.target as HTMLInputElement).blur();
  };

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
        onKeyDown={clearOnEscape(() => setMInput(""))}
        placeholder="Milestone…"
        aria-label="Filter by milestone"
        className={`bg-surface border rounded px-2 py-1 text-sm w-40 placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent ${
          mInput ? "border-primary-soft text-info" : "border-line text-fg-secondary"
        }`}
      />
      <datalist id="lens-milestone-options">
        {/* The sentinel leads the list: "no milestone" is a first-class choice,
            not something to be discovered after the real titles. */}
        <option value={NO_MILESTONE_LABEL} />
        {availableMilestones.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <CheckboxDropdown
        label="Label"
        options={labelOptions}
        selected={labels}
        onChange={handleLabelsChange}
      />
      {/* Live region, not a bare hint: the cap makes further clicks do nothing, so
          a screen-reader user has to be told it was reached. It appears the moment
          the cap is hit (empty -> text is what triggers the announcement), before
          the first refused click rather than after it. */}
      <span role="status" className="text-xs text-fg-muted">
        {atLabelCap ? `max ${MAX_LENS_LABELS} labels` : ""}
      </span>

      <input
        list="lens-assignee-options"
        type="text"
        value={aInput}
        onChange={(e) => setAInput(e.target.value)}
        onKeyDown={clearOnEscape(() => setAInput(""))}
        placeholder="Assignee…"
        aria-label="Filter by assignee"
        className={`bg-surface border rounded px-2 py-1 text-sm w-36 placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent ${
          aInput ? "border-primary-soft text-info" : "border-line text-fg-secondary"
        }`}
      />
      <datalist id="lens-assignee-options">
        {availableAssignees.map((a) => (
          <option key={a} value={a} />
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
