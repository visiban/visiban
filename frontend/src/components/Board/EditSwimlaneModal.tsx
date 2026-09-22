import { useState } from "react";
import { updateSwimlane, deleteSwimlane } from "../../api/boards";
import type { Swimlane, SwimlaneCustomFieldDefinition } from "../../types";
import { COLUMN_COLORS } from "../../constants/colors";
import ModalWrapper from "../shared/ModalWrapper";
import SwimlaneFieldEditRow from "./SwimlaneFieldEditRow";

interface Props {
  boardId: number;
  swimlane: Swimlane;
  cardCount: number;
  onUpdated: (swimlane: Swimlane) => void;
  onDeleted: (swimlaneId: number) => void;
  onClose: () => void;
  /** Row field schema (#1140). The Fields section is omitted when empty. */
  swimlaneFieldDefinitions?: SwimlaneCustomFieldDefinition[];
}

export default function EditSwimlaneModal({ boardId, swimlane, cardCount, onUpdated, onDeleted, onClose, swimlaneFieldDefinitions }: Props) {
  const [name, setName] = useState(swimlane.name);
  const [color, setColor] = useState(swimlane.color);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const defs = [...(swimlaneFieldDefinitions ?? [])].sort((a, b) => a.position - b.position);

  // Values held at mount, so Save can send a diff rather than the whole set.
  const [initialValues] = useState<Record<number, string>>(() =>
    Object.fromEntries((swimlane.custom_field_values ?? []).map((v) => [v.field_definition, v.value]))
  );
  const [fieldValues, setFieldValues] = useState<Record<number, string>>(initialValues);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Diff, not the whole array: apply_swimlane_custom_field_values leaves
      // definitions it is not told about alone, so sending only what changed
      // is both correct and strictly safer than a full replace — a field this
      // client never knew about (added by another admin mid-edit) is not
      // silently cleared. A cleared field is sent as "" and deletes its row.
      const changed = defs
        .filter((d) => (fieldValues[d.id] ?? "") !== (initialValues[d.id] ?? ""))
        .map((d) => ({ field_definition: d.id, value: fieldValues[d.id] ?? "" }));

      const updated = await updateSwimlane(boardId, swimlane.id, {
        name: name.trim(),
        color,
        ...(changed.length > 0 && { custom_field_values: changed }),
      });
      onUpdated(updated);
      onClose();
    } catch {
      setSaveError("Couldn't save this swimlane. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    await deleteSwimlane(boardId, swimlane.id);
    onDeleted(swimlane.id);
    onClose();
  };

  // Dynamic title based on delete-confirmation state
  const title = confirmDelete
    ? (cardCount > 0 ? "Cannot delete swimlane" : "Delete swimlane?")
    : "Edit Swimlane";

  return (
    <ModalWrapper open={true} onClose={onClose} title={title} maxWidth="max-w-md" labelId="edit-swimlane-title">
      {confirmDelete ? (
        cardCount > 0 ? (
          <>
            <p className="text-sm text-fg-tertiary mb-5">
              <span className="font-medium text-fg">{swimlane.name}</span> has {cardCount} card{cardCount !== 1 ? "s" : ""}. Move or delete all cards before removing this swimlane.
            </p>
            <div className="flex justify-end">
              <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 text-sm bg-surface-hover text-fg rounded hover:bg-surface-active transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
                OK
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-fg-tertiary mb-5">
              Delete <span className="font-medium text-fg">{swimlane.name}</span>? This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 text-sm text-fg-tertiary hover:text-fg rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
                Cancel
              </button>
              <button onClick={handleDelete} className="px-4 py-2 text-sm font-medium bg-danger-bg text-on-danger rounded hover:bg-danger-bg-hover transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis">
                Delete
              </button>
            </div>
          </>
        )
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-xs text-fg-tertiary mb-1 block">Name *</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
              />
            </div>

            <div>
              <label className="text-xs text-fg-tertiary mb-1 block">Color</label>
              <div className="flex gap-2">
                {COLUMN_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    aria-label={`Select color ${c}`}
                    aria-pressed={color === c}
                    className={`w-7 h-7 rounded-full border-2 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${color === c ? "border-white scale-110" : "border-transparent"}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Context-gated: omit the section *and* its divider when the board
              defines no row fields, rather than showing an empty heading. */}
          {defs.length > 0 && (
            <>
              <div className="border-t border-line my-4" />
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2">
                Swimlane fields <span className="ml-1.5 normal-case font-normal text-fg-muted">({defs.length})</span>
              </p>
              {/* Not collapsible: this is one of two sections in a focused
                  modal, and a collapsed section behind a Save button is a trap. */}
              <div className="flex flex-col gap-4 max-h-[45vh] overflow-y-auto pr-1 -mr-1">
                {defs.map((def) => (
                  <SwimlaneFieldEditRow
                    key={def.id}
                    definition={def}
                    value={fieldValues[def.id]}
                    onChange={(v) => setFieldValues((prev) => ({ ...prev, [def.id]: v }))}
                  />
                ))}
              </div>
            </>
          )}

          <p className="text-xs h-4 mt-2">
            {saveError && <span className="text-danger">{saveError}</span>}
          </p>

          <div className="flex justify-between items-center mt-2">
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-sm text-danger hover:text-danger transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
            >
              Delete swimlane
            </button>
            <div className="flex gap-2">
              <button onClick={onClose} className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
              <button
                onClick={handleSave}
                disabled={!name.trim() || saving}
                className="text-sm bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </ModalWrapper>
  );
}
