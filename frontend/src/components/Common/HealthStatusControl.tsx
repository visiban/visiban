import { useCallback, useRef, useState } from "react";
import { useInstanceFlags } from "../../contexts/InstanceFlagsContext";
import type { HealthStatus } from "../../constants/healthStatus";
import {
  getHealthDisplay, healthStatusAnnouncement, healthTitle, type HealthFields,
} from "../../utils/healthStatus";
import HealthStatusPill from "./HealthStatusPill";
import HealthStatusPopover from "./HealthStatusPopover";

interface Props extends HealthFields {
  entityKind: "board" | "group";
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
  health_status, effective_health_status, health_status_source,
}: Props) {
  const demoMode = useInstanceFlags().demo_mode;
  const fields = { health_status, effective_health_status, health_status_source };
  const display = getHealthDisplay(fields);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const close = useCallback((refocus: boolean) => {
    setAnchorRect(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const save = useCallback(async (next: HealthStatus | null) => {
    const result = await onSave(next);
    setAnchorRect(null);
    triggerRef.current?.focus();
    setAnnouncement(healthStatusAnnouncement(next, result.effective_health_status, parentName));
  }, [onSave, parentName]);

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
          title={healthTitle(display, "static")}
          className={className}
        />
        {caption}
        {liveRegion}
      </>
    );
  }

  const open = anchorRect !== null;
  return (
    <>
      <HealthStatusPill
        ref={triggerRef}
        value={display.value}
        inheritedFrom={display.inheritedFrom}
        collapseLabel={collapseLabel}
        expanded={open}
        ariaDisabled={demoMode}
        title={healthTitle(display, demoMode ? "demo" : "interactive")}
        className={className}
        onClick={() => {
          if (demoMode) return;
          if (open) { close(false); return; }
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect) setAnchorRect(rect);
        }}
      />
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
