import { useId, useRef, useState } from "react";
import type { ColumnPolicyMode } from "../../types";
import { POLICY_CRITERION_MAX_LENGTH, POLICY_MAX_CRITERIA } from "../../utils/columnPolicy";

/** One editable criterion. `key` is a client-only stable id for React and focus. */
export interface CriterionDraft {
  key: number;
  text: string;
}

interface ListProps {
  /** "entry" | "done" — used in accessible names ("Entry criterion 2"). */
  kind: "entry" | "done";
  legend: string;
  items: CriterionDraft[];
  onChange: (items: CriterionDraft[]) => void;
  nextKey: () => number;
  onAnnounce: (message: string) => void;
  /** Id of helper text that belongs to this list, if any. */
  describedBy?: string;
}

const ICON_BASE =
  "w-7 h-7 shrink-0 flex items-center justify-center rounded text-fg-tertiary hover:bg-surface-hover transition focus:outline-none focus:ring-2 aria-disabled:opacity-40 aria-disabled:cursor-not-allowed";
const ICON_BUTTON = `${ICON_BASE} hover:text-fg focus:ring-primary-emphasis`;
const ICON_BUTTON_DANGER = `${ICON_BASE} hover:text-danger focus:ring-danger-emphasis`;

/**
 * One reorderable criteria list (#1101): up to eight one-line criteria with
 * Move up / Move down / Remove per row and "+ Add criterion" below.
 *
 * Reordering uses buttons, not drag, so it works from the keyboard and inside
 * the modal's focus trap. The move buttons at the ends are `aria-disabled`
 * rather than `disabled`: a moved row's button keeps focus when it reaches
 * the top or bottom instead of dropping focus to the body.
 */
function CriteriaList({ kind, legend, items, onChange, nextKey, onAnnounce, describedBy }: ListProps) {
  const listId = useId();
  const capId = `${listId}-cap`;
  const inputRefs = useRef(new Map<number, HTMLInputElement>());
  const addRef = useRef<HTMLButtonElement>(null);
  const noun = kind === "entry" ? "Entry criterion" : "Done criterion";
  const atCap = items.length >= POLICY_MAX_CRITERIA;

  const focusInput = (key: number) => {
    // After React commits the new row.
    requestAnimationFrame(() => inputRefs.current.get(key)?.focus());
  };

  const add = () => {
    if (atCap) return;
    const key = nextKey();
    onChange([...items, { key, text: "" }]);
    focusInput(key);
  };

  const remove = (index: number) => {
    const next = items.filter((_, i) => i !== index);
    onChange(next);
    onAnnounce(`${noun} ${index + 1} removed.`);
    // Focus the row that took its place, else the one above, else Add.
    const target = next[index] ?? next[index - 1];
    if (target) focusInput(target.key);
    else requestAnimationFrame(() => addRef.current?.focus());
  };

  const move = (index: number, delta: -1 | 1) => {
    const to = index + delta;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
    onAnnounce(`${noun} moved to position ${to + 1} of ${items.length}.`);
  };

  return (
    <fieldset className="flex flex-col gap-1.5" aria-describedby={describedBy}>
      <legend className="text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5">{legend}</legend>
      {items.length === 0 ? (
        <p className="text-xs text-fg-tertiary italic">No criteria yet.</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {items.map((item, i) => {
            const n = i + 1;
            const first = i === 0;
            const last = i === items.length - 1;
            return (
              <li key={item.key} className="flex items-center gap-1">
                <span aria-hidden="true" className="w-4 shrink-0 text-xs text-fg-tertiary text-right tabular-nums">{n}.</span>
                <input
                  ref={(el) => {
                    if (el) inputRefs.current.set(item.key, el);
                    else inputRefs.current.delete(item.key);
                  }}
                  value={item.text}
                  maxLength={POLICY_CRITERION_MAX_LENGTH}
                  aria-label={`${noun} ${n}`}
                  onChange={(e) => onChange(items.map((it) => (it.key === item.key ? { ...it, text: e.target.value } : it)))}
                  className="flex-1 min-w-0 bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                />
                <button
                  type="button"
                  aria-label={`Move ${noun.toLowerCase()} ${n} up`}
                  aria-disabled={first || undefined}
                  onClick={() => move(i, -1)}
                  className={ICON_BUTTON}
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  aria-label={`Move ${noun.toLowerCase()} ${n} down`}
                  aria-disabled={last || undefined}
                  onClick={() => move(i, 1)}
                  className={ICON_BUTTON}
                >
                  <span aria-hidden="true">↓</span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${noun.toLowerCase()} ${n}`}
                  onClick={() => remove(i)}
                  className={ICON_BUTTON_DANGER}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex items-center gap-3">
        <button
          ref={addRef}
          type="button"
          onClick={atCap ? undefined : add}
          aria-disabled={atCap || undefined}
          aria-describedby={atCap ? capId : undefined}
          // Begins with the visible text (WCAG 2.5.3 label in name) and
          // names the list, since both lists have this button.
          aria-label={`Add criterion to ${legend}`}
          className="self-start text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
        >
          + Add criterion
        </button>
        {atCap && (
          <p id={capId} className="text-xs text-fg-tertiary">Up to {POLICY_MAX_CRITERIA} criteria per list.</p>
        )}
      </div>
    </fieldset>
  );
}

interface Props {
  entry: CriterionDraft[];
  done: CriterionDraft[];
  mode: ColumnPolicyMode;
  onEntryChange: (items: CriterionDraft[]) => void;
  onDoneChange: (items: CriterionDraft[]) => void;
  onModeChange: (mode: ColumnPolicyMode) => void;
  nextKey: () => number;
}

const MODE_OPTIONS: { value: ColumnPolicyMode; label: string; description: string }[] = [
  {
    value: "advisory",
    label: "Show the criteria",
    description: "Entry criteria appear in the column header and while a card is dragged over the column.",
  },
  {
    value: "confirm",
    label: "Ask the mover to confirm",
    description: "After a drop, the mover checks off each entry criterion before the card moves in.",
  },
];

/** The Policy tab of EditColumnModal (#1101). Controlled; the modal owns Save. */
export default function ColumnPolicyEditor({
  entry, done, mode, onEntryChange, onDoneChange, onModeChange, nextKey,
}: Props) {
  const [announcement, setAnnouncement] = useState("");
  const radioName = useId();
  const doneHelpId = useId();
  return (
    <div className="flex flex-col gap-5">
      <CriteriaList
        kind="entry"
        legend="Entry criteria"
        items={entry}
        onChange={onEntryChange}
        nextKey={nextKey}
        onAnnounce={setAnnouncement}
      />
      <div className="flex flex-col gap-1.5">
        <CriteriaList
          kind="done"
          legend="Definition of done"
          items={done}
          onChange={onDoneChange}
          nextKey={nextKey}
          onAnnounce={setAnnouncement}
          describedBy={doneHelpId}
        />
        <p id={doneHelpId} className="text-xs text-fg-tertiary">
          Definition of done shows as a read-only list in card detail. It never blocks moving out.
        </p>
      </div>
      <fieldset>
        <legend className="text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-2">When a card enters</legend>
        <div className="flex flex-col gap-2">
          {MODE_OPTIONS.map(({ value, label, description }) => (
            <label
              key={value}
              className={`flex flex-col px-3 py-2 border rounded-lg cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-emphasis ${
                mode === value ? "border-primary-emphasis bg-primary-emphasis/10" : "border-line-strong hover:bg-surface-hover/40"
              }`}
            >
              <input
                type="radio"
                name={radioName}
                value={value}
                checked={mode === value}
                onChange={() => onModeChange(value)}
                className="sr-only"
              />
              <span className="text-sm text-fg font-medium">{label}</span>
              <span className="text-xs text-fg-tertiary mt-0.5">{description}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>
    </div>
  );
}
