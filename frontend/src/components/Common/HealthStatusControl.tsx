import { useCallback, useEffect, useRef, useState } from "react";
import { useInstanceFlags } from "../../contexts/InstanceFlagsContext";
import type { HealthStatus } from "../../constants/healthStatus";
import {
  getHealthDisplay, healthStatusAnnouncement, healthTitle, type HealthEntityKind, type HealthFields,
} from "../../utils/healthStatus";
import HealthStatusPill from "./HealthStatusPill";
import HealthStatusPopover from "./HealthStatusPopover";

interface Props extends HealthFields {
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
  onSave: (next: HealthStatus | null) => Promise<{ effective_health_status: HealthStatus | null }>;
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
 * page's meta line. An admin gets a pill that opens `HealthStatusPopover`;
 * everyone else gets a plain pill, or nothing at all when no status applies
 * (never a greyed-out control). In the hosted demo the admin trigger stays
 * focusable but `aria-disabled` and never opens.
 */
export default function HealthStatusControl({
  entityKind, entityName, parentName, canEdit, collapseLabel, showCaption, onSave, className = "",
  trigger = "pill", scope, shapeOnly, autoFocus, onAutoFocused, onAnnounce,
  health_status, effective_health_status, health_status_source,
}: Props) {
  const demoMode = useInstanceFlags().demo_mode;
  const fields = { health_status, effective_health_status, health_status_source };
  const display = getHealthDisplay(fields);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const isLane = entityKind === "swimlane";
  const srPrefix = isLane ? `Health status for lane ${entityName}: ` : undefined;

  useEffect(() => {
    if (!autoFocus) return;
    triggerRef.current?.focus();
    onAutoFocused?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: a later re-render must not steal focus again
  }, []);

  const close = useCallback((refocus: boolean) => {
    setAnchorRect(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const save = useCallback(async (next: HealthStatus | null) => {
    const result = await onSave(next);
    setAnchorRect(null);
    triggerRef.current?.focus();
    const message = healthStatusAnnouncement(
      next, result.effective_health_status, parentName, isLane ? { name: entityName } : undefined,
    );
    if (onAnnounce) onAnnounce(message);
    else setAnnouncement(message);
  }, [onSave, parentName, isLane, entityName, onAnnounce]);

  const caption = showCaption && display.inheritedFrom ? (
    <span className="text-xs text-fg-tertiary max-w-[14rem] truncate" title={`Inherited from ${display.inheritedFrom}`}>
      Inherited from {display.inheritedFrom}
    </span>
  ) : null;
  // Always mounted, so a change of its text is announced (frontend/CLAUDE.md § Inline status messages).
  const liveRegion = <span role="status" aria-live="polite" className="sr-only">{announcement}</span>;

  if (!canEdit) {
    if (display.value === "none") return liveRegion;
    return (
      <>
        <HealthStatusPill
          value={display.value}
          inheritedFrom={display.inheritedFrom}
          collapseLabel={collapseLabel}
          scope={scope}
          shapeOnly={shapeOnly}
          srPrefix={srPrefix}
          title={healthTitle(display, "static", entityKind)}
          className={className}
        />
        {caption}
        {liveRegion}
      </>
    );
  }

  const open = anchorRect !== null;
  const toggle = () => {
    if (demoMode) return;
    if (open) { close(false); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchorRect(rect);
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
          className={`text-fg-tertiary hover:text-fg rounded shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 transition ${open ? "opacity-100" : ""} ${demoMode ? "cursor-not-allowed" : ""} ${className}`}
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
          title={healthTitle(display, demoMode ? "demo" : "interactive", entityKind)}
          className={className}
          onClick={toggle}
        />
      )}
      {caption}
      {liveRegion}
      {open && (
        <HealthStatusPopover
          entityKind={entityKind}
          entityName={entityName}
          parentName={parentName}
          anchorRect={anchorRect}
          triggerRef={triggerRef}
          onDismiss={close}
          onSave={save}
          {...fields}
        />
      )}
    </>
  );
}
