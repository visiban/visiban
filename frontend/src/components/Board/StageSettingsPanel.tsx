import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Card, Column, CustomFieldDefinition, Swimlane } from "../../types";
import { createCustomFieldDefinition, getStageCardCounts, saveColumnStage, updateCustomFieldDefinition, type StageSettingsBody, type StageSubColumnCardCount } from "../../api/boards";
import { cardSubColumnIndex, stageSubColumns } from "../../utils/stages";
import { NEW_TRACK_RESOLUTIONS, NEW_TRACK_CHOICES, SUB_COLUMN_MAX, SUB_COLUMN_MIN, stageErrorMessage } from "../../utils/stageSettings";

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
 *
 * Sub-columns can be reordered with ↑ / ↓ (#2368). The server moves each card
 * with its own sub-column, so a reorder alone moves no card out of the
 * sub-column it is in and needs no consequence line. A track's name is its
 * dimension field's name (#2382): renaming one PATCHes the field before the
 * stage save, so card values and lane exceptions, keyed by field id, keep.
 */

interface SubRow { key: string; id?: number; name: string }
/** `savedName` is the field's name on the server; a row whose `name` differs is renamed on Save (#2382). */
interface TrackRow { key: string; fieldId?: number; name: string; savedName?: string }
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


let rowSeq = 0;
const nextKey = () => `row-${++rowSeq}`;

export default function StageSettingsPanel({ boardId, column, swimlanes, definitions, cards, onSaved, onCancel, footerTarget }: Props) {
  const uid = useId();
  const initialSubs = useMemo(() => stageSubColumns(column), [column]);
  const [subs, setSubs] = useState<SubRow[]>(() => initialSubs.map((s) => ({ key: nextKey(), id: s.id, name: s.name })));
  const [tracks, setTracks] = useState<TrackRow[]>(() =>
    [...(column.tracks ?? [])].sort((a, b) => a.position - b.position).map((t) => {
      // A rename reaches the field definitions only, not this column's copy of
      // the track name, so the live definition's name wins (as in getTrackStates).
      const name = definitions.find((d) => d.id === t.field_id)?.name ?? t.name;
      return { key: `f-${t.field_id}`, fieldId: t.field_id, name, savedName: name };
    }));
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
  const [announcement, setAnnouncement] = useState("");
  // The server's per-sub-column counts, archived cards included (#2368): a
  // save remaps archived cards too, and the board payload has none of them.
  // Until they load, or if the request fails, the summary falls back to the
  // cards the caller passed.
  const [serverCounts, setServerCounts] = useState<StageSubColumnCardCount[] | null>(null);
  useEffect(() => {
    if (initialSubs.length === 0) return;
    let live = true;
    // Promise.resolve().then so a missing client function also lands in catch.
    Promise.resolve()
      .then(() => getStageCardCounts(boardId, column.id))
      .then((counts) => { if (live && Array.isArray(counts)) setServerCounts(counts); })
      .catch(() => { /* keep the client-side counts */ });
    return () => { live = false; };
  }, [boardId, column.id, initialSubs]);

  // Focus after add / remove (G4): an element id, applied once the row exists.
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
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

  // Track names are field names, unique per board (#2382). Compare against the
  // other tracks and against every field that is not one of these tracks.
  const trackFieldIds = new Set(tracks.map((t) => t.fieldId).filter((id) => id !== undefined));
  const otherFieldNames = new Set(definitions.filter((d) => !trackFieldIds.has(d.id)).map((d) => d.name.trim().toLowerCase()));
  const trackNameCounts = new Map<string, number>();
  for (const t of tracks) {
    const k = t.name.trim().toLowerCase();
    trackNameCounts.set(k, (trackNameCounts.get(k) ?? 0) + 1);
  }
  // Only the rows the shown message covers are marked invalid: an empty name
  // is reported first, so duplicates are marked once every row has a name.
  const anyEmptyTrack = tracks.some((t) => !t.name.trim());
  const trackInvalid = (t: TrackRow) => {
    const k = t.name.trim().toLowerCase();
    if (anyEmptyTrack) return k === "";
    return (trackNameCounts.get(k) ?? 0) > 1 || otherFieldNames.has(k);
  };
  const trackError = anyEmptyTrack
    ? "Every track needs a name."
    : tracks.some((track) => trackInvalid(track))
      ? "Track names must be different from each other and from the board's other fields."
      : null;

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
  // A reorder and a removal in one save is refused by the server (a card's
  // fall-back sub-column could land after it), so reordering waits for Save.
  const removalPending = initialSubs.some((s) => !subs.some((r) => r.id === s.id));
  // The reverse holds too: once the kept sub-columns are out of their saved
  // order, removing one would build the same refused save.
  const keptIds = new Set(subs.filter((r) => r.id !== undefined).map((r) => r.id));
  const savedKeptOrder = initialSubs.filter((s) => keptIds.has(s.id)).map((s) => s.id);
  const reorderPending = subs.filter((r) => r.id !== undefined).some((r, i) => r.id !== savedKeptOrder[i]);
  const removeSub = (key: string) => {
    if (atMin || reorderPending) return;
    const i = subs.findIndex((r) => r.key === key);
    const rest = subs.filter((r) => r.key !== key);
    setSubs(rest);
    const neighbor = rest[i] ?? rest[i - 1];
    setFocusTarget(neighbor ? `sub-remove-${neighbor.key}` : "sub-add");
  };

  // Reorder (#2368): ↑ / ↓ swap with the neighbor. The ends are aria-disabled,
  // not disabled, so a row moved to an end keeps focus on its button.
  const moveSub = (key: string, dir: -1 | 1) => {
    const i = subs.findIndex((r) => r.key === key);
    const j = i + dir;
    if (removalPending || i < 0 || j < 0 || j >= subs.length) return;
    const next = [...subs];
    [next[i], next[j]] = [next[j], next[i]];
    setSubs(next);
    setFocusTarget(`sub-${dir < 0 ? "up" : "down"}-${key}`);
    setAnnouncement(`${subs[i].name.trim() || `Sub-column ${i + 1}`} moved to position ${j + 1} of ${subs.length}.`);
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
    setTracks((prev) => [...prev, { key: `f-${def.id}`, fieldId: def.id, name: def.name, savedName: def.name }]);
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
    const keptIds = new Set(subs.filter((s) => s.id !== undefined).map((s) => s.id));
    if (initialSubs.length === 0) return [];
    // Server counts first (archived included, #2368); else the caller's cards.
    const byId = new Map((serverCounts ?? []).map((c) => [c.id, c]));
    const counts = initialSubs.map(() => 0);
    const archived = initialSubs.map(() => 0);
    if (serverCounts) {
      initialSubs.forEach((sub, i) => {
        counts[i] = (byId.get(sub.id)?.cards ?? 0) + (byId.get(sub.id)?.archived_cards ?? 0);
        archived[i] = byId.get(sub.id)?.archived_cards ?? 0;
      });
    } else if (cards) {
      for (const c of cards) if (c.column === column.id) counts[cardSubColumnIndex(c, column)] += 1;
    }
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
      const noun = counts[i] === 1 ? "card" : "cards";
      const arch = archived[i] > 0 ? ` (${archived[i]} archived)` : "";
      lines.push(`${counts[i]} ${noun}${arch} will move from ${sub.name} back to ${target}.`);
    });
    return lines;
  }, [cards, column, initialSubs, subs, serverCounts]);

  const canSave = subError === null && trackError === null && !saving;
  // The fieldset and Save are disabled while saving, which drops focus to the body; after a failed
  // save put it back on Save so the error is read in place and a retry is one key away (WCAG 3.2/4.1.3).
  useEffect(() => {
    if (!saving && error) saveRef.current?.focus();
  }, [saving, error]);

  const save = async () => {
    if (!canSave) return;
    // Defense in depth: the server refuses this combination, but only after the
    // renames and new tracks below have already been written.
    if (removalPending && reorderPending) {
      setError("Reorder and remove sub-columns in separate saves.");
      return;
    }
    setSaving(true);
    setError(null);
    let renamedAny = false;
    try {
      // Renamed tracks PATCH their field first (#2382): values and lane
      // exceptions are keyed by field id, so a rename keeps every state.
      const renamed = new Map<string, string>();
      for (const t of tracks) {
        if (t.fieldId === undefined || t.name.trim() === t.savedName) continue;
        await updateCustomFieldDefinition(boardId, t.fieldId, { name: t.name.trim() });
        renamed.set(t.key, t.name.trim());
        renamedAny = true;
      }
      // A retry after a later failure does not PATCH the same rename again.
      if (renamed.size) setTracks((prev) => prev.map((t) => (renamed.has(t.key) ? { ...t, savedName: renamed.get(t.key) } : t)));
      // New tracks become dimension dropdowns first (#1921); the stage then binds them by id.
      const ids = new Map<string, number>();
      for (const t of tracks) {
        if (t.fieldId !== undefined) { ids.set(t.key, t.fieldId); continue; }
        const def = await createCustomFieldDefinition(boardId, {
          name: t.name.trim(),
          field_type: "dropdown",
          choices: [...NEW_TRACK_CHOICES],
          is_dimension: true,
          choice_resolutions: { ...NEW_TRACK_RESOLUTIONS },
        });
        ids.set(t.key, def.id);
      }
      // Rows created above keep their new id, so a retry after a later failure does not create them twice.
      setTracks((prev) => prev.map((t) => (t.fieldId === undefined && ids.has(t.key) ? { ...t, fieldId: ids.get(t.key), savedName: t.name.trim() } : t)));
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
      // A rename is its own request and has already landed: say so.
      setError(renamedAny ? `Track names were saved. ${stageErrorMessage(err)}` : stageErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const INPUT = "w-full max-sm:min-h-11 bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted disabled:opacity-60";
  const LINK_BUTTON = "text-sm text-info px-1 py-1 max-sm:min-h-11 max-sm:px-2 hover:underline disabled:text-fg-muted disabled:no-underline disabled:cursor-not-allowed aria-disabled:text-fg-muted aria-disabled:no-underline aria-disabled:cursor-not-allowed rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
  const ARROW = "shrink-0 transition h-8 w-8 max-sm:h-11 max-sm:w-11 text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover rounded aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
  const REMOVE = "shrink-0 h-8 max-sm:h-11 px-2 text-xs text-fg-secondary hover:text-danger hover:bg-surface-hover rounded disabled:opacity-40 disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
  const laneName = (id: number) => swimlanes.find((l) => l.id === id)?.name ?? "Deleted swimlane";
  const trackName = (key: string) => tracks.find((t) => t.key === key)?.name ?? "";

  const footer = (
    <div className="flex flex-1 items-center gap-2" data-testid="stage-settings-footer">
      <div className="text-xs flex-1 min-w-0">
        <p className="text-danger" role="alert">{error ?? ""}</p>
        <p className="text-fg-secondary" role="status" aria-live="polite" aria-atomic="true">{saving ? "Saving the stage…" : ""}</p>
      </div>
      <button type="button" onClick={onCancel} className="text-sm px-3 py-1.5 max-sm:min-h-11 rounded text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
      <button
        type="button"
        ref={saveRef}
        onClick={() => void save()}
        disabled={!canSave}
        className="text-sm px-3 py-1.5 max-sm:min-h-11 rounded bg-button-primary text-on-primary hover:bg-button-primary-hover disabled:opacity-50 disabled:cursor-not-allowed font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >{saving ? "Saving…" : "Save stage"}</button>
    </div>
  );

  return (
    <div ref={rootRef} className="flex flex-col gap-5" data-testid="stage-settings-panel" aria-busy={saving}>
      {/* #2543: "stage" is defined once, here and in board.md; the tab and menu item keep their names. */}
      <p className="text-xs text-fg-muted" data-testid="stage-definition">A stage is a column. This tab holds its sub-columns and tracks. A stage with sub-columns is a gated stage.</p>
      <fieldset disabled={saving} className="contents">
        {/* #2542: the hint at this point of choice says it applies to every card in the column. */}
        <section aria-labelledby={`${uid}-subs`}>
          <h3 id={`${uid}-subs`} className="text-sm font-semibold text-fg">Sub-columns, in order</h3>
          <p id={`${uid}-subs-hint`} className="mt-0.5 text-xs text-fg-muted">Steps every card in this column goes through, in order. One WIP limit covers the whole stage. Time in the last sub-column is recorded as waiting.</p>
          <ol className="mt-2 flex flex-col gap-1.5">
            {subs.map((s, i) => (
              <li key={s.key} className="flex flex-wrap sm:flex-nowrap items-center gap-2">
                <span aria-hidden="true" className="w-4 text-right text-xs tabular-nums text-fg-tertiary">{i + 1}</span>
                <input
                  aria-label={`Sub-column ${i + 1} name`}
                  data-focus-key={`sub-input-${s.key}`}
                  value={s.name}
                  maxLength={100}
                  aria-invalid={subError ? true : undefined}
                  aria-describedby={subError ? `${uid}-suberr` : undefined}
                  onChange={(e) => setSubs((prev) => prev.map((r) => (r.key === s.key ? { ...r, name: e.target.value } : r)))}
                  // At phone width the input keeps its own line and the buttons wrap below it.
                  className={`${INPUT} max-sm:basis-[calc(100%-1.5rem)] sm:flex-1`}
                />
                <button
                  type="button"
                  className={ARROW}
                  data-focus-key={`sub-up-${s.key}`}
                  aria-label={`Move sub-column ${s.name || i + 1} up`}
                  aria-disabled={i === 0 || removalPending || undefined}
                  aria-describedby={removalPending ? `${uid}-reorder-hold` : undefined}
                  onClick={() => moveSub(s.key, -1)}
                ><span aria-hidden="true">↑</span></button>
                <button
                  type="button"
                  className={ARROW}
                  data-focus-key={`sub-down-${s.key}`}
                  aria-label={`Move sub-column ${s.name || i + 1} down`}
                  aria-disabled={i === subs.length - 1 || removalPending || undefined}
                  aria-describedby={removalPending ? `${uid}-reorder-hold` : undefined}
                  onClick={() => moveSub(s.key, 1)}
                ><span aria-hidden="true">↓</span></button>
                <button
                  type="button"
                  className={REMOVE}
                  data-focus-key={`sub-remove-${s.key}`}
                  aria-label={`Remove sub-column ${s.name || i + 1}`}
                  // Two is the floor; below it the stage becomes a plain column via "Remove all".
                  // aria-disabled keeps the reason reachable by keyboard.
                  aria-disabled={atMin || reorderPending || undefined}
                  aria-describedby={atMin ? `${uid}-min` : reorderPending ? `${uid}-remove-hold` : undefined}
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
              aria-describedby={atMax ? `${uid}-subs-hint ${uid}-max` : `${uid}-subs-hint`}
              onClick={addSub}
            >
              {subs.length === 0 ? "Split into sub-columns" : "Add sub-column"}
            </button>
            {subs.length > 0 && (
              <button type="button" className={LINK_BUTTON} onClick={() => { setSubs([]); setFocusTarget("sub-add"); }}>Remove all sub-columns</button>
            )}
          </div>
          {atMax && <p id={`${uid}-max`} className="mt-1 text-xs text-fg-tertiary">A stage has at most four sub-columns.</p>}
          {removalPending && <p id={`${uid}-reorder-hold`} className="mt-1 text-xs text-fg-tertiary">Reorder and remove sub-columns in separate saves. Save the removal first, then reorder.</p>}
          {reorderPending && <p id={`${uid}-remove-hold`} className="mt-1 text-xs text-fg-tertiary">Reorder and remove sub-columns in separate saves. Save the new order first, then remove.</p>}
          {subs.length > 0 && atMin && <p id={`${uid}-min`} className="mt-1 text-xs text-fg-tertiary">A stage needs at least two sub-columns, or none. Use Remove all sub-columns to make it a plain column.</p>}
          {subs.length > 0 && <p className="mt-1 text-xs text-fg-tertiary">Removing a sub-column moves its cards back to the one before it in the saved order. Moving a sub-column takes its cards with it.</p>}
          {consequences.length > 0 && (
            <ul data-testid="stage-consequences" className="mt-2 rounded border border-line bg-surface-sunken px-3 py-2 text-xs text-fg-secondary">
              {consequences.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
          {subError && <p id={`${uid}-suberr`} className="mt-1 text-xs text-danger" role="alert">{subError}</p>}
        </section>

        <section aria-labelledby={`${uid}-tracks`}>
          <h3 id={`${uid}-tracks`} className="text-sm font-semibold text-fg">Tracks, any order</h3>
          <p id={`${uid}-tracks-hint`} className="mt-0.5 text-xs text-fg-muted">Checks every card in this column needs, in any order. Each shows as a chip on the card. For one card's to-dos, use its checklist.</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {tracks.map((t, i) => (
              <li key={t.key} className="flex items-center gap-2">
                <input
                  aria-label={`Track ${i + 1} name${t.fieldId === undefined ? " (new)" : ""}`}
                  data-focus-key={`track-input-${t.key}`}
                  value={t.name}
                  maxLength={100}
                  aria-invalid={trackInvalid(t) || undefined}
                  aria-describedby={trackInvalid(t) ? `${uid}-trackerr` : undefined}
                  onChange={(e) => setTracks((prev) => prev.map((r) => (r.key === t.key ? { ...r, name: e.target.value } : r)))}
                  className={INPUT}
                />
                {t.fieldId === undefined && <span className="shrink-0 text-xs text-fg-tertiary">New</span>}
                <button type="button" className={REMOVE} data-focus-key={`track-remove-${t.key}`} aria-label={`Remove track ${t.name.trim() || i + 1}`} onClick={() => removeTrack(t.key)}>Remove</button>
              </li>
            ))}
          </ul>
          {trackError && <p id={`${uid}-trackerr`} className="mt-1 text-xs text-danger" role="alert">{trackError}</p>}
          <div className="mt-2 flex items-center gap-2">
            <input
              aria-label="New track name"
              data-focus-key="track-new"
              placeholder="Track name"
              value={newTrackName}
              maxLength={100}
              aria-invalid={trackNameTaken || undefined}
              aria-describedby={trackNameTaken ? `${uid}-tracks-hint ${uid}-track-taken` : `${uid}-tracks-hint`}
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
          <p className="mt-1 text-xs text-fg-tertiary">Removing a track only takes it off this stage. The field and its values stay. Renaming a track renames its field everywhere it is used.</p>
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
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>

      {footerTarget === undefined
        ? <div className="flex justify-end">{footer}</div>
        : footerTarget
          ? createPortal(footer, footerTarget)
          : null}
    </div>
  );
}
