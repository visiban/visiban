import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";
import { POPOVER_VIEWPORT_MARGIN, visibleMaxHeight } from "../../hooks/useAnchoredPlacement";
import { formatShortcut } from "../../utils/platform";
import ActiveMark from "../Common/ActiveMark";
import { MENU_ITEM_FOCUS_RING } from "../Common/menuItemFocusRing";
import { useLiveAnnouncer, laneStateMessage, columnStateMessage } from "../../hooks/useLiveAnnouncer";
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
  /** Total lane count, for the "Collapsed all N lanes" announcement (#2323). */
  laneCount?: number;
  /** Total column count, for the "Hid all N columns" announcement (#2338). */
  columnCount?: number;
  onCollapseSwimlanes: () => void;
  onExpandSwimlanes: () => void;
  onCollapseColumns: () => void;
  onExpandColumns: () => void;
  // Archived cards
  showArchived: boolean;
  onToggleArchived: () => void;
  /**
   * "Show sub-columns" (#2278). Rendered only when the board has a gated stage
   * (omit the handler otherwise): on, a split stage takes one column's width
   * per sub-column; off, normal width with a progress bar per card.
   */
  showSubColumns?: boolean;
  onShowSubColumnsChange?: (show: boolean) => void;
  /**
   * #2388 — names of the custom fields pinned to the card face, for the footer line
   * "On the card: <fields> Change". Omit `onChangeCardFields` (viewers who cannot
   * edit the board's fields) and the line shows without the action.
   */
  cardFieldNames?: string[];
  onChangeCardFields?: () => void;
  /**
   * Phones only (#2340): the View button is hidden and the Filter panel's "View options"
   * button opens this panel instead. Each bump of `openRequest` opens it anchored to
   * `anchorRef` (the Filter trigger), which also takes focus back on Escape or Tab-off.
   */
  phoneHandoff?: { openRequest: number; anchorRef: React.RefObject<HTMLButtonElement | null> };
  /**
   * Children mode's options (#2370): Lanes, Show done cards, Blocked only, Planned. Passed only while Children is
   * shown, and drawn first, so they live in the View menu (and, on phones, behind Filters through the handoff).
   */
  childrenOptions?: React.ReactNode;
}

const PANEL_WIDTH = 320

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
  // Where focus returns on close: the View button, or the Filter button on phones (#2340).
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The panel stays open after Collapse all / Expand all, so say what happened (#2323);
  // same wording as the Show row. Rendered outside the panel so it survives closing.
  const { message: laneAnnouncement, announce } = useLiveAnnouncer();
  const collapseLanes = () => { announce(laneStateMessage(true, props.laneCount)); props.onCollapseSwimlanes(); };
  const expandLanes = () => { announce(laneStateMessage(false, props.laneCount)); props.onExpandSwimlanes(); };
  const hideColumns = () => { announce(columnStateMessage(true, props.columnCount)); props.onCollapseColumns(); };
  const showColumns = () => { announce(columnStateMessage(false, props.columnCount)); props.onExpandColumns(); };
  const id = useId();
  const panelId = `${id}-panel`;

  const close = () => {
    setOpen(false);
    setAnchor(null);
  };
  // Popover tier 25; the pickers inside pass escapePriority={26} so Escape closes
  // an open picker menu first.
  useDropdownEscape(open, close, returnFocusRef, 25);

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

  const FOCUSABLE = 'button:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'
  const focusablesInPanel = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])

  // The panel is portaled to <body>, so move focus into it on open; otherwise
  // Tab from the View button would skip it entirely (keyboard parity, #2269).
  useEffect(() => {
    if (open && anchor) focusablesInPanel()[0]?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once per open, not per render
  }, [open, anchor !== null])

  // A button that disables itself on press (Collapse all) would drop focus to <body>;
  // hand it to the enabled sibling of the pair instead.
  const collapseRef = useRef<HTMLButtonElement>(null)
  const expandRef = useRef<HTMLButtonElement>(null)
  const hideRef = useRef<HTMLButtonElement>(null)
  const showRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    ;[[collapseRef, expandRef], [expandRef, collapseRef], [hideRef, showRef], [showRef, hideRef]].forEach(([from, to]) => {
      const active = document.activeElement
      if ((active === document.body || active === from.current) && from.current?.disabled && !to.current?.disabled && lastFocusRef.current === from.current) to.current?.focus()
    })
  })
  const lastFocusRef = useRef<Element | null>(null)

  // Tab off either end of the panel closes it and hands focus back to the trigger,
  // so the order stays trigger -> panel -> next toolbar control.
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return
    const items = focusablesInPanel()
    const edge = e.shiftKey ? items[0] : items[items.length - 1]
    if (items.length > 0 && document.activeElement !== edge) return
    close()
    returnFocusRef.current?.focus()
    if (e.shiftKey) e.preventDefault()
  }
  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (open && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault()
      focusablesInPanel()[0]?.focus()
    }
  }

  const openAt = (el: HTMLButtonElement | null) => {
    returnFocusRef.current = el;
    const rect = el?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 4, right: Math.max(POPOVER_VIEWPORT_MARGIN, Math.min(window.innerWidth - rect.right, window.innerWidth - PANEL_WIDTH - POPOVER_VIEWPORT_MARGIN)) });
    setOpen(true);
  };
  const toggle = () => {
    if (open) return close();
    openAt(triggerRef.current);
  };
  const openRequest = props.phoneHandoff?.openRequest ?? 0;
  const handoffAnchorRef = props.phoneHandoff?.anchorRef;
  // Only a new request opens the panel: mounting, or returning to phone width with an
  // old count, must not.
  const handledRequestRef = useRef(openRequest);
  useEffect(() => {
    if (openRequest <= handledRequestRef.current) return;
    handledRequestRef.current = openRequest;
    openAt(handoffAnchorRef?.current ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once per request, not per render
  }, [openRequest]);

  const { density, onDensityChange, cardLayout, onCardLayoutChange } = props;
  const cardFieldNames = props.cardFieldNames ?? [];

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
      data-shortcut-scope="popover"
      onKeyDown={onPanelKeyDown}
      onFocusCapture={(e) => { lastFocusRef.current = e.target }}
      style={{ position: "fixed", top: anchor.top, right: anchor.right, width: PANEL_WIDTH, maxWidth: `calc(100vw - ${2 * POPOVER_VIEWPORT_MARGIN}px)`, maxHeight: visibleMaxHeight(2 * POPOVER_VIEWPORT_MARGIN) }}
      className="z-50 bg-surface border border-line-strong rounded-lg shadow-lg p-3 space-y-3 overflow-y-auto max-sm:[&_button]:min-h-11"
    >
      <h2 className="text-sm font-semibold text-fg">View</h2>

      {props.childrenOptions}

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
        <span className={SECTION_LABEL}>Card layout <kbd className="ml-1 text-fg-secondary">{formatShortcut({ mod: true, shift: true, key: "L" })}</kbd></span>
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
        <span className={SECTION_LABEL}>Swimlanes <kbd className="ml-1 text-fg-secondary">E</kbd></span>
        <div className="flex gap-2">
          <button type="button" ref={collapseRef} className={BUTTON_CLASS} disabled={props.allSwimlanesCollapsed} onClick={collapseLanes}>Collapse all</button>
          <button type="button" ref={expandRef} className={BUTTON_CLASS} disabled={props.allSwimlanesExpanded} onClick={expandLanes}>Expand all</button>
        </div>
      </div>

      <div role="group" aria-label="Columns">
        <span className={SECTION_LABEL}>Columns <kbd className="ml-1 text-fg-secondary">E</kbd></span>
        <div className="flex gap-2">
          <button type="button" ref={hideRef} className={BUTTON_CLASS} disabled={props.allColumnsCollapsed} onClick={hideColumns}>Hide all</button>
          <button type="button" ref={showRef} className={BUTTON_CLASS} disabled={props.allColumnsExpanded} onClick={showColumns}>Show all</button>
        </div>
      </div>

      {props.onShowSubColumnsChange && (
        // A checkbox, as the reference menu draws it (#2388). The whole row is the target
        // (44px on phone): the label forwards its click to the box.
        <label className="flex items-center justify-between gap-2 cursor-pointer text-sm text-fg max-sm:min-h-11">
          Show sub-columns
          <input
            type="checkbox"
            checked={props.showSubColumns !== false}
            onChange={(e) => props.onShowSubColumnsChange?.(e.target.checked)}
            data-testid="view-menu-sub-columns"
            className="h-4 w-4 rounded accent-primary focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          />
        </label>
      )}

      <div className="flex items-start justify-between gap-2 border-t border-line pt-2">
        <p className="min-w-0 text-xs text-fg-secondary break-words" data-testid="view-menu-card-fields">
          On the card:{" "}
          <span className="text-fg">{cardFieldNames.length > 0 ? cardFieldNames.join(", ") : "No pinned fields"}</span>
        </p>
        {props.onChangeCardFields && (
          <button
            type="button"
            onClick={() => { close(); props.onChangeCardFields?.(); }}
            className="shrink-0 inline-flex items-center px-1 text-xs text-info underline hover:no-underline rounded max-sm:min-w-11 max-sm:justify-center focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Change
          </button>
        )}
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
          <span className="flex-1 text-left">{props.showArchived ? "Hide archived cards" : "Show archived cards"}</span>
          <kbd aria-hidden="true" className="text-xs text-fg-secondary">Y</kbd>
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
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-tour-step="view-menu"
        className={`${props.phoneHandoff ? "max-sm:hidden " : ""}inline-flex items-center justify-center gap-1.5 h-9 px-3 max-sm:h-11 max-sm:min-w-11 max-sm:px-0 text-sm rounded border transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
          open ? "text-info-on-tint bg-info/10 border-info/40" : "text-fg border-line-strong hover:bg-surface-hover"
        }`}
      >
        {props.icon}
        {/* Icon-only on phones (#2333); the text stays in the DOM as the accessible name. */}
        <span className="max-sm:sr-only">View</span>
        <svg className="w-3 h-3 max-sm:hidden" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="view-menu-lanes-status">{laneAnnouncement}</span>
      {panel && createPortal(panel, document.body)}
    </>
  );
}
