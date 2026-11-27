import { useEffect, useId, useRef, useState } from "react";
import type { Board } from "../../types";
import ActiveMark from "../Common/ActiveMark";
import { DEFAULT_PARENT_PLURAL, DEFAULT_PARENT_SINGULAR } from "../../utils/parentItemNames";

interface Props {
  board: Pick<Board, "id" | "parent_name_singular" | "parent_name_plural">;
  /** Board admins only (rendered inside ChildCardsSettings, which is admin-only). */
  onUpdate: (patch: Record<string, unknown>) => void | Promise<unknown>;
}

/** Suggestions only: OSS ships no domain word as a default (#2212: no domain-specific default word ships in OSS). */
const SUGGESTIONS = [
  { singular: "Opportunity", plural: "Opportunities" },
  { singular: "Initiative", plural: "Initiatives" },
  { singular: "Release", plural: "Releases" },
] as const;

const MAX = 24;
const FAILED = "Couldn't save the parent name. Please try again.";

function serverMessage(err: unknown): string {
  const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
  for (const key of ["parent_name_singular", "parent_name_plural", "detail"]) {
    const v = data?.[key];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  }
  return FAILED;
}

/**
 * Board settings > Rules: what this board calls a parent card (#2212).
 *
 * Shown only while "Cards on this board can have children" is on. Both fields start empty (the UI then
 * says "Parent" / "Parents"); each saves on blur when its trimmed value changed, the Rules tab's pattern.
 * A suggestion fills and saves both in one PATCH; activating the pressed one clears both. `aria-pressed`
 * is derived from both fields, never stored.
 */
export default function ParentNameSettings({ board, onUpdate }: Props) {
  const uid = useId();
  const helpId = `${uid}-help`;
  const [singular, setSingular] = useState(board.parent_name_singular ?? "");
  const [plural, setPlural] = useState(board.parent_name_plural ?? "");
  const [error, setError] = useState<string | null>(null);
  const errorId = `${uid}-error`;
  // Saves run one at a time: a later save waits for the earlier one, so a failed earlier save
  // can never roll state back after a later save has started.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const describedBy = error ? `${helpId} ${errorId}` : helpId;

  // A board.updated frame or another tab can change the stored value: follow it.
  useEffect(() => setSingular(board.parent_name_singular ?? ""), [board.parent_name_singular]);
  useEffect(() => setPlural(board.parent_name_plural ?? ""), [board.parent_name_plural]);

  const save = (patch: Record<string, string>, rollback: () => void) => {
    const run = chain.current.then(() => doSave(patch, rollback));
    chain.current = run.catch(() => undefined);
    return run;
  };

  const doSave = async (patch: Record<string, string>, rollback: () => void) => {
    setError(null);
    // useBoard.updateBoardSettings resolves with the error (null on success) rather than rejecting.
    let failure: unknown = null;
    try {
      failure = await onUpdate(patch);
    } catch (err) {
      failure = err ?? new Error("failed");
    }
    if (failure) {
      rollback();
      setError(serverMessage(failure));
    }
  };

  const blur = (field: "parent_name_singular" | "parent_name_plural", value: string, set: (v: string) => void) => {
    const next = value.trim();
    const stored = board[field] ?? "";
    set(next);
    if (next === stored) return;
    void save({ [field]: next }, () => set(stored));
  };

  const choose = (s: (typeof SUGGESTIONS)[number], pressed: boolean) => {
    const prev = { singular: board.parent_name_singular ?? "", plural: board.parent_name_plural ?? "" };
    const next = pressed ? { singular: "", plural: "" } : { singular: s.singular, plural: s.plural };
    setSingular(next.singular);
    setPlural(next.plural);
    void save(
      { parent_name_singular: next.singular, parent_name_plural: next.plural },
      () => { setSingular(prev.singular); setPlural(prev.plural); },
    );
  };

  const inputClass =
    "w-full min-h-11 rounded border border-line bg-surface px-3 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

  return (
    <fieldset className="flex flex-col gap-2 py-1" data-testid="parent-name-settings" aria-describedby={helpId}>
      <legend className="text-sm text-fg-secondary">What do you call a parent card on this board?</legend>
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-singular`} className="text-xs font-medium text-fg-secondary">Singular</label>
          <input
            id={`${uid}-singular`}
            value={singular}
            maxLength={MAX}
            placeholder={DEFAULT_PARENT_SINGULAR}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setSingular(e.target.value)}
            onBlur={(e) => blur("parent_name_singular", e.target.value, setSingular)}
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-plural`} className="text-xs font-medium text-fg-secondary">Plural</label>
          <input
            id={`${uid}-plural`}
            value={plural}
            maxLength={MAX}
            placeholder={DEFAULT_PARENT_PLURAL}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setPlural(e.target.value)}
            onBlur={(e) => blur("parent_name_plural", e.target.value, setPlural)}
            className={inputClass}
          />
        </div>
      </div>
      <div role="group" aria-label="Suggestions" className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => {
          const pressed = singular.trim() === s.singular && plural.trim() === s.plural;
          return (
            <button
              key={s.singular}
              type="button"
              aria-pressed={pressed}
              onClick={() => choose(s, pressed)}
              className={`inline-flex min-h-11 items-center gap-1 rounded border border-line-boundary text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${pressed ? "px-3 bg-primary-emphasis/15 text-fg-secondary" : "px-5 text-fg-tertiary hover:bg-surface-hover"}`}
            >
              {/* Rendered only when pressed: the idle chip holds the check's room (w-3 + gap-1) as
                  symmetric padding (px-5 vs px-3) so the name is centered and the width fixed (#2673). */}
              {pressed && <ActiveMark active testId={`parent-name-mark-${s.singular}`} />}
              {s.singular}
            </button>
          );
        })}
      </div>
      <p id={helpId} className="text-sm text-fg-muted">
        Starts empty, so the board says &ldquo;Parent&rdquo;. Suggestions fill both fields. Any text works, up to 24 characters.
      </p>
      {error && <p id={errorId} role="alert" className="text-sm text-danger" data-testid="parent-name-error">{error}</p>}
    </fieldset>
  );
}
