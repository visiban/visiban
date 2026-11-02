import { useId, useState } from "react";
import ModalWrapper from "../shared/ModalWrapper";

interface Props {
  cardTitle: string;
  targetColumnName: string;
  sourceColumnName: string;
  criteria: string[];
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm-on-entry checklist (#1101). Opens after a drop into a column whose
 * policy mode is "confirm", and only when no limit would block the move: a
 * limit block wins, and no checklist opens for a move the server will refuse.
 *
 * This is a client-side acknowledgment. The server never checks it, which the
 * docs say plainly (docs/features/column-policies.md).
 *
 * The move button is `aria-disabled` rather than `disabled` until every item
 * is checked, so it stays a Tab stop and its reason line is reachable
 * (frontend/CLAUDE.md § Subordinate settings blocks, rule 5 and #1314).
 */
export default function PolicyConfirmModal({
  cardTitle, targetColumnName, sourceColumnName, criteria, onConfirm, onCancel,
}: Props) {
  const [checked, setChecked] = useState<boolean[]>(() => criteria.map(() => false));
  const id = useId();
  const reasonId = `${id}-reason`;
  const allChecked = checked.every(Boolean);
  const remaining = checked.filter((c) => !c).length;

  return (
    <ModalWrapper
      open={true}
      onClose={onCancel}
      title={`Move “${cardTitle}” to ${targetColumnName}?`}
      maxWidth="max-w-md"
      labelId={`${id}-title`}
    >
      <fieldset>
        <legend className="text-sm text-fg-secondary mb-3">
          Check each entry criterion for <span className="font-medium text-fg">{targetColumnName}</span>.
        </legend>
        <ul className="flex flex-col gap-2">
          {criteria.map((text, i) => (
            <li key={i}>
              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={checked[i]}
                  onChange={(e) => setChecked((prev) => prev.map((v, j) => (j === i ? e.target.checked : v)))}
                  className="mt-0.5 w-4 h-4 rounded accent-primary shrink-0"
                />
                <span className="text-sm text-fg-secondary break-words min-w-0">{text}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <p id={reasonId} className="text-xs text-fg-tertiary mt-4 min-h-4" role="status" aria-live="polite" aria-atomic="true">
        {allChecked ? "" : `${remaining} of ${criteria.length} still to check.`}
      </p>

      <div className="flex items-center justify-end gap-3 mt-4">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Keep in {sourceColumnName}
        </button>
        <button
          type="button"
          aria-disabled={!allChecked || undefined}
          aria-describedby={allChecked ? undefined : reasonId}
          onClick={allChecked ? onConfirm : undefined}
          className="text-sm bg-button-primary text-on-primary px-3 py-1.5 rounded hover:bg-button-primary-hover transition font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
        >
          Move to {targetColumnName}
        </button>
      </div>
    </ModalWrapper>
  );
}
