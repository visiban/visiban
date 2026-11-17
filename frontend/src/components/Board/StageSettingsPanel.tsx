import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Card, Column, CustomFieldDefinition, Swimlane } from "../../types";
import { createCustomFieldDefinition, saveColumnStage, type StageSettingsBody } from "../../api/boards";
import { cardSubColumnIndex, stageSubColumns } from "../../utils/stages";

/**
 * Stage settings (#2278, spec § Stage settings): sub-columns in order, tracks
 * in any order, and per-lane "not applicable" marks, saved together through
 * `PUT .../columns/{id}/stage/`. Board admins only: the caller renders it
 * only for them, and the server refuses everyone else (403).
 *
 * The save always sends `not_applicable`, which REPLACES the lane exceptions
 * for this stage's tracks. So the panel must only ever be rendered with the
 * board's full, loaded swimlane and field lists: an empty fallback would wipe
 * every lane exception on Save (frontend/CLAUDE.md § Gated stages and tracks).
 *
 * Phase 1 is warn-and-record (#1102): the "Every track must be done" rule is
 * deferred, so there is no rule checkbox here.
 */

export const SUB_COLUMN_MIN = 2;
export const SUB_COLUMN_MAX = 4;
/** "Add track" creates a dimension dropdown with these choices (#1921). */
export const NEW_TRACK_CHOICES = ["Done", "Not applicable"] as const;
const NEW_TRACK_RESOLUTIONS = { Done: "satisfied", "Not applicable": "not_applicable" } as const;

interface SubRow { key: string; id?: number; name: string }
interface TrackRow { key: string; fieldId?: number; name: string }
interface ExceptionRow { swimlaneId: number; fieldKey: string }

interface Props {
  boardId: number;
  column: Column;
  /** Every board swimlane, hidden ones included. Required: see the module note. */
  swimlanes: Swimlane[];
  definitions: CustomFieldDefinition[];
  /** Cards on the board (or in this column), for the "N cards will move" summary. */
  cards?: Pick<Card, "column" | "gates_passed">[];
  /** Called with the saved column (and the server's `remapped` list) on success. */
  onSaved: (column: Column & { remapped?: { id: number; gates_passed: number; version: number }[] }) => void;
  onCancel: () => void;
  /**
   * Where to render the status line and the Cancel / Save stage buttons. The
   * edit modal passes its fixed footer, so they stay put while the body
   * scrolls. Omitted, they render at the end of the panel; null renders none
   * (the panel is mounted but hidden behind another tab).
   */
  footerTarget?: HTMLElement | null;
}

/** A server refusal, by string code first; field messages second (#2278). */
export function stageErrorMessage(err: unknown): string {
  const data = (err as { response?: { status?: number; data?: unknown } })?.response?.data as
    | { code?: string; detail?: string } & Record<string, unknown>
    | undefined;
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (data?.code === "version_conflict") return "Someone changed this stage or its cards while you were editing. Close and try again.";
  if (data?.code === "column_not_found") return "This column was deleted.";
  if (status === 403) return "Only board admins can change stage settings.";
  if (data && typeof data === "object") {
    // name / choices / field_type come from creating a new track's field first.
    for (const key of ["sub_columns", "tracks", "not_applicable", "name", "choices", "field_type", "non_field_errors", "detail"]) {
      const v = data[key];
      const msg = typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : null;
      if (msg) return key === "name" ? `Track name: ${msg}` : msg;
    }
    if (status !== undefined && status >= 400 && status < 500) return "The stage didn't save. Check the settings and try again.";
  }
  return "The stage didn't save. Check your connection and try again.";
}

let rowSeq = 0;
const nextKey = () => `row-${++rowSeq}`;

export default function StageSettingsPanel({ boardId, column, swimlanes, definitions, cards, onSaved, onCancel, footerTarget }: Props) {
  const uid = useId();
  const initialSubs = useMemo(() => stageSubColumns(column), [column]);
  const [subs, setSubs] = useState<SubRow[]>(() => initialSubs.map((s) => ({ key: nextKey(), id: s.id, name: s.name })));
  const [tracks, setTracks] = useState<TrackRow[]>(() =>
    [...(column.tracks ?? [])].sort((a, b) => a.position - b.position).map((t) => ({ key: `f-${t.field_id}`, fieldId: t.field_id, name: t.name })));
  const initialTrackIds = useMemo(() => new Set((column.tracks ?? []).map((t) => t.field_id)), [column.tracks]);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>(() =>
    swimlanes.flatMap((l) => (l.not_applicable_field_ids ?? [])
      .filter((f) => initialTrackIds.has(f))
      .map((f) => ({ swimlaneId: l.id, fieldKey: `f-${f}` }))));
  const [newTrackName, setNewTrackName] = useState("");
  const [existingPick, setExistingPick] = useState("");
  const [exLane, setExLane] = useState<string>("");
  const [exTrack, setExTrack] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Focus after add / remove (G4): an element id, applied once the row exists.
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusTarget) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-focus-key="${focusTarget}"]`)?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const unboundDimensions = definitions.filter((d) => d.is_dimension && !tracks.some((t) => t.fieldId === d.id));
  const subError = subs.length === 1
    ? "A stage needs at least two sub-columns, or none."
    : subs.some((s) => !s.name.trim())
      ? "Every sub-column needs a name."
      : new Set(subs.map((s) => s.name.trim().toLowerCase())).size !== subs.length
        ? "Sub-column names must be different."
        : null;
  // A new track creates a board field, and field names are unique per board.
  const typedTrack = newTrackName.trim().toLowerCase();
  const trackNameTaken = typedTrack !== "" && (
    tracks.some((t) => t.name.trim().toLowerCase() === typedTrack) ||
    definitions.some((d) => d.name.trim().toLowerCase() === typedTrack)
  );

  const atMax = subs.length >= SUB_COLUMN_MAX;
  const atMin = subs.length <= SUB_COLUMN_MIN;

  const addSub = () => {
    if (atMax) return;
    // Splitting a plain column starts with two, since a stage never has one.
    if (subs.length === 0) {
      const rows = [{ key: nextKey(), name: "Doing" }, { key: nextKey(), name: "Ready" }];
      setSubs(rows);
      setFocusTarget(`sub-input-${rows[0].key}`);
      return;
    }
    const row = { key: nextKey(), name: "" };
    setSubs((prev) => [...prev, row]);
    setFocusTarget(`sub-input-${row.key}`);
  };
  const removeSub = (key: string) => {
    if (atMin) return;
    const i = subs.findIndex((r) => r.key === key);
    const rest = subs.filter((r) => r.key !== key);
    setSubs(rest);
    const neighbor = rest[i] ?? rest[i - 1];
    setFocusTarget(neighbor ? `sub-remove-${neighbor.key}` : "sub-add");
  };

  const addNewTrack = () => {
    const name = newTrackName.trim();
    if (!name || trackNameTaken) return;
    setTracks((prev) => [...prev, { key: nextKey(), name }]);
    setNewTrackName("");
  };
  const addExistingTrack = () => {
    const def = definitions.find((d) => String(d.id) === existingPick);
    if (!def) return;
    setTracks((prev) => [...prev, { key: `f-${def.id}`, fieldId: def.id, name: def.name }]);
    setExistingPick("");
  };
  const removeTrack = (key: string) => {
    const i = tracks.findIndex((t) => t.key === key);
    const rest = tracks.filter((t) => t.key !== key);
    setTracks(rest);
    setExceptions((prev) => prev.filter((e) => e.fieldKey !== key));
    const neighbor = rest[i] ?? rest[i - 1];
    setFocusTarget(neighbor ? `track-remove-${neighbor.key}` : "track-new");
  };
  const exKey = (e: ExceptionRow) => `${e.swimlaneId}:${e.fieldKey}`;
  const addException = () => {
    const laneId = Number(exLane);
    if (!laneId || !exTrack) return;
    if (exceptions.some((e) => e.swimlaneId === laneId && e.fieldKey === exTrack)) return;
    setExceptions((prev) => [...prev, { swimlaneId: laneId, fieldKey: exTrack }]);
    setExLane("");
    setExTrack("");
  };
  const removeException = (row: ExceptionRow) => {
    const i = exceptions.indexOf(row);
    const rest = exceptions.filter((x) => x !== row);
    setExceptions(rest);
    const neighbor = rest[i] ?? rest[i - 1];
    setFocusTarget(neighbor ? `ex-remove-${exKey(neighbor)}` : "ex-lane");
  };

  // G6: what Save does to cards already on the board, mirroring the server's
  // remap (services/stages.py `_remap`): a card in a removed sub-column falls
  // back to the nearest kept one before it, else the first; removing every
  // sub-column makes the column plain.
  const consequences = useMemo(() => {
    if (initialSubs.length === 0 || !cards) return [];
    const keptIds = new Set(subs.filter((s) => s.id !== undefined).map((s) => s.id));
    const counts = initialSubs.map(() => 0);
    for (const c of cards) if (c.column === column.id) counts[cardSubColumnIndex(c, column)] += 1;
    const lines: string[] = [];
    initialSubs.forEach((sub, i) => {
      if (keptIds.has(sub.id) || counts[i] === 0) return;
      let target: string;
      if (subs.length === 0) {
        target = `the plain ${column.name} column`;
      } else {
        const before = initialSubs.slice(0, i).reverse().find((s) => keptIds.has(s.id));
        const row = before ? subs.find((r) => r.id === before.id) : subs[0];
        target = row?.name.trim() || "the first sub-column";
      }
      lines.push(`${counts[i]} ${counts[i] === 1 ? "card" : "cards"} will move from ${sub.name} back to ${target}.`);
    });
    return lines;
  }, [cards, column, initialSubs, subs]);

  const canSave = subError === null && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      // New tracks become dimension dropdowns first (#1921); the stage then binds them by id.
      const ids = new Map<string, number>();
      for (const t of tracks) {
        if (t.fieldId !== undefined) { ids.set(t.key, t.fieldId); continue; }
        const def = await createCustomFieldDefinition(boardId, {
          name: t.name,
          field_type: "dropdown",
          choices: [...NEW_TRACK_CHOICES],
          is_dimension: true,
          choice_resolutions: { ...NEW_TRACK_RESOLUTIONS },
        });
        ids.set(t.key, def.id);
      }
      // Rows created above keep their new id, so a retry after a later failure does not create them twice.
      setTracks((prev) => prev.map((t) => (t.fieldId === undefined && ids.has(t.key) ? { ...t, fieldId: ids.get(t.key) } : t)));
      const body: StageSettingsBody = {
        sub_columns: subs.map((s) => (s.id !== undefined ? { id: s.id, name: s.name.trim() } : { name: s.name.trim() })),
        tracks: tracks.map((t) => ids.get(t.key)!).filter((v) => v !== undefined),
        not_applicable: exceptions
          .filter((e) => ids.has(e.fieldKey))
          .map((e) => ({ swimlane_id: e.swimlaneId, field_id: ids.get(e.fieldKey)! })),
      };
      const res = await saveColumnStage(boardId, column.id, body);
      onSaved({ ...res.column, remapped: res.remapped });
    } catch (err) {
      setError(stageErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const INPUT = "w-full max-sm:min-h-11 bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted disabled:opacity-60";
  const LINK_BUTTON = "text-sm text-info px-1 py-1 max-sm:min-h-11 max-sm:px-2 hover:underline disabled:text-fg-muted disabled:no-underline disabled:cursor-not-allowed aria-disabled:text-fg-muted aria-disabled:no-underline aria-disabled:cursor-not-allowed rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
  const REMOVE = "shrink-0 h-8 max-sm:h-11 px-2 text-xs text-fg-secondary hover:text-danger hover:bg-surface-hover rounded disabled:opacity-40 disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
  const laneName = (id: number) => swimlanes.find((l) => l.id === id)?.name ?? "Deleted swimlane";
  const trackName = (key: string) => tracks.find((t) => t.key === key)?.name ?? "";

  const footer = (
    <div className="flex flex-1 items-center gap-2" data-testid="stage-settings-footer">
      <div className="text-xs flex-1 min-w-0">
        {error
          ? <p className="text-danger" role="alert">{error}</p>
          : <p className="text-fg-secondary" role="status" aria-live="polite" aria-atomic="true">{saving ? "Saving the stage…" : ""}</p>}
      </div>
      <button type="button" onClick={onCancel} className="text-sm px-3 py-1.5 max-sm:min-h-11 rounded text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
      <button
        type="button"
        onClick={() => void save()}
        disabled={!canSave}
        className="text-sm px-3 py-1.5 max-sm:min-h-11 rounded bg-button-primary text-on-primary hover:bg-button-primary-hover disabled:opacity-50 disabled:cursor-not-allowed font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >{saving ? "Saving…" : "Save stage"}</button>
    </div>
  );

  return (
    <div ref={rootRef} className="flex flex-col gap-5" data-testid="stage-settings-panel" aria-busy={saving}>
      <fieldset disabled={saving} className="contents">
        <section aria-labelledby={`${uid}-subs`}>
          <h3 id={`${uid}-subs`} className="text-sm font-semibold text-fg">Sub-columns, in order</h3>
          <p className="mt-0.5 text-xs text-fg-tertiary">One WIP limit covers the whole stage. Time in the last sub-column is recorded as waiting.</p>
          <ol className="mt-2 flex flex-col gap-1.5">
            {subs.map((s, i) => (
              <li key={s.key} className="flex items-center gap-2">
                <span aria-hidden="true" className="w-4 text-right text-xs tabular-nums text-fg-tertiary">{i + 1}</span>
                <input
                  aria-label={`Sub-column ${i + 1} name`}
                  data-focus-key={`sub-input-${s.key}`}
                  value={s.name}
                  maxLength={100}
                  onChange={(e) => setSubs((prev) => prev.map((r) => (r.key === s.key ? { ...r, name: e.target.value } : r)))}
                  className={INPUT}
                />
                <button
                  type="button"
                  className={REMOVE}
                  data-focus-key={`sub-remove-${s.key}`}
                  aria-label={`Remove sub-column ${s.name || i + 1}`}
                  // Two is the floor; below it the stage becomes a plain column via "Remove all".
                  // aria-disabled keeps the reason reachable by keyboard.
                  aria-disabled={atMin || undefined}
                  aria-describedby={atMin ? `${uid}-min` : undefined}
                  onClick={() => removeSub(s.key)}
                >Remove</button>
              </li>
            ))}
          </ol>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <button
              type="button"
              className={LINK_BUTTON}
              data-focus-key="sub-add"
              aria-disabled={atMax || undefined}
              aria-describedby={atMax ? `${uid}-max` : undefined}
              onClick={addSub}
            >
              {subs.length === 0 ? "Split into sub-columns" : "Add sub-column"}
            </button>
            {subs.length > 0 && (
              <button type="button" className={LINK_BUTTON} onClick={() => { setSubs([]); setFocusTarget("sub-add"); }}>Remove all sub-columns</button>
            )}
          </div>
          {atMax && <p id={`${uid}-max`} className="mt-1 text-xs text-fg-tertiary">A stage has at most four sub-columns.</p>}
          {subs.length > 0 && atMin && <p id={`${uid}-min`} className="mt-1 text-xs text-fg-tertiary">A stage needs at least two sub-columns, or none. Use Remove all sub-columns to make it a plain column.</p>}
          {subs.length > 0 && <p className="mt-1 text-xs text-fg-tertiary">Removing a sub-column moves its cards back to the one before it. Sub-columns can't be reordered.</p>}
          {consequences.length > 0 && (
            <ul data-testid="stage-consequences" className="mt-2 rounded border border-line bg-surface-sunken px-3 py-2 text-xs text-fg-secondary">
              {consequences.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
          {subError && <p className="mt-1 text-xs text-danger" role="alert">{subError}</p>}
        </section>

        <section aria-labelledby={`${uid}-tracks`}>
          <h3 id={`${uid}-tracks`} className="text-sm font-semibold text-fg">Tracks, any order</h3>
          <p className="mt-0.5 text-xs text-fg-tertiary">Each track is open, done or not applicable and shows as a chip on the card.</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {tracks.map((t) => (
              <li key={t.key} className="flex items-center gap-2">
                <span className="flex-1 truncate text-sm text-fg-secondary">{t.name}{t.fieldId === undefined && <span className="ml-1 text-xs text-fg-tertiary">(new)</span>}</span>
                <button type="button" className={REMOVE} data-focus-key={`track-remove-${t.key}`} aria-label={`Remove track ${t.name}`} onClick={() => removeTrack(t.key)}>Remove</button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <input
              aria-label="New track name"
              data-focus-key="track-new"
              placeholder="Track name"
              value={newTrackName}
              maxLength={100}
              aria-invalid={trackNameTaken || undefined}
              aria-describedby={trackNameTaken ? `${uid}-track-taken` : undefined}
              onChange={(e) => setNewTrackName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addNewTrack(); } }}
              className={INPUT}
            />
            <button type="button" className={`${LINK_BUTTON} shrink-0`} disabled={!newTrackName.trim() || trackNameTaken} onClick={addNewTrack}>Add track</button>
          </div>
          {trackNameTaken && (
            <p id={`${uid}-track-taken`} className="mt-1 text-xs text-danger">
              A track or field with this name already exists. Pick it from the existing track fields, or use another name.
            </p>
          )}
          {unboundDimensions.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <select aria-label="Existing track field" value={existingPick} onChange={(e) => setExistingPick(e.target.value)} className={INPUT}>
                <option value="">Use an existing track field…</option>
                {unboundDimensions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <button type="button" className={`${LINK_BUTTON} shrink-0`} disabled={!existingPick} onClick={addExistingTrack}>Add</button>
            </div>
          )}
          <p className="mt-1 text-xs text-fg-tertiary">Removing a track only takes it off this stage. The field and its values stay.</p>
        </section>

        {tracks.length > 0 && (
          <section aria-labelledby={`${uid}-ex`}>
            <h3 id={`${uid}-ex`} className="text-sm font-semibold text-fg">Swimlane exceptions</h3>
            <p className="mt-0.5 text-xs text-fg-tertiary">A swimlane can mark a track not applicable for every card in it. The column structure stays the same in every swimlane.</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {exceptions.map((e) => (
                <li key={exKey(e)} className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-fg-secondary">{laneName(e.swimlaneId)}: {trackName(e.fieldKey)} is not applicable</span>
                  <button
                    type="button"
                    className={REMOVE}
                    data-focus-key={`ex-remove-${exKey(e)}`}
                    aria-label={`Remove exception ${laneName(e.swimlaneId)}: ${trackName(e.fieldKey)}`}
                    onClick={() => removeException(e)}
                  >Remove</button>
                </li>
              ))}
            </ul>
            <div className="mt-2 grid grid-cols-[1fr_1fr] sm:grid-cols-[1fr_1fr_auto] items-center gap-2">
              <select aria-label="Exception swimlane" data-focus-key="ex-lane" value={exLane} onChange={(e) => setExLane(e.target.value)} className={INPUT}>
                <option value="">Swimlane…</option>
                {swimlanes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <select aria-label="Exception track" value={exTrack} onChange={(e) => setExTrack(e.target.value)} className={INPUT}>
                <option value="">Track…</option>
                {tracks.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
              </select>
              <button type="button" className={`${LINK_BUTTON} max-sm:col-span-2 justify-self-start`} disabled={!exLane || !exTrack} onClick={addException}>Add swimlane exception</button>
            </div>
          </section>
        )}
      </fieldset>

      {footerTarget === undefined
        ? <div className="flex justify-end">{footer}</div>
        : footerTarget
          ? createPortal(footer, footerTarget)
          : null}
    </div>
  );
}
