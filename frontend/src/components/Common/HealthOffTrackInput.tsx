import { useEffect, useId, useRef, useState } from "react";
import { isImeComposing } from "../../utils/imeComposition";

export const HEALTH_OFF_TRACK_MAX = 1000;

interface Props {
  /** The stored `health_off_track_cards`: an absolute count, 1-1000 (#2245). */
  value: number;
  /** Persist the new value. Reject to show the error and restore the stored value. */
  onSave: (next: number) => Promise<void>;
  /** Auto health is off: shown, but not editable, with a hint saying why. */
  disabled?: boolean;
}

/** A whole number 1..1000 → it; anything else (incl. blank) → undefined (invalid). */
export function parseHealthOffTrack(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n >= 1 && n <= HEALTH_OFF_TRACK_MAX ? n : undefined;
}

/**
 * "Off track at N flagged cards" (#2245), modeled on HealthReviewDaysInput:
 * saves on blur or Enter, Escape reverts, an invalid entry is never sent and
 * shows an inline error. The count is absolute (not a share of open cards).
 */
export default function HealthOffTrackInput({ value, onSave, disabled = false }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const focused = useRef(false);
  // Enter commits, then the blur that usually follows would commit the same
  // value again while the first PATCH is in flight: one save at a time.
  const savingRef = useRef(false);

  // A remote board.updated reaches the input unless the user is typing in it.
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const commit = async () => {
    if (disabled) return;
    const next = parseHealthOffTrack(draft);
    if (next === undefined) {
      setError(`Enter a whole number from 1 to ${HEALTH_OFF_TRACK_MAX}.`);
      setSaved(false);
      return;
    }
    setError(null);
    if (next === value || savingRef.current) return;
    savingRef.current = true;
    try {
      await onSave(next);
      setSaved(true);
    } catch {
      setDraft(String(value));
      setSaved(false);
      setError("Failed to save the threshold. Please try again.");
    } finally {
      savingRef.current = false;
    }
  };

  const describedBy = [`${id}-hint`, disabled ? `${id}-disabled` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");

  return (
    <div className="flex flex-col gap-1.5">
      {/* Only the input row dims; the hints explaining why stay full opacity. */}
      <div className={`flex items-center gap-2 ${disabled ? "opacity-60" : ""}`}>
        <label htmlFor={id} className="text-sm text-fg-tertiary">Off track at</label>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={HEALTH_OFF_TRACK_MAX}
          value={draft}
          disabled={disabled}
          aria-disabled={disabled ? true : undefined}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          onFocus={() => { focused.current = true; }}
          onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
          onBlur={() => { focused.current = false; void commit(); }}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return;
            if (e.key === "Enter") { e.preventDefault(); void commit(); }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(String(value)); setError(null); }
          }}
          className="bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 w-20 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
        />
        <span className="text-sm text-fg-tertiary">flagged cards</span>
        <span role="status" className="text-success text-xs">{saved && !error ? "Saved" : ""}</span>
      </div>
      <p id={`${id}-hint`} className="text-xs text-fg-tertiary">
        1 or more flagged cards is At risk. This many or more is Off track. Flagged means overdue, stale, or blocked.
      </p>
      {disabled && <p id={`${id}-disabled`} className="text-xs text-fg-tertiary">Turn on automatic health status to set this.</p>}
      <p className="text-xs min-h-4">
        {error && <span id={`${id}-error`} role="alert" className="text-danger">{error}</span>}
      </p>
    </div>
  );
}
