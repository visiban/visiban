import { useId } from "react";
import { thresholdDraftError, type ThresholdDraft } from "../../utils/customFieldValue";
import ThresholdMark from "../Card/ThresholdMark";

interface Props {
  isDate: boolean;
  draft: ThresholdDraft;
  onChange: (next: ThresholdDraft) => void;
}

const DIRECTIONS: { value: ThresholdDraft["direction"]; label: string }[] = [
  { value: "", label: "Off" },
  { value: "above", label: "Above" },
  { value: "below", label: "Below" },
];

/**
 * The "Thresholds" block of the Board Settings card-field editor (#1122),
 * rendered only for number and date fields. Display-only: a card value at or
 * beyond a threshold is marked on the card face with a chevron and bold
 * weight, never a color. Date thresholds are whole days relative to today.
 * An invalid draft shows its message here and blocks Save.
 */
export default function ThresholdFields({ isDate, draft, onChange }: Props) {
  const id = useId();
  const error = thresholdDraftError(isDate, draft);
  const off = draft.direction === "";
  const inputClasses =
    "bg-surface border rounded px-3 py-1.5 text-sm text-fg-secondary placeholder-fg-muted focus:outline-none focus:ring-2 w-full disabled:opacity-50";
  const okInput = "border-line focus:ring-primary-emphasis focus:border-transparent";
  const badInput = "border-danger focus:ring-danger-emphasis";
  const unit = isDate ? "Days from today" : "Value";

  return (
    <fieldset className="mb-3" aria-describedby={`${id}-help`}>
      <legend className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Thresholds</legend>
      <div role="radiogroup" aria-label="Mark values" className="flex flex-wrap gap-3 mb-2">
        {DIRECTIONS.map((d) => (
          <label key={d.value || "off"} className="inline-flex items-center gap-1.5 text-sm text-fg-secondary">
            <input
              type="radio"
              name={`${id}-direction`}
              value={d.value}
              checked={draft.direction === d.value}
              onChange={() => onChange({ ...draft, direction: d.value })}
            />
            {d.label}
          </label>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-secondary">Warn at</span>
          <input
            type="number"
            step={isDate ? 1 : "any"}
            inputMode={isDate ? "numeric" : "decimal"}
            value={draft.warn}
            disabled={off}
            onChange={(e) => onChange({ ...draft, warn: e.target.value })}
            placeholder={unit}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-help`}
            className={`${inputClasses} ${error ? badInput : okInput}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-secondary">Alert at</span>
          <input
            type="number"
            step={isDate ? 1 : "any"}
            inputMode={isDate ? "numeric" : "decimal"}
            value={draft.alert}
            disabled={off}
            onChange={(e) => onChange({ ...draft, alert: e.target.value })}
            placeholder={unit}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-help`}
            className={`${inputClasses} ${error ? badInput : okInput}`}
          />
        </label>
      </div>
      {/* Reserved slot (§ Inline status messages): the legend by default, the error when invalid. */}
      <p id={`${id}-help`} className="text-xs min-h-4 mt-1">
        {error ? (
          <span role="alert" className="text-danger">{error}</span>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1 text-fg-muted" data-testid="threshold-legend">
            <ThresholdMark level="warn" direction={draft.direction || "above"} />
            <span>warning,</span>
            <ThresholdMark level="alert" direction={draft.direction || "above"} />
            <span>alert, shown in bold on cards.{isDate ? " Negative days are in the past." : ""}</span>
          </span>
        )}
      </p>
    </fieldset>
  );
}
