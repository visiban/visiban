import { useCallback, useEffect, useRef, useState } from "react";
import { useInstanceFlags } from "../../contexts/InstanceFlagsContext";
import { HEALTH_STATUS_LABELS, type HealthStatus } from "../../constants/healthStatus";
import {
  getHealthDisplay, healthCaption, healthStatusAnnouncement, healthTitle,
  type HealthAttribution, type HealthEntityKind, type HealthFields,
} from "../../utils/healthStatus";
import type { UserDatePrefs } from "../../utils/date";
import type { HealthHistory } from "../../types";
import HealthStatusPill from "./HealthStatusPill";
import HealthStatusPopover from "./HealthStatusPopover";

interface Props extends HealthFields, Partial<HealthAttribution> {
  entityKind: HealthEntityKind;
  entityName: string;
  /** Name of the group above the entity; null at the root (personal board, top-level group). */
  parentName: string | null;
  /** Board admin / group admin. The server is the authority; this only picks the control. */
  canEdit: boolean;
  collapseLabel?: boolean;
  /** Group header: a visible "Inherited from {Group}" caption beside the pill. */
  showCaption?: boolean;
  /**
   * Persist `next` (null = inherit / clear) and merge the server's response
   * into the parent's state. Reject to keep the popover open with a message.
   */
  onSave: (next: HealthStatus | null, note?: string | null) => Promise<{ effective_health_status: HealthStatus | null }>;
  /**
   * "detailed" (default for boards and groups, #2242) or "basic" (no note,
   * Confirm or History). A swimlane (#2243) is always "basic": lanes keep no
   * history, so `entityKind="swimlane"` ignores a "detailed" request.
   */
  mode?: "detailed" | "basic";
  /** Reconfirm the unchanged status with an optional note (POST .../health-status/). */
  onConfirm?: (status: HealthStatus, note: string | null) => Promise<unknown>;
  /** Load the history; given, non-admins get a read-only popover with it. */
  fetchHistory?: () => Promise<HealthHistory>;
  datePrefs?: UserDatePrefs | null;
  className?: string;
  /**
   * Swimlane label panel (#2243). `"icon"`: the admin's trigger for an unset
   * value is an icon button revealed on hover/focus (visible at rest on coarse
   * pointers), not a "No status" pill; the caller renders this variant only
   * while the value is unset. `"pill"` (default) is the header pill.
   */
  trigger?: "pill" | "icon";
  /** Pill spacing; `"lane"` for the swimlane label panel. */
  scope?: "header" | "lane";
  /** Shape-only pill at every width (collapsed lane). */
  shapeOnly?: boolean;
  /**
   * Focus the trigger once on mount, then call `onAutoFocused`. A lane's set
   * and unset triggers are different elements in different places, so after a
   * save that swaps them the parent asks the new one to take focus.
   */
  autoFocus?: boolean;
  onAutoFocused?: () => void;
  /**
   * Announce through the caller's live region instead of this control's own.
   * A lane save can unmount this control (set -> unset swaps triggers), and an
   * unmounted live region announces nothing.
   */
  onAnnounce?: (message: string) => void;
  /**
   * Told when the popover opens or closes. A lane's caller keeps the open
   * trigger mounted until it closes, so a remote update that would swap the
   * trigger (set <-> unset) never destroys an open editor and its draft.
   */
  onOpenChange?: (open: boolean) => void;
}

/** 16px half-filled circle: "a status could go here", in currentColor. */
function UnsetHealthIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
    </svg>
  );
}

/**
 * Health status in a header (#1133): the board page's Row 1 and the group
 * page's meta line, and a swimlane's label panel (#2243). An admin gets a
 * pill (or, for an unset lane, an icon) that opens `HealthStatusPopover`;
 * everyone else gets a pill that opens it read-only with the history (#2242;
 * a plain pill in basic mode, for a lane, or without `fetchHistory`), or
 * nothing at all when no status applies (never a greyed-out control). In the
 * hosted demo the admin trigger stays focusable but `aria-disabled` and never
 * opens.
 */
export default function HealthStatusControl({
  entityKind, entityName, parentName, canEdit, collapseLabel, showCaption, onSave, className = "",
  mode: requestedMode = "detailed", onConfirm, fetchHistory, datePrefs,
  trigger = "pill", scope, shapeOnly, autoFocus, onAutoFocused, onAnnounce, onOpenChange,
  health_status, effective_health_status, health_status_source,
  health_status_changed_at = null, health_status_changed_by = null, health_status_note = null,
}: Props) {
  const demoMode = useInstanceFlags().demo_mode;
  const fields = { health_status, effective_health_status, health_status_source };
  const isLane = entityKind === "swimlane";
  // Lanes are basic whatever the caller asks for (#2242 is board/group only).
  const mode = isLane ? "basic" : requestedMode;
  const detailed = mode === "detailed";
  const attribution: HealthAttribution | null = detailed
    ? { health_status_changed_at, health_status_changed_by, health_status_note }
    : null;
  const display = getHealthDisplay(fields);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const isOpen = anchorRect !== null;
  // Changes only, never on mount: a sibling trigger mounting closed must not
  // report "closed" over the one whose popover is open.
  const wasOpen = useRef(isOpen);
  useEffect(() => {
    if (wasOpen.current === isOpen) return;
    wasOpen.current = isOpen;
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);
  const srPrefix = isLane ? `Health status for lane ${entityName}: ` : undefined;

  useEffect(() => {
    if (!autoFocus) return;
    triggerRef.current?.focus();
    onAutoFocused?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: a later re-render must not steal focus again
  }, []);

  const announce = useCallback((message: string) => {
    if (onAnnounce) onAnnounce(message);
    else setAnnouncement(message);
  }, [onAnnounce]);

  const close = useCallback((refocus: boolean) => {
    setAnchorRect(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const save = useCallback(async (next: HealthStatus | null, note?: string | null) => {
    // basic mode keeps the one-argument call (#1133 callers, lanes).
    const result = note === undefined ? await onSave(next) : await onSave(next, note);
    setAnchorRect(null);
    triggerRef.current?.focus();
    announce(healthStatusAnnouncement(
      next, result.effective_health_status, parentName, isLane ? { name: entityName } : undefined,
    ));
  }, [onSave, parentName, isLane, entityName, announce]);

  const confirm = useCallback(async (status: HealthStatus, note: string | null) => {
    if (!onConfirm) return;
    await onConfirm(status, note);
    setAnchorRect(null);
    triggerRef.current?.focus();
    announce(`Health status confirmed: ${HEALTH_STATUS_LABELS[status]}.`);
  }, [onConfirm, announce]);

  // Group page caption (#2242): "Set 3d ago by Priya" / "Inherited from Eng · 3d ago".
  const captionText = showCaption
    ? (detailed ? healthCaption(display, attribution, health_status_source) : (display.inheritedFrom ? `Inherited from ${display.inheritedFrom}` : ""))
    : "";
  const captionTitle = captionText && !display.inheritedFrom && health_status_note
    ? `${captionText}. Note: ${health_status_note}`
    : captionText;
  const caption = captionText ? (
    <span className="text-xs text-fg-tertiary truncate max-w-[14rem] max-sm:max-w-full" title={captionTitle}>
      {captionText}
    </span>
  ) : null;
  // Always mounted, so a change of its text is announced (frontend/CLAUDE.md § Inline status messages).
  const liveRegion = <span role="status" aria-live="polite" className="sr-only">{announcement}</span>;

  const open = anchorRect !== null;
  const openFromTrigger = () => {
    if (open) { close(false); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchorRect(rect);
  };
  const popover = (readOnly: boolean) => open && (
    <HealthStatusPopover
      entityKind={entityKind}
      entityName={entityName}
      parentName={parentName}
      anchorRect={anchorRect}
      triggerRef={triggerRef}
      onDismiss={close}
      onSave={save}
      mode={mode}
      onConfirm={detailed && onConfirm ? confirm : undefined}
      fetchHistory={detailed ? fetchHistory : undefined}
      readOnly={readOnly}
      datePrefs={datePrefs}
      {...fields}
      health_status_changed_at={health_status_changed_at}
      health_status_changed_by={health_status_changed_by}
      health_status_note={health_status_note}
    />
  );

  if (!canEdit) {
    if (display.value === "none") return liveRegion;
    if (detailed && fetchHistory) {
      // Non-admins get a trigger that opens a read-only popover with the
      // history (#2242), never a greyed-out control.
      return (
        <>
          <HealthStatusPill
            ref={triggerRef}
            value={display.value}
            inheritedFrom={display.inheritedFrom}
            collapseLabel={collapseLabel}
            scope={scope}
            shapeOnly={shapeOnly}
            srPrefix={srPrefix}
            expanded={open}
            title={healthTitle(display, "readonly", attribution, health_status_source, entityKind)}
            className={className}
            onClick={openFromTrigger}
          />
          {caption}
          {liveRegion}
          {popover(true)}
        </>
      );
    }
    return (
      <>
        <HealthStatusPill
          value={display.value}
          inheritedFrom={display.inheritedFrom}
          collapseLabel={collapseLabel}
          scope={scope}
          shapeOnly={shapeOnly}
          srPrefix={srPrefix}
          title={healthTitle(display, "static", attribution, health_status_source, entityKind)}
          className={className}
        />
        {caption}
        {liveRegion}
      </>
    );
  }

  const toggle = () => {
    if (demoMode) return;
    openFromTrigger();
  };
  return (
    <>
      {trigger === "icon" ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          aria-label={isLane ? `Set health status for lane ${entityName}` : `Set health status for ${entityName}`}
          title={demoMode ? healthTitle(display, "demo") : "Set health status"}
          aria-haspopup={demoMode ? undefined : "dialog"}
          aria-expanded={demoMode ? undefined : open}
          aria-disabled={demoMode ? true : undefined}
          // 24px hit target (WCAG 2.5.8) around the 16px glyph.
          className={`inline-flex items-center justify-center min-w-6 min-h-6 text-fg-tertiary hover:text-fg rounded shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 transition ${open ? "opacity-100" : ""} ${demoMode ? "cursor-not-allowed" : ""} ${className}`}
        >
          <UnsetHealthIcon />
        </button>
      ) : (
        <HealthStatusPill
          ref={triggerRef}
          value={display.value}
          inheritedFrom={display.inheritedFrom}
          collapseLabel={collapseLabel}
          scope={scope}
          shapeOnly={shapeOnly}
          srPrefix={srPrefix}
          expanded={open}
          ariaDisabled={demoMode}
          title={healthTitle(display, demoMode ? "demo" : "interactive", attribution, health_status_source, entityKind)}
          className={className}
          onClick={toggle}
        />
      )}
      {caption}
      {liveRegion}
      {popover(false)}
    </>
  );
}
