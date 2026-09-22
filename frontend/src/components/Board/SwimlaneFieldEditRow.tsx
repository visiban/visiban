import type { SwimlaneCustomFieldDefinition } from "../../types";
import CustomFieldValueInput from "../Card/CustomFieldValueInput";
import AdminOnlyFieldGlyph from "../Common/AdminOnlyFieldGlyph";

interface Props {
  definition: SwimlaneCustomFieldDefinition;
  value: string | undefined;
  /** Updates local form state only — no network call. */
  onChange: (value: string) => void;
}

/**
 * One editable row field inside `EditSwimlaneModal` (#1140).
 *
 * Deliberately **not** a reuse of `CustomFieldEditRow`: that component owns a
 * `useAutosaveStatus()` per row and fires an API call on every commit, which is
 * right for the card detail panel's autosave surface and wrong here — this
 * modal commits once, explicitly, behind its Save button. Sharing it would mean
 * every keystroke in a swimlane field writing to the server, and Cancel no
 * longer cancelling anything.
 *
 * `debounceMs={0}` is load-bearing for the same reason: with the default 600ms
 * debounce, clicking Save within that window of the last keystroke would drop
 * those characters, because the timer never fires before the form is read.
 */
export default function SwimlaneFieldEditRow({ definition, value, onChange }: Props) {
  // ToggleField renders its own label and description, so a checkbox row must
  // not print them again — same carve-out CustomFieldEditRow makes.
  const isCheckbox = definition.field_type === "checkbox";

  return (
    <div>
      {!isCheckbox && (
        <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5 flex items-center gap-1.5">
          {definition.name}
          {definition.is_admin_only && <AdminOnlyFieldGlyph />}
        </p>
      )}
      <CustomFieldValueInput
        definition={definition}
        value={value}
        onCommit={onChange}
        debounceMs={0}
        // Above ModalWrapper's 40, so Escape inside an open dropdown closes the
        // dropdown rather than the modal and the half-filled form with it.
        escapePriority={45}
      />
      {!isCheckbox && definition.help_text && (
        <p className="text-xs text-fg-muted mt-1">{definition.help_text}</p>
      )}
    </div>
  );
}
