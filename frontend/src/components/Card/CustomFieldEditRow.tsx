import { useState } from "react";
import type { CustomFieldDefinition } from "../../types";
import CustomFieldValueInput from "./CustomFieldValueInput";
import CustomFieldValueDisplay from "./CustomFieldValueDisplay";
import AutosaveIndicator from "../Common/AutosaveIndicator";
import { useAutosaveStatus } from "../../hooks/useAutosaveStatus";
import { urlErrorFromServer } from "../../utils/customFieldValue";

interface Props {
  definition: CustomFieldDefinition;
  value: string | undefined;
  /** `!canEdit` — read-only rows render via `CustomFieldValueDisplay`, no save affordance. */
  disabled: boolean;
  onSave: (value: string) => Promise<void>;
  userDateFormat?: string;
}

/**
 * One row in `CardDetail`'s Custom fields section — one board field
 * definition, editable or read-only depending on `disabled`. Owns its own
 * `useAutosaveStatus()` instance; this component is instantiated once per
 * field (0-30 times), so each row gets an independent save/saving/error
 * indicator rather than sharing one across the whole section — the same
 * "extract a component so the hook isn't called in a loop" shape as
 * `CardDetail`'s single Weight field, just repeated per row here.
 */
export default function CustomFieldEditRow({ definition, value, disabled, onSave, userDateFormat }: Props) {
  const { status, fadingOut, runSave } = useAutosaveStatus();
  // #1390: a URL the server refused (400) gets the editor's inline copy next
  // to the input, not just the row's generic "Failed to save".
  const [urlServerError, setUrlServerError] = useState<string | null>(null);
  const isUrl = definition.field_type === "url";

  const commit = (v: string): Promise<void> | void => {
    if (definition.field_type === "multi_select") {
      // #1391: hand the save back so the editor can revert its selection and
      // say which field failed; runSave still drives the row's indicator.
      const saving = onSave(v);
      void runSave(saving);
      return saving;
    }
    if (!isUrl) { void runSave(onSave(v)); return; }
    setUrlServerError(null);
    void runSave(
      onSave(v).catch((err: unknown) => {
        setUrlServerError(urlErrorFromServer(err));
        throw err;
      })
    );
  };

  // checkbox's ToggleField renders the field name + help text internally —
  // duplicating them in this row's own label would show the name twice.
  const isCheckbox = definition.field_type === "checkbox";

  return (
    <div>
      {!isCheckbox && (
        <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">{definition.name}</p>
      )}
      {disabled ? (
        <CustomFieldValueDisplay definition={definition} value={value} variant="detail" userDateFormat={userDateFormat} />
      ) : (
        <CustomFieldValueInput
          definition={definition}
          value={value}
          disabled={disabled}
          onCommit={commit}
          serverError={isUrl ? urlServerError : undefined}
        />
      )}
      {!isCheckbox && definition.help_text && (
        <p className="text-xs text-fg-muted mt-1">{definition.help_text}</p>
      )}
      {!disabled && <AutosaveIndicator status={status} fadingOut={fadingOut} />}
    </div>
  );
}
