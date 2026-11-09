import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPlacement, POPOVER_VIEWPORT_MARGIN, clampLeftToVisible } from "../../hooks/useAnchoredPlacement";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import {
  HEALTH_STATUS_DESCRIPTIONS, HEALTH_STATUS_LABELS, HEALTH_STATUS_TEXT, HEALTH_STATUS_VALUES,
  NO_STATUS_LABEL, type HealthDisplayValue, type HealthStatus,
} from "../../constants/healthStatus";
import { getHealthDisplay, healthStatusErrorMessage, type HealthFields } from "../../utils/healthStatus";
import HealthStatusShape from "./HealthStatusShape";

/** The draft: a stored value, or "inherit" for null (inherit at a nested level, clear at the root). */
type Draft = HealthStatus | "inherit";

export interface HealthStatusPopoverProps extends HealthFields {
  entityKind: "board" | "group";
  entityName: string;
  /** Name of the group above the entity; null at the root (a personal board or a top-level group). */
  parentName: string | null;
  anchorRect: DOMRect;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Close with no write. `refocus` returns focus to the trigger (Cancel, Escape). */
  onDismiss: (refocus: boolean) => void;
  /** Persist; resolve on success (the parent merges the response), reject on failure. */
  onSave: (next: HealthStatus | null) => Promise<void>;
}

const PANEL_WIDTH = 320;
const CARD = "flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-emphasis";
const CARD_SELECTED = "border-primary-emphasis bg-primary-emphasis/10";
const CARD_IDLE = "border-line-strong hover:bg-surface-hover/40";

function stateLine(fields: HealthFields, entityKind: "board" | "group", parentName: string | null): string {
  if (fields.health_status !== null) return entityKind === "board" ? "Set on this board." : "Set on this group.";
  const display = getHealthDisplay(fields);
  if (display.inheritedFrom) return `Inherited from ${display.inheritedFrom}.`;
  return parentName !== null ? "No status set here or in a group above." : "No status set.";
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
  health_status, effective_health_status, health_status_source,
}: HealthStatusPopoverProps) {
  const fields = { health_status, effective_health_status, health_status_source };
  const panelRef = useRef<HTMLDivElement>(null);
  const checkedRef = useRef<HTMLInputElement>(null);
  const initial: Draft = health_status ?? "inherit";
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
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
    deps: [error],
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
    checkedRef.current?.focus();
  }, [placed]);

  const unchanged = draft === initial;

  const submit = async () => {
    if (savingRef.current) return;
    if (unchanged) {
      onDismiss(true);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft === "inherit" ? null : draft);
    } catch (err) {
      setError(healthStatusErrorMessage(err));
      savingRef.current = false;
      setSaving(false);
      return;
    }
    savingRef.current = false;
    // The parent closes the popover and returns focus on success.
  };

  const resetLabel = parentName !== null ? `Inherit from ${parentName}` : NO_STATUS_LABEL;
  const resetDescription = parentName !== null
    ? `Follow ${parentName}, or the nearest group above it that has a status.`
    : "Clear the status. Nothing is shown as set.";
  const left = clampLeftToVisible(anchorRect.left, PANEL_WIDTH);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
      aria-label={`Health status for ${entityName}`}
      className="fixed z-50 bg-surface border border-line-strong rounded-lg shadow-xl focus:outline-none"
      style={{
        top: top ?? 0,
        left,
        width: `min(${PANEL_WIDTH}px, calc(100vw - ${2 * POPOVER_VIEWPORT_MARGIN}px))`,
        visibility: top === null ? "hidden" : undefined,
      }}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        onKeyDown={(e) => {
          // Enter on a radio submits (browsers do not submit a form from a radio).
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
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
        </div>
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
        <p role="status" aria-live="polite" className="px-3 mt-1 text-xs min-h-4">
          {error && <span className="text-danger">{error}</span>}
        </p>
        <div className="flex justify-end gap-2 px-3 py-3">
          <button
            type="button"
            onClick={() => { if (!savingRef.current) onDismiss(true); }}
            className="text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Cancel
          </button>
          <button
            type="submit"
            aria-disabled={unchanged || saving ? true : undefined}
            className={`inline-flex items-center gap-2 text-sm bg-button-primary text-on-primary px-3 py-1.5 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
              unchanged || saving ? "opacity-40 cursor-not-allowed" : "hover:bg-button-primary-hover"
            }`}
          >
            {saving && (
              <span aria-hidden="true" className="w-3 h-3 border-2 border-on-primary border-t-transparent rounded-full animate-spin motion-reduce:animate-none" />
            )}
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
