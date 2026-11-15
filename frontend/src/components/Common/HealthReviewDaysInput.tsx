import { useEffect, useId, useRef, useState } from "react";
import { isImeComposing } from "../../utils/imeComposition";

export const HEALTH_REVIEW_DAYS_MAX = 365;

interface Props {
  /** The stored `health_review_days`: 1-365, or null for off. */
  value: number | null;
  /** Persist the new value (null = off). Reject to show the error and restore the stored value. */
  onSave: (next: number | null) => Promise<void>;
  /** "board" or "group": only changes the hint's wording. */
  entityKind: "board" | "group";
  disabled?: boolean;
}

/** `""` → null (off); a whole number 1..365 → it; anything else → undefined (invalid). */
export function parseHealthReviewDays(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n >= 1 && n <= HEALTH_REVIEW_DAYS_MAX ? n : undefined;
}

/**
 * "Review status every N days" (#2244) for a board's or group's settings.
 * Empty means off. Saves on blur or Enter, like the stale-card threshold next
 * to it; an invalid entry is never sent and shows an inline error instead.
 */
export default function HealthReviewDaysInput({ value, onSave, entityKind, disabled = false }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const focused = useRef(false);

  // A remote change (board.updated / group.updated) reaches the input unless
  // the user is typing in it.
  useEffect(() => {
    if (!focused.current) setDraft(value === null ? "" : String(value));
  }, [value]);

  const commit = async () => {
    const next = parseHealthReviewDays(draft);
    if (next === undefined) {
      setError(`Enter a whole number from 1 to ${HEALTH_REVIEW_DAYS_MAX}, or leave it empty to turn it off.`);
      setSaved(false);
      return;
    }
    setError(null);
    if (next === value) return;
    try {
      await onSave(next);
      setSaved(true);
    } catch {
      setDraft(value === null ? "" : String(value));
      setSaved(false);
      setError("Failed to save the review setting. Please try again.");
    }
  };

  const hint = entityKind === "group"
    ? "Shows “Not reviewed in N days” once the status is older than this, here and on the subgroups and boards that inherit it. Empty turns it off."
    : "Shows “Not reviewed in N days” once the board’s own status is older than this. An inherited status follows its group’s setting. Empty turns it off.";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm text-fg-tertiary">Review status every</label>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={HEALTH_REVIEW_DAYS_MAX}
          placeholder="Off"
          value={draft}
          disabled={disabled}
          aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
          aria-invalid={error ? true : undefined}
          onFocus={() => { focused.current = true; }}
          onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
          onBlur={() => { focused.current = false; void commit(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isImeComposing(e)) { e.preventDefault(); void commit(); }
          }}
          className="bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 w-20 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent disabled:opacity-40"
        />
        <span className="text-sm text-fg-tertiary">days</span>
        <span role="status" className="text-success text-xs">{saved && !error ? "Saved" : ""}</span>
      </div>
      <p id={`${id}-hint`} className="text-xs text-fg-muted">{hint}</p>
      <p className="text-xs min-h-4">
        {error && <span id={`${id}-error`} role="alert" className="text-danger">{error}</span>}
      </p>
    </div>
  );
}
