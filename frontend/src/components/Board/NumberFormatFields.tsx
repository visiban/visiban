import { useId } from "react";
import { formatNumberValue, parseDecimalsInput, type NumberFormatDraft } from "../../utils/customFieldValue";

/** Value used for the live preview line. */
const PREVIEW_SAMPLE = "1234.5";

interface Props {
  draft: NumberFormatDraft;
  onChange: (next: NumberFormatDraft) => void;
}

/**
 * The "Format" block of the Board Settings card-field and swimlane-field
 * editors (#1391). Rendered by both tabs only while the selected type is
 * `number`. Display-only options: the stored value stays the plain number.
 */
export default function NumberFormatFields({ draft, onChange }: Props) {
  const id = useId();
  const decimals = parseDecimalsInput(draft.number_decimals);
  const invalid = decimals === undefined;
  const preview = formatNumberValue(PREVIEW_SAMPLE, {
    prefix: draft.number_prefix,
    suffix: draft.number_suffix,
    decimals: invalid ? null : decimals,
  });
  const inputClasses =
    "bg-surface border rounded px-3 py-1.5 text-sm text-fg-secondary placeholder-fg-muted focus:outline-none focus:ring-2 w-full";
  const okInput = "border-line focus:ring-primary-emphasis focus:border-transparent";

  return (
    <div className="mb-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Format</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-secondary">Prefix</span>
          <input
            type="text"
            maxLength={10}
            value={draft.number_prefix}
            onChange={(e) => onChange({ ...draft, number_prefix: e.target.value })}
            placeholder="e.g. $"
            className={`${inputClasses} ${okInput}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-secondary">Suffix</span>
          <input
            type="text"
            maxLength={10}
            value={draft.number_suffix}
            onChange={(e) => onChange({ ...draft, number_suffix: e.target.value })}
            placeholder="e.g. h"
            className={`${inputClasses} ${okInput}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-secondary">Decimals</span>
          <input
            type="number"
            min={0}
            max={10}
            step={1}
            inputMode="numeric"
            value={draft.number_decimals}
            onChange={(e) => onChange({ ...draft, number_decimals: e.target.value })}
            placeholder="As typed"
            aria-invalid={invalid ? true : undefined}
            aria-describedby={`${id}-decimals`}
            className={`${inputClasses} ${invalid ? "border-danger focus:ring-danger-emphasis" : okInput}`}
          />
        </label>
      </div>
      {/* Reserved slot (§ Inline status messages): helper by default, the error when invalid. */}
      <p id={`${id}-decimals`} className="text-xs min-h-4 mt-1">
        {invalid ? (
          <span role="alert" className="text-danger">Enter 0 to 10.</span>
        ) : (
          <span className="text-fg-muted">Preview: {preview}</span>
        )}
      </p>
    </div>
  );
}
