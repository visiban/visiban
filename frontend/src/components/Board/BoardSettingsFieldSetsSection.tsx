/**
 * Board Settings → Field sets (#2570). Board admins create, edit, reorder,
 * delete and copy sets; every other role sees the rows read-only.
 *
 * Saves are pessimistic (the server response is applied, then announced).
 * Deleting a set ungroups its fields; it never deletes a field or a value.
 * The delete confirm copy is built by `deleteSetPrompt` so entry requirements
 * (#1923, MR B) can append the requirements a delete widens.
 */
import { useEffect, useMemo, useState } from "react";
import type { BoardFull, CustomFieldDefinition, CustomFieldSet, FieldSetSize } from "../../types";
import {
  copyFieldSet, createFieldSet, deleteFieldSet, listBoards, listCustomFieldDefinitions, listFieldSets,
  reorderFieldSets, updateFieldSet, type FieldSetWrite,
} from "../../api/boards";
import { useEscapeStack } from "../../hooks/useEscapeStack";

/** The server's `detail` (or first field error) when there is one, else `fallback`. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === "object") {
    const first = Object.values(data as Record<string, unknown>)[0];
    const msg = Array.isArray(first) ? first[0] : first;
    if (typeof msg === "string" && msg) return msg;
  }
  return fallback;
}

export const SET_CAP = 10;
/** Escape priority of the editor's delete / discard confirms (frontend/CLAUDE.md). */
export const FIELD_SET_CONFIRM_ESCAPE_PRIORITY = 40.8;

const BTN_PRIMARY = "px-3 py-1.5 text-sm rounded bg-primary-emphasis text-on-primary hover:opacity-90 max-sm:min-h-11 focus:outline-none focus:ring-2 focus:ring-primary-emphasis aria-disabled:opacity-50 aria-disabled:cursor-not-allowed";
const BTN_SECONDARY = "px-3 py-1.5 text-sm rounded border border-line-strong text-fg-secondary hover:bg-surface-hover max-sm:min-h-11 focus:outline-none focus:ring-2 focus:ring-primary-emphasis aria-disabled:opacity-50 aria-disabled:cursor-not-allowed";
const BTN_QUIET = "px-2 py-1 text-sm rounded text-fg-secondary hover:bg-surface-hover max-sm:min-h-11 focus:outline-none focus:ring-2 focus:ring-primary-emphasis aria-disabled:opacity-50";
const BTN_DANGER = "px-3 py-1.5 text-sm rounded border border-danger text-danger hover:bg-danger/10 max-sm:min-h-11 focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
const INPUT = "w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
const SIZE_LABEL: Record<FieldSetSize, string> = { collapsed: "Collapsed", summary: "Summary", expanded: "All fields" };

/** "Delete {name}? Its {n} fields move to Other fields. No field values are deleted." Extended by #1923. */
export function deleteSetPrompt(set: CustomFieldSet, extra: string[] = []): string {
  const n = set.field_ids.length;
  return [`Delete ${set.name}? Its ${n} field${n === 1 ? "" : "s"} move${n === 1 ? "s" : ""} to Other fields. No field values are deleted.`, ...extra].join(" ");
}

interface Props {
  board: BoardFull;
  isAdmin: boolean;
  onFieldSetsUpdated: (sets: CustomFieldSet[] | ((prev: CustomFieldSet[]) => CustomFieldSet[])) => void;
  onFieldsUpdated: (definitions: CustomFieldDefinition[]) => void;
}

interface Draft { name: string; description: string; default_size: FieldSetSize; scope: "all" | "swimlanes"; swimlanes: number[]; field_ids: number[] }

function draftOf(set: CustomFieldSet | null): Draft {
  return set
    ? { name: set.name, description: set.description ?? "", default_size: set.default_size, scope: set.scope, swimlanes: [...set.swimlanes], field_ids: [...set.field_ids] }
    : { name: "", description: "", default_size: "summary", scope: "all", swimlanes: [], field_ids: [] };
}

export default function BoardSettingsFieldSetsSection({ board, isAdmin, onFieldSetsUpdated, onFieldsUpdated }: Props) {
  const sets = useMemo(() => [...(board.custom_field_sets ?? [])].sort((a, b) => a.position - b.position), [board.custom_field_sets]);
  const definitions = board.custom_field_definitions;
  const [openId, setOpenId] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [pendingOpen, setPendingOpen] = useState<number | "new" | null | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  const openSet = openId === "new" ? null : sets.find((s) => s.id === openId) ?? null;
  const dirty = openId !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(openSet));
  const atCap = sets.length >= SET_CAP;
  const grouped = new Set(sets.flatMap((s) => s.field_ids));
  const setOfField = (id: number) => sets.find((s) => s.field_ids.includes(id));

  useEscapeStack(() => {
    if (confirmDelete) { setConfirmDelete(false); return true; }
    if (pendingOpen !== undefined) { setPendingOpen(undefined); return true; }
    return false;
  }, FIELD_SET_CONFIRM_ESCAPE_PRIORITY);

  const requestOpen = (id: number | "new" | null) => {
    if (dirty) { setPendingOpen(id); return; }
    doOpen(id);
  };
  const doOpen = (id: number | "new" | null) => {
    setPendingOpen(undefined);
    setConfirmDelete(false);
    setError(null);
    setOpenId(id);
    setDraft(draftOf(id === "new" || id === null ? null : sets.find((s) => s.id === id) ?? null));
  };

  const save = async () => {
    if (busy) return;
    const body: FieldSetWrite = { ...draft, name: draft.name.trim(), description: draft.description.trim() || null };
    setBusy(true);
    setError(null);
    try {
      const saved = openSet ? await updateFieldSet(board.id, openSet.id, body) : await createFieldSet(board.id, body);
      // A move out of another set changes that set too: re-read the list.
      onFieldSetsUpdated(await listFieldSets(board.id));
      setOpenId(saved.id);
      setDraft(draftOf(saved));
      setStatus("Field set saved.");
    } catch (e) {
      setError(apiErrorMessage(e, "Could not save the field set."));
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
      onFieldSetsUpdated((prev) => prev.filter((s) => s.id !== id));
      setStatus(`${openSet.name} deleted. Its fields are now under Other fields.`);
      setOpenId(null);
      setConfirmDelete(false);
    } catch (e) {
      setError(apiErrorMessage(e, "Could not delete the field set."));
    } finally {
      setBusy(false);
    }
  };

  const move = async (index: number, delta: number) => {
    const order = sets.map((s) => s.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    try {
      onFieldSetsUpdated(await reorderFieldSets(board.id, order));
    } catch (e) {
      setError(apiErrorMessage(e, "Could not reorder the field sets."));
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="field-sets-section">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-fg">Field sets</h3>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <button type="button" className={BTN_SECONDARY} aria-disabled={atCap} onClick={() => { if (!atCap) setCopyOpen(true); }}>Copy from another board</button>
            <button type="button" className={BTN_PRIMARY} aria-disabled={atCap} onClick={() => { if (!atCap) requestOpen("new"); }}>New field set</button>
          </div>
        )}
      </div>
      <p className="text-xs text-fg-muted">
        {grouped.size} of {definitions.length} card fields are in a set · {sets.length} of {SET_CAP} sets
      </p>
      {isAdmin && atCap && <p className="text-xs text-fg-muted">This board has reached its {SET_CAP}-set limit. Delete a set to add a new one.</p>}
      {!isAdmin && <p className="text-xs text-fg-muted">Only board admins can add or edit field sets.</p>}
      {copyOpen && isAdmin && (
        <CopyFieldSetPanel board={board} onClose={() => setCopyOpen(false)} onCopied={async (created) => {
          onFieldSetsUpdated((prev) => (prev.some((s) => s.id === created.id) ? prev : [...prev, created]));
          onFieldsUpdated(await listCustomFieldDefinitions(board.id));
          setCopyOpen(false);
          setStatus(`${created.name} copied.`);
        }} />
      )}
      {pendingOpen !== undefined && (
        <div role="group" aria-label="Unsaved changes" className="flex items-center gap-2 text-sm">
          <span>Discard changes to {draft.name || "the new set"}?</span>
          <button type="button" className={BTN_QUIET} autoFocus onClick={() => setPendingOpen(undefined)}>Cancel</button>
          <button type="button" className={BTN_DANGER} onClick={() => doOpen(pendingOpen)}>Discard</button>
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {[...sets, ...(openId === "new" ? [null] : [])].map((set, index) => {
          const id = set?.id ?? "new";
          const open = openId === id;
          return (
            <li key={id} className="rounded border border-line">
              <div className="flex items-center gap-2 px-3 min-h-11">
                <button type="button" aria-expanded={open} disabled={!isAdmin && set === null}
                  onClick={() => requestOpen(open ? null : id)}
                  className="flex-1 min-w-0 text-left text-sm text-fg truncate rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis max-sm:min-h-11">
                  {set ? set.name : "New field set"}
                  {set && (
                    <span className="ml-2 text-xs text-fg-muted">
                      {set.field_ids.length} field{set.field_ids.length === 1 ? "" : "s"} · {set.scope === "all" ? "Every card" : `${set.swimlanes.length} swimlane${set.swimlanes.length === 1 ? "" : "s"}`} · {SIZE_LABEL[set.default_size]}
                    </span>
                  )}
                </button>
                {isAdmin && set && (
                  <>
                    <button type="button" className={BTN_QUIET} aria-label={`Move ${set.name} earlier`} aria-disabled={index === 0} onClick={() => void move(index, -1)}>↑</button>
                    <button type="button" className={BTN_QUIET} aria-label={`Move ${set.name} later`} aria-disabled={index === sets.length - 1} onClick={() => void move(index, 1)}>↓</button>
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
                          <span className="flex-1 truncate">{d.name} <span className="text-xs text-fg-muted">{d.field_type}</span></span>
                          <button type="button" className={BTN_QUIET} aria-label={`Remove ${d.name} from ${draft.name || "this set"}`}
                            onClick={() => setDraft({ ...draft, field_ids: draft.field_ids.filter((x) => x !== d.id) })}>Remove</button>
                        </li>
                      ))}
                    </ul>
                    <label className="flex flex-col gap-1 text-xs text-fg-muted">+ Add field
                      <select className={INPUT} value="" onChange={(e) => {
                        const fid = Number(e.target.value);
                        if (fid) setDraft({ ...draft, field_ids: [...draft.field_ids, fid] });
                      }}>
                        <option value="">Choose a field…</option>
                        <optgroup label="Not in a set">
                          {definitions.filter((d) => !draft.field_ids.includes(d.id) && (!setOfField(d.id) || setOfField(d.id)?.id === openSet?.id)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </optgroup>
                        <optgroup label="In another set">
                          {definitions.filter((d) => !draft.field_ids.includes(d.id) && setOfField(d.id) && setOfField(d.id)?.id !== openSet?.id).map((d) => (
                            <option key={d.id} value={d.id}>{d.name} (moves it out of {setOfField(d.id)?.name})</option>
                          ))}
                        </optgroup>
                      </select>
                    </label>
                  </div>
                  {confirmDelete && openSet ? (
                    <div role="group" aria-label="Confirm delete" className="flex items-center gap-2 flex-wrap text-sm">
                      <span>{deleteSetPrompt(openSet)}</span>
                      <button type="button" className={BTN_QUIET} autoFocus onClick={() => setConfirmDelete(false)}>Cancel</button>
                      <button type="button" className={BTN_DANGER} onClick={() => void remove()}>Delete set</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {openSet && <button type="button" className={BTN_DANGER} onClick={() => setConfirmDelete(true)}>Delete set</button>}
                      <span className="flex-1" />
                      <button type="button" className={BTN_QUIET} onClick={() => doOpen(null)}>Cancel</button>
                      <button type="button" className={BTN_PRIMARY} aria-disabled={busy || !draft.name.trim()} onClick={() => { if (draft.name.trim()) void save(); }}>Save field set</button>
                    </div>
                  )}
                  {error && <p role="alert" className="text-xs text-danger">{error}</p>}
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
  useEffect(() => { listBoards().then((bs) => setBoards(bs.filter((b) => b.id !== board.id).map((b) => ({ id: b.id, name: b.name })))).catch(() => setError("Could not load your boards.")); }, [board.id]);
  useEffect(() => {
    if (sourceBoard === null) return;
    Promise.all([listFieldSets(sourceBoard), listCustomFieldDefinitions(sourceBoard)])
      .then(([s, d]) => { setSourceSets(s); setSourceDefs(d); setSourceSet(null); })
      .catch(() => setError("Could not load that board's field sets."));
  }, [sourceBoard]);
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
    if (!chosen || sourceBoard === null || adds > room) return;
    try {
      await onCopied(await copyFieldSet(board.id, { source_board: sourceBoard, source_set: chosen.id, name: name.trim() || undefined }));
    } catch (e) {
      setError(apiErrorMessage(e, "Could not copy the field set."));
    }
  };
  return (
    <div role="group" aria-label="Copy a field set" className="flex flex-col gap-2 rounded border border-line p-3">
      <p className="text-sm font-semibold text-fg">Copy a field set</p>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">Board
        <select className={INPUT} value={sourceBoard ?? ""} onChange={(e) => setSourceBoard(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Choose a board…</option>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      {sourceBoard !== null && (
        <label className="flex flex-col gap-1 text-xs text-fg-muted">Field set
          <select className={INPUT} value={sourceSet ?? ""} onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null;
            setSourceSet(id);
            const s = sourceSets.find((x) => x.id === id);
            const taken = new Set((board.custom_field_sets ?? []).map((x) => x.name));
            setName(s ? (taken.has(s.name) ? `${s.name} (copy)` : s.name) : "");
          }}>
            <option value="">{sourceSets.length ? "Choose a set…" : "That board has no field sets"}</option>
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
        <button type="button" className={BTN_QUIET} onClick={onClose}>Cancel</button>
        <button type="button" className={BTN_PRIMARY} aria-disabled={!chosen || adds > room} onClick={() => void copy()}>Copy field set</button>
      </div>
    </div>
  );
}
