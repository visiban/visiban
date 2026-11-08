import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Column, ColumnPolicy } from "../../types";
import { columnPolicy, policyCountSummary, POLICY_MODE_LABEL } from "../../utils/columnPolicy";
import { useColumnPolicyDraft } from "../../hooks/useColumnPolicyDraft";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import ColumnPolicyEditor from "./ColumnPolicyEditor";

interface Props {
  /** Every column on the board, hidden ones included, in column order. */
  columns: Column[];
  isAdmin: boolean;
  /** Ids the viewer has hidden in their own view prefs; only drives the "Hidden" badge. */
  hiddenColumnIds?: number[];
  /** Saves one column's policy (and tells the board). Rejects on failure. */
  onSaveColumnPolicy: (columnId: number, policy: ColumnPolicy | null) => Promise<void>;
}

const SAVE_FALLBACK_ERROR = "Couldn't save the policy. Try again.";

/** The server's message for a refused save: `detail`, else the first field error, else a fixed line. */
function saveErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.detail === "string" && record.detail) return record.detail;
    for (const value of Object.values(record)) {
      if (typeof value === "string" && value) return value;
      if (Array.isArray(value) && typeof value[0] === "string" && value[0]) return value[0];
    }
  }
  return SAVE_FALLBACK_ERROR;
}

function policySummary(column: Column): string {
  const p = columnPolicy(column);
  return p ? `${policyCountSummary(p)} · ${POLICY_MODE_LABEL[p.mode]}` : "No policy";
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`w-4 h-4 shrink-0 text-fg-tertiary transition-transform ${open ? "rotate-90" : ""}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

interface RowEditorProps {
  column: Column;
  panelId: string;
  buttonId: string;
  onSave: Props["onSaveColumnPolicy"];
  onSaved: () => void;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  children?: React.ReactNode;
}

/**
 * The open row's editor. Mounted only while the row is open, so its draft
 * reseeds from the column on every open and is dropped on collapse (#2156).
 */
function PolicyRowEditor({ column, panelId, buttonId, onSave, onSaved, onCancel, onDirtyChange, onSavingChange, children }: RowEditorProps) {
  const draft = useColumnPolicyDraft(column);
  const { dirty } = draft;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onSavingChange(saving); }, [saving, onSavingChange]);
  useEffect(() => {
    // jsdom has no scrollIntoView.
    panelRef.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const edited = <T,>(set: (v: T) => void) => (v: T) => { setError(null); set(v); };

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(column.id, draft.toPolicy());
      onSaved();
    } catch (err) {
      setError(saveErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <div role="group" id={panelId} aria-labelledby={buttonId} ref={panelRef} className="pl-4 sm:pl-7 pr-1 pb-3">
      <fieldset disabled={saving} className="min-w-0 border-0 p-0 m-0">
        <ColumnPolicyEditor
          entry={draft.entry}
          done={draft.done}
          mode={draft.mode}
          onEntryChange={edited(draft.setEntry)}
          onDoneChange={edited(draft.setDone)}
          onModeChange={edited(draft.setMode)}
          nextKey={draft.nextKey}
        />
      </fieldset>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p id={statusId} role="status" aria-live="polite" aria-atomic="true" className="text-xs h-4 flex-1 min-w-0 basis-full sm:basis-0">
          <span className={error ? "text-danger" : "text-fg-tertiary"}>{error ?? (dirty ? "Unsaved changes" : "")}</span>
        </p>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()} // save manages its own error state and never rejects
          disabled={!dirty || saving}
          aria-describedby={error ? statusId : undefined}
          className="text-sm bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {children}
    </div>
  );
}

function ReadOnlyList({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="mt-2">
      <p className="text-xs text-fg-tertiary">{label}</p>
      {items.length > 0 ? (
        <ol aria-label={label} className="mt-1 ml-4 list-decimal text-xs text-fg-secondary">
          {items.map((text, i) => <li key={i}>{text}</li>)}
        </ol>
      ) : (
        <p className="mt-1 text-xs text-fg-muted">None.</p>
      )}
    </div>
  );
}

/**
 * Column policies for the whole board, in Board settings → Rules (#2156).
 * Everyone reads each column's policy; admins expand a column to edit it with
 * the same editor as the column's Policy tab. One editor is open at a time.
 */
export default function BoardSettingsPoliciesSection({ columns, isAdmin, hiddenColumnIds = [], onSaveColumnPolicy }: Props) {
  const headingId = useId();
  const idBase = useId();
  const [openColumnId, setOpenColumnId] = useState<number | null>(null);
  const [pendingSwitchId, setPendingSwitchId] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const dirtyRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const buttonRefs = useRef(new Map<number, HTMLButtonElement>());
  // Focus returns to the row that was clicked when the discard prompt closes
  // (frontend/CLAUDE.md: dismissing an inline confirm returns focus to its trigger).
  const triggerRef = useConfirmFocusReturn<number>(pendingSwitchId);

  const focusRow = (id: number) => requestAnimationFrame(() => buttonRefs.current.get(id)?.focus());
  const onDirtyChange = useCallback((d: boolean) => { dirtyRef.current = d; }, []);

  // The open column was deleted (by anyone): drop the draft silently.
  useEffect(() => {
    if (openColumnId !== null && !columns.some((c) => c.id === openColumnId)) {
      setOpenColumnId(null);
      setPendingSwitchId(null);
      setSaving(false);
      dirtyRef.current = false;
    }
  }, [columns, openColumnId]);

  // Escape 40.6 (frontend/CLAUDE.md): cancels the discard prompt, above
  // ModalWrapper's 40, and returns false otherwise so Escape still closes the modal.
  useEscapeStack(() => {
    if (pendingSwitchId === null) return false;
    setPendingSwitchId(null);
  }, 40.6);

  const collapse = (id: number) => {
    dirtyRef.current = false;
    setSaving(false);
    setPendingSwitchId(null);
    setOpenColumnId(null);
    focusRow(id);
  };

  const toggle = (id: number) => {
    if (saving) return;
    if (openColumnId === id) {
      collapse(id);
      return;
    }
    if (openColumnId !== null && dirtyRef.current) {
      setPendingSwitchId(id);
      return;
    }
    dirtyRef.current = false;
    setPendingSwitchId(null);
    setOpenColumnId(id);
  };

  const heading = <h3 id={headingId} className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Column policies</h3>;
  const intro = (
    <p className="text-xs text-fg-muted mb-2">
      Entry criteria and definition of done for each column. Policies are guidance for the team; they never block a card move.
      {!isAdmin && " Only admins can change these."}
    </p>
  );

  if (columns.length === 0) {
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
            const p = columnPolicy(col);
            return (
              <li key={col.id} className="py-2 border-b border-line/60">
                <span className="block text-sm text-fg">{col.name}</span>
                <span className="block text-xs text-fg-muted">{policySummary(col)}</span>
                {p && (
                  <>
                    <ReadOnlyList label="Entry criteria" items={p.entry} />
                    <ReadOnlyList label="Definition of done" items={p.done} />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  const openName = columns.find((c) => c.id === openColumnId)?.name ?? "";
  const targetName = columns.find((c) => c.id === pendingSwitchId)?.name ?? "";

  return (
    <section aria-labelledby={headingId}>
      {heading}
      {intro}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>
      <ul className="m-0 p-0 list-none">
        {columns.map((col) => {
          const open = col.id === openColumnId;
          const btnId = `${idBase}-btn-${col.id}`;
          const panelId = `${idBase}-panel-${col.id}`;
          const summary = policySummary(col);
          return (
            <li key={col.id} className="border-b border-line/60">
              <button
                type="button"
                id={btnId}
                ref={(el) => {
                  if (el) buttonRefs.current.set(col.id, el);
                  else buttonRefs.current.delete(col.id);
                  triggerRef(col.id)(el);
                }}
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                aria-disabled={saving || undefined}
                onClick={() => toggle(col.id)}
                className="w-full flex items-center gap-3 py-2 min-h-11 text-left rounded hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis transition"
              >
                <Chevron open={open} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-fg truncate" title={col.name}>{col.name}</span>
                  <span className="block text-xs text-fg-muted truncate" title={summary}>{summary}</span>
                </span>
                {hiddenColumnIds.includes(col.id) && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-fg-secondary shrink-0">Hidden</span>
                )}
              </button>
              {open && (
                <PolicyRowEditor
                  key={col.id}
                  column={col}
                  panelId={panelId}
                  buttonId={btnId}
                  onSave={onSaveColumnPolicy}
                  onSaved={() => {
                    setAnnouncement(`Policy saved for ${col.name}.`);
                    collapse(col.id);
                  }}
                  onCancel={() => collapse(col.id)}
                  onDirtyChange={onDirtyChange}
                  onSavingChange={setSaving}
                >
                  {pendingSwitchId !== null && (
                    <div role="status" aria-live="polite" aria-atomic="true" className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-fg-tertiary">Discard changes to “{openName}” and open “{targetName}”?</span>
                      <button
                        type="button"
                        onClick={() => {
                          dirtyRef.current = false;
                          setOpenColumnId(pendingSwitchId);
                          setPendingSwitchId(null);
                        }}
                        className="text-danger hover:text-danger font-medium transition rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingSwitchId(null)}
                        className="text-fg-tertiary hover:text-fg transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </PolicyRowEditor>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
