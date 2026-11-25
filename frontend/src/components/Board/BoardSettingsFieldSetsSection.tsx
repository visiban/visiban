/**
 * Board Settings → Field sets (#2570). Board admins create, edit, reorder,
 * delete and copy sets; every other role sees the rows read-only.
 *
 * Saves are pessimistic (the server response is applied, then announced).
 * Deleting a set ungroups its fields; it never deletes a field or a value.
 * The delete confirm copy is built by `deleteSetPrompt` so entry requirements
 * (#1923, MR B) can append the requirements a delete widens.
 */
import HelpLink from "../Common/HelpLink";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { BoardFull, CustomFieldDefinition, CustomFieldSet, FieldSetSize } from "../../types";
import {
  createFieldSet, deleteFieldSet, listCustomFieldDefinitions, listFieldSets,
  reorderCustomFields, reorderFieldSets, updateFieldSet, type FieldSetWrite,
} from "../../api/boards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { Button, EmptyState, InlineConfirm, buttonClasses } from "../Page";
import { useDragSensors } from "../../hooks/useDragSensors";
import { useSortableFieldDrag } from "../../hooks/useSortableFieldDrag";
import {
  FIELD_SET_CONFIRM_ESCAPE_PRIORITY, FIELD_SET_MENU_ESCAPE_PRIORITY, SET_CAP, apiErrorMessage, deleteSetPrompt, fieldOrderWith, sortByPosition,
} from "../../utils/fieldSetSettings";
import CheckboxDropdown from "../Common/CheckboxDropdown";
import CopyFieldSetDialog from "./CopyFieldSetDialog";
import FieldSetFieldList from "./FieldSetFieldList";
import SortableRow from "./SortableRow";

/** Asks before leaving with unsaved edits: returns true when it took over `proceed`. */
export type FieldSetCloseGuard = (proceed: () => void) => boolean;

const OFF = "aria-disabled:opacity-40 aria-disabled:cursor-not-allowed";
const BTN_PRIMARY = buttonClasses("primary", { className: `${OFF} aria-disabled:hover:bg-button-primary` });
const BTN_SECONDARY = buttonClasses("secondary", { className: `${OFF} aria-disabled:hover:bg-surface` });
const BTN_QUIET = buttonClasses("quiet", { className: `${OFF} aria-disabled:hover:bg-transparent aria-disabled:hover:text-fg-secondary` });
const BTN_DANGER_OUTLINE = buttonClasses("danger-outline");
const INPUT = "w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
const SIZE_LABEL: Record<FieldSetSize, string> = { collapsed: "Collapsed", summary: "Summary", expanded: "All fields" };

interface Props {
  board: BoardFull;
  isAdmin: boolean;
  onFieldSetsUpdated: (sets: CustomFieldSet[] | ((prev: CustomFieldSet[]) => CustomFieldSet[])) => void;
  onFieldsUpdated: (definitions: CustomFieldDefinition[]) => void;
  /** Board settings asks this guard before closing or switching section. */
  registerCloseGuard?: (guard: FieldSetCloseGuard | null) => void;
}

interface Draft { name: string; description: string; default_size: FieldSetSize; scope: "all" | "swimlanes"; swimlanes: number[]; field_ids: number[] }

function draftOf(set: CustomFieldSet | null, definitions: CustomFieldDefinition[] = []): Draft {
  return set
    ? { name: set.name, description: set.description ?? "", default_size: set.default_size, scope: set.scope, swimlanes: [...set.swimlanes], field_ids: sortByPosition(set.field_ids, definitions) }
    : { name: "", description: "", default_size: "summary", scope: "all", swimlanes: [], field_ids: [] };
}

export default function BoardSettingsFieldSetsSection({ board, isAdmin, onFieldSetsUpdated, onFieldsUpdated, registerCloseGuard }: Props) {
  const sets = useMemo(() => [...(board.custom_field_sets ?? [])].sort((a, b) => a.position - b.position), [board.custom_field_sets]);
  const definitions = board.custom_field_definitions;
  const [openId, setOpenId] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  /** What to do if the admin discards the dirty draft. */
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<{ where: "section" | "editor"; text: string } | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  const openSet = openId === "new" ? null : sets.find((s) => s.id === openId) ?? null;
  const dirty = openId !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(openSet, definitions));
  const atCap = sets.length >= SET_CAP;
  const grouped = new Set(sets.flatMap((s) => s.field_ids));
  const setOfField = (id: number) => sets.find((s) => s.field_ids.includes(id));

  // Focus is moved after the re-render that creates (or removes) the target.
  const rowRefs = useRef(new Map<number | "new", HTMLButtonElement | null>());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<(() => HTMLElement | null | undefined) | null>(null);
  useEffect(() => {
    const el = focusNext.current?.();
    if (!el || !el.isConnected) return;
    focusNext.current = null;
    el.focus();
  });
  const rowOf = (id: number | "new" | null) => () => (id === null || id === "new" ? newButtonRef.current : rowRefs.current.get(id));

  const doOpen = (id: number | "new" | null) => {
    setPendingLeave(null);
    setConfirmDelete(false);
    setError(null);
    setOpenId(id);
    setDraft(draftOf(id === "new" || id === null ? null : sets.find((s) => s.id === id) ?? null, definitions));
  };
  const requestOpen = (id: number | "new" | null) => {
    if (dirty) { setPendingLeave(() => () => doOpen(id)); return; }
    doOpen(id);
  };

  const guard = useCallback<FieldSetCloseGuard>((proceed) => {
    if (!dirty) return false;
    setPendingLeave(() => proceed);
    return true;
  }, [dirty]);
  // The open set was deleted elsewhere: close its row, or the stale draft reads
  // as dirty and asks to "Discard changes" to something that no longer exists.
  // Only for a set seen here: a just-created one may not be in props yet.
  const seenOpen = useRef<number | null>(null);
  useEffect(() => {
    if (openSet) { seenOpen.current = openSet.id; return; }
    if (typeof openId !== "number" || seenOpen.current !== openId) return;
    seenOpen.current = null;
    setOpenId(null);
    setDraft(draftOf(null));
    setPendingLeave(null);
    setConfirmDelete(false);
    focusNext.current = () => (document.activeElement === document.body ? headingRef.current : null);
  }, [openId, openSet]);

  useEffect(() => {
    registerCloseGuard?.(guard);
    return () => registerCloseGuard?.(null);
  }, [guard, registerCloseGuard]);

  const cancelDelete = () => {
    focusNext.current = () => deleteButtonRef.current;
    setConfirmDelete(false);
  };
  const cancelLeave = () => {
    focusNext.current = rowOf(openId === "new" ? null : openId);
    setPendingLeave(null);
  };
  const closeCopy = () => {
    focusNext.current = () => copyButtonRef.current;
    setCopyOpen(false);
  };

  useEscapeStack(() => {
    // The copy dialog is on top of everything else here.
    if (copyOpen) { closeCopy(); return true; }
    if (confirmDelete) { cancelDelete(); return true; }
    if (pendingLeave) { cancelLeave(); return true; }
    return false;
  }, FIELD_SET_CONFIRM_ESCAPE_PRIORITY);

  const save = async () => {
    if (busy) return;
    const body: FieldSetWrite = { ...draft, name: draft.name.trim(), description: draft.description.trim() || null };
    setBusy(true);
    setError(null);
    try {
      const saved = openSet ? await updateFieldSet(board.id, openSet.id, body) : await createFieldSet(board.id, body);
      // A move out of another set changes that set too: re-read the list.
      onFieldSetsUpdated(await listFieldSets(board.id));
      // A new set's row replaces the "new" row, taking the focused editor with it.
      if (!openSet) focusNext.current = () => rowRefs.current.get(saved.id);
      setOpenId(saved.id);
      // Order within a set is the board's field order: permute only this set's slots.
      const order = fieldOrderWith(definitions, draft.field_ids);
      if (order) {
        try {
          onFieldsUpdated(await reorderCustomFields(board.id, order));
        } catch (e) {
          // The set is saved; the draft keeps its order so Save can retry it.
          setDraft({ ...draftOf(saved, definitions), field_ids: draft.field_ids });
          setError({ where: "editor", text: apiErrorMessage(e, "The field set was saved, but its field order was not.") });
          return;
        }
      }
      setDraft({ ...draftOf(saved, definitions), field_ids: draft.field_ids });
      setStatus("Field set saved.");
    } catch (e) {
      setError({ where: "editor", text: apiErrorMessage(e, "Could not save the field set.") });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!openSet || busy) return;
    setBusy(true);
    try {
      await deleteFieldSet(board.id, openSet.id);
      const id = openSet.id;
      const index = sets.findIndex((s) => s.id === id);
      const neighbor = sets[index + 1] ?? sets[index - 1];
      focusNext.current = () => (neighbor ? rowRefs.current.get(neighbor.id) : headingRef.current);
      onFieldSetsUpdated((prev) => prev.filter((s) => s.id !== id));
      setStatus(`${openSet.name} deleted. Its fields are now under Other fields.`);
      setOpenId(null);
      setConfirmDelete(false);
    } catch (e) {
      setError({ where: "editor", text: apiErrorMessage(e, "Could not delete the field set.") });
    } finally {
      setBusy(false);
    }
  };

  const reorder = async (from: number, to: number) => {
    if (to < 0 || to >= sets.length || from === to) return;
    const next = arrayMove(sets, from, to);
    setError(null);
    // Shown at once so a dropped row does not snap back; restored on refusal.
    onFieldSetsUpdated(next.map((s, position) => ({ ...s, position })));
    try {
      onFieldSetsUpdated(await reorderFieldSets(board.id, next.map((s) => s.id)));
      setStatus("Field sets reordered.");
    } catch (e) {
      onFieldSetsUpdated(sets);
      setError({ where: "section", text: apiErrorMessage(e, "Could not reorder the field sets.") });
    }
  };
  const dragSensors = useDragSensors({ keyboard: true, sortable: true });
  const setDrag = useSortableFieldDrag(sets, "set");
  const onSetDragEnd = ({ active, over }: DragEndEvent) => {
    if (over) void reorder(sets.findIndex((s) => s.id === active.id), sets.findIndex((s) => s.id === over.id));
  };

  const nameMissing = !draft.name.trim();
  const elsewhere = (id: number) => {
    const owner = setOfField(id);
    return owner && owner.id !== openSet?.id ? owner : undefined;
  };

  return (
    <div className="flex flex-col gap-4" data-testid="field-sets-section">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5">
          <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-fg focus:outline-none">Field sets</h3>
          <HelpLink topic="field-sets" />
        </span>
        {isAdmin && (
          <div className="flex items-center gap-2 flex-wrap">
            <button ref={copyButtonRef} type="button" className={BTN_SECONDARY} aria-disabled={atCap}
              aria-haspopup="dialog"
              aria-describedby={atCap ? "field-set-cap-reason" : undefined}
              onClick={() => { if (!atCap) setCopyOpen(true); }}>Copy from another board</button>
            <button ref={newButtonRef} type="button" className={BTN_PRIMARY} aria-disabled={atCap}
              aria-describedby={atCap ? "field-set-cap-reason" : undefined}
              onClick={() => { if (!atCap) requestOpen("new"); }}>New field set</button>
          </div>
        )}
      </div>
      <p className="text-xs text-fg-muted">
        {grouped.size} of {definitions.length} card fields are in a set · {sets.length} of {SET_CAP} sets
      </p>
      {isAdmin && atCap && <p id="field-set-cap-reason" className="text-xs text-fg-muted">This board has reached its {SET_CAP}-set limit. Delete a set to add a new one.</p>}
      {!isAdmin && <p className="text-xs text-fg-muted">Only board admins can add or edit field sets.</p>}
      {error?.where === "section" && <p role="alert" className="text-xs text-danger">{error.text}</p>}
      {copyOpen && isAdmin && (
        <CopyFieldSetDialog board={board} onClose={closeCopy} onCopied={async (created) => {
          onFieldSetsUpdated((prev) => (prev.some((s) => s.id === created.id) ? prev : [...prev, created]));
          // The copy exists now: a failed re-read must not read as a failed copy,
          // or the retry makes a duplicate.
          setError(null);
          try {
            onFieldsUpdated(await listCustomFieldDefinitions(board.id));
          } catch {
            setError({ where: "section", text: `${created.name} was copied, but its fields could not be loaded. Reload the page to see them.` });
          }
          closeCopy();
          setStatus(`${created.name} copied.`);
        }} />
      )}
      {pendingLeave && (
        <InlineConfirm
          message={`Discard changes to ${draft.name || "the new set"}?`}
          actionLabel="Discard"
          onCancel={cancelLeave}
          onConfirm={() => {
            const run = pendingLeave;
            focusNext.current = rowOf(openId === "new" ? null : openId);
            doOpen(null);
            run();
          }}
        />
      )}
      {sets.length === 0 && openId === null && (
        <EmptyState headingLevel="h4" title="No field sets yet"
          description="A field set groups related card fields into one collapsible block."
          action={isAdmin ? <button type="button" className={BTN_SECONDARY} onClick={() => doOpen("new")}>Create a field set</button> : undefined} />
      )}
      <DndContext sensors={dragSensors} collisionDetection={closestCenter} accessibility={setDrag.accessibility}
        onDragStart={setDrag.onDragStart} onDragCancel={setDrag.onDragCancel} onDragEnd={setDrag.wrapDragEnd(onSetDragEnd)}>
      <SortableContext items={sets.map((s) => s.id)} strategy={verticalListSortingStrategy}>
      <ul className="flex flex-col gap-2">
        {[...sets, ...(openId === "new" ? [null] : [])].map((set, index) => {
          const id = set?.id ?? "new";
          const open = openId === id;
          const meta = set
            ? `${set.field_ids.length} field${set.field_ids.length === 1 ? "" : "s"} · ${set.scope === "all" ? "Every card" : `${set.swimlanes.length} swimlane${set.swimlanes.length === 1 ? "" : "s"}`} · ${SIZE_LABEL[set.default_size]}`
            : "";
          const label = (
            <>
              {set ? set.name : "New field set"}
              {set && <span className="ml-2 text-xs text-fg-muted">{meta}</span>}
            </>
          );
          const title = set ? `${set.name} · ${meta}` : undefined;
          const body = (handle: ReactNode) => (
            <>
              <div className="flex items-center gap-2 px-3 min-h-11">
                {handle}
                {isAdmin ? (
                  <button ref={(el) => { rowRefs.current.set(id, el); }} type="button" aria-expanded={open} title={title}
                    onClick={() => requestOpen(open ? null : id)}
                    className="flex-1 min-w-0 flex items-center gap-1.5 text-left text-sm text-fg rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis max-sm:min-h-11">
                    <svg className={`w-3.5 h-3.5 shrink-0 text-fg-faint transition-transform ${open ? "" : "-rotate-90"}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                    <span className="min-w-0 truncate">{label}</span>
                  </button>
                ) : (
                  <p className="flex-1 min-w-0 truncate text-sm text-fg" title={title}>{label}</p>
                )}
                {isAdmin && set && (
                  <>
                    <button type="button" className={`${BTN_QUIET} sm:hidden max-sm:min-w-11`} aria-label={`Move ${set.name} earlier`} aria-disabled={index === 0} onClick={() => void reorder(index, index - 1)}>↑</button>
                    <button type="button" className={`${BTN_QUIET} sm:hidden max-sm:min-w-11`} aria-label={`Move ${set.name} later`} aria-disabled={index === sets.length - 1} onClick={() => void reorder(index, index + 1)}>↓</button>
                  </>
                )}
              </div>
              {open && isAdmin && (
                <div className="flex flex-col gap-3 px-3 pb-3 border-t border-line pt-3">
                  <label className="flex flex-col gap-1 text-xs text-fg-muted">Name
                    <input className={INPUT} maxLength={100} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-fg-muted">Description (optional)
                    <input className={INPUT} maxLength={120} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                  </label>
                  <fieldset className="flex flex-col gap-1">
                    <legend className="text-xs text-fg-muted mb-1">Default size</legend>
                    <div className="flex gap-3 flex-wrap">
                      {(["collapsed", "summary", "expanded"] as FieldSetSize[]).map((s) => (
                        <label key={s} className="flex items-center gap-1.5 text-sm max-sm:min-h-11">
                          <input type="radio" className="accent-primary" name="fs-size" checked={draft.default_size === s} onChange={() => setDraft({ ...draft, default_size: s })} />{SIZE_LABEL[s]}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="flex flex-col gap-1">
                    <legend className="text-xs text-fg-muted mb-1">Shows on</legend>
                    <label className="flex items-center gap-1.5 text-sm max-sm:min-h-11">
                      <input type="radio" className="accent-primary" name="fs-scope" checked={draft.scope === "all"} onChange={() => setDraft({ ...draft, scope: "all", swimlanes: [] })} />Every card
                    </label>
                    <label className="flex items-center gap-1.5 text-sm max-sm:min-h-11">
                      <input type="radio" className="accent-primary" name="fs-scope" disabled={board.swimlanes.length === 0} checked={draft.scope === "swimlanes"} onChange={() => setDraft({ ...draft, scope: "swimlanes" })} />Only cards in these swimlanes
                    </label>
                    {board.swimlanes.length === 0 && <p className="text-xs text-fg-muted">This board has no swimlanes.</p>}
                    {draft.scope === "swimlanes" && (
                      <div className="pl-6">
                        <CheckboxDropdown
                          label="Swimlanes"
                          options={board.swimlanes.map((sw) => ({ value: sw.id, label: sw.name }))}
                          selected={draft.swimlanes}
                          onChange={(swimlanes) => setDraft({ ...draft, swimlanes })}
                          escapePriority={FIELD_SET_MENU_ESCAPE_PRIORITY}
                        />
                      </div>
                    )}
                  </fieldset>
                  <FieldSetFieldList
                    definitions={definitions}
                    fieldIds={draft.field_ids}
                    setName={draft.name}
                    otherSetOf={(fieldId) => elsewhere(fieldId)?.name}
                    onChange={(field_ids) => setDraft({ ...draft, field_ids })}
                  />
                  {confirmDelete && openSet ? (
                    <InlineConfirm message={deleteSetPrompt(openSet)} actionLabel="Delete set" busy={busy}
                      onCancel={cancelDelete} onConfirm={() => void remove()} />
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      {openSet && <button ref={deleteButtonRef} type="button" className={BTN_DANGER_OUTLINE} onClick={() => setConfirmDelete(true)}>Delete set</button>}
                      <span className="flex-1" />
                      {nameMissing && <span id="field-set-name-reason" className="text-xs text-fg-muted">Enter a name to save.</span>}
                      <Button variant="quiet" onClick={() => { focusNext.current = rowOf(openId); doOpen(null); }}>Cancel</Button>
                      <button type="button" className={BTN_PRIMARY} aria-disabled={busy || nameMissing}
                        aria-describedby={nameMissing ? "field-set-name-reason" : undefined}
                        onClick={() => { if (!nameMissing) void save(); }}>Save field set</button>
                    </div>
                  )}
                  {error?.where === "editor" && <p role="alert" className="text-xs text-danger">{error.text}</p>}
                </div>
              )}
            </>
          );
          return set && isAdmin
            ? <SortableRow key={id} id={set.id} name={set.name} className="rounded border border-line bg-surface">{body}</SortableRow>
            : <li key={id} className="rounded border border-line">{body(null)}</li>;
        })}
      </ul>
      </SortableContext>
      </DndContext>
      <div role="status" aria-live="polite" className="sr-only">{status}</div>
    </div>
  );
}
