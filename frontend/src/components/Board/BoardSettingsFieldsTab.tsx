import { useEffect, useRef, useState } from "react";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
import { useConfirmAnnouncement } from "../../hooks/useConfirmAnnouncement";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BoardFull, CustomFieldDefinition, CustomFieldType } from "../../types";
import ModalWrapper from "../shared/ModalWrapper";
import { useDragSensors } from "../../hooks/useDragSensors";
import { Toggle } from "../Common/Toggle";
import {
  createCustomFieldDefinition,
  updateCustomFieldDefinition,
  listCustomFieldDefinitions,
  deleteCustomFieldDefinition,
  reorderCustomFields,
} from "../../api/boards";
import NumberFormatFields from "./NumberFormatFields";
import ThresholdFields from "./ThresholdFields";
import { EMPTY_NUMBER_FORMAT, EMPTY_THRESHOLD_DRAFT, thresholdDraftFrom, thresholdPayload, type ThresholdDraft, choiceColorsPayload, draftChoiceColor, numberFormatDraftFrom, numberFormatPayload, pastedChoicesToAdd, withChoiceColor, withoutChoiceColor, type NumberFormatDraft } from "../../utils/customFieldValue";
import ChoiceColorPicker from "./ChoiceColorPicker";
import SortableChoiceList from "./SortableChoiceList";
import { isChoiceColorKey } from "../../constants/choiceColors";
import { typeLockedMessage } from "../../constants/customFields";
import { isImeComposing } from "../../utils/imeComposition";

interface Props {
  board: BoardFull;
  isAdmin: boolean;
  onFieldsUpdated: (definitions: CustomFieldDefinition[]) => void;
}

const FIELD_TYPE_OPTIONS: { value: CustomFieldType; label: string; glyph: string }[] = [
  { value: "text", label: "Text", glyph: "Aa" },
  { value: "number", label: "Number", glyph: "#" },
  { value: "date", label: "Date", glyph: "📅" },
  { value: "dropdown", label: "Dropdown", glyph: "▾" },
  { value: "checkbox", label: "Checkbox", glyph: "☑" },
  { value: "url", label: "URL", glyph: "↗" },
  { value: "multi_select", label: "Multi-select", glyph: "☰" },
];

const TYPE_LABEL: Record<CustomFieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  dropdown: "Dropdown",
  checkbox: "Checkbox",
  url: "URL",
  multi_select: "Multi-select",
};

const TYPE_GLYPH: Record<CustomFieldType, string> = {
  text: "Aa",
  number: "#",
  date: "📅",
  dropdown: "▾",
  checkbox: "☑",
  url: "↗",
  multi_select: "☰",
};

/** Types whose definition carries a `choices` list (#1391: dropdown, multi-select). */
function hasChoices(t: CustomFieldType): boolean {
  return t === "dropdown" || t === "multi_select";
}


const PIN_ERROR = "Couldn't change that pin. The list now shows what is pinned.";
const FIELD_CAP = 30;
const PIN_CAP = 2;

interface FormState {
  name: string;
  field_type: CustomFieldType;
  choices: string[];
  help_text: string;
  /** #1391: number-format options; sent only meaningfully when field_type is "number". */
  number_format: NumberFormatDraft;
  /** #1391: per-choice colors keyed by the choice text as typed; sent only for choice types. */
  choice_colors: Record<string, string>;
  /** #1122: threshold marking; sent only for number and date fields. */
  thresholds: ThresholdDraft;
  show_on_card: boolean;
}

function emptyForm(): FormState {
  return { name: "", field_type: "text", choices: [], help_text: "", number_format: EMPTY_NUMBER_FORMAT, choice_colors: {}, thresholds: EMPTY_THRESHOLD_DRAFT, show_on_card: false };
}

function formFromDefinition(d: CustomFieldDefinition): FormState {
  return { name: d.name, field_type: d.field_type, choices: [...d.choices], help_text: d.help_text, number_format: numberFormatDraftFrom(d), choice_colors: { ...(d.choice_colors ?? {}) }, thresholds: thresholdDraftFrom(d), show_on_card: d.show_on_card };
}

const TYPE_LOCKED_MESSAGE = typeLockedMessage("cards");

/**
 * Board Settings → Fields tab (#371) — Layout 1: single pane, inline
 * expansion. See the ux-design spec posted on issue #371 for the full
 * rationale; this component implements it directly rather than composing
 * from smaller pieces, since the list/add/edit/reorder states are tightly
 * interdependent (only one row can be in edit mode, drag is disabled while
 * editing, etc.) in a way that doesn't decompose cleanly.
 */
export default function BoardSettingsFieldsTab({ board, isAdmin, onFieldsUpdated }: Props) {
  const [fields, setFields] = useState<CustomFieldDefinition[]>(
    () => [...board.custom_field_definitions].sort((a, b) => a.position - b.position)
  );

  // Re-sync from the parent's board state when it changes for a reason other
  // than this component's own edits (e.g. another admin editing fields
  // concurrently — board.custom_field_definitions updates via the
  // custom_field.* WS handlers in BoardView while this modal is open). Only
  // while no row is mid-edit, so an incoming update never clobbers
  // in-progress local form state.
  useEffect(() => {
    if (editingId === null) {
      setFields([...board.custom_field_definitions].sort((a, b) => a.position - b.position));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excludes editingId: this should re-run only when board's data changes, not when the user starts/stops editing
  }, [board.custom_field_definitions]);
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [pasteListOpen, setPasteListOpen] = useState(false);
  const [pasteListText, setPasteListText] = useState("");
  const [pendingTypeChange, setPendingTypeChange] = useState<CustomFieldType | null>(null);
  const [swapPromptId, setSwapPromptId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomFieldDefinition | null>(null);
  const [deleteInput, setDeleteInput] = useState("");
  const [saving, setSaving] = useState(false);
  // Keeps DndContext's default keyboard reordering; adds touch press-and-hold (#1287).
  const dragSensors = useDragSensors({ keyboard: true, sortable: true });

  const pinnedCount = fields.filter((f) => f.show_on_card).length;

  const commit = (next: CustomFieldDefinition[]) => {
    const sorted = [...next].sort((a, b) => a.position - b.position);
    setFields(sorted);
    onFieldsUpdated(sorted);
  };

  const startAdd = () => {
    setEditingId("new");
    setForm(emptyForm());
    setFormError(null);
    setPendingTypeChange(null);
    setPasteListOpen(false);
    setPasteListText("");
  };

  const startEdit = (def: CustomFieldDefinition) => {
    setEditingId(def.id);
    setForm(formFromDefinition(def));
    setFormError(null);
    setPendingTypeChange(null);
    setPasteListOpen(false);
    setPasteListText("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setPendingTypeChange(null);
    setPasteListOpen(false);
    setPasteListText("");
  };

  const handleTypeSelect = (nextType: CustomFieldType) => {
    // Confirm before changing an *existing, already-persisted* field's type —
    // The server refuses a retype once cards hold values, but this tab has no
    // client-side value count to lock up front (see #2202), so it warns first
    // and the refusal is explained on save. A brand-new unsaved field ("new")
    // has nothing to protect yet, so it commits the selection directly.
    // Returning to the *saved* type needs no prompt: the server accepts a save
    // whose type equals the stored one.
    const savedType = fields.find((f) => f.id === editingId)?.field_type;
    if (editingId !== "new" && nextType !== form.field_type && nextType !== savedType) {
      setPendingTypeChange(nextType);
      return;
    }
    // #1122: thresholds never carry across a type change (the server clears them too).
    setForm((f) => ({ ...f, field_type: nextType, thresholds: EMPTY_THRESHOLD_DRAFT }));
  };

  const confirmTypeChange = () => {
    if (pendingTypeChange) setForm((f) => ({ ...f, field_type: pendingTypeChange, thresholds: EMPTY_THRESHOLD_DRAFT }));
    setPendingTypeChange(null);
  };

  const handlePin = (def: CustomFieldDefinition) => {
    setSwapError(null);
    if (def.show_on_card) {
      void savePin(def, false);
      return;
    }
    if (pinnedCount >= PIN_CAP) {
      setSwapPromptId(def.id);
      return;
    }
    void savePin(def, true);
  };

  const savePin = async (def: CustomFieldDefinition, pinned: boolean) => {
    const prev = fields;
    const next = fields.map((f) => (f.id === def.id ? { ...f, show_on_card: pinned } : f));
    setFields(next);
    try {
      const updated = await updateCustomFieldDefinition(board.id, def.id, { show_on_card: pinned });
      commit(fields.map((f) => (f.id === def.id ? updated : f)));
    } catch {
      // The server may have refused on a stale count (#2193): say so and
      // re-sync, keeping the pre-click list only if the re-sync fails too.
      setSwapError(PIN_ERROR);
      try {
        commit(await listCustomFieldDefinitions(board.id));
      } catch {
        setFields(prev);
      }
    }
  };

  // The unpin must commit before the pin is sent: the server checks the cap
  // before taking any lock, so a parallel pin can be refused while the unpin
  // still succeeds (#2193). On any failure we re-sync from the server rather
  // than roll back to a stale snapshot, since the unpin may have landed.
  const swapPin = async (replaceId: number, newId: number) => {
    setSwapPromptId(null);
    setSwapError(null);
    let unpinned: typeof fields[number] | null = null;
    try {
      unpinned = await updateCustomFieldDefinition(board.id, replaceId, { show_on_card: false });
      const pinned = await updateCustomFieldDefinition(board.id, newId, { show_on_card: true });
      commit(fields.map((f) => (f.id === replaceId ? unpinned! : f.id === newId ? pinned : f)));
    } catch {
      setSwapError("Couldn't finish replacing the pinned field. The list now shows what is pinned; try again.");
      try {
        commit(await listCustomFieldDefinitions(board.id));
      } catch {
        // Re-sync failed too: keep only what the server actually confirmed.
        if (unpinned) {
          const confirmed = unpinned;
          commit(fields.map((f) => (f.id === replaceId ? confirmed : f)));
        }
      }
    }
  };

  const addChoice = () => setForm((f) => ({ ...f, choices: [...f.choices, ""] }));
  // #1391: the color is keyed by the choice text, so removing or renaming a
  // choice drops its color from the draft ("Renaming a choice resets its color").
  const removeChoice = (i: number) => setForm((f) => ({
    ...f,
    choices: f.choices.filter((_, idx) => idx !== i),
    choice_colors: withoutChoiceColor(f.choice_colors, f.choices[i]),
  }));
  const updateChoice = (i: number, value: string) =>
    setForm((f) => ({
      ...f,
      choices: f.choices.map((c, idx) => (idx === i ? value : c)),
      choice_colors: f.choices[i] === value ? f.choice_colors : withoutChoiceColor(f.choice_colors, f.choices[i]),
    }));
  const moveChoice = (from: number, to: number) =>
    setForm((f) => ({ ...f, choices: arrayMove(f.choices, from, to) }));

  /**
   * Move whatever is in the "Paste a list" box into the choices and close it,
   * returning the resulting choice list (#2192). Save calls this too: before
   * #2192 text still sitting in the box was ignored on Save, so removing the
   * original choices and saving straight after a paste failed with "needs at
   * least one choice" (or, with choices left, silently dropped the paste).
   */
  const takePastedChoices = (): string[] => {
    if (!pasteListOpen || !pasteListText.trim()) return form.choices;
    const added = pastedChoicesToAdd(pasteListText, form.choices);
    setForm((f) => ({ ...f, choices: [...f.choices, ...added] }));
    setPasteListText("");
    setPasteListOpen(false);
    return [...form.choices, ...added];
  };
  const applyPastedChoices = () => { takePastedChoices(); };

  const handleSave = async () => {
    const choices = takePastedChoices();
    const name = form.name.trim();
    if (!name) { setFormError("Name is required."); return; }
    const dupe = fields.some((f) => f.id !== editingId && f.name.trim().toLowerCase() === name.toLowerCase());
    if (dupe) { setFormError("A field with this name already exists."); return; }
    const cleanedChoices = choices.map((c) => c.trim()).filter((c) => c !== "");
    if (form.field_type === "dropdown" && cleanedChoices.length === 0) {
      setFormError("A dropdown field needs at least one choice.");
      return;
    }
    if (form.field_type === "multi_select" && cleanedChoices.length === 0) {
      setFormError("A multi-select field needs at least one choice.");
      return;
    }
    // The server caps choices at 100 and its message would be swallowed by the
    // generic save error; a pasted spreadsheet range can easily exceed it.
    if (hasChoices(form.field_type) && cleanedChoices.length > 100) {
      setFormError(`A ${form.field_type === "multi_select" ? "multi-select" : "dropdown"} field may have at most 100 choices.`);
      return;
    }
    // #1391: an invalid decimals entry is already flagged inline under the
    // Format block; refuse to save rather than send something the server 400s.
    const numberFormat = numberFormatPayload(form.field_type === "number", form.number_format);
    if (!numberFormat) return;
    // #1122: same rule for an invalid Thresholds block.
    const thresholds = thresholdPayload(form.field_type, form.thresholds);
    if (!thresholds) return;

    setSaving(true);
    setFormError(null);
    setSwapError(null);
    try {
      if (editingId === "new") {
        const created = await createCustomFieldDefinition(board.id, {
          name,
          field_type: form.field_type,
          choices: hasChoices(form.field_type) ? cleanedChoices : undefined,
          choice_colors: hasChoices(form.field_type) ? choiceColorsPayload(choices, form.choice_colors) : undefined,
          help_text: form.help_text.trim() || undefined,
          ...numberFormat,
          ...thresholds,
        });
        // Commit the created field first: if the follow-up pin is refused the
        // field still exists server-side, and a second Save would re-create it.
        commit([...fields, created]);
        // At the cap the pin goes through the swap prompt (the editor's "you'll
        // pick a swap" hint), never a PATCH the server refuses (#2193).
        let swapFor: number | null = null;
        if (form.show_on_card) {
          if (pinnedCount >= PIN_CAP) swapFor = created.id;
          else {
            try {
              const pinned = await updateCustomFieldDefinition(board.id, created.id, { show_on_card: true });
              commit([...fields, pinned]);
            } catch {
              setSwapError(PIN_ERROR);
              try {
                commit(await listCustomFieldDefinitions(board.id));
              } catch {
                // Re-sync failed: the created field is already in the list.
              }
            }
          }
        }
        setSwapPromptId(swapFor);
      } else if (editingId !== null) {
        // #2193: the editor's pin toggle used to be read on create only, so
        // saving an existing field could not unpin, re-pin or pin it. Sent only
        // when it changed, so a plain rename never touches the pin.
        const current = fields.find((f) => f.id === editingId);
        const pinChanged = current !== undefined && form.show_on_card !== current.show_on_card;
        const needsSwap = pinChanged && form.show_on_card && pinnedCount >= PIN_CAP;
        const updated = await updateCustomFieldDefinition(board.id, editingId, {
          name,
          field_type: form.field_type,
          choices: hasChoices(form.field_type) ? cleanedChoices : undefined,
          choice_colors: hasChoices(form.field_type) ? choiceColorsPayload(choices, form.choice_colors) : undefined,
          help_text: form.help_text.trim() || undefined,
          ...numberFormat,
          ...thresholds,
          ...(pinChanged && !needsSwap ? { show_on_card: form.show_on_card } : {}),
        });
        commit(fields.map((f) => (f.id === editingId ? updated : f)));
        setSwapPromptId(needsSwap ? editingId : null);
      }
      cancelEdit();
    } catch (err: unknown) {
      // The card tab has no client-side value count (the definition payload
      // carries none, and archived cards still count server-side), so the
      // server's `field_type` rejection is the source of truth. Explain it
      // rather than showing the generic failure.
      const detail = (err as { response?: { data?: { field_type?: unknown } } })?.response?.data?.field_type;
      setFormError(detail ? TYPE_LOCKED_MESSAGE : "Couldn't save this field. Check the values and try again.");
    } finally {
      setSaving(false);
    }
  };

  // #2204: after a delete the modal's opener (the row ✕, or the editor's Delete field
  // button) is gone, so focus returns to "+ Add field" (list footer or empty state),
  // or to the tab heading when no enabled Add field button is rendered.
  const tabRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLParagraphElement>(null);
  const deleteFocusFallback = () =>
    tabRef.current?.querySelector<HTMLElement>("button[data-add-field]:not([disabled])") ?? headingRef.current;

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const prev = fields;
    // Deleting from inside the editor: close it on success, or the editor would stay open on a removed field.
    // Focus after the delete: the modal's restoreFocusTo fallback (#2204).
    const wasEditing = editingId === deleteTarget.id;
    setFields(fields.filter((f) => f.id !== deleteTarget.id));
    try {
      await deleteCustomFieldDefinition(board.id, deleteTarget.id);
      // Close only once the DELETE succeeded, so a failure keeps unsaved edits.
      if (wasEditing) cancelEdit();
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
      const updated = await reorderCustomFields(board.id, reordered.map((f) => f.id));
      commit(updated);
    } catch {
      // Matches reorderColumns' rollback-to-pre-drag-order semantics — there's
      // no concurrent-add race here (creation happens through this same tab,
      // serially), so a straight rollback is correct rather than a re-fetch.
      setFields(prev);
    }
  };

  if (!isAdmin) {
    return (
      <div>
        <p className="text-sm text-fg-secondary mb-3">Only board admins can add or edit custom fields.</p>
        {fields.length === 0 ? (
          <EmptyState isAdmin={false} />
        ) : (
          <div>
            {fields.map((f) => (
              <div key={f.id} className="flex items-center gap-3 py-2.5 border-b border-line/60 last:border-0">
                <span className="w-5 text-center text-fg-tertiary shrink-0" aria-hidden="true">{TYPE_GLYPH[f.field_type]}</span>
                <span className="flex-1 min-w-0 truncate text-sm text-fg" title={f.name}>{f.name}</span>
                <span className="text-xs text-fg-muted capitalize w-20 whitespace-nowrap shrink-0">{TYPE_LABEL[f.field_type]}</span>
                {f.show_on_card && (
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
    <div ref={tabRef}>
      <div className="flex items-center justify-between mb-2">
        <p ref={headingRef} tabIndex={-1} className="text-xs font-semibold uppercase tracking-wide text-fg-muted focus:outline-none">Custom fields</p>
        <span className={`text-xs ${fields.length >= FIELD_CAP - 2 ? "text-warning" : "text-fg-muted"}`}>
          {fields.length} of {FIELD_CAP} · {pinnedCount} of {PIN_CAP} pinned
        </span>
      </div>

      {swapError && <p role="alert" className="text-xs text-danger mb-2">{swapError}</p>}

      {fields.length === 0 && editingId === null ? (
        <EmptyState isAdmin onAdd={startAdd} />
      ) : (
        <DndContext sensors={dragSensors} onDragEnd={(e) => void handleDragEnd(e)}>
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
                pinnedFields={fields.filter((f) => f.show_on_card)}
                onSwap={(replaceId) => void swapPin(replaceId, def.id)}
                onCancelSwap={() => setSwapPromptId(null)}
              >
                {editingId === def.id && (
                  <FieldEditPanel
                    form={form}
                    setForm={setForm}
                    onTypeSelect={handleTypeSelect}
                    pendingTypeChange={pendingTypeChange}
                    onConfirmTypeChange={confirmTypeChange}
                    onCancelTypeChange={() => setPendingTypeChange(null)}
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
                    onDelete={() => setDeleteTarget(def)}
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
            onTypeSelect={handleTypeSelect}
            pendingTypeChange={null}
            onConfirmTypeChange={confirmTypeChange}
            onCancelTypeChange={() => setPendingTypeChange(null)}
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
            <button data-add-field onClick={startAdd} className="text-xs px-3 py-1.5 rounded bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
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
        <ModalWrapper open onClose={() => { setDeleteTarget(null); setDeleteInput(""); }} title="Delete field?" maxWidth="max-w-sm" restoreFocusTo={deleteFocusFallback}>
          <p className="text-fg-tertiary text-sm mb-1">
            <span className="text-fg font-medium">{deleteTarget.name}</span> will be permanently deleted.
          </p>
          <p className="text-danger text-sm mb-1">This removes the field and any values stored on cards for it.</p>
          <p className="text-fg-muted text-sm mb-5">This cannot be undone.</p>
          <div className="mb-5">
            <label htmlFor="delete-field-confirm-input" className="block text-xs text-fg-muted mb-1">
              Type <span className="text-fg-secondary font-mono">{deleteTarget.name}</span> to confirm deletion.
            </label>
            <input
              id="delete-field-confirm-input"
              type="text"
              autoFocus
              value={deleteInput}
              onChange={(e) => setDeleteInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeComposing(e) && deleteInput === deleteTarget.name) { e.preventDefault(); void confirmDelete(); }
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
        <path d="M7 9h10M7 13h6" />
      </svg>
      <p className="text-sm text-fg-tertiary font-medium mb-1">No custom fields yet</p>
      <p className="text-sm text-fg-muted mb-4 max-w-xs">
        {isAdmin
          ? "Add fields to capture info specific to this board — sprint, budget, region, anything."
          : "This board has no custom fields."}
      </p>
      {isAdmin && onAdd && (
        <button data-add-field onClick={onAdd} className="text-sm px-3 py-1.5 rounded bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
          + Add field
        </button>
      )}
    </div>
  );
}

interface FieldRowProps {
  def: CustomFieldDefinition;
  editing: boolean;
  dragDisabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
  swapPromptOpen: boolean;
  pinnedFields: CustomFieldDefinition[];
  onSwap: (replaceId: number) => void;
  onCancelSwap: () => void;
  children?: React.ReactNode;
}

function FieldRow({ def, editing, dragDisabled, onEdit, onDelete, onPin, swapPromptOpen, pinnedFields, onSwap, onCancelSwap, children }: FieldRowProps) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: def.id, disabled: dragDisabled });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  if (editing) {
    return (
      <div ref={setNodeRef} style={style}>
        {children}
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={style} className="group">
      <div className="flex items-center gap-3 py-2.5 border-b border-line/60 last:border-0">
        {/* A real button (#1739): dnd-kit's KeyboardSensor (Space/Enter to lift, arrows to
            move, Space to drop, Escape to cancel) is the keyboard reorder path, so the
            handle must be a named, ringed tab stop. `attributes` adds the sortable
            role description and the instructions via aria-describedby. */}
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="w-4 text-fg-tertiary hover:text-fg cursor-grab opacity-0 group-hover:opacity-100 focus:opacity-100 transition shrink-0 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          aria-label={`Drag to reorder ${def.name}`}
        >
          <span aria-hidden="true">⋮⋮</span>
        </button>
        <span className="w-5 text-center text-fg-tertiary shrink-0" aria-hidden="true">{TYPE_GLYPH[def.field_type]}</span>
        <span className="flex-1 min-w-0 truncate text-sm text-fg" title={def.name}>{def.name}</span>
        <span className="text-xs text-fg-muted capitalize w-20 whitespace-nowrap shrink-0">{TYPE_LABEL[def.field_type]}</span>
        <button
          onClick={onPin}
          aria-label={`${def.show_on_card ? "Unpin" : "Pin"} ${def.name} ${def.show_on_card ? "from" : "to"} card face`}
          className={`text-xs rounded px-2 py-0.5 whitespace-nowrap shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
            def.show_on_card
              ? "text-info-on-tint bg-primary-emphasis/10 border border-primary-emphasis/25 font-medium"
              : "text-fg-muted hover:text-fg-secondary"
          }`}
        >
          {def.show_on_card ? "Pinned" : `Pin (${pinnedFields.length} of ${PIN_CAP})`}
        </button>
        <span className="flex items-center gap-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition shrink-0">
          <button type="button" onClick={onEdit} className="text-xs text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded" title={`Edit ${def.name}`} aria-label={`Edit ${def.name}`}>✎</button>
          <button type="button" onClick={onDelete} className="text-xs text-fg-tertiary hover:text-danger focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded" title={`Delete ${def.name}`} aria-label={`Delete ${def.name}`}>✕</button>
        </span>
      </div>
      {swapPromptOpen && (
        <div className="bg-sunken border border-primary-soft rounded p-2.5 mb-2 text-xs">
          <p className="font-semibold text-fg mb-1">The card face holds {PIN_CAP} fields.</p>
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
            <p className="text-fg-muted">Unpinned values stay on the card detail view and in the hover peek.</p>
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
  onTypeSelect: (t: CustomFieldType) => void;
  pendingTypeChange: CustomFieldType | null;
  onConfirmTypeChange: () => void;
  onCancelTypeChange: () => void;
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
  /** Present only when editing an existing field (admin-only tab): opens the type-the-name delete confirmation. */
  onDelete?: () => void;
}

function FieldEditPanel({
  form, setForm, onTypeSelect, pendingTypeChange, onConfirmTypeChange, onCancelTypeChange,
  addChoice, removeChoice, updateChoice, moveChoice,
  pasteListOpen, setPasteListOpen, pasteListText, setPasteListText, applyPastedChoices,
  pinnedCount, isNew, formError, saving, onSave, onCancel, onDelete,
}: FieldEditPanelProps) {
  const pastedCount = pasteListOpen ? pastedChoicesToAdd(pasteListText, form.choices).length : 0;
  const inputClasses = "bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent w-full";
  const atPinCap = pinnedCount >= PIN_CAP && !form.show_on_card;
  // The type button that raised the "Change type" prompt is the trigger focus returns to (#1367).
  const typeTriggerRef = useConfirmFocusReturn(pendingTypeChange);
  useConfirmAnnouncement(
    pendingTypeChange
      ? "If cards already have values for this field, the save will be refused. To use a different type, add a new field of that type, then delete this one. Continue?"
      : null,
  );

  return (
    <div className={isNew ? "" : "bg-sunken border border-primary-soft rounded-lg p-3 my-1"}>
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Field name</p>
      <input
        type="text"
        autoFocus
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        className={`${inputClasses} mb-3`}
        placeholder="e.g. Sprint"
      />

      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Type</p>
      <div className="flex gap-1.5 flex-wrap mb-2" role="group" aria-label="Field type">
        {FIELD_TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            ref={typeTriggerRef(opt.value)}
            onClick={() => onTypeSelect(opt.value)}
            className={`border rounded px-2.5 py-1 text-xs flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
              form.field_type === opt.value ? "border-primary-emphasis text-fg bg-primary/10 font-medium" : "border-line text-fg-secondary hover:border-line-strong"
            }`}
          >
            <span className="font-semibold">{opt.glyph}</span>{opt.label}
          </button>
        ))}
      </div>

      {form.field_type === "multi_select" && (
        <p className="text-xs text-fg-muted mb-3">People can pick more than one choice.</p>
      )}

      {pendingTypeChange && (
        <div className="mb-3 flex items-center gap-2 text-xs">
          <span className="text-warning">If cards already have values for this field, the save will be refused. To use a different type, add a new field of that type, then delete this one. Continue?</span>
          <button onClick={onConfirmTypeChange} className="text-warning hover:underline focus:outline-none focus:ring-2 focus:ring-warning-emphasis rounded">Change type</button>
          <button onClick={onCancelTypeChange} className="text-fg-secondary hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded">Cancel</button>
        </div>
      )}

      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Help text</p>
      <input
        type="text"
        value={form.help_text}
        onChange={(e) => setForm((f) => ({ ...f, help_text: e.target.value }))}
        className={`${inputClasses} mb-3`}
        placeholder="Shown as hint text"
      />

      {form.field_type === "number" && (
        <NumberFormatFields
          draft={form.number_format}
          onChange={(next) => setForm((f) => ({ ...f, number_format: next }))}
        />
      )}

      {(form.field_type === "number" || form.field_type === "date") && (
        <ThresholdFields
          isDate={form.field_type === "date"}
          draft={form.thresholds}
          onChange={(next) => setForm((f) => ({ ...f, thresholds: next }))}
        />
      )}

      {hasChoices(form.field_type) && (
        <div className="mb-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Choices</p>
          <div className="flex flex-col gap-1 mb-1.5">
            <SortableChoiceList
              choices={form.choices}
              onMove={moveChoice}
              renderRow={(choice, i) => (
                <>
                  <ChoiceColorPicker
                    choice={choice}
                    colorKey={draftChoiceColor(form.choice_colors, choice)}
                    onChange={(key) => setForm((f) => ({
                      ...f,
                      choice_colors: withChoiceColor(f.choice_colors, choice, key),
                    }))}
                  />
                  <input
                    type="text"
                    value={choice}
                    onChange={(e) => updateChoice(i, e.target.value)}
                    className="bg-surface border border-line rounded px-2 py-1 text-xs text-fg-secondary flex-1 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  />
                  <button type="button" onClick={() => removeChoice(i)} aria-label={choice.trim() ? `Remove choice ${choice.trim()}` : `Remove choice ${i + 1}`} className="text-fg-faint hover:text-danger text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded">✕</button>
                </>
              )}
            />
          </div>
          {/* Shown only once a choice actually has a color to lose. */}
          {form.choices.some((c) => isChoiceColorKey(draftChoiceColor(form.choice_colors, c))) && (
            <p className="text-xs text-fg-muted mb-1.5">Renaming a choice resets its color.</p>
          )}
          <div className="flex items-center gap-3">
            <button onClick={addChoice} className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">+ Add choice</button>
            <button onClick={() => { if (pasteListOpen) { applyPastedChoices(); setPasteListOpen(false); setPasteListText(""); } else { setPasteListOpen(true); } }} className="text-xs text-info underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded">Paste a list</button>
            {pasteListOpen && <span className="text-xs text-fg-muted">one per line or cell</span>}
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
              {/* The count is what Add will actually add (#2192): before, it counted
                  raw lines, so a paste of already-listed choices said "Add 3" and
                  added nothing. */}
              {pasteListText.trim() && (pastedCount > 0 ? (
                <button onClick={applyPastedChoices} className="mt-1.5 text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
                  Add {pastedCount} {pastedCount === 1 ? "choice" : "choices"}
                </button>
              ) : (
                <p className="mt-1.5 text-xs text-fg-muted">Every pasted choice is already in the list.</p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mb-1 pt-2 border-t border-line">
        <Toggle checked={form.show_on_card} onChange={(v) => setForm((f) => ({ ...f, show_on_card: v }))} aria-label="Pin to card face" />
        <span className="text-xs text-fg-secondary">Pin to card face</span>
        {atPinCap && <span className="text-xs text-fg-muted ml-1">2 of 2 pinned — you'll pick a swap.</span>}
      </div>

      <p className="text-xs min-h-4 mt-2" role="status" aria-live="polite" aria-atomic="true">
        {formError && <span className="text-danger">{formError}</span>}
      </p>

      <div className="flex flex-wrap items-center justify-end gap-3 mt-1">
        {/* #2194: Delete lives in the editor too, since the row's ✕ is easy to
            miss. DOM-first so it sits at the far left, apart from Save, and so
            Tab reaches Delete -> Cancel -> Save (Cancel always sits between
            Delete and Save). It never takes default focus (the name input
            autofocuses) and only renders for an existing field. */}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            className="mr-auto bg-danger-bg hover:bg-danger-bg-hover text-on-danger font-medium px-3 py-1.5 rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
          >
            Delete field
          </button>
        )}
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
