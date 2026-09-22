import { useEffect, useState } from "react";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BoardFull, CustomFieldType, SwimlaneCustomFieldDefinition } from "../../types";
import ModalWrapper from "../shared/ModalWrapper";
import { Toggle, ToggleField } from "../Common/Toggle";
import {
  createSwimlaneCustomFieldDefinition,
  updateSwimlaneCustomFieldDefinition,
  deleteSwimlaneCustomFieldDefinition,
  reorderSwimlaneCustomFields,
} from "../../api/boards";
import AdminOnlyFieldGlyph from "../Common/AdminOnlyFieldGlyph";

interface Props {
  board: BoardFull;
  isAdmin: boolean;
  onFieldsUpdated: (definitions: SwimlaneCustomFieldDefinition[]) => void;
}

const FIELD_TYPE_OPTIONS: { value: CustomFieldType; label: string; glyph: string }[] = [
  { value: "text", label: "Text", glyph: "Aa" },
  { value: "number", label: "Number", glyph: "#" },
  { value: "date", label: "Date", glyph: "📅" },
  { value: "dropdown", label: "Dropdown", glyph: "▾" },
  { value: "checkbox", label: "Checkbox", glyph: "☑" },
];

const TYPE_LABEL: Record<CustomFieldType, string> = {
  text: "Text", number: "Number", date: "Date", dropdown: "Dropdown", checkbox: "Checkbox",
};

const TYPE_GLYPH: Record<CustomFieldType, string> = {
  text: "Aa", number: "#", date: "📅", dropdown: "▾", checkbox: "☑",
};

// Mirror SwimlaneCustomFieldDefinition.MAX_PER_BOARD / MAX_PINNED_PER_BOARD.
// Deliberately different from the card tab's 30/2 — see the derivation on the
// model. Keep these in step with the backend; the server is authoritative and
// will 400 regardless, these only drive the local affordances.
const FIELD_CAP = 15;
const PIN_CAP = 3;

interface FormState {
  name: string;
  field_type: CustomFieldType;
  choices: string[];
  help_text: string;
  show_on_row: boolean;
  is_admin_only: boolean;
}

function emptyForm(): FormState {
  // is_admin_only defaults ON, matching the model default. Loosening a field
  // later is additive; tightening one changes what an install already exposes.
  return { name: "", field_type: "text", choices: [], help_text: "", show_on_row: false, is_admin_only: true };
}

function formFromDefinition(d: SwimlaneCustomFieldDefinition): FormState {
  return {
    name: d.name, field_type: d.field_type, choices: [...d.choices],
    help_text: d.help_text, show_on_row: d.show_on_row, is_admin_only: d.is_admin_only,
  };
}

/**
 * Board Settings → Swimlane fields tab (#1140).
 *
 * A sibling of `BoardSettingsFieldsTab`, deliberately copied rather than
 * factored into a shared component with a `scope` prop: that file's own notes
 * explain that its list/add/edit/reorder states are too interdependent to
 * decompose, and the two now genuinely diverge — this one has an `is_admin_only`
 * control, a *hard* type lock instead of a soft warning, and different caps.
 * A shared component would carry every one of those as a conditional.
 */
export default function BoardSettingsSwimlaneFieldsTab({ board, isAdmin, onFieldsUpdated }: Props) {
  const [fields, setFields] = useState<SwimlaneCustomFieldDefinition[]>(
    () => [...board.swimlane_custom_field_definitions].sort((a, b) => a.position - b.position)
  );
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [pasteListOpen, setPasteListOpen] = useState(false);
  const [pasteListText, setPasteListText] = useState("");
  const [swapPromptId, setSwapPromptId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SwimlaneCustomFieldDefinition | null>(null);
  const [deleteInput, setDeleteInput] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-sync from the parent when the board's definitions change for a reason
  // other than this component's own edits (another admin, over the WS
  // swimlane_custom_field.* handlers). Only while no row is mid-edit, so an
  // incoming update never clobbers in-progress local form state.
  useEffect(() => {
    if (editingId === null) {
      setFields([...board.swimlane_custom_field_definitions].sort((a, b) => a.position - b.position));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excludes editingId: this should re-run only when board's data changes, not when the user starts/stops editing
  }, [board.swimlane_custom_field_definitions]);

  const pinnedCount = fields.filter((f) => f.show_on_row).length;

  /**
   * Whether any swimlane on this board already holds a value for a definition.
   *
   * Derived client-side rather than asking for a new serializer field: an
   * admin's `/full/` payload already carries every row value including
   * admin-only ones, so the answer is in hand. The server enforces the same
   * rule regardless — this only decides whether to *offer* the click.
   */
  const fieldHasValues = (defId: number) =>
    board.swimlanes.some((s) =>
      (s.custom_field_values ?? []).some((v) => v.field_definition === defId && v.value !== "")
    );

  const commit = (next: SwimlaneCustomFieldDefinition[]) => {
    const sorted = [...next].sort((a, b) => a.position - b.position);
    setFields(sorted);
    onFieldsUpdated(sorted);
  };

  const startAdd = () => { setEditingId("new"); setForm(emptyForm()); setFormError(null); };
  const startEdit = (def: SwimlaneCustomFieldDefinition) => {
    setEditingId(def.id); setForm(formFromDefinition(def)); setFormError(null);
  };
  const cancelEdit = () => {
    setEditingId(null); setPasteListOpen(false); setPasteListText("");
  };

  const handlePin = (def: SwimlaneCustomFieldDefinition) => {
    if (def.show_on_row) { void savePin(def, false); return; }
    if (pinnedCount >= PIN_CAP) { setSwapPromptId(def.id); return; }
    void savePin(def, true);
  };

  const savePin = async (def: SwimlaneCustomFieldDefinition, pinned: boolean) => {
    const prev = fields;
    setFields(fields.map((f) => (f.id === def.id ? { ...f, show_on_row: pinned } : f)));
    try {
      const updated = await updateSwimlaneCustomFieldDefinition(board.id, def.id, { show_on_row: pinned });
      commit(fields.map((f) => (f.id === def.id ? updated : f)));
    } catch {
      setFields(prev);
    }
  };

  const swapPin = async (replaceId: number, newId: number) => {
    const prev = fields;
    setSwapPromptId(null);
    try {
      const [unpinned, pinned] = await Promise.all([
        updateSwimlaneCustomFieldDefinition(board.id, replaceId, { show_on_row: false }),
        updateSwimlaneCustomFieldDefinition(board.id, newId, { show_on_row: true }),
      ]);
      commit(fields.map((f) => (f.id === replaceId ? unpinned : f.id === newId ? pinned : f)));
    } catch {
      // One logical operation — either half failing rolls back both.
      setFields(prev);
    }
  };

  const addChoice = () => setForm((f) => ({ ...f, choices: [...f.choices, ""] }));
  const removeChoice = (i: number) => setForm((f) => ({ ...f, choices: f.choices.filter((_, idx) => idx !== i) }));
  const updateChoice = (i: number, value: string) =>
    setForm((f) => ({ ...f, choices: f.choices.map((c, idx) => (idx === i ? value : c)) }));
  const moveChoice = (from: number, to: number) =>
    setForm((f) => ({ ...f, choices: arrayMove(f.choices, from, to) }));

  const applyPastedChoices = () => {
    const lines = pasteListText.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const existing = new Set(form.choices.map((c) => c.trim()));
    setForm((f) => ({ ...f, choices: [...f.choices, ...lines.filter((l) => !existing.has(l))] }));
    setPasteListText("");
    setPasteListOpen(false);
  };

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) { setFormError("Name is required."); return; }
    const dupe = fields.some((f) => f.id !== editingId && f.name.trim().toLowerCase() === name.toLowerCase());
    if (dupe) { setFormError("A swimlane field with this name already exists."); return; }
    const cleanedChoices = form.choices.map((c) => c.trim()).filter((c) => c !== "");
    if (form.field_type === "dropdown" && cleanedChoices.length === 0) {
      setFormError("A dropdown field needs at least one choice.");
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      if (editingId === "new") {
        const created = await createSwimlaneCustomFieldDefinition(board.id, {
          name,
          field_type: form.field_type,
          choices: form.field_type === "dropdown" ? cleanedChoices : undefined,
          help_text: form.help_text.trim() || undefined,
          is_admin_only: form.is_admin_only,
        });
        let finalDef = created;
        if (form.show_on_row) {
          finalDef = await updateSwimlaneCustomFieldDefinition(board.id, created.id, { show_on_row: true });
        }
        commit([...fields, finalDef]);
      } else if (editingId !== null) {
        const updated = await updateSwimlaneCustomFieldDefinition(board.id, editingId, {
          name,
          field_type: form.field_type,
          choices: form.field_type === "dropdown" ? cleanedChoices : undefined,
          help_text: form.help_text.trim() || undefined,
          is_admin_only: form.is_admin_only,
        });
        commit(fields.map((f) => (f.id === editingId ? updated : f)));
      }
      cancelEdit();
    } catch (err: unknown) {
      // Belt and braces for the type lock: the disabled buttons are driven by
      // a client-side derivation that can go stale if a value is written
      // between board load and save. The server is the real gate.
      const detail = (err as { response?: { data?: { field_type?: unknown } } })?.response?.data?.field_type;
      setFormError(
        detail
          ? "Couldn't change this field's type — swimlanes already have values for it."
          : "Couldn't save this field. Check the values and try again."
      );
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const prev = fields;
    setFields(fields.filter((f) => f.id !== deleteTarget.id));
    try {
      await deleteSwimlaneCustomFieldDefinition(board.id, deleteTarget.id);
      commit(fields.filter((f) => f.id !== deleteTarget.id));
    } catch {
      setFields(prev);
    } finally {
      setDeleteTarget(null);
      setDeleteInput("");
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = fields.findIndex((f) => f.id === active.id);
    const newIndex = fields.findIndex((f) => f.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const prev = fields;
    const reordered = arrayMove(fields, oldIndex, newIndex);
    setFields(reordered);
    try {
      commit(await reorderSwimlaneCustomFields(board.id, reordered.map((f) => f.id)));
    } catch {
      setFields(prev);
    }
  };

  if (!isAdmin) {
    // Currently unreachable — every entry point to Board Settings is
    // admin-gated. Kept for parity with the card tab, since that gate is a
    // call-site decision that could change.
    return (
      <div>
        <p className="text-sm text-fg-secondary mb-3">Only board admins can add or edit swimlane fields.</p>
        {fields.some((f) => f.is_admin_only) && (
          <p className="text-xs text-fg-muted mb-3">Locked fields store values only board admins can see.</p>
        )}
        {fields.length === 0 ? (
          <EmptyState isAdmin={false} />
        ) : (
          <div>
            {fields.map((f) => (
              <div key={f.id} className="flex items-center gap-3 py-2.5 border-b border-line/60 last:border-0">
                <span className="w-5 text-center text-fg-tertiary shrink-0" aria-hidden="true">{TYPE_GLYPH[f.field_type]}</span>
                <span className="flex-1 min-w-0 truncate text-sm text-fg" title={f.name}>{f.name}</span>
                <span className="text-xs text-fg-muted capitalize w-16 shrink-0">{TYPE_LABEL[f.field_type]}</span>
                {f.is_admin_only && <AdminOnlyFieldGlyph />}
                {f.show_on_row && (
                  <span className="text-xs text-fg-muted bg-surface-hover rounded px-2 py-0.5 shrink-0">Pinned</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Swimlane fields</p>
        <span className={`text-xs ${fields.length >= FIELD_CAP - 2 ? "text-warning" : "text-fg-muted"}`}>
          {fields.length} of {FIELD_CAP} · {pinnedCount} of {PIN_CAP} pinned
        </span>
      </div>

      {/* Surfaced once here rather than repeated per field: with the default
          being admin-only, a board can quietly end up with nothing visible to
          the people doing daily work. */}
      {fields.length > 0 && fields.every((f) => f.is_admin_only) && (
        <p className="text-xs text-warning mb-2">
          Every field here is admin only — members and viewers see none of these on the board.
        </p>
      )}

      {fields.length === 0 && editingId === null ? (
        <EmptyState isAdmin onAdd={startAdd} />
      ) : (
        <DndContext onDragEnd={(e) => void handleDragEnd(e)}>
          <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            {fields.map((def) => (
              <FieldRow
                key={def.id}
                def={def}
                editing={editingId === def.id}
                dragDisabled={editingId !== null}
                onEdit={() => startEdit(def)}
                onDelete={() => setDeleteTarget(def)}
                onPin={() => handlePin(def)}
                swapPromptOpen={swapPromptId === def.id}
                pinnedFields={fields.filter((f) => f.show_on_row)}
                onSwap={(replaceId) => void swapPin(replaceId, def.id)}
                onCancelSwap={() => setSwapPromptId(null)}
              >
                {editingId === def.id && (
                  <FieldEditPanel
                    form={form}
                    setForm={setForm}
                    typeLocked={fieldHasValues(def.id)}
                    addChoice={addChoice}
                    removeChoice={removeChoice}
                    updateChoice={updateChoice}
                    moveChoice={moveChoice}
                    pasteListOpen={pasteListOpen}
                    setPasteListOpen={setPasteListOpen}
                    pasteListText={pasteListText}
                    setPasteListText={setPasteListText}
                    applyPastedChoices={applyPastedChoices}
                    pinnedCount={pinnedCount}
                    isNew={false}
                    formError={formError}
                    saving={saving}
                    onSave={() => void handleSave()}
                    onCancel={cancelEdit}
                  />
                )}
              </FieldRow>
            ))}
          </SortableContext>
        </DndContext>
      )}

      {editingId === "new" && (
        <div className="bg-sunken border border-primary-soft rounded-lg p-3 my-1">
          <FieldEditPanel
            form={form}
            setForm={setForm}
            typeLocked={false}
            addChoice={addChoice}
            removeChoice={removeChoice}
            updateChoice={updateChoice}
            moveChoice={moveChoice}
            pasteListOpen={pasteListOpen}
            setPasteListOpen={setPasteListOpen}
            pasteListText={pasteListText}
            setPasteListText={setPasteListText}
            applyPastedChoices={applyPastedChoices}
            pinnedCount={pinnedCount}
            isNew
            formError={formError}
            saving={saving}
            onSave={() => void handleSave()}
            onCancel={cancelEdit}
          />
        </div>
      )}

      {fields.length > 0 && editingId === null && (
        <div className="pt-3 flex items-center gap-3">
          {fields.length >= FIELD_CAP ? (
            <button disabled className="text-xs px-3 py-1.5 rounded border border-line-strong bg-surface text-fg-muted disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
              + Add field
            </button>
          ) : (
            <button onClick={startAdd} className="text-xs px-3 py-1.5 rounded bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
              + Add field
            </button>
          )}
          {fields.length >= FIELD_CAP - 2 && fields.length < FIELD_CAP && (
            <span className="text-xs text-warning">{FIELD_CAP - fields.length} field{FIELD_CAP - fields.length === 1 ? "" : "s"} left on this board.</span>
          )}
        </div>
      )}
      {fields.length >= FIELD_CAP && editingId === null && (
        <p className="text-xs text-fg-muted mt-2">
          This board has reached its {FIELD_CAP}-field limit. Delete a field to add a new one.
        </p>
      )}

      {deleteTarget && (
        <ModalWrapper open onClose={() => { setDeleteTarget(null); setDeleteInput(""); }} title="Delete field?" maxWidth="max-w-sm">
          <p className="text-fg-tertiary text-sm mb-1">
            <span className="text-fg font-medium">{deleteTarget.name}</span> will be permanently deleted.
          </p>
          <p className="text-danger text-sm mb-1">This removes the field and any values stored on swimlanes for it.</p>
          <p className="text-fg-muted text-sm mb-5">This cannot be undone.</p>
          <div className="mb-5">
            <label htmlFor="delete-swimlane-field-confirm-input" className="block text-xs text-fg-muted mb-1">
              Type <span className="text-fg-secondary font-mono">{deleteTarget.name}</span> to confirm deletion.
            </label>
            <input
              id="delete-swimlane-field-confirm-input"
              type="text"
              autoFocus
              value={deleteInput}
              onChange={(e) => setDeleteInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && deleteInput === deleteTarget.name) { e.preventDefault(); void confirmDelete(); }
              }}
              placeholder={deleteTarget.name}
              className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-danger-emphasis focus:border-transparent placeholder-fg-muted"
            />
          </div>
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={() => { setDeleteTarget(null); setDeleteInput(""); }}
              className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Cancel
            </button>
            <button
              onClick={() => void confirmDelete()}
              disabled={deleteInput !== deleteTarget.name}
              className="bg-danger-bg hover:bg-danger-bg-hover text-on-danger font-medium px-3 py-1.5 rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
            >
              Delete
            </button>
          </div>
        </ModalWrapper>
      )}
    </div>
  );
}

function EmptyState({ isAdmin, onAdd }: { isAdmin: boolean; onAdd?: () => void }) {
  return (
    <div className="flex flex-col items-center text-center py-8 px-4">
      <svg className="w-6 h-6 text-fg-faint mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 10h18M7 14h6" />
      </svg>
      <p className="text-sm text-fg-tertiary font-medium mb-1">No swimlane fields yet</p>
      <p className="text-sm text-fg-muted mb-4 max-w-xs">
        {isAdmin
          ? "Add fields to capture info about each swimlane row — owner, region, renewal date, anything."
          : "This board has no swimlane fields."}
      </p>
      {isAdmin && onAdd && (
        <button onClick={onAdd} className="text-sm px-3 py-1.5 rounded bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
          + Add field
        </button>
      )}
    </div>
  );
}

interface FieldRowProps {
  def: SwimlaneCustomFieldDefinition;
  editing: boolean;
  dragDisabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
  swapPromptOpen: boolean;
  pinnedFields: SwimlaneCustomFieldDefinition[];
  onSwap: (replaceId: number) => void;
  onCancelSwap: () => void;
  children?: React.ReactNode;
}

function FieldRow({ def, editing, dragDisabled, onEdit, onDelete, onPin, swapPromptOpen, pinnedFields, onSwap, onCancelSwap, children }: FieldRowProps) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: def.id, disabled: dragDisabled });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  if (editing) {
    return <div ref={setNodeRef} style={style}>{children}</div>;
  }

  return (
    <div ref={setNodeRef} style={style} className="group">
      <div className="flex items-center gap-3 py-2.5 border-b border-line/60 last:border-0">
        <span
          {...attributes}
          {...listeners}
          className="w-4 text-fg-faint hover:text-fg-tertiary cursor-grab opacity-0 group-hover:opacity-100 focus:opacity-100 transition shrink-0"
          aria-label={`Drag to reorder ${def.name}`}
        >
          ⋮⋮
        </span>
        <span className="w-5 text-center text-fg-tertiary shrink-0" aria-hidden="true">{TYPE_GLYPH[def.field_type]}</span>
        <span className="flex-1 min-w-0 truncate text-sm text-fg" title={def.name}>{def.name}</span>
        <span className="text-xs text-fg-muted capitalize w-16 shrink-0">{TYPE_LABEL[def.field_type]}</span>
        {/* Only the exception is marked. Admin-only is the default, so marking
            it everywhere would be noise; a public field is the surprise. */}
        {def.is_admin_only && (
          <span title="Admin only — members and viewers can't see this field's values" className="shrink-0 flex items-center">
            <AdminOnlyFieldGlyph />
          </span>
        )}
        <button
          onClick={onPin}
          aria-label={`${def.show_on_row ? "Unpin" : "Pin"} ${def.name} ${def.show_on_row ? "from" : "to"} swimlane row`}
          className={`text-xs rounded px-2 py-0.5 whitespace-nowrap shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
            def.show_on_row
              ? "text-info bg-info/10 border border-info/25 font-medium"
              : "text-fg-muted hover:text-fg-secondary"
          }`}
        >
          {def.show_on_row ? "Pinned" : `Pin (${pinnedFields.length} of ${PIN_CAP})`}
        </button>
        <span className="flex items-center gap-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition shrink-0">
          <button onClick={onEdit} className="text-xs text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded" title={`Edit ${def.name}`}>✎</button>
          <button onClick={onDelete} className="text-xs text-fg-tertiary hover:text-danger focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded" title={`Delete ${def.name}`}>✕</button>
        </span>
      </div>
      {swapPromptOpen && (
        <div className="bg-sunken border border-primary-soft rounded p-2.5 mb-2 text-xs">
          <p className="font-semibold text-fg mb-1">The row header shows {PIN_CAP} fields.</p>
          <p className="text-fg-muted mb-2">Pin <span className="text-fg-secondary font-medium">{def.name}</span> by replacing one of these:</p>
          <div className="flex flex-col gap-1 mb-2">
            {pinnedFields.map((p) => (
              <button
                key={p.id}
                onClick={() => onSwap(p.id)}
                className="flex items-center justify-between px-2 py-1 rounded hover:bg-surface-hover text-left focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                <span className="text-fg-secondary">{p.name}</span>
                <span className="text-info">Replace</span>
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between">
            {/* Deliberately does not name the card detail view or hover peek —
                neither exists for a row. */}
            <p className="text-fg-muted">Unpinned values are still visible in the row's field list.</p>
            <button onClick={onCancelSwap} className="text-fg-secondary hover:text-fg shrink-0 ml-2 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface FieldEditPanelProps {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  /** True once any swimlane holds a value — the type becomes unchangeable. */
  typeLocked: boolean;
  addChoice: () => void;
  removeChoice: (i: number) => void;
  updateChoice: (i: number, v: string) => void;
  moveChoice: (from: number, to: number) => void;
  pasteListOpen: boolean;
  setPasteListOpen: (open: boolean) => void;
  pasteListText: string;
  setPasteListText: (text: string) => void;
  applyPastedChoices: () => void;
  pinnedCount: number;
  isNew: boolean;
  formError: string | null;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}

function FieldEditPanel({
  form, setForm, typeLocked,
  addChoice, removeChoice, updateChoice, moveChoice,
  pasteListOpen, setPasteListOpen, pasteListText, setPasteListText, applyPastedChoices,
  pinnedCount, isNew, formError, saving, onSave, onCancel,
}: FieldEditPanelProps) {
  const inputClasses = "bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent w-full";
  const atPinCap = pinnedCount >= PIN_CAP && !form.show_on_row;

  return (
    <div className={isNew ? "" : "bg-sunken border border-primary-soft rounded-lg p-3 my-1"}>
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Field name</p>
      <input
        type="text"
        autoFocus
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        className={`${inputClasses} mb-3`}
        placeholder="e.g. Account owner"
      />

      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Type</p>
      <div className="flex gap-1.5 flex-wrap mb-2" aria-describedby={typeLocked ? "swimlane-field-type-lock" : undefined}>
        {FIELD_TYPE_OPTIONS.map((opt) => {
          const selected = form.field_type === opt.value;
          // Diverges from the card tab's soft warning: here the constraint is
          // server-enforced, so the UI must not offer a click that will 400.
          // `disabled` is honest because this is impossible for every user —
          // it is not standing in for a permission the caller lacks.
          const locked = typeLocked && !selected;
          return (
            <button
              key={opt.value}
              disabled={locked}
              onClick={locked ? undefined : () => setForm((f) => ({ ...f, field_type: opt.value }))}
              className={`border rounded px-2.5 py-1 text-xs flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40 disabled:cursor-not-allowed ${
                selected ? "border-primary-emphasis text-fg bg-primary/10 font-medium" : "border-line text-fg-secondary hover:border-line-strong"
              }`}
              title={locked ? "This field's type is locked — swimlanes already have values for it." : undefined}
            >
              <span className="font-semibold">{opt.glyph}</span>{opt.label}
            </button>
          );
        })}
      </div>

      {typeLocked && (
        <p id="swimlane-field-type-lock" className="text-xs text-fg-muted mb-3">
          Type is locked — swimlanes already have values for this field. Delete the field and add it again to change the type.
        </p>
      )}

      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Help text</p>
      <input
        type="text"
        value={form.help_text}
        onChange={(e) => setForm((f) => ({ ...f, help_text: e.target.value }))}
        className={`${inputClasses} mb-3`}
        placeholder="Shown as hint text"
      />

      {form.field_type === "dropdown" && (
        <div className="mb-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Choices</p>
          <div className="flex flex-col gap-1 mb-1.5">
            {form.choices.map((choice, i) => (
              <div key={i} className="flex items-center gap-2">
                <span
                  className="text-fg-faint text-xs cursor-grab shrink-0"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i))}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); moveChoice(Number(e.dataTransfer.getData("text/plain")), i); }}
                >⋮⋮</span>
                <input
                  type="text"
                  value={choice}
                  onChange={(e) => updateChoice(i, e.target.value)}
                  className="bg-surface border border-line rounded px-2 py-1 text-xs text-fg-secondary flex-1 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                />
                <button onClick={() => removeChoice(i)} className="text-fg-faint hover:text-danger text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded">✕</button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={addChoice} className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">+ Add choice</button>
            <button onClick={() => setPasteListOpen(!pasteListOpen)} className="text-xs text-info underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded">Paste a list</button>
            {pasteListOpen && <span className="text-xs text-fg-muted">newline-separated</span>}
          </div>
          {pasteListOpen && (
            <div className="mt-2">
              <textarea
                value={pasteListText}
                onChange={(e) => setPasteListText(e.target.value)}
                placeholder="One choice per line"
                rows={4}
                className="bg-surface border border-line rounded px-2 py-1.5 text-xs text-fg-secondary w-full focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              />
              {pasteListText.trim() && (
                <button onClick={applyPastedChoices} className="mt-1.5 text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
                  Add {pasteListText.split("\n").map((l) => l.trim()).filter(Boolean).length} choices
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Visibility sits above the pin toggle: it is the more consequential of
          the two, and the caution line below fires only on the loosening
          transition — the one with a blast radius. */}
      <div className="pt-2 border-t border-line">
        <ToggleField
          checked={form.is_admin_only}
          onChange={(v) => setForm((f) => ({ ...f, is_admin_only: v }))}
          label="Admin only"
          description="Only board admins see this field's values. Members and viewers won't see it on the board."
          labelSize="xs"
        />
        <p className="text-xs h-4 mt-1">
          {!form.is_admin_only && (
            <span className="text-warning">Everyone on this board will see this field's values.</span>
          )}
        </p>
      </div>

      <div className="flex items-center gap-2 mb-1 pt-2">
        <Toggle checked={form.show_on_row} onChange={(v) => setForm((f) => ({ ...f, show_on_row: v }))} aria-label="Pin to swimlane row" />
        <span className="text-xs text-fg-secondary">Pin to swimlane row</span>
        {atPinCap && <span className="text-xs text-fg-muted ml-1">{PIN_CAP} of {PIN_CAP} pinned — you'll pick a swap.</span>}
      </div>

      <p className="text-xs h-4 mt-2">
        {formError && <span className="text-danger">{formError}</span>}
      </p>

      <div className="flex justify-end gap-3 mt-1">
        <button
          onClick={onCancel}
          className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium px-3 py-1.5 rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Save field
        </button>
      </div>
    </div>
  );
}
