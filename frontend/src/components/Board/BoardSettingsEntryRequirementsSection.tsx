/**
 * Board settings → Rules & limits → Entry requirements (#1923, MR B).
 *
 * One editor per board, after Column policies (ux-design proposal, owner
 * decisions 2026-11-24): a stage strip picks the column, the editor below holds
 * its AND-ed conditions and its mode, and "Save requirements" sends one
 * replace-all PUT. There is no EditColumnModal tab, so a column never has two
 * save models. Lane scope is derived from the field sets and shown, never
 * chosen. Non-admins read one sentence per column.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import HelpLink from "../Common/HelpLink";
import { InlineConfirm } from "../Page";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { Column, CustomFieldDefinition, CustomFieldSet, EntryEnforcement, EntryRequirementOperator, Swimlane } from "../../types";
import {
  DISCARD_ESCAPE_PRIORITY, ENTRY_MODE_LABEL, ENTRY_REQUIREMENTS_CAP, MARKER, MODE_HELP, NEEDS_OPERAND, OPERATOR_LABEL,
  laneSuffix, operatorsFor, sameDraft, saveErrorMessage, seed, toWrite, validateDraft, type Draft, type Row,
} from "../../utils/entryRequirementsEditor";

interface Props {
  columns: Column[];
  fields: CustomFieldDefinition[];
  sets: CustomFieldSet[];
  swimlanes: Swimlane[];
  isAdmin: boolean;
  /** #2672: open Board settings › Field sets, where a requirement's lanes are set. */
  onOpenFieldSets?: () => void;
  /** Column ⋮ "Entry requirements…" deep link: select this column. */
  initialColumnId?: number;
  /** Replace-all PUT; resolves once the board has the saved column. Rejects on failure. */
  onSave: (columnId: number, body: ReturnType<typeof toWrite>) => Promise<void>;
}

export default function BoardSettingsEntryRequirementsSection({ columns, fields, sets, swimlanes, isAdmin, initialColumnId, onSave, onOpenFieldSets }: Props) {
  const headingId = useId();
  const idBase = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const [selectedId, setSelectedId] = useState<number | null>(
    () => columns.find((c) => c.id === initialColumnId)?.id ?? columns[0]?.id ?? null,
  );
  const selected = columns.find((c) => c.id === selectedId) ?? columns[0] ?? null;
  const [draft, setDraft] = useState<Draft | null>(() => (selected ? seed(selected) : null));
  const [pendingSwitch, setPendingSwitch] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ index: number | null; message: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const nextKey = useRef(100);
  const markerRefs = useRef(new Map<number, HTMLButtonElement>());

  // Reseed when the selected column changes or a save/broadcast updates it, unless the admin has edits.
  const seeded = selected ? seed(selected) : null;
  const dirty = draft !== null && seeded !== null && !sameDraft(draft, seeded);
  const seedKey = selected ? `${selected.id}:${JSON.stringify(seeded)}` : "";
  const lastSeedKey = useRef(seedKey);
  useEffect(() => {
    if (seedKey === lastSeedKey.current) return;
    const sameColumn = lastSeedKey.current.split(":")[0] === seedKey.split(":")[0];
    lastSeedKey.current = seedKey;
    if (sameColumn && dirty) return;
    setDraft(seeded);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seedKey is the serialized content of `seeded`
  }, [seedKey]);

  // A deep link scrolls the editor into view once (jsdom has no scrollIntoView).
  useEffect(() => {
    if (initialColumnId !== undefined) sectionRef.current?.scrollIntoView?.({ block: "start" });
  }, [initialColumnId]);

  // The prompt guards unsaved edits: once the draft is no longer dirty (the admin edited back, or a broadcast
  // reseeded it) there is nothing left to discard, so a lingering prompt would be a lie.
  useEffect(() => {
    if (!dirty && pendingSwitch !== null) setPendingSwitch(null);
  }, [dirty, pendingSwitch]);

  // InlineConfirm unmounts on both outcomes, so focus would drop to body: name the marker that gets it
  // (the new column after Discard, the still-selected one after Cancel) and take it once that render commits.
  const [focusMarker, setFocusMarker] = useState<number | null>(null);
  useEffect(() => {
    if (focusMarker === null) return;
    markerRefs.current.get(focusMarker)?.focus();
    setFocusMarker(null);
  }, [focusMarker]);

  useEscapeStack(() => {
    if (pendingSwitch === null) return false;
    setPendingSwitch(null);
    setFocusMarker(selectedId);
  }, DISCARD_ESCAPE_PRIORITY);

  const fieldByUid = useMemo(() => new Map(fields.map((f) => [f.uid, f])), [fields]);
  const setByUid = useMemo(() => new Map(sets.map((s) => [s.uid, s])), [sets]);
  const laneName = useMemo(() => new Map(swimlanes.map((l) => [l.id, l.name])), [swimlanes]);
  const sortedSets = useMemo(() => [...sets].sort((a, b) => a.position - b.position), [sets]);

  /** Lane names a row applies in, or null for every lane (derived from the set it belongs to). */
  const rowLanes = (kind: Row["kind"], uid: string): string[] | null => {
    const set = kind === "set" ? setByUid.get(uid) : sets.find((s) => s.field_ids.includes(fieldByUid.get(uid)?.id ?? -1));
    if (!set || set.scope !== "swimlanes") return null;
    return set.swimlanes.map((id) => laneName.get(id) ?? "").filter(Boolean);
  };
  const rowSetName = (kind: Row["kind"], uid: string) =>
    (kind === "set" ? setByUid.get(uid) : sets.find((s) => s.field_ids.includes(fieldByUid.get(uid)?.id ?? -1)))?.name ?? "";

  const describeRow = (r: Pick<Row, "kind" | "uid" | "operator" | "operand">): string => {
    const name = r.kind === "set" ? setByUid.get(r.uid)?.name : fieldByUid.get(r.uid)?.name;
    if (r.operator === "min_count") return `${name ?? "?"} has at least ${r.operand} choice${r.operand === "1" ? "" : "s"}`;
    return `${name ?? "?"} ${OPERATOR_LABEL[r.operator]}${NEEDS_OPERAND.has(r.operator) ? ` ${r.operand}` : ""}`;
  };

  const summary = (col: Column): string => {
    const n = col.entry_requirements?.length ?? 0;
    if (col.entry_enforcement == null) return n > 0 ? `Off · ${n} saved` : "Off";
    return `${ENTRY_MODE_LABEL[col.entry_enforcement]} · ${n}`;
  };

  const heading = (
    <div className="flex items-center gap-2 mb-2 min-w-0">
      <h3 id={headingId} className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide">Entry requirements</h3>
      <HelpLink topic="entry-requirements" />
    </div>
  );
  const intro = (
    <p className="text-xs text-fg-muted mb-2">
      Field conditions a card must meet to move forward into a column. Checked on forward moves, on create and on restore.
    </p>
  );

  if (columns.length === 0 || !selected || !draft) {
    return (
      <section aria-labelledby={headingId}>
        {heading}
        {intro}
        <p className="text-sm text-fg-muted py-2">This board has no columns yet.</p>
      </section>
    );
  }

  if (!isAdmin) {
    return (
      <section aria-labelledby={headingId}>
        {heading}
        {intro}
        <ul className="m-0 p-0 list-none">
          {columns.map((col) => {
            const rows = seed(col).rows;
            return (
              <li key={col.id} className="py-2 border-b border-line/60 text-sm text-fg">
                <span className="font-medium">{col.name}</span>
                <span className="text-fg-secondary">
                  {col.entry_enforcement == null || rows.length === 0
                    ? ": no entry requirements."
                    : ` (${ENTRY_MODE_LABEL[col.entry_enforcement]}): ${rows.map((r) => describeRow(r)).join("; ")}.`}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-xs text-fg-tertiary">Only board admins can change entry requirements.</p>
      </section>
    );
  }

  const choose = (id: number) => {
    if (saving || id === selected.id) return;
    if (dirty) { setPendingSwitch(id); return; }
    setPendingSwitch(null);
    setSelectedId(id);
  };
  const onStripKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = columns.length - 1;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (index === last ? 0 : index + 1)
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (index === 0 ? last : index - 1)
        : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    markerRefs.current.get(columns[next].id)?.focus();
    choose(columns[next].id);
  };

  const edit = (next: Draft) => { setError(null); setDraft(next); };
  const updateRow = (key: number, patch: Partial<Row>) =>
    edit({ ...draft, rows: draft.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const atCap = draft.rows.length >= ENTRY_REQUIREMENTS_CAP;
  const capId = `${idBase}-cap`;
  const statusId = `${idBase}-status`;
  const modesDisabled = saving || !draft.on;
  // "On" with no rows saves as off (the server has nothing to enforce): say so instead of letting the strip read "Off" unexplained.
  const onWithoutRows = draft.on && draft.rows.length === 0;
  const addRow = (kind: Row["kind"]) => {
    if (atCap) return;
    const uid = kind === "set" ? sortedSets[0]?.uid ?? "" : "";
    edit({ ...draft, rows: [...draft.rows, { key: nextKey.current++, kind, uid, operator: kind === "set" ? "set_complete" : "filled", operand: "" }] });
  };

  // "Applies to" (ux-design: derived, read-only).
  const scopes = draft.rows.filter((r) => r.uid).map((r) => ({ lanes: rowLanes(r.kind, r.uid), set: rowSetName(r.kind, r.uid) }));
  const allEverywhere = scopes.every((s) => s.lanes === null);
  const firstScoped = scopes[0];
  const oneSet = scopes.length > 0 && firstScoped.lanes !== null && scopes.every((s) => s.set === firstScoped.set && s.lanes !== null);
  const appliesTo = allEverywhere
    ? "Applies to every swimlane."
    : oneSet
      ? `Applies in swimlanes where ${firstScoped.set} shows: ${(firstScoped.lanes ?? []).join(", ")}.`
      : "Applies to different swimlanes per condition.";
  const mixed = !allEverywhere && !oneSet;

  const save = async () => {
    if (!dirty || saving) return;
    const problem = validateDraft(draft);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(selected.id, toWrite(draft));
      setAnnouncement(`Entry requirements saved for ${selected.name}.`);
    } catch (err) {
      setError({ index: null, message: saveErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const pendingName = columns.find((c) => c.id === pendingSwitch)?.name ?? "";
  const btnQuiet = "text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 min-h-11 sm:min-h-0 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40";
  const btnAdd = "text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 min-h-11 sm:min-h-0 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis aria-disabled:opacity-40 aria-disabled:cursor-not-allowed";
  const selectCls = "bg-surface border border-line-strong rounded px-2 py-1 text-sm text-fg min-h-11 sm:min-h-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

  return (
    <section aria-labelledby={headingId} ref={sectionRef}>
      {heading}
      {intro}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>

      {/* Stage strip: one marker per column, a radiogroup with roving tabindex. */}
      <div className="relative">
        <div role="radiogroup" aria-label="Column to edit" className="flex gap-2 overflow-x-auto pb-2">
          {columns.map((col, i) => {
            const mode = col.entry_enforcement ?? "off";
            const n = col.entry_requirements?.length ?? 0;
            const checked = col.id === selected.id;
            return (
              <button
                key={col.id}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                aria-label={`Entering ${col.name}: ${mode === "off" ? "off" : ENTRY_MODE_LABEL[mode]}, ${n} requirement${n === 1 ? "" : "s"}`}
                ref={(el) => { if (el) markerRefs.current.set(col.id, el); else markerRefs.current.delete(col.id); }}
                onClick={() => choose(col.id)}
                onKeyDown={(e) => onStripKey(e, i)}
                className={`shrink-0 flex items-center gap-2 px-2 py-1 min-h-11 rounded-lg border transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${checked ? "border-2 border-primary-emphasis bg-primary-emphasis/10" : "px-[calc(0.5rem+1px)] border-line-strong hover:bg-surface-hover/40"}`}
              >
                <span aria-hidden="true" className={`w-7 h-7 rounded-full flex items-center justify-center text-xs shrink-0 ${MARKER[mode].cls}`}>{MARKER[mode].glyph}</span>
                <span className="text-sm text-fg whitespace-nowrap">{col.name}</span>
                <span className="text-xs text-fg-tertiary whitespace-nowrap">{summary(col)}</span>
              </button>
            );
          })}
        </div>
        <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 bottom-2 w-6 bg-gradient-to-l from-surface" />
      </div>
      <p className="text-xs text-fg-tertiary mb-3">○ Off · ⚠ Warn · 🔒 Block · ⛔ Hard</p>

      {pendingSwitch !== null && (
        <div className="mb-3">
          <InlineConfirm
            message={`Discard changes to “${selected.name}” and open “${pendingName}”?`}
            actionLabel="Discard"
            onCancel={() => { setPendingSwitch(null); setFocusMarker(selected.id); }}
            onConfirm={() => { setSelectedId(pendingSwitch); setPendingSwitch(null); setFocusMarker(pendingSwitch); }}
          />
        </div>
      )}

      <div role="group" aria-labelledby={`${idBase}-editor`} className="rounded-lg border border-line p-3">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          {/* A labelled group, not a heading: its text carries the column name, which Find a setting can't index. */}
          <p id={`${idBase}-editor`} className="text-sm font-medium text-fg">Entering {selected.name}</p>
          <button
            type="button"
            role="switch"
            aria-checked={draft.on}
            aria-label="Requirements on"
            disabled={saving}
            onClick={() => edit({ ...draft, on: !draft.on })}
            className="inline-flex items-center gap-2 min-h-11 sm:min-h-0 text-sm text-fg rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            <span aria-hidden="true" className={`relative inline-block w-9 h-5 rounded-full transition-colors ${draft.on ? "bg-primary-emphasis" : "bg-line-strong"}`}>
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-surface transition-transform ${draft.on ? "translate-x-4" : "translate-x-0.5"}`} />
            </span>
            Requirements on
          </button>
        </div>

        {/* Unlabelled on purpose: the group above names it; the fieldset only disables while saving. */}
        <fieldset disabled={saving} className="min-w-0 border-0 p-0 m-0">
          {draft.rows.length === 0 && <p className="text-sm text-fg-muted mb-2">No conditions yet.</p>}
          {fields.length === 0 && <p className="text-sm text-fg-muted mb-2">Add card fields first (Board settings › Card fields).</p>}
          <ol className="m-0 p-0 list-none flex flex-col gap-2">
            {draft.rows.map((r, i) => {
              const n = i + 1;
              const field = r.kind === "field" ? fieldByUid.get(r.uid) : undefined;
              const ops = r.kind === "set" ? (["set_complete"] as EntryRequirementOperator[]) : field ? operatorsFor(field) : [];
              const invalid = error?.index === i;
              const lanes = mixed && r.uid ? rowLanes(r.kind, r.uid) : null;
              return (
                <li key={r.key} className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-fg-tertiary w-8">{i === 0 ? "If" : "And"}</span>
                  <select
                    aria-label={`Condition ${n} ${r.kind === "set" ? "field set" : "field"}`}
                    aria-invalid={invalid && !r.uid ? true : undefined}
                    aria-describedby={invalid && !r.uid ? statusId : undefined}
                    className={selectCls}
                    value={r.uid}
                    onChange={(e) => {
                      const f = fieldByUid.get(e.target.value);
                      updateRow(r.key, r.kind === "set" ? { uid: e.target.value } : { uid: e.target.value, operator: f ? operatorsFor(f)[0] ?? "filled" : "filled", operand: "" });
                    }}
                  >
                    {r.kind === "set" ? (
                      sortedSets.map((s) => <option key={s.uid} value={s.uid}>{s.name}</option>)
                    ) : (
                      <>
                        <option value="">Choose a field</option>
                        {sortedSets.map((s) => (
                          <optgroup key={s.uid} label={s.name}>
                            {fields.filter((f) => s.field_ids.includes(f.id)).map((f) => (
                              <option key={f.uid} value={f.uid} disabled={f.field_type === "checkbox"}>
                                {f.field_type === "checkbox" ? `${f.name} (checkbox fields can't be required yet)` : f.name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                        <optgroup label="Other fields">
                          {fields.filter((f) => !sets.some((s) => s.field_ids.includes(f.id))).map((f) => (
                            <option key={f.uid} value={f.uid} disabled={f.field_type === "checkbox"}>
                              {f.field_type === "checkbox" ? `${f.name} (checkbox fields can't be required yet)` : f.name}
                            </option>
                          ))}
                        </optgroup>
                      </>
                    )}
                  </select>
                  {r.kind === "set" ? (
                    <span className="text-sm text-fg-secondary">is complete (every field filled)</span>
                  ) : (
                    <select
                      aria-label={`Condition ${n} operator`}
                      className={selectCls}
                      value={r.operator}
                      disabled={ops.length === 0}
                      onChange={(e) => updateRow(r.key, { operator: e.target.value as EntryRequirementOperator, operand: "" })}
                    >
                      {(ops.length > 0 ? ops : (["filled"] as EntryRequirementOperator[])).map((op) => (
                        <option key={op} value={op}>{OPERATOR_LABEL[op]}</option>
                      ))}
                    </select>
                  )}
                  {NEEDS_OPERAND.has(r.operator) && (
                    <input
                      type="number"
                      inputMode="decimal"
                      aria-label={`Condition ${n} value`}
                      aria-invalid={invalid ? true : undefined}
                      aria-describedby={invalid ? statusId : undefined}
                      min={r.operator === "min_count" ? 1 : undefined}
                      step={r.operator === "min_count" ? 1 : "any"}
                      value={r.operand}
                      onChange={(e) => updateRow(r.key, { operand: e.target.value })}
                      className="w-28 bg-surface border border-line-strong rounded px-2 py-1 text-sm text-fg min-h-11 sm:min-h-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    />
                  )}
                  {lanes && <span className="text-xs text-fg-tertiary">{laneSuffix(lanes).replace(/^ · /, "")}</span>}
                  <button
                    type="button"
                    aria-label={`Remove condition ${n}`}
                    onClick={() => edit({ ...draft, rows: draft.rows.filter((x) => x.key !== r.key) })}
                    className="ml-auto w-11 h-11 sm:w-7 sm:h-7 flex items-center justify-center text-fg-tertiary hover:text-fg rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                  {field?.is_dimension && r.operator === "satisfied" && (
                    <p className="basis-full ml-10 text-xs text-fg-tertiary">Not applicable in a lane counts as satisfied.</p>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {fields.length > 0 && (
              <button type="button" className={btnAdd} aria-disabled={atCap || undefined} aria-describedby={atCap ? capId : undefined} onClick={() => addRow("field")}>
                + Field condition
              </button>
            )}
            {sortedSets.length > 0 && (
              <button type="button" className={btnAdd} aria-disabled={atCap || undefined} aria-describedby={atCap ? capId : undefined} onClick={() => addRow("set")}>
                + Whole field set complete
              </button>
            )}
            <span id={capId} className="text-xs text-fg-tertiary">{atCap ? `A column can have up to ${ENTRY_REQUIREMENTS_CAP} requirements.` : ""}</span>
          </div>

          <fieldset className="mt-3 min-w-0 border-0 p-0" disabled={modesDisabled}>
            <legend className="text-xs font-medium text-fg-secondary mb-1">When a card doesn’t meet them</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {(["warn", "block", "hard"] as EntryEnforcement[]).map((m) => (
                <label
                  key={m}
                  className={`flex items-start gap-2 rounded-lg border cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-emphasis ${draft.mode === m ? "border-2 px-3 py-2 border-primary-emphasis bg-primary-emphasis/10" : "px-[calc(0.75rem+1px)] py-[calc(0.5rem+1px)] border-line-strong hover:bg-surface-hover/40"} ${modesDisabled ? "opacity-60 cursor-not-allowed" : ""}`}
                >
                  <input type="radio" className="sr-only" name={`${idBase}-mode`} value={m} checked={draft.mode === m} onChange={() => edit({ ...draft, mode: m })} />
                  <span aria-hidden="true" className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0 ${MARKER[m].cls}`}>{MARKER[m].glyph}</span>
                  <span>
                    <span className="block text-sm text-fg font-medium">{ENTRY_MODE_LABEL[m]}</span>
                    <span className="block text-xs text-fg-tertiary mt-0.5">{MODE_HELP[m]}</span>
                  </span>
                  {draft.mode === m && <span aria-hidden="true" className="ml-auto text-sm text-fg">✓</span>}
                </label>
              ))}
            </div>
          </fieldset>
        </fieldset>

        {draft.rows.length > 0 && (
          <p className="mt-3 text-xs text-fg-secondary">
            {appliesTo} Cards created directly in {selected.name} are checked too.
          </p>
        )}
        {/* #2672: lane scope is derived and read-only (owner, #1923), so say where it is changed. */}
        {draft.rows.length > 0 && !allEverywhere && (
          <p className="mt-1 text-xs text-fg-tertiary" data-testid="entry-lanes-help">
            Set by the field set&apos;s lanes. Change them in{" "}
            {onOpenFieldSets ? (
              <button type="button" className="underline text-primary-emphasis hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded-sm" onClick={onOpenFieldSets}>Field sets</button>
            ) : "Field sets"}.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p id={statusId} role="status" aria-live="polite" aria-atomic="true" className="text-xs min-h-4 flex-1 min-w-0 basis-full sm:basis-0">
            <span className={error ? "text-danger" : "text-fg-tertiary"}>{error?.message ?? (onWithoutRows ? "Add at least one condition to turn requirements on." : dirty ? "Unsaved changes" : "")}</span>
          </p>
          <button type="button" className={btnQuiet} disabled={saving || !dirty} onClick={() => { if (seeded) setDraft(seeded); setError(null); }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()} // save manages its own error state and never rejects
            disabled={!dirty || saving}
            aria-describedby={error ? statusId : undefined}
            className="text-sm bg-button-primary text-on-primary px-4 py-1.5 min-h-11 sm:min-h-0 rounded hover:bg-button-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
          >
            {saving ? "Saving…" : "Save requirements"}
          </button>
        </div>
      </div>
    </section>
  );
}
