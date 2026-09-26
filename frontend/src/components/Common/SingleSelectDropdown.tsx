import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";

export interface SingleSelectDropdownProps<T extends string | number> {
  label: string;
  options: { value: T; label: string }[];
  selected: T | null;
  onChange: (selected: T | null) => void;
  /**
   * Optional element rendered before the trigger label (e.g. an icon).
   * Decorative — the component wraps it in aria-hidden.
   */
  triggerPrefix?: ReactNode;
  /**
   * Extra classes merged onto the trigger button (#371) — e.g. `"w-full
   * justify-between"` when the dropdown needs to fill a form-field-width
   * container instead of the default inline/auto width. Additive only; the
   * component's own base classes always apply.
   */
  className?: string;
  /**
   * Escape-stack priority for the open menu (#1140). Defaults to the
   * dropdown tier, 25. A dropdown rendered inside a `ModalWrapper` (priority
   * 40) MUST pass a higher value, or Escape closes the modal and discards the
   * form instead of just closing this menu.
   */
  escapePriority?: number;
  /**
   * #964 — fired on every open/close transition (click-toggle, outside-click,
   * and Escape via useDropdownEscape). Additive and optional: no existing
   * consumer passes it, so no existing behavior changes.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * #1147 — render the menu into a `document.body` portal, anchored with
   * `getBoundingClientRect` + `position: fixed`, exactly as `SplitButton` does.
   *
   * Required for any dropdown placed inside the Row 2 board toolbar: that strip is
   * `overflow-x-auto` on an `h-10` box, and per the CSS spec `overflow-x: auto` with
   * the default `overflow-y: visible` promotes the y-axis to `auto` too — so an
   * `absolute top-full` menu is clipped to 40px of height.
   *
   * Opt-in rather than the default because the in-flow menu is inside the component's
   * own DOM subtree, which is what modal focus traps and existing call sites assume.
   */
  portalMenu?: boolean;
}

export default function SingleSelectDropdown<T extends string | number>({
  label,
  options,
  selected,
  onChange,
  triggerPrefix,
  className,
  escapePriority,
  onOpenChange,
  portalMenu = false,
}: SingleSelectDropdownProps<T>) {
  const [open, setOpenState] = useState(false);
  // Menu anchor captured at open time (portal mode only), so the position survives a
  // re-render without re-measuring. Same approach as SplitButton.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const menuId = `${id}-menu`;

  // #964 — onOpenChange fires as a plain call after setOpenState, never
  // inside a state-updater function (see the identical comment in
  // CheckboxDropdown.tsx for why). Every call site here already knows the
  // resolved next value up front.
  const setOpen = useCallback(
    (next: boolean) => {
      if (next && portalMenu) {
        const rect = triggerRef.current?.getBoundingClientRect();
        if (rect) setAnchor({ top: rect.bottom + 4, left: rect.left });
      }
      if (!next) setAnchor(null);
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange, portalMenu],
  );

  useDropdownEscape(open, () => setOpen(false), triggerRef, escapePriority);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // In portal mode the menu is not inside `ref`, so it needs its own check or
      // every click on an option would first close the menu.
      if (panelRef.current?.contains(target)) return;
      if (ref.current && !ref.current.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, setOpen]);

  const displayLabel =
    selected === null
      ? label
      : options.find((o) => o.value === selected)?.label ?? label;

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      itemRefs.current[0]?.focus();
      e.preventDefault();
    }
  };

  const handleItemKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === "ArrowDown") {
      itemRefs.current[Math.min(i + 1, options.length - 1)]?.focus();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      if (i === 0) triggerRef.current?.focus();
      else itemRefs.current[i - 1]?.focus();
      e.preventDefault();
    } else if (e.key === "Home") {
      itemRefs.current[0]?.focus();
      e.preventDefault();
    } else if (e.key === "End") {
      itemRefs.current[options.length - 1]?.focus();
      e.preventDefault();
    }
  };

  const menu = (
    <div
      ref={panelRef}
      role="menu"
      id={menuId}
      aria-labelledby={`${id}-trigger`}
      style={portalMenu && anchor ? { position: "fixed", top: anchor.top, left: anchor.left } : undefined}
      className={`${portalMenu ? "" : "absolute top-full mt-1 left-0 "}z-50 bg-surface border border-line-strong rounded-lg shadow-lg py-1 min-w-[140px]`}
    >
      {options.map((opt, i) => (
        <div key={opt.value}>
          {i > 0 && (
            <div role="separator" className="mx-4">
              <div className="h-px bg-sunken" />
              <div className="h-px bg-surface-active/50" />
            </div>
          )}
          <button
            ref={(el) => { itemRefs.current[i] = el; }}
            role="menuitem"
            onClick={() => {
              onChange(selected === opt.value ? null : opt.value);
              setOpen(false);
            }}
            onKeyDown={(e) => handleItemKeyDown(e, i)}
            // Menu items are real tab stops, reached by roving arrow-key
            // focus — `hover:` alone is invisible to a keyboard user who
            // arrowed here without touching the mouse. Pre-existing gap,
            // fixed here because #1140 newly routes modal-hosted dropdowns
            // through this primitive.
            className={`w-full text-left px-3 py-1.5 hover:bg-surface-hover text-sm transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
              selected === opt.value ? "text-info" : "text-fg-secondary"
            }`}
          >
            {opt.label}
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        id={`${id}-trigger`}
        onClick={() => setOpen(!open)}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className={`bg-surface border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-sunken ${
          selected !== null
            ? "border-info text-info"
            : "border-line-strong text-fg-secondary hover:border-line-emphasis"
        } ${className ?? ""}`}
      >
        {triggerPrefix !== undefined && (
          <span aria-hidden="true" className="flex items-center">
            {triggerPrefix}
          </span>
        )}
        {displayLabel}
        <svg
          className="w-3 h-3 text-fg-muted"
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (portalMenu ? createPortal(menu, document.body) : menu)}
    </div>
  );
}
