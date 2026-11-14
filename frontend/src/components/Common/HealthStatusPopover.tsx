import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPlacement, POPOVER_VIEWPORT_MARGIN, clampLeftToVisible, visibleMaxHeight } from "../../hooks/useAnchoredPlacement";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import {
  HEALTH_STATUS_DESCRIPTIONS, HEALTH_STATUS_LABELS, HEALTH_STATUS_TEXT, HEALTH_STATUS_VALUES,
  NO_STATUS_LABEL, type HealthDisplayValue, type HealthStatus,
} from "../../constants/healthStatus";
import {
  getHealthDisplay, healthSetLine, healthSetWhen, healthSetterName, healthStatusErrorMessage,
  type HealthAttribution, type HealthEntityKind, type HealthFields,
} from "../../utils/healthStatus";
import { formatDateTimeUser, formatRelativeTime, type UserDatePrefs } from "../../utils/date";
import type { HealthHistory, HealthStatusChange } from "../../types";
import HealthStatusShape from "./HealthStatusShape";
import { isImeComposing } from "../../utils/imeComposition";

/** The draft: a stored value, or "inherit" for null (inherit at a nested level, clear at the root). */
type Draft = HealthStatus | "inherit";

export interface HealthStatusPopoverProps extends HealthFields, Partial<HealthAttribution> {
  /**
   * `"swimlane"` (#2243): no Inherit choice (parentName is always null, so the
   * reset is "No status"), a line saying the lane is separate from the board,
   * and none of the board/group extras: a lane has no note or history yet, so
   * it is always "basic" whatever `mode` the caller passes (#2242).
   */
  entityKind: HealthEntityKind;
  entityName: string;
  /** Name of the group above the entity; null at the root (a personal board or a top-level group). */
  parentName: string | null;
  anchorRect: DOMRect;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Close with no write. `refocus` returns focus to the trigger (Cancel, Escape). */
  onDismiss: (refocus: boolean) => void;
  /** Persist; resolve on success (the parent merges the response), reject on failure. */
  onSave: (next: HealthStatus | null, note?: string | null) => Promise<void>;
  /**
   * "detailed" (default, #2242): set line, note field, Confirm status and
   * History. "basic": exactly the #1133 editor (no note, Confirm or History),
   * for the lane editor. Forced for `entityKind="swimlane"`.
   */
  mode?: "detailed" | "basic";
  /** Reconfirm the unchanged status (the explicit action); detailed mode only. */
  onConfirm?: (status: HealthStatus, note: string | null) => Promise<void>;
  /** Load the last 20 changes; detailed mode shows History only when given. */
  fetchHistory?: () => Promise<HealthHistory>;
  /** Non-admins: header, set line, note and History only, with a Close button. */
  readOnly?: boolean;
  /** The viewer's date and time format, for exact times in `<time title>`. */
  datePrefs?: UserDatePrefs | null;
}

export const HEALTH_NOTE_MAX = 280;
const NOTE_WARN = 260;

type HistoryState =
  | { status: "idle" | "loading" | "error" }
  | { status: "done"; data: HealthHistory };

function TimeAgo({ iso, prefs }: { iso: string; prefs?: UserDatePrefs | null }) {
  return <time dateTime={iso} title={formatDateTimeUser(iso, prefs)}>{formatRelativeTime(iso)}</time>;
}

function HistoryStatus({ value, parentName }: { value: HealthStatus | null; parentName: string | null }) {
  const shape: HealthDisplayValue = value ?? "none";
  const label = value ? HEALTH_STATUS_LABELS[value] : parentName !== null ? "Inherited" : "No status";
  return (
    <span className="inline-flex items-center gap-1">
      <span className={HEALTH_STATUS_TEXT[shape]}><HealthStatusShape value={shape} /></span>
      <span className="text-fg">{label}</span>
    </span>
  );
}

function HistoryRow({ row, parentName, prefs }: {
  row: HealthStatusChange; parentName: string | null; prefs?: UserDatePrefs | null;
}) {
  const reconfirm = row.from_status === row.to_status;
  return (
    <li className="py-2 border-b border-line last:border-0">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {reconfirm ? (
          <>
            <HistoryStatus value={row.to_status} parentName={parentName} />
            <span className="text-fg-tertiary">· confirmed</span>
          </>
        ) : (
          <>
            <HistoryStatus value={row.from_status} parentName={parentName} />
            <span aria-hidden="true" className="text-fg-tertiary">→</span>
            <span className="sr-only">to</span>
            <HistoryStatus value={row.to_status} parentName={parentName} />
          </>
        )}
      </div>
      <p className="text-xs text-fg-tertiary mt-0.5">
        {row.changed_by
          ? healthSetterName(row.changed_by)
          : <span title="Automatic change or removed account">System</span>}
        {" · "}
        <TimeAgo iso={row.changed_at} prefs={prefs} />
      </p>
      {row.note && <p className="text-xs text-fg-secondary break-words mt-0.5">{row.note}</p>}
    </li>
  );
}

const PANEL_WIDTH = 320;
const CARD = "flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-emphasis";
const CARD_SELECTED = "border-primary-emphasis bg-primary-emphasis/10";
const CARD_IDLE = "border-line-strong hover:bg-surface-hover/40";

const SET_HERE: Record<HealthEntityKind, string> = {
  board: "Set on this board.", group: "Set on this group.", swimlane: "Set on this lane.",
};

function stateLine(fields: HealthFields, entityKind: HealthEntityKind, parentName: string | null): string {
  if (fields.health_status !== null) return SET_HERE[entityKind];
  if (entityKind === "swimlane") return "No status set.";
  const display = getHealthDisplay(fields);
  if (display.inheritedFrom) return `Inherited from ${display.inheritedFrom}.`;
  return parentName !== null ? "No status set here or in a group above." : "No status set.";
}

/** The attribution under the state line (#2242): own set line, or the source's time. */
function setLine(fields: HealthFields, attribution: Partial<HealthAttribution>): string {
  if (fields.health_status !== null) {
    return healthSetLine(attribution.health_status_changed_at ?? null, attribution.health_status_changed_by ?? null);
  }
  const display = getHealthDisplay(fields);
  const when = healthSetWhen(fields.health_status_source?.changed_at ?? null);
  return display.inheritedFrom && when ? `${display.inheritedFrom} set this ${when}.` : "";
}

function RadioCard({ name, value, checked, onSelect, shape, label, description, inputRef }: {
  name: string;
  value: Draft;
  checked: boolean;
  onSelect: (v: Draft) => void;
  shape: HealthDisplayValue;
  label: string;
  description: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <label className={`${CARD} ${checked ? CARD_SELECTED : CARD_IDLE}`}>
      <input
        ref={inputRef}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
        className="sr-only"
      />
      <span className={`mt-0.5 ${HEALTH_STATUS_TEXT[shape]}`}>
        <HealthStatusShape value={shape} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{label}</span>
        {/* fg-tertiary, not the radio rule's fg-muted: fg-muted is sub-AA on surface (#1862). */}
        <span className="block text-xs text-fg-tertiary mt-0.5">{description}</span>
      </span>
    </label>
  );
}

/**
 * The health status editor (#1133): a non-modal, anchored dialog modeled on
 * `ColumnPolicyPopover`. Arrow keys move the draft only; Enter or Save writes.
 * Not optimistic: the server's response carries the new effective value and
 * its source, which only the server can resolve. A failed save keeps the
 * popover open with the draft and a message. Remote updates while open change
 * the state line but never the draft.
 */
export default function HealthStatusPopover({
  entityKind, entityName, parentName, anchorRect, triggerRef, onDismiss, onSave,
  mode: requestedMode = "detailed", onConfirm, fetchHistory, readOnly = false, datePrefs,
  health_status, effective_health_status, health_status_source,
  health_status_changed_at, health_status_changed_by, health_status_note,
}: HealthStatusPopoverProps) {
  const fields = { health_status, effective_health_status, health_status_source };
  // A lane is always basic (#2243 ships no lane history), so a caller cannot
  // switch the note, Confirm or History on for one by accident.
  const mode = entityKind === "swimlane" ? "basic" : requestedMode;
  const detailed = mode === "detailed";
  const showHistory = detailed && fetchHistory !== undefined;
  const editable = !(detailed && readOnly);
  // A note belongs to a change, so the field always starts empty.
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"save" | "confirm" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryState>({ status: "idle" });
  const confirmRef = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const noteId = `health-note-${uid}`;
  const noteHelpId = `health-note-help-${uid}`;
  const historyId = `health-history-${uid}`;
  const confirmReasonId = `health-confirm-reason-${uid}`;
  const saveReasonId = `health-save-reason-${uid}`;
  // The time the set line describes, for the exact time on hover (#2242).
  const attributionTime = health_status !== null
    ? (health_status_changed_at ?? null)
    : (health_status_source?.changed_at ?? null);
  const attributionLine = detailed
    ? setLine(fields, { health_status_changed_at, health_status_changed_by })
    : "";
  const panelRef = useRef<HTMLDivElement>(null);
  const checkedRef = useRef<HTMLInputElement>(null);
  const initial: Draft = health_status ?? "inherit";
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const radioName = `health-${entityKind}-${useId()}`;

  // Outside mousedown and focus leaving close without moving focus: the user
  // has already moved on. Resize and outside scroll can close the panel while
  // focus is still inside it, so those return focus to the trigger rather than
  // dropping it to <body>.
  const dismissQuietly = () => { if (!savingRef.current) onDismiss(false); };
  const dismissForLayout = () => {
    if (savingRef.current) return;
    onDismiss(!!panelRef.current?.contains(document.activeElement));
  };
  const top = useAnchoredPlacement(panelRef, {
    anchor: { top: anchorRect.top, bottom: anchorRect.bottom },
    deps: [error, historyOpen, history],
    onResize: dismissForLayout,
    onOutsideScroll: dismissForLayout,
  });

  // Default dropdown tier (25). Escape is swallowed while a save is in flight
  // so the request's outcome is never shown on a closed popover.
  useEscapeStack(() => {
    if (savingRef.current) return;
    onDismiss(true);
  }, 25);

  useEffect(() => {
    const outside = (target: Node) =>
      !panelRef.current?.contains(target) && !triggerRef.current?.contains(target);
    const onMouseDown = (e: MouseEvent) => { if (outside(e.target as Node)) dismissQuietly(); };
    // Non-modal, no focus trap: leaving the panel with Tab closes it.
    const onFocusIn = (e: FocusEvent) => { if (outside(e.target as Node)) dismissQuietly(); };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dismissQuietly reads refs only; re-binding per render is pointless
  }, [triggerRef, onDismiss]);

  // Focus the checked radio once placed, never on the hidden measuring pass (#1455).
  const placed = top !== null;
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!placed || focusedRef.current) return;
    focusedRef.current = true;
    if (editable) checkedRef.current?.focus();
    else panelRef.current?.focus();
  }, [placed, editable]);

  const loadHistory = () => {
    if (!fetchHistory) return;
    setHistory({ status: "loading" });
    fetchHistory().then(
      (data) => setHistory({ status: "done", data }),
      () => setHistory({ status: "error" }),
    );
  };
  // Read-only viewers open the popover for the history, so it loads at once.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!showHistory || editable || autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    setHistoryOpen(true);
    loadHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one load on mount; loadHistory reads current props
  }, []);
  const toggleHistory = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    // First expand fetches; an expanded list is never refetched by a remote update.
    if (next && history.status === "idle") loadHistory();
  };

  const unchanged = draft === initial;
  const saving = pending !== null;
  // Confirm keeps the current status: only when it is unchanged and set here.
  const canConfirm = detailed && onConfirm !== undefined && unchanged && health_status !== null;
  const confirmReason = !unchanged
    ? "Save to change the status. Confirm keeps the current one."
    : "Nothing set here to confirm.";
  const noteValue = note.trim() || null;

  const run = async (kind: "save" | "confirm", write: () => Promise<void>) => {
    savingRef.current = true;
    setPending(kind);
    setError(null);
    try {
      await write();
    } catch (err) {
      setError(healthStatusErrorMessage(err));
      savingRef.current = false;
      setPending(null);
      return;
    }
    savingRef.current = false;
    // The parent closes the popover and returns focus on success.
  };

  const submit = async () => {
    if (savingRef.current) return;
    if (unchanged) {
      // Save never records a no-change; a reconfirm is the explicit action.
      onDismiss(true);
      return;
    }
    await run("save", () => detailed
      ? onSave(draft === "inherit" ? null : draft, noteValue)
      : onSave(draft === "inherit" ? null : draft));
  };

  const confirm = async () => {
    if (savingRef.current || !canConfirm || health_status === null || !onConfirm) return;
    await run("confirm", () => onConfirm(health_status, noteValue));
  };

  // A lane never inherits (#2243), whatever parentName the caller passes.
  const inherits = parentName !== null && entityKind !== "swimlane";
  const resetLabel = inherits ? `Inherit from ${parentName}` : NO_STATUS_LABEL;
  const resetDescription = inherits
    ? `Follow ${parentName}, or the nearest group above it that has a status.`
    : "Clear the status. Nothing is shown as set.";
  const left = clampLeftToVisible(anchorRect.left, PANEL_WIDTH);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
      aria-label={entityKind === "swimlane" ? `Health status for lane ${entityName}` : `Health status for ${entityName}`}
      className="fixed z-50 bg-surface border border-line-strong rounded-lg shadow-xl focus:outline-none overflow-y-auto"
      style={{
        top: top ?? 0,
        left,
        width: `min(${PANEL_WIDTH}px, calc(100vw - ${2 * POPOVER_VIEWPORT_MARGIN}px))`,
        visibility: top === null ? "hidden" : undefined,
        maxHeight: visibleMaxHeight(),
      }}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        onKeyDown={(e) => {
          // Enter on a radio submits (browsers do not submit a form from a radio).
          if (e.key === "Enter" && !isImeComposing(e) && (e.target as HTMLElement).tagName === "INPUT"
            && (e.target as HTMLInputElement).type === "radio") {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="px-3 pt-3 pb-2">
          <p className="text-sm font-medium text-fg">Health status</p>
          <p className="text-xs text-fg-tertiary mt-0.5 truncate" title={stateLine(fields, entityKind, parentName)}>
            {stateLine(fields, entityKind, parentName)}
          </p>
          {attributionLine && (
            <p
              className="text-xs text-fg-tertiary mt-0.5"
              data-testid="health-set-line"
              title={attributionTime ? formatDateTimeUser(attributionTime, datePrefs) : undefined}
            >
              {attributionLine}
            </p>
          )}
          {detailed && health_status !== null && health_status_note && (
            <p className="text-xs text-fg-secondary break-words line-clamp-3 mt-1" title={health_status_note}>
              {health_status_note}
            </p>
          )}
        </div>
        {editable && (<>
        <fieldset className="px-3 flex flex-col gap-1.5">
          <legend className="sr-only">Health status</legend>
          {HEALTH_STATUS_VALUES.map((v) => (
            <RadioCard
              key={v}
              name={radioName}
              value={v}
              checked={draft === v}
              onSelect={setDraft}
              shape={v}
              label={HEALTH_STATUS_LABELS[v]}
              description={HEALTH_STATUS_DESCRIPTIONS[v]}
              inputRef={draft === v ? checkedRef : undefined}
            />
          ))}
          <div className="border-t border-line my-1" />
          <RadioCard
            name={radioName}
            value="inherit"
            checked={draft === "inherit"}
            onSelect={setDraft}
            shape="none"
            label={resetLabel}
            description={resetDescription}
            inputRef={draft === "inherit" ? checkedRef : undefined}
          />
        </fieldset>
        {entityKind === "group" && (
          <p className="px-3 mt-2 text-xs text-fg-tertiary">
            Boards and subgroups that don't set their own status follow this one.
          </p>
        )}
        {entityKind === "swimlane" && (
          <p className="px-3 mt-2 text-xs text-fg-tertiary">
            This lane&apos;s status is separate from the board&apos;s status.
          </p>
        )}
        {detailed && (
          <div className="px-3 mt-2">
            <label htmlFor={noteId} className="block text-xs font-medium text-fg-secondary mb-1">Note (optional)</label>
            <textarea
              id={noteId}
              rows={2}
              maxLength={HEALTH_NOTE_MAX}
              value={note}
              aria-describedby={noteHelpId}
              placeholder="Why? e.g. vendor slipped API delivery"
              // One line: newlines (typed or pasted) become spaces.
              onChange={(e) => setNote(e.target.value.replace(/[\r\n]+/g, " "))}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || isImeComposing(e)) return;
                e.preventDefault();
                // Shift+Enter does nothing: the note is one line.
                if (e.shiftKey) return;
                if (!unchanged) void submit();
                else confirmRef.current?.focus();
              }}
              className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted resize-none transition"
            />
            <div id={noteHelpId} className="flex justify-between gap-2 text-xs text-fg-tertiary">
              <span>Shown in the tooltip and history.<span className="sr-only"> 280 characters maximum.</span></span>
              <span
                aria-hidden="true"
                className={note.length >= HEALTH_NOTE_MAX ? "text-danger" : note.length >= NOTE_WARN ? "text-warning" : undefined}
              >
                {note.length}/{HEALTH_NOTE_MAX}
              </span>
            </div>
          </div>
        )}
        </>)}
        <p role="status" aria-live="polite" className="px-3 mt-1 text-xs min-h-4">
          {error && <span className="text-danger">{error}</span>}
        </p>
        <div className="flex flex-wrap justify-end gap-2 px-3 py-3">
          <button
            type="button"
            onClick={() => { if (!savingRef.current) onDismiss(true); }}
            className="text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {editable ? "Cancel" : "Close"}
          </button>
          {editable && detailed && onConfirm !== undefined && (
            <button
              ref={confirmRef}
              type="button"
              onClick={() => { void confirm(); }}
              aria-disabled={!canConfirm || saving ? true : undefined}
              aria-describedby={canConfirm ? undefined : confirmReasonId}
              title={canConfirm ? undefined : confirmReason}
              className={`inline-flex items-center gap-2 text-sm border border-line-strong text-fg px-3 py-1.5 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                !canConfirm || saving ? "opacity-40 cursor-not-allowed" : "hover:bg-surface-hover"
              }`}
            >
              {pending === "confirm" && (
                <span aria-hidden="true" className="w-3 h-3 border-2 border-fg border-t-transparent rounded-full animate-spin motion-reduce:animate-none" />
              )}
              {pending === "confirm" ? "Confirming…" : "Confirm status"}
            </button>
          )}
          {editable && (
          <button
            type="submit"
            aria-describedby={detailed && unchanged ? saveReasonId : undefined}
            aria-disabled={unchanged || saving ? true : undefined}
            className={`inline-flex items-center gap-2 text-sm bg-button-primary text-on-primary px-3 py-1.5 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
              unchanged || saving ? "opacity-40 cursor-not-allowed" : "hover:bg-button-primary-hover"
            }`}
          >
            {pending === "save" && (
              <span aria-hidden="true" className="w-3 h-3 border-2 border-on-primary border-t-transparent rounded-full animate-spin motion-reduce:animate-none" />
            )}
            {pending === "save" ? "Saving…" : "Save"}
          </button>
          )}
          {/* Disabled reasons, outside the buttons so they stay out of the names. */}
          {editable && detailed && onConfirm !== undefined && !canConfirm && (
            <span id={confirmReasonId} className="sr-only">{confirmReason}</span>
          )}
          {editable && detailed && unchanged && (
            <span id={saveReasonId} className="sr-only">Choose a different status to save.</span>
          )}
        </div>
        {showHistory && (
          <div className="border-t border-line">
            <button
              type="button"
              aria-expanded={historyOpen}
              aria-controls={historyId}
              onClick={toggleHistory}
              className="w-full flex items-center justify-between px-3 py-2 min-h-9 text-xs font-medium text-fg-secondary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis"
            >
              History
              <svg aria-hidden="true" viewBox="0 0 20 20" className={`w-4 h-4 transition-transform motion-reduce:transition-none ${historyOpen ? "rotate-180" : ""}`} fill="currentColor">
                <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
              </svg>
            </button>
            {historyOpen && (
              <div
                id={historyId}
                role="region"
                aria-label="Status history"
                tabIndex={0}
                className="max-h-56 overflow-y-auto px-3 pb-2 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis"
              >
                {(history.status === "loading" || history.status === "idle") && (
                  <p role="status" className="text-xs text-fg-tertiary py-2">Loading history…</p>
                )}
                {history.status === "error" && (
                  <p className="text-xs py-2">
                    <span className="text-danger">Could not load history.</span>{" "}
                    <button type="button" onClick={loadHistory} className="text-primary-emphasis hover:underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded">
                      Try again
                    </button>
                  </p>
                )}
                {history.status === "done" && history.data.results.length === 0 && (
                  <p className="text-xs text-fg-tertiary py-2">
                    No changes recorded yet. Changes made from now on are listed here.
                  </p>
                )}
                {history.status === "done" && history.data.results.length > 0 && (
                  <ol>
                    {history.data.results.map((row, i) => (
                      <HistoryRow key={`${row.changed_at}-${i}`} row={row} parentName={parentName} prefs={datePrefs} />
                    ))}
                  </ol>
                )}
                {history.status === "done" && history.data.has_more && (
                  <p className="text-xs text-fg-tertiary pt-2">Showing the 20 most recent changes.</p>
                )}
              </div>
            )}
          </div>
        )}
      </form>
    </div>,
    document.body,
  );
}
