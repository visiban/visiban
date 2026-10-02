import type { FieldDefinitionShape } from "../../types";
import { parseMultiSelect, serializeMultiSelect } from "../../utils/customFieldValue";
import MultiSelectDropdown from "../Common/MultiSelectDropdown";
import MultiSelectChips from "./MultiSelectChips";

interface Props {
  definition: FieldDefinitionShape;
  /** The stored value — a JSON array string, `""`/`undefined` for none. */
  value: string | undefined;
  /**
   * Called once when the menu closes with a changed selection: the canonical
   * JSON array string, or `""` when everything was unchecked. Return the save
   * promise to get revert-on-failure; a form surface that only updates local
   * state may return nothing.
   */
  onCommit: (value: string) => void | Promise<void>;
  disabled?: boolean;
  /**
   * Escape stack priority. Defaults to 39, above `CardDetail`'s panel close
   * (30) and its other controls (35-38). Inside a `ModalWrapper` (40) pass a
   * value above 40 — `EditSwimlaneModal` passes 46. See the allocation lists
   * in frontend/CLAUDE.md.
   */
  escapePriority?: number;
}

/**
 * The value editor for a `multi_select` custom field (#1391), used on card
 * detail and in the swimlane edit modal. A thin mapping onto the `Common`
 * `MultiSelectDropdown` primitive: the stored JSON array string becomes the
 * selection, the definition's choices become the options, and a committed
 * selection is encoded the way the server stores it (`serializeMultiSelect`),
 * so "nothing changed" never costs a request.
 *
 * Entries already stored that are no longer choices ("orphans", left behind
 * when an admin renames or removes a choice) appear under "No longer a
 * choice"; the server accepts them for this owner only. An unparseable stored
 * value reads as no entries.
 */
export default function MultiSelectValueInput({ definition, value, onCommit, disabled, escapePriority = 39 }: Props) {
  return (
    <MultiSelectDropdown
      label={definition.name}
      options={definition.choices}
      selected={parseMultiSelect(value)}
      onCommit={(entries) => onCommit(serializeMultiSelect(entries, definition.choices))}
      disabled={disabled}
      escapePriority={escapePriority}
      saveErrorMessage={`Couldn't save ${definition.name}. Try again.`}
      renderValue={(entries) => <MultiSelectChips entries={entries} definition={definition} wrap />}
    />
  );
}
