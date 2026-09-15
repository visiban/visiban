import type { CustomFieldDefinition } from "../../types";
import CustomFieldValueInput from "./CustomFieldValueInput";
import CustomFieldValueDisplay from "./CustomFieldValueDisplay";
import AutosaveIndicator from "../Common/AutosaveIndicator";
import { useAutosaveStatus } from "../../hooks/useAutosaveStatus";

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
          onCommit={(v) => { void runSave(onSave(v)); }}
        />
      )}
      {!isCheckbox && definition.help_text && (
        <p className="text-xs text-fg-muted mt-1">{definition.help_text}</p>
      )}
      {!disabled && <AutosaveIndicator status={status} fadingOut={fadingOut} />}
    </div>
  );
}
