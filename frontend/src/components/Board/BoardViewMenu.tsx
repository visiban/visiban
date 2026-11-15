import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";
import { POPOVER_VIEWPORT_MARGIN, visibleMaxHeight } from "../../hooks/useAnchoredPlacement";
import ActiveMark from "../Common/ActiveMark";
import { MENU_ITEM_FOCUS_RING } from "../Common/menuItemFocusRing";
import type { CardDensity } from "../../types";

interface Props {
  /** Icon shown before the "View" label. */
  icon?: React.ReactNode;
  /** The Preset picker (a SingleSelectDropdown; the caller owns its apply/undo wiring). */
  presetPicker: React.ReactNode;
  // Card density
  density: CardDensity;
  onDensityChange: (d: CardDensity) => void;
  // Card layout
  cardLayout: "compact" | "expanded";
  onCardLayoutChange: (l: "compact" | "expanded") => void;
  /** The Overlay picker (a SingleSelectDropdown). */
  overlayPicker: React.ReactNode;
  // Swimlanes and columns
  allSwimlanesCollapsed: boolean;
  allSwimlanesExpanded: boolean;
  allColumnsCollapsed: boolean;
  allColumnsExpanded: boolean;
  onCollapseSwimlanes: () => void;
  onExpandSwimlanes: () => void;
  onCollapseColumns: () => void;
  onExpandColumns: () => void;
  // Archived cards
  showArchived: boolean;
  onToggleArchived: () => void;
}

const DENSITIES: { value: CardDensity; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "standard", label: "Standard" },
  { value: "dense", label: "Dense" },
];

const SECTION_LABEL = "block text-xs text-fg-secondary mb-1";
const BUTTON_CLASS = `flex-1 text-sm text-fg border border-line-strong rounded px-2 py-1.5 hover:bg-surface-hover transition disabled:opacity-40 disabled:cursor-not-allowed ${MENU_ITEM_FOCUS_RING}`;

/**
 * The board toolbar's View button and panel (#2269): Preset, card density,
 * card layout, overlay, and the collapse/expand actions that used to be
 * separate toolbar controls. Everything is a native control, so Tab, arrows
 * and Space work with no custom key handling; Escape closes and returns focus
 * to the trigger. The panel is portaled so the toolbar never clips it, and it
 * closes on resize or an outside scroll like the other anchored menus.
 */
export default function BoardViewMenu(props: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const panelId = `${id}-panel`;

  const close = () => {
    setOpen(false);
    setAnchor(null);
  };
  // Priority 24, below a picker's own menu (25), so Escape closes that menu first.
  useDropdownEscape(open, close, triggerRef, 24);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      // A picker inside the panel portals its own menu to <body>; that is still "inside".
      if (t instanceof Element && t.closest('[role="menu"]')) return;
      close();
    };
    const onResize = () => close();
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      if (e.target instanceof Element && e.target.closest('[role="menu"]')) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) return close();
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 4, right: Math.max(POPOVER_VIEWPORT_MARGIN, window.innerWidth - rect.right) });
    setOpen(true);
  };

  const { density, onDensityChange, cardLayout, onCardLayoutChange } = props;

  const segment = (label: string, active: boolean, onClick: () => void, first: boolean) => (
    <button
      key={label}
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex-1 inline-flex items-center justify-center gap-1 text-sm px-2 py-1.5 transition ${first ? "" : "border-l border-line-strong"} ${
        active ? "bg-primary text-on-primary font-medium" : "text-fg-secondary hover:text-fg hover:bg-surface-hover"
      } focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis`}
    >
      <ActiveMark active={active} />
      {label}
    </button>
  );

  const panel = open && anchor ? (
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      aria-label="View options"
      data-testid="view-menu-panel"
      style={{ position: "fixed", top: anchor.top, right: anchor.right, width: 320, maxWidth: `calc(100vw - ${2 * POPOVER_VIEWPORT_MARGIN}px)`, maxHeight: visibleMaxHeight(2 * POPOVER_VIEWPORT_MARGIN) }}
      className="z-50 bg-surface border border-line-strong rounded-lg shadow-lg p-3 space-y-3 overflow-y-auto"
    >
      <h2 className="text-sm font-semibold text-fg">View</h2>

      <div>
        <span className={SECTION_LABEL}>Preset</span>
        {props.presetPicker}
      </div>

      <div role="group" aria-label="Card density">
        <span className={SECTION_LABEL}>Card density</span>
        <div className="flex border border-line-strong rounded overflow-hidden">
          {DENSITIES.map((d, i) => segment(d.label, density === d.value, () => onDensityChange(d.value), i === 0))}
        </div>
      </div>

      <div role="group" aria-label="Card layout">
        <span className={SECTION_LABEL}>Card layout (Ctrl/Cmd+Shift+L)</span>
        <div className="flex border border-line-strong rounded overflow-hidden">
          {segment("Expanded", cardLayout === "expanded", () => onCardLayoutChange("expanded"), true)}
          {segment("Compact", cardLayout === "compact", () => onCardLayoutChange("compact"), false)}
        </div>
      </div>

      <div>
        <span className={SECTION_LABEL}>Overlay</span>
        {props.overlayPicker}
      </div>

      <div role="group" aria-label="Swimlanes">
        <span className={SECTION_LABEL}>Swimlanes</span>
        <div className="flex gap-2">
          <button type="button" className={BUTTON_CLASS} disabled={props.allSwimlanesCollapsed} onClick={props.onCollapseSwimlanes}>Collapse all</button>
          <button type="button" className={BUTTON_CLASS} disabled={props.allSwimlanesExpanded} onClick={props.onExpandSwimlanes}>Expand all</button>
        </div>
      </div>

      <div role="group" aria-label="Columns">
        <span className={SECTION_LABEL}>Columns (E toggles everything)</span>
        <div className="flex gap-2">
          <button type="button" className={BUTTON_CLASS} disabled={props.allColumnsCollapsed} onClick={props.onCollapseColumns}>Hide all</button>
          <button type="button" className={BUTTON_CLASS} disabled={props.allColumnsExpanded} onClick={props.onExpandColumns}>Show all</button>
        </div>
      </div>

      <div className="border-t border-line pt-2">
        <button
          type="button"
          aria-pressed={props.showArchived}
          aria-keyshortcuts="Y"
          onClick={props.onToggleArchived}
          className={`w-full flex items-center gap-2 text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover rounded px-1 py-1.5 ${MENU_ITEM_FOCUS_RING}`}
        >
          <ActiveMark active={props.showArchived} />
          {props.showArchived ? "Hide archived cards" : "Show archived cards"}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-tour-step="view-menu"
        className={`inline-flex items-center gap-1.5 h-9 px-3 text-sm rounded border transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
          open ? "bg-surface-active text-fg border-line-emphasis" : "text-fg border-line-strong hover:bg-surface-hover"
        }`}
      >
        {props.icon}
        View
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {panel && createPortal(panel, document.body)}
    </>
  );
}
