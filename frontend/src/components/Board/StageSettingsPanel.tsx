import { useId, useMemo, useState } from "react";
import type { Column, CustomFieldDefinition, Swimlane } from "../../types";
import { createCustomFieldDefinition, saveColumnStage, type StageSettingsBody } from "../../api/boards";
import { stageSubColumns } from "../../utils/stages";

/**
 * Stage settings (#2278, spec § Stage settings): sub-columns in order, tracks
 * in any order, and per-lane "not applicable" marks, saved together through
 * `PUT .../columns/{id}/stage/`. Board admins only: the caller renders it
 * only for them, and the server refuses everyone else (403).
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
  swimlanes: Swimlane[];
  definitions: CustomFieldDefinition[];
  /** Called with the saved column (and the server's `remapped` list) on success. */
  onSaved: (column: Column & { remapped?: { id: number; gates_passed: number; version: number }[] }) => void;
  onCancel: () => void;
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
    for (const key of ["sub_columns", "tracks", "not_applicable", "non_field_errors", "detail"]) {
      const v = data[key];
      if (typeof v === "string") return v;
      if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    }
  }
  return "The stage didn't save. Check your connection and try again.";
}

let rowSeq = 0;
const nextKey = () => `row-${++rowSeq}`;

export default function StageSettingsPanel({ boardId, column, swimlanes, definitions, onSaved, onCancel }: Props) {
  const uid = useId();
  const [subs, setSubs] = useState<SubRow[]>(() =>
    stageSubColumns(column).map((s) => ({ key: nextKey(), id: s.id, name: s.name })));
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

  const unboundDimensions = definitions.filter((d) => d.is_dimension && !tracks.some((t) => t.fieldId === d.id));
  const subError = subs.length === 1
    ? "A stage has no sub-columns or at least two."
    : subs.some((s) => !s.name.trim())
      ? "Every sub-column needs a name."
      : new Set(subs.map((s) => s.name.trim().toLowerCase())).size !== subs.length
        ? "Sub-column names must be different."
        : null;

  const addSub = () => setSubs((prev) => {
    if (prev.length >= SUB_COLUMN_MAX) return prev;
    // Splitting a plain column starts with two, since a stage never has one.
    if (prev.length === 0) return [{ key: nextKey(), name: "Doing" }, { key: nextKey(), name: "Ready" }];
    return [...prev, { key: nextKey(), name: "" }];
  });

  const addNewTrack = () => {
    const name = newTrackName.trim();
    if (!name) return;
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
    setTracks((prev) => prev.filter((t) => t.key !== key));
    setExceptions((prev) => prev.filter((e) => e.fieldKey !== key));
  };
  const addException = () => {
    const laneId = Number(exLane);
    if (!laneId || !exTrack) return;
    if (exceptions.some((e) => e.swimlaneId === laneId && e.fieldKey === exTrack)) return;
    setExceptions((prev) => [...prev, { swimlaneId: laneId, fieldKey: exTrack }]);
    setExLane("");
    setExTrack("");
  };

  const save = async () => {
    if (subError || saving) return;
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

  const INPUT = "w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted";
  const LINK_BUTTON = "text-sm text-info hover:underline disabled:text-fg-muted disabled:no-underline disabled:cursor-not-allowed rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
  const REMOVE = "shrink-0 h-8 px-2 text-xs text-fg-secondary hover:text-danger hover:bg-surface-hover rounded disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
  const laneName = (id: number) => swimlanes.find((l) => l.id === id)?.name ?? "Deleted swimlane";
  const trackName = (key: string) => tracks.find((t) => t.key === key)?.name ?? "";

  return (
    <div className="flex flex-col gap-5" data-testid="stage-settings-panel">
      <section aria-labelledby={`${uid}-subs`}>
        <h3 id={`${uid}-subs`} className="text-sm font-semibold text-fg">Sub-columns, in order</h3>
        <p className="mt-0.5 text-xs text-fg-tertiary">One WIP limit covers the whole stage. Time in the last sub-column is recorded as waiting.</p>
        <ol className="mt-2 flex flex-col gap-1.5">
          {subs.map((s, i) => (
            <li key={s.key} className="flex items-center gap-2">
              <span aria-hidden="true" className="w-4 text-right text-xs tabular-nums text-fg-tertiary">{i + 1}</span>
              <input
                aria-label={`Sub-column ${i + 1} name`}
                value={s.name}
                maxLength={100}
                onChange={(e) => setSubs((prev) => prev.map((r) => (r.key === s.key ? { ...r, name: e.target.value } : r)))}
                className={INPUT}
              />
              <button
                type="button"
                className={REMOVE}
                aria-label={`Remove sub-column ${s.name || i + 1}`}
                // Two is the floor; below it the stage becomes a plain column via "Remove all".
                disabled={subs.length <= SUB_COLUMN_MIN}
                onClick={() => setSubs((prev) => prev.filter((r) => r.key !== s.key))}
              >Remove</button>
            </li>
          ))}
        </ol>
        <div className="mt-2 flex items-center gap-4">
          <button type="button" className={LINK_BUTTON} disabled={subs.length >= SUB_COLUMN_MAX} onClick={addSub}>
            {subs.length === 0 ? "Split into sub-columns" : "Add sub-column"}
          </button>
          {subs.length > 0 && (
            <button type="button" className={LINK_BUTTON} onClick={() => setSubs([])}>Remove all sub-columns</button>
          )}
        </div>
        {subs.length > 0 && <p className="mt-1 text-xs text-fg-tertiary">Removing a sub-column moves its cards back to the one before it. Sub-columns can't be reordered.</p>}
        {subError && <p className="mt-1 text-xs text-danger" role="alert">{subError}</p>}
      </section>

      <section aria-labelledby={`${uid}-tracks`}>
        <h3 id={`${uid}-tracks`} className="text-sm font-semibold text-fg">Tracks, any order</h3>
        <p className="mt-0.5 text-xs text-fg-tertiary">Each track is open, done or not applicable and shows as a chip on the card.</p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {tracks.map((t) => (
            <li key={t.key} className="flex items-center gap-2">
              <span className="flex-1 truncate text-sm text-fg-secondary">{t.name}{t.fieldId === undefined && <span className="ml-1 text-xs text-fg-tertiary">(new)</span>}</span>
              <button type="button" className={REMOVE} aria-label={`Remove track ${t.name}`} onClick={() => removeTrack(t.key)}>Remove</button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-center gap-2">
          <input
            aria-label="New track name"
            placeholder="Track name"
            value={newTrackName}
            maxLength={100}
            onChange={(e) => setNewTrackName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addNewTrack(); } }}
            className={INPUT}
          />
          <button type="button" className={`${LINK_BUTTON} shrink-0`} disabled={!newTrackName.trim()} onClick={addNewTrack}>Add track</button>
        </div>
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
              <li key={`${e.swimlaneId}:${e.fieldKey}`} className="flex items-center gap-2">
                <span className="flex-1 text-sm text-fg-secondary">{laneName(e.swimlaneId)}: {trackName(e.fieldKey)} is not applicable</span>
                <button
                  type="button"
                  className={REMOVE}
                  aria-label={`Remove exception ${laneName(e.swimlaneId)}: ${trackName(e.fieldKey)}`}
                  onClick={() => setExceptions((prev) => prev.filter((x) => x !== e))}
                >Remove</button>
              </li>
            ))}
          </ul>
          <div className="mt-2 grid grid-cols-[1fr_1fr_auto] items-center gap-2">
            <select aria-label="Exception swimlane" value={exLane} onChange={(e) => setExLane(e.target.value)} className={INPUT}>
              <option value="">Swimlane…</option>
              {swimlanes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <select aria-label="Exception track" value={exTrack} onChange={(e) => setExTrack(e.target.value)} className={INPUT}>
              <option value="">Track…</option>
              {tracks.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
            <button type="button" className={LINK_BUTTON} disabled={!exLane || !exTrack} onClick={addException}>Add swimlane exception</button>
          </div>
        </section>
      )}

      <p className="text-xs min-h-4" role="status" aria-live="polite" aria-atomic="true"><span className="text-danger">{error}</span></p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-sm px-3 py-1.5 rounded text-fg-secondary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || subError !== null}
          className="text-sm px-3 py-1.5 rounded bg-button-primary text-on-primary hover:bg-button-primary-hover disabled:opacity-50 disabled:cursor-not-allowed font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >{saving ? "Saving…" : "Save stage"}</button>
      </div>
    </div>
  );
}
