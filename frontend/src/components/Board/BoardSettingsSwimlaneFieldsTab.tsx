import { useEffect, useId, useRef, useState } from "react";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BoardFull, CustomFieldType, LaneTier, SwimlaneCustomFieldDefinition } from "../../types";
import { BAND_MAX_COUNT, DEFAULT_LANE_DETAILS_CAP, LANE_DETAILS_CAP_OPTIONS, effectiveLaneDetailsCap, isLegacyTiers, resolveLaneTiers } from "../../utils/laneBand";
import ModalWrapper from "../shared/ModalWrapper";
import { useDragSensors } from "../../hooks/useDragSensors";
import { useSortableFieldDrag } from "../../hooks/useSortableFieldDrag";
import { Toggle, ToggleField } from "../Common/Toggle";
import HelpLink from "../Common/HelpLink";
import {
  createSwimlaneCustomFieldDefinition,
  updateSwimlaneCustomFieldDefinition,
  deleteSwimlaneCustomFieldDefinition,
  reorderSwimlaneCustomFields,
} from "../../api/boards";
import CustomFieldValueDisplay from "../Card/CustomFieldValueDisplay";
import NumberFormatFields from "./NumberFormatFields";
import { EMPTY_NUMBER_FORMAT, choiceColorsPayload, draftChoiceColor, numberFormatDraftFrom, numberFormatPayload, pastedChoicesToAdd, withChoiceColor, withoutChoiceColor, type NumberFormatDraft } from "../../utils/customFieldValue";
import ChoiceColorPicker from "./ChoiceColorPicker";
import SortableChoiceList from "./SortableChoiceList";
import { resolveChoiceColor } from "../../constants/choiceColors";
import AdminOnlyFieldGlyph from "../Common/AdminOnlyFieldGlyph";
import { typeLockedMessage } from "../../constants/customFields";
import { isImeComposing } from "../../utils/imeComposition";

interface Props {
  board: BoardFull;
  isAdmin: boolean;
  onFieldsUpdated: (definitions: SwimlaneCustomFieldDefinition[]) => void;
  /**
   * #1418 — the same optimistic board PATCH the Rules-tab toggles use
   * (`useBoard.updateBoardSettings`). Omitted → the row-chip names setting
   * renders as a read-only line.
   */
  onUpdateBoardSettings?: (patch: Record<string, unknown>) => void;
  /** #2663 — Band fields this screen shows. Omitted (unknown): no "fit on this screen" line. */
  bandSlots?: number;
}

const ROW_CHIP_NAMES_HELP =
  "Turn off to show values only. Names stay available on hover and in the row's field list. Checkbox fields always show their name.";

/**
 * #1418 — board-level admin setting for the `{name}:` label on pinned
 * swimlane row chips. One switch for the whole board, deliberately not a
 * per-viewer preference and not per-field. Non-admins (or a caller with no
 * write callback) get a read-only line instead of a control.
 */
function RowChipNamesSetting({ board, isAdmin, onUpdateBoardSettings }: {
  board: BoardFull;
  isAdmin: boolean;
  onUpdateBoardSettings?: (patch: Record<string, unknown>) => void;
}) {
  const id = useId();
  const shown = board.show_row_chip_field_names !== false;
  if (!isAdmin || !onUpdateBoardSettings) {
    return (
      <p className="text-sm text-fg-secondary mb-3">
        Field names on row chips: {shown ? "shown" : "hidden"}
      </p>
    );
  }
  return (
    <div className="flex items-center justify-between py-2 mb-3 border-b border-line/60">
      <label htmlFor={id} className="min-w-0 flex-1 pr-4 cursor-pointer">
        <span className="text-sm text-fg">Show field names on row chips</span>
        <span id={`${id}-help`} className="block text-xs text-fg-muted mt-0.5">{ROW_CHIP_NAMES_HELP}</span>
      </label>
      <Toggle
        id={id}
        checked={shown}
        onChange={(v) => onUpdateBoardSettings({ show_row_chip_field_names: v })}
        aria-label="Show field names on row chips"
        aria-describedby={`${id}-help`}
      />
    </div>
  );
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
  text: "Text", number: "Number", date: "Date", dropdown: "Dropdown", checkbox: "Checkbox", url: "URL", multi_select: "Multi-select",
};

const TYPE_GLYPH: Record<CustomFieldType, string> = {
  text: "Aa", number: "#", date: "📅", dropdown: "▾", checkbox: "☑", url: "↗", multi_select: "☰",
};

/** Types whose definition carries a `choices` list (#1391: dropdown, multi-select). */
const TIER_LABEL: Record<LaneTier, string> = { band: "Band", details: "Details", hidden: "Hidden" };
const BAND_FULL_REASON = `The band holds ${BAND_MAX_COUNT} fields. Move one to Details first.`;
const detailsFullReason = (cap: number) => `Lane details hold ${cap} fields. Move one to Hidden first.`;

/**
 * The local mirror of the server's materialization (#2439, `lane_field_tiers.materialize`):
 * the first tier write gives every null row the tier it already resolves to (on a board with
 * no tiers set, first two Band, the rest Details with the cap grown to fit, #2658). Applied
 * before the write so this tab shows what the server will hold without waiting for the per-row
 * `swimlane_custom_field.updated` events.
 */
function materializeLocal(fields: SwimlaneCustomFieldDefinition[], cap: number): SwimlaneCustomFieldDefinition[] {
  const tiers = resolveLaneTiers(fields, cap);
  return fields.map((f) => (f.band_visibility == null ? { ...f, band_visibility: tiers.get(f.id) } : f));
}

function hasChoices(t: CustomFieldType): boolean {
  return t === "dropdown" || t === "multi_select";
}


// Mirror SwimlaneCustomFieldDefinition.MAX_PER_BOARD. The server is
// authoritative and will 400 regardless; this only drives the local affordance.
//
// #2303: no pin control. The swimlane band (#2271, docs/development/board-redesign.md
// § Swimlane bands) shows the first two fields by position and all of them in the "N fields" grid,
// so the `show_on_row` pin flag no longer changes anything on the board. The field
// stays in the API and the TypeScript type (1.0 contract); this tab never sends it,
// so a saved pin is left as it was.
const FIELD_CAP = 30; // 15 until #2438

interface FormState {
  name: string;
  field_type: CustomFieldType;
  choices: string[];
  help_text: string;
  /** #1391: number-format options; sent only meaningfully when field_type is "number". */
  number_format: NumberFormatDraft;
  /** #1391: per-choice colors keyed by the choice text as typed; sent only for choice types. */
  choice_colors: Record<string, string>;
  is_admin_only: boolean;
}

function emptyForm(): FormState {
  // is_admin_only defaults ON, matching the model default. Loosening a field
  // later is additive; tightening one changes what an install already exposes.
  return { name: "", field_type: "text", choices: [], help_text: "", number_format: EMPTY_NUMBER_FORMAT, choice_colors: {}, is_admin_only: true };
}

function formFromDefinition(d: SwimlaneCustomFieldDefinition): FormState {
  return {
    name: d.name, field_type: d.field_type, choices: [...d.choices],
    help_text: d.help_text, number_format: numberFormatDraftFrom(d), choice_colors: { ...(d.choice_colors ?? {}) }, is_admin_only: d.is_admin_only,
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
export default function BoardSettingsSwimlaneFieldsTab({ board, isAdmin, onFieldsUpdated, onUpdateBoardSettings, bandSlots }: Props) {
  const [fields, setFields] = useState<SwimlaneCustomFieldDefinition[]>(
    () => [...board.swimlane_custom_field_definitions].sort((a, b) => a.position - b.position)
  );
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [pasteListOpen, setPasteListOpen] = useState(false);
  const [pasteListText, setPasteListText] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SwimlaneCustomFieldDefinition | null>(null);
  const [deleteInput, setDeleteInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [tierError, setTierError] = useState<string | null>(null);
  // #2658 "Grow cap to fit": a board with no tiers set reads with its cap grown to hold every
  // Details field, and its first tier write stores that cap (sent as `board.updated`). Until that
  // event lands, `grownCap` keeps the grown value so the counts never read the stale stored cap.
  const [grownCap, setGrownCap] = useState(0);
  useEffect(() => { setGrownCap(0); }, [board.lane_details_cap]);
  const cap = Math.max(effectiveLaneDetailsCap(fields, board.lane_details_cap ?? DEFAULT_LANE_DETAILS_CAP), grownCap);
  const tiers = resolveLaneTiers(fields, cap);
  const tierOf = (f: SwimlaneCustomFieldDefinition): LaneTier => tiers.get(f.id) ?? "details";
  const bandCount = fields.filter((f) => tierOf(f) === "band").length;
  const detailsCount = fields.filter((f) => tierOf(f) === "details").length;
  const unset = isLegacyTiers(fields);
  const q = query.trim().toLowerCase();
  const visibleFields = q ? fields.filter((f) => f.name.toLowerCase().includes(q)) : fields;
  /** Why `tier` cannot be chosen for `def`, or null when it can (the server enforces the same rule). */
  const tierBlockedReason = (def: SwimlaneCustomFieldDefinition, tier: LaneTier): string | null => {
    if (tierOf(def) === tier) return null;
    if (tier === "band" && bandCount >= BAND_MAX_COUNT) return BAND_FULL_REASON;
    if (tier === "details" && detailsCount >= cap) return detailsFullReason(cap);
    return null;
  };
  const setTier = async (def: SwimlaneCustomFieldDefinition, tier: LaneTier) => {
    if (tierOf(def) === tier && def.band_visibility != null) return;
    if (tierBlockedReason(def, tier)) return;
    const prev = fields;
    setTierError(null);
    if (unset && cap > (board.lane_details_cap ?? DEFAULT_LANE_DETAILS_CAP)) setGrownCap(cap);
    commit(materializeLocal(fields, cap).map((f) => (f.id === def.id ? { ...f, band_visibility: tier } : f)));
    try {
      const updated = await updateSwimlaneCustomFieldDefinition(board.id, def.id, { band_visibility: tier });
      commit(materializeLocal(prev, cap).map((f) => (f.id === def.id ? updated : f)));
    } catch (err: unknown) {
      commit(prev);
      setGrownCap(0);
      const detail = (err as { response?: { data?: { band_visibility?: unknown } } })?.response?.data?.band_visibility;
      setTierError(Array.isArray(detail) ? String(detail[0]) : typeof detail === "string" ? detail : "Couldn't change where this field shows. Try again.");
    }
  };
  const setCap = (next: number) => {
    if (!onUpdateBoardSettings || next === cap) return;
    setTierError(null);
    // A cap change materializes a board with no tiers set on the server too, so mirror it here.
    if (unset) commit(materializeLocal(fields, next));
    onUpdateBoardSettings({ lane_details_cap: next });
  };
  // Keeps DndContext's default keyboard reordering; adds touch press-and-hold (#1287).
  const dragSensors = useDragSensors({ keyboard: true, sortable: true });
  const fieldDrag = useSortableFieldDrag(fields);

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

  const startAdd = () => { setEditingId("new"); setForm(emptyForm()); setFormError(null); setPasteListOpen(false); setPasteListText(""); };
  const startEdit = (def: SwimlaneCustomFieldDefinition) => {
    setEditingId(def.id); setForm(formFromDefinition(def)); setFormError(null);
    setPasteListOpen(false); setPasteListText("");
  };
  const cancelEdit = () => {
    setEditingId(null); setPasteListOpen(false); setPasteListText("");
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
    if (dupe) { setFormError("A swimlane field with this name already exists."); return; }
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

    setSaving(true);
    setFormError(null);
    try {
      if (editingId === "new") {
        const created = await createSwimlaneCustomFieldDefinition(board.id, {
          name,
          field_type: form.field_type,
          choices: hasChoices(form.field_type) ? cleanedChoices : undefined,
          choice_colors: hasChoices(form.field_type) ? choiceColorsPayload(choices, form.choice_colors) : undefined,
          help_text: form.help_text.trim() || undefined,
          ...numberFormat,
          is_admin_only: form.is_admin_only,
        });
        commit([...fields, created]);
      } else if (editingId !== null) {
        const updated = await updateSwimlaneCustomFieldDefinition(board.id, editingId, {
          name,
          field_type: form.field_type,
          choices: hasChoices(form.field_type) ? cleanedChoices : undefined,
          choice_colors: hasChoices(form.field_type) ? choiceColorsPayload(choices, form.choice_colors) : undefined,
          help_text: form.help_text.trim() || undefined,
          ...numberFormat,
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
      setFormError(detail ? typeLockedMessage("swimlanes") : "Couldn't save this field. Check the values and try again.");
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
    const wasEditing = editingId === deleteTarget.id;
    setFields(fields.filter((f) => f.id !== deleteTarget.id));
    try {
      await deleteSwimlaneCustomFieldDefinition(board.id, deleteTarget.id);
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
      commit(await reorderSwimlaneCustomFields(board.id, reordered.map((f) => f.id)));
    } catch {
      setFields(prev);
    }
  };

  if (!isAdmin) {
    // Currently unreachable — every entry point to Board Settings is
    // admin-gated. Kept for parity with the card tab, since that gate is a
    // call-site decision that could change. The read-only "Field names on row
    // chips" line (#1418) sits in this same branch, and in RowChipNamesSetting's
    // `!onUpdateBoardSettings` fallback.
    return (
      <div>
        <p className="mb-2"><HelpLink topic="swimlane-fields" variant="text" /></p>
        <RowChipNamesSetting board={board} isAdmin={false} />
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
                <span className="text-xs text-fg-muted capitalize w-20 whitespace-nowrap shrink-0">{TYPE_LABEL[f.field_type]}</span>
                {f.is_admin_only && <AdminOnlyFieldGlyph />}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={tabRef}>
      <p className="mb-2"><HelpLink topic="swimlane-fields" variant="text" /></p>
      {/* Artboard "4 · Swimlane fields" (#2439), top to bottom: header, row chip names toggle,
          summary bar, field list, the filters line, the help line, the preview. */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-fg focus:outline-none">Swimlane fields</p>
          <p className="text-xs text-fg-tertiary mt-0.5">Choose where each field appears on the lane band. Drag to reorder.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs ${fields.length >= FIELD_CAP - 2 ? "text-warning" : "text-fg-muted"}`}>
            {fields.length} of {FIELD_CAP}
          </span>
          {fields.length >= FIELD_CAP && editingId === null && (
            <button disabled className="text-xs px-3 py-1.5 rounded border border-line-strong bg-surface text-fg-muted disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
              + Add field
            </button>
          )}
          {fields.length > 0 && editingId === null && fields.length < FIELD_CAP && (
            <button data-add-field onClick={startAdd} className="text-xs px-3 py-1.5 rounded bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
              + Add field
            </button>
          )}
        </div>
      </div>
      <RowChipNamesSetting board={board} isAdmin onUpdateBoardSettings={onUpdateBoardSettings} />

      {fields.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-end mb-3 p-3 rounded-lg border border-line bg-sunken" data-testid="swimlane-tier-summary">
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">On the band</p>
            <p className="text-xs text-fg-muted">Beside the lane name · up to {BAND_MAX_COUNT}</p>
            <p className="text-xs font-semibold text-fg mt-1" data-testid="swimlane-band-counter">
              {bandCount} / {BAND_MAX_COUNT}
              {bandSlots !== undefined && bandCount > bandSlots && <span className="font-normal text-fg-muted"> · {bandSlots} fit on this screen</span>}
            </p>
            {bandSlots !== undefined && bandCount > bandSlots && (
              <p className="text-xs text-fg-muted mt-1">Narrower screens show the first fields and move the rest behind “Show N more”.</p>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">In lane details</p>
            <p className="text-xs text-fg-muted">Behind “Show N more”</p>
            <div className="flex items-center gap-2 mt-1">
              <label htmlFor="lane-details-cap" className="text-xs text-fg-muted"><span className="sr-only">In lane details </span>up to</label>
              <select
                id="lane-details-cap"
                value={cap}
                disabled={!onUpdateBoardSettings}
                onChange={(e) => setCap(Number(e.target.value))}
                className="bg-surface border border-line rounded px-2 py-1 text-xs text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                {LANE_DETAILS_CAP_OPTIONS.map((n) => (
                  // A cap below the Details count would 400, on a board with no tiers set too (#2658: its cap grew to fit).
                  <option key={n} value={n} disabled={n < detailsCount}>{n < detailsCount ? `${n} (below the ${detailsCount} in Details)` : n}</option>
                ))}
              </select>
              <span className={`text-xs font-semibold ${detailsCount > cap ? "text-warning" : "text-fg"}`} data-testid="swimlane-details-counter">{detailsCount} / {cap}</span>
            </div>
          </div>
          <div className="min-w-0">
            <label htmlFor="swimlane-field-find" className="sr-only">Find a field</label>
            <input
              id="swimlane-field-find"
              type="search"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setTierError(null); }}
              placeholder="Find a field"
              className="w-full sm:w-44 bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis placeholder-fg-muted"
            />
          </div>
        </div>
      )}
      {tierError && <p role="alert" className="text-xs text-danger-on-tint mb-2">{tierError}</p>}

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
        <DndContext
          sensors={dragSensors}
          accessibility={fieldDrag.accessibility}
          onDragStart={fieldDrag.onDragStart}
          onDragCancel={fieldDrag.onDragCancel}
          onDragEnd={fieldDrag.wrapDragEnd((e) => void handleDragEnd(e))}
        >
          <div className="flex items-center gap-3 pb-1 border-b border-line text-xs font-medium text-fg-muted" aria-hidden="true">
            <span className="w-4 shrink-0" />
            <span className="w-5 shrink-0" />
            <span className="flex-1">Field</span>
            <span className="w-20 shrink-0">Type</span>
            <span className="shrink-0">Show</span>
          </div>
          {q && visibleFields.length === 0 && <p className="text-sm text-fg-muted py-3">No fields match “{query.trim()}”.</p>}
          <SortableContext items={visibleFields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            {visibleFields.map((def) => (
              <FieldRow
                key={def.id}
                def={def}
                editing={editingId === def.id}
                // A filtered list is not the whole order, so a drag in it could not say where a field goes.
                dragDisabled={editingId !== null || q !== ""}
                show={<TierControl def={def} tier={tierOf(def)} blockedReason={(t) => tierBlockedReason(def, t)} onChange={(t) => void setTier(def, t)} />}
                onEdit={() => startEdit(def)}
                onDelete={() => setDeleteTarget(def)}
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
            isNew
            formError={formError}
            saving={saving}
            onSave={() => void handleSave()}
            onCancel={cancelEdit}
          />
        </div>
      )}

      {fields.length > 0 && editingId === null && fields.length >= FIELD_CAP - 2 && fields.length < FIELD_CAP && (
        <p className="pt-3 text-xs text-warning">{FIELD_CAP - fields.length} field{FIELD_CAP - fields.length === 1 ? "" : "s"} left on this board.</p>
      )}
      {fields.length >= FIELD_CAP && editingId === null && (
        <p className="text-xs text-fg-muted mt-2">
          This board has reached its {FIELD_CAP}-field limit. Delete a field to add a new one.
        </p>
      )}

      {fields.length > 0 && (
        <>
          <p className="flex items-center gap-1.5 mt-3 text-xs text-fg-secondary">
            <svg aria-hidden="true" className="w-3.5 h-3.5 text-success shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8.5l3 3 7-7" /></svg>
            Every field can be searched and used in filters, whatever its Show setting.
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            Hidden fields are left off the band and out of the details count. They are listed last in the lane details, under Hidden on band, and stay in filters and exports. Admin-only fields stay visible to admins only.
          </p>
          <TierPreview board={board} fields={fields} tierOf={tierOf} bandSlots={bandSlots} />
        </>
      )}

      {deleteTarget && (
        <ModalWrapper open onClose={() => { setDeleteTarget(null); setDeleteInput(""); }} title="Delete field?" maxWidth="max-w-sm" restoreFocusTo={deleteFocusFallback}>
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
        <path d="M3 10h18M7 14h6" />
      </svg>
      <p className="text-sm text-fg-tertiary font-medium mb-1">No swimlane fields yet</p>
      <p className="text-sm text-fg-muted mb-4 max-w-xs">
        {isAdmin
          ? "Add fields to capture info about each swimlane row — owner, region, renewal date, anything."
          : "This board has no swimlane fields."}
      </p>
      {isAdmin && onAdd && (
        <button data-add-field onClick={onAdd} className="text-sm px-3 py-1.5 rounded bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
          + Add field
        </button>
      )}
    </div>
  );
}

/**
 * The segmented Band | Details | Hidden control on each field row (#2439). A blocked option
 * stays focusable (`aria-disabled`) so its reason, in the tooltip and the accessible
 * description, can be reached; choosing it does nothing.
 */
function TierControl({ def, tier, blockedReason, onChange }: {
  def: SwimlaneCustomFieldDefinition; tier: LaneTier; blockedReason: (t: LaneTier) => string | null; onChange: (t: LaneTier) => void;
}) {
  const reasonId = useId();
  const order: LaneTier[] = ["band", "details", "hidden"];
  // A blocked option's reason must reach keyboard and touch users, not only a hover tooltip.
  const [shownReason, setShownReason] = useState<string | null>(null);
  // Roving tabindex: one Tab stop per row; Left/Right move focus between options (a blocked
  // one included, so its reason can be heard), Space/Enter chooses.
  const onKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[role=radio]"));
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(i + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
    next?.focus();
  };
  return (
    <span className="relative inline-flex">
    <span role="radiogroup" onKeyDown={onKeyDown} aria-label={`Show ${def.name}`} className="inline-flex rounded border border-line-strong overflow-hidden" data-testid={`swimlane-tier-${def.id}`}>
      {(["band", "details", "hidden"] as LaneTier[]).map((t) => {
        const reason = blockedReason(t);
        const checked = tier === t;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={reason ? true : undefined}
            aria-describedby={reason ? `${reasonId}-${t}` : undefined}
            tabIndex={checked ? 0 : -1}
            title={reason ?? undefined}
            onFocus={() => setShownReason(reason)}
            onBlur={() => setShownReason(null)}
            onClick={() => { if (!reason) onChange(t); else setShownReason(reason); }}
            className={`min-h-6 px-2 py-0.5 text-xs border-l first:border-l-0 border-line-strong focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis ${checked ? "bg-primary-soft text-fg font-semibold" : "bg-surface text-fg-secondary hover:bg-surface-hover"} ${reason ? "opacity-40 cursor-not-allowed" : ""}`}
          >
            {TIER_LABEL[t]}
          </button>
        );
      })}
      {order.map((t) => { const r = blockedReason(t); return r ? <span key={t} id={`${reasonId}-${t}`} className="sr-only">{r}</span> : null; })}
    </span>
    {shownReason && (
      <span aria-hidden="true" data-testid="swimlane-tier-reason" className="absolute right-0 top-full z-10 mt-1 w-56 rounded border border-line-strong bg-surface px-2 py-1 text-xs text-fg shadow-lg">{shownReason}</span>
    )}
    </span>
  );
}

/** A live band built from the current settings (#2439): the name, the Band fields and "Show N more". */
function TierPreview({ board, fields, tierOf, bandSlots = BAND_MAX_COUNT }: {
  board: BoardFull; fields: SwimlaneCustomFieldDefinition[]; tierOf: (f: SwimlaneCustomFieldDefinition) => LaneTier; bandSlots?: number;
}) {
  const lane = board.swimlanes?.[0];
  const values = new Map((lane?.custom_field_values ?? []).map((v) => [v.field_definition, v.value]));
  const onBand = fields.filter((f) => tierOf(f) === "band");
  // #2663: as on the lane, fields past this screen's slots count in "Show N more".
  const band = onBand.slice(0, bandSlots);
  const details = fields.filter((f) => tierOf(f) === "details");
  const hidden = fields.filter((f) => tierOf(f) === "hidden");
  const more = onBand.length - band.length + details.length + hidden.length;
  return (
    <div className="mt-3" data-testid="swimlane-tier-preview">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1">Preview</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-line bg-surface px-3 py-2 text-sm">
        <span className="font-semibold text-fg">{lane?.name ?? "Lane"}</span>
        {band.map((f) => {
          const v = values.get(f.id);
          // The band's own renderer, so a multi-select, date or number shows as it will on the lane.
          return v
            ? <CustomFieldValueDisplay key={f.id} definition={f} value={v} variant="band" adminOnly={f.is_admin_only} singleLine />
            : <span key={f.id} className="text-fg-secondary">{f.name} <span className="text-fg font-medium">—</span></span>;
        })}
        {more > 0 && <span className="text-xs text-fg-secondary">Show {more} more</span>}
      </div>
      <p className="mt-1 text-xs text-fg-muted">Details: {more > hidden.length ? [...onBand.slice(band.length), ...details].map((f) => f.name).join(", ") : "none"}</p>
      <p className="text-xs text-fg-muted">Hidden on band: {hidden.length ? hidden.map((f) => f.name).join(", ") : "none"}</p>
    </div>
  );
}

interface FieldRowProps {
  def: SwimlaneCustomFieldDefinition;
  /** The row's Show control (#2439). */
  show?: React.ReactNode;
  editing: boolean;
  dragDisabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
  children?: React.ReactNode;
}

function FieldRow({ def, editing, dragDisabled, show, onEdit, onDelete, children }: FieldRowProps) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: def.id, disabled: dragDisabled });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  if (editing) {
    return <div ref={setNodeRef} style={style}>{children}</div>;
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
          className="w-4 text-fg-tertiary hover:text-fg cursor-grab opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 transition shrink-0 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          aria-label={`Drag to reorder ${def.name}`}
          title={dragDisabled && !editing ? "Clear the search to reorder fields" : undefined}
        >
          <span aria-hidden="true">⋮⋮</span>
        </button>
        <span className="w-5 text-center text-fg-tertiary shrink-0" aria-hidden="true">{TYPE_GLYPH[def.field_type]}</span>
        <span className="flex-1 min-w-0 truncate text-sm text-fg" title={def.name}>{def.name}</span>
        <span className="text-xs text-fg-muted capitalize w-20 whitespace-nowrap shrink-0">{TYPE_LABEL[def.field_type]}</span>
        {/* Only the exception is marked. Admin-only is the default, so marking
            it everywhere would be noise; a public field is the surprise. */}
        {def.is_admin_only && (
          <span title="Admin only — members and viewers can't see this field's values" className="shrink-0 flex items-center">
            <AdminOnlyFieldGlyph />
          </span>
        )}
        {show}
        <span className="flex items-center gap-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition shrink-0">
          <button type="button" onClick={onEdit} className="text-xs text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded" title={`Edit ${def.name}`} aria-label={`Edit ${def.name}`}>✎</button>
          <button type="button" onClick={onDelete} className="text-xs text-fg-tertiary hover:text-danger focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded" title={`Delete ${def.name}`} aria-label={`Delete ${def.name}`}>✕</button>
        </span>
      </div>
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
  isNew: boolean;
  formError: string | null;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  /** Present only when editing an existing field (admin-only tab): opens the type-the-name delete confirmation. */
  onDelete?: () => void;
}

function FieldEditPanel({
  form, setForm, typeLocked,
  addChoice, removeChoice, updateChoice, moveChoice,
  pasteListOpen, setPasteListOpen, pasteListText, setPasteListText, applyPastedChoices,
  isNew, formError, saving, onSave, onCancel, onDelete,
}: FieldEditPanelProps) {
  const pastedCount = pasteListOpen ? pastedChoicesToAdd(pasteListText, form.choices).length : 0;
  const inputClasses = "bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent w-full";

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
      <div className="flex gap-1.5 flex-wrap mb-2" role="group" aria-label="Field type" aria-describedby={typeLocked ? "swimlane-field-type-lock" : undefined}>
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
            >
              <span className="font-semibold">{opt.glyph}</span>{opt.label}
            </button>
          );
        })}
      </div>

      {typeLocked && (
        <p id="swimlane-field-type-lock" className="text-xs text-fg-muted mb-3 max-w-prose">
          {typeLockedMessage("swimlanes")}
        </p>
      )}

      {form.field_type === "multi_select" && (
        <p className="text-xs text-fg-muted mb-3">People can pick more than one choice.</p>
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
                  <button type="button" onClick={() => removeChoice(i)} aria-label={choice.trim() ? `Remove choice ${choice.trim()}` : `Remove choice ${i + 1}`} className="text-fg-muted hover:text-danger text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded">✕</button>
                </>
              )}
            />
          </div>
          {/* Shown only once a choice actually has a color to lose. */}
          {form.choices.some((c) => resolveChoiceColor(draftChoiceColor(form.choice_colors, c)) !== null) && (
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

      {/* The caution line below fires only on the loosening transition, the one
          with a blast radius. */}
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
