/**
 * Board Settings → Field sets (#2570). Board admins create, edit, reorder,
 * delete and copy sets; every other role sees the rows read-only.
 *
 * Saves are pessimistic (the server response is applied, then announced).
 * Deleting a set ungroups its fields; it never deletes a field or a value.
 * The delete confirm copy is built by `deleteSetPrompt` so entry requirements
 * (#1923, MR B) can append the requirements a delete widens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardFull, CustomFieldDefinition, CustomFieldSet, FieldSetSize } from "../../types";
import {
  copyFieldSet, createFieldSet, deleteFieldSet, listBoards, listCustomFieldDefinitions, listFieldSets,
  reorderFieldSets, updateFieldSet, type FieldSetWrite,
} from "../../api/boards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { Button, EmptyState, InlineConfirm, buttonClasses } from "../Page";
import { CUSTOM_FIELD_TYPE_LABEL } from "../../utils/customFieldValue";
import { FIELD_SET_CONFIRM_ESCAPE_PRIORITY, SET_CAP, apiErrorMessage, deleteSetPrompt } from "../../utils/fieldSetSettings";

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

function draftOf(set: CustomFieldSet | null): Draft {
  return set
    ? { name: set.name, description: set.description ?? "", default_size: set.default_size, scope: set.scope, swimlanes: [...set.swimlanes], field_ids: [...set.field_ids] }
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
  const [pick, setPick] = useState("");

  const openSet = openId === "new" ? null : sets.find((s) => s.id === openId) ?? null;
  const dirty = openId !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(openSet));
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
    setPick("");
    setOpenId(id);
    setDraft(draftOf(id === "new" || id === null ? null : sets.find((s) => s.id === id) ?? null));
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
    if (confirmDelete) { cancelDelete(); return true; }
    if (pendingLeave) { cancelLeave(); return true; }
    if (copyOpen) { closeCopy(); return true; }
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
      setDraft(draftOf(saved));
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

  const move = async (index: number, delta: number) => {
    const order = sets.map((s) => s.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    setError(null);
    try {
      onFieldSetsUpdated(await reorderFieldSets(board.id, order));
      setStatus("Field sets reordered.");
    } catch (e) {
      setError({ where: "section", text: apiErrorMessage(e, "Could not reorder the field sets.") });
    }
  };

  const nameMissing = !draft.name.trim();
  const addable = definitions.filter((d) => !draft.field_ids.includes(d.id));
  const elsewhere = (id: number) => {
    const owner = setOfField(id);
    return owner && owner.id !== openSet?.id ? owner : undefined;
  };

  return (
    <div className="flex flex-col gap-4" data-testid="field-sets-section">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-fg focus:outline-none">Field sets</h3>
        {isAdmin && (
          <div className="flex items-center gap-2 flex-wrap">
            <button ref={copyButtonRef} type="button" className={BTN_SECONDARY} aria-disabled={atCap}
              aria-expanded={copyOpen} aria-controls={copyOpen ? "field-set-copy-panel" : undefined}
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
        <CopyFieldSetPanel board={board} onClose={closeCopy} onCopied={async (created) => {
          onFieldSetsUpdated((prev) => (prev.some((s) => s.id === created.id) ? prev : [...prev, created]));
          onFieldsUpdated(await listCustomFieldDefinitions(board.id));
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
          return (
            <li key={id} className="rounded border border-line">
              <div className="flex items-center gap-2 px-3 min-h-11">
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
                    <button type="button" className={`${BTN_QUIET} max-sm:min-w-11`} aria-label={`Move ${set.name} earlier`} aria-disabled={index === 0} onClick={() => void move(index, -1)}>↑</button>
                    <button type="button" className={`${BTN_QUIET} max-sm:min-w-11`} aria-label={`Move ${set.name} later`} aria-disabled={index === sets.length - 1} onClick={() => void move(index, 1)}>↓</button>
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
                          <input type="radio" name="fs-size" checked={draft.default_size === s} onChange={() => setDraft({ ...draft, default_size: s })} />{SIZE_LABEL[s]}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="flex flex-col gap-1">
                    <legend className="text-xs text-fg-muted mb-1">Shows on</legend>
                    <label className="flex items-center gap-1.5 text-sm max-sm:min-h-11">
                      <input type="radio" name="fs-scope" checked={draft.scope === "all"} onChange={() => setDraft({ ...draft, scope: "all", swimlanes: [] })} />Every card
                    </label>
                    <label className="flex items-center gap-1.5 text-sm max-sm:min-h-11">
                      <input type="radio" name="fs-scope" disabled={board.swimlanes.length === 0} checked={draft.scope === "swimlanes"} onChange={() => setDraft({ ...draft, scope: "swimlanes" })} />Only cards in these swimlanes
                    </label>
                    {board.swimlanes.length === 0 && <p className="text-xs text-fg-muted">This board has no swimlanes.</p>}
                    {draft.scope === "swimlanes" && (
                      <div className="flex flex-col gap-1 pl-6">
                        {board.swimlanes.map((sw) => (
                          <label key={sw.id} className="flex items-center gap-1.5 text-sm max-sm:min-h-11">
                            <input type="checkbox" checked={draft.swimlanes.includes(sw.id)} onChange={(e) => setDraft({
                              ...draft, swimlanes: e.target.checked ? [...draft.swimlanes, sw.id] : draft.swimlanes.filter((x) => x !== sw.id),
                            })} />{sw.name}
                          </label>
                        ))}
                      </div>
                    )}
                  </fieldset>
                  <div className="flex flex-col gap-1">
                    <p className="text-xs text-fg-muted">Fields</p>
                    <ul className="flex flex-col gap-1">
                      {definitions.filter((d) => draft.field_ids.includes(d.id)).sort((a, b) => a.position - b.position).map((d) => (
                        <li key={d.id} className="flex items-center gap-2 text-sm">
                          <span className="flex-1 truncate" title={d.name}>{d.name} <span className="text-xs text-fg-muted">{CUSTOM_FIELD_TYPE_LABEL[d.field_type]}</span></span>
                          <button type="button" className={BTN_QUIET} aria-label={`Remove ${d.name} from ${draft.name || "this set"}`}
                            onClick={() => setDraft({ ...draft, field_ids: draft.field_ids.filter((x) => x !== d.id) })}>Remove</button>
                        </li>
                      ))}
                    </ul>
                    {/* Choosing never commits (WCAG 3.2.2): arrowing a closed select would add fields one by one. */}
                    <div className="flex items-end gap-2">
                      <label className="flex-1 min-w-0 flex flex-col gap-1 text-xs text-fg-muted">+ Add field
                        <select className={INPUT} value={pick} onChange={(e) => setPick(e.target.value)}>
                          <option value="">Choose a field…</option>
                          <optgroup label="Not in a set">
                            {addable.filter((d) => !elsewhere(d.id)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </optgroup>
                          <optgroup label="In another set">
                            {addable.filter((d) => elsewhere(d.id)).map((d) => (
                              <option key={d.id} value={d.id}>{d.name} (moves it out of {elsewhere(d.id)?.name})</option>
                            ))}
                          </optgroup>
                        </select>
                      </label>
                      <button type="button" className={BTN_SECONDARY} aria-disabled={!pick} onClick={() => {
                        if (!pick) return;
                        setDraft({ ...draft, field_ids: [...draft.field_ids, Number(pick)] });
                        setPick("");
                      }}>Add</button>
                    </div>
                  </div>
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
            </li>
          );
        })}
      </ul>
      <div role="status" aria-live="polite" className="sr-only">{status}</div>
    </div>
  );
}

/** Copy a field set: pick a board, then one of its sets, preview per field, name, copy. */
export function CopyFieldSetPanel({ board, onClose, onCopied }: { board: BoardFull; onClose: () => void; onCopied: (s: CustomFieldSet) => void | Promise<void> }) {
  const [boards, setBoards] = useState<{ id: number; name: string }[]>([]);
  const [sourceBoard, setSourceBoard] = useState<number | null>(null);
  const [sourceSets, setSourceSets] = useState<CustomFieldSet[]>([]);
  const [sourceDefs, setSourceDefs] = useState<CustomFieldDefinition[]>([]);
  const [sourceSet, setSourceSet] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const boardSelectRef = useRef<HTMLSelectElement>(null);
  const request = useRef(0);
  useEffect(() => { boardSelectRef.current?.focus(); }, []);
  const chooseBoard = (id: number | null) => {
    // Clear at once and drop late answers, so board and set can never mismatch.
    const mine = ++request.current;
    setSourceBoard(id);
    setSourceSets([]);
    setSourceDefs([]);
    setSourceSet(null);
    setName("");
    setError(null);
    setLoading(id !== null);
    if (id === null) return;
    Promise.all([listFieldSets(id), listCustomFieldDefinitions(id)])
      .then(([s, d]) => { if (mine !== request.current) return; setSourceSets(s); setSourceDefs(d); setLoading(false); })
      .catch(() => { if (mine !== request.current) return; setError("Could not load that board's field sets."); setLoading(false); });
  };
  useEffect(() => { listBoards().then((bs) => setBoards(bs.filter((b) => b.id !== board.id).map((b) => ({ id: b.id, name: b.name })))).catch(() => setError("Could not load your boards.")); }, [board.id]);
  const chosen = sourceSets.find((s) => s.id === sourceSet) ?? null;
  const preview = chosen ? sourceDefs.filter((d) => chosen.field_ids.includes(d.id)).map((d) => {
    const local = board.custom_field_definitions.find((l) => l.name === d.name);
    const grouped = local && (board.custom_field_sets ?? []).some((s) => s.field_ids.includes(local.id));
    if (local && local.field_type === d.field_type && !grouped) return { d, text: "Uses existing field" };
    if (local) return { d, text: `Creates ${d.name} (copied)` };
    return { d, text: "Creates new field" };
  }) : [];
  const adds = preview.filter((p) => p.text !== "Uses existing field").length;
  const room = 30 - board.custom_field_definitions.length;
  const copy = async () => {
    if (!chosen || sourceBoard === null || adds > room || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCopied(await copyFieldSet(board.id, { source_board: sourceBoard, source_set: chosen.id, name: name.trim() || undefined }));
    } catch (e) {
      setError(apiErrorMessage(e, "Could not copy the field set."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div id="field-set-copy-panel" role="group" aria-label="Copy a field set" className="flex flex-col gap-2 rounded border border-line p-3">
      <p className="text-sm font-semibold text-fg">Copy a field set</p>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">Board
        <select ref={boardSelectRef} className={INPUT} value={sourceBoard ?? ""} onChange={(e) => chooseBoard(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Choose a board…</option>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      {sourceBoard !== null && (
        <label className="flex flex-col gap-1 text-xs text-fg-muted">Field set
          <select className={INPUT} value={sourceSet ?? ""} onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null;
            setError(null);
            setSourceSet(id);
            const s = sourceSets.find((x) => x.id === id);
            const taken = new Set((board.custom_field_sets ?? []).map((x) => x.name));
            setName(s ? (taken.has(s.name) ? `${s.name} (copy)` : s.name) : "");
          }}>
            <option value="">{loading ? "Loading…" : sourceSets.length ? "Choose a set…" : "That board has no field sets"}</option>
            {sourceSets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
      {chosen && (
        <>
          <ul className="flex flex-col gap-0.5 text-sm" aria-label="Preview">
            {preview.map(({ d, text }) => <li key={d.id}>{d.name} <span className="text-xs text-fg-muted">— {text}</span></li>)}
          </ul>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">Name
            <input className={INPUT} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {adds > room && <p className="text-xs text-danger">Copying adds {adds} fields; this board has room for {Math.max(room, 0)}. Delete fields or choose a smaller set.</p>}
        </>
      )}
      <div role="status" className="text-xs text-danger">{error}</div>
      <div className="flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
        <button type="button" className={BTN_PRIMARY} aria-disabled={!chosen || adds > room || busy} aria-busy={busy || undefined} onClick={() => void copy()}>Copy field set</button>
      </div>
    </div>
  );
}
