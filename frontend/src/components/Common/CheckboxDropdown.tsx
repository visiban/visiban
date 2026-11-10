import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";
import AnchoredMenuPanel from "./AnchoredMenuPanel";
import { captureMenuAnchor, type MenuAnchor } from "../../utils/menuAnchor";

export interface CheckboxDropdownProps<T extends string | number> {
  label: string;
  options: { value: T; label: string; color?: string }[];
  selected: T[];
  onChange: (selected: T[]) => void;
  /**
   * #964 — fired on every open/close transition (click-toggle, outside-click,
   * and Escape via useDropdownEscape). Additive and optional: no existing
   * consumer passes it, so no existing behavior changes. Lets a caller (e.g.
   * FilterBar's "+ Filter" facet controls) react to a control closing itself,
   * such as collapsing a facet back out of the toolbar row.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * #964 — optional count badge rendered after the label, before the
   * chevron, when a truthy (non-zero) count is passed. Used by triggers
   * (e.g. "+ Filter") that reveal a variable set of sub-controls rather than
   * being a single filter themselves — see frontend/CLAUDE.md "Dropdown
   * menus" for the token spec. `badge={0}` and `badge={undefined}` both
   * suppress the badge (and its aria-label fold-in) — the component gates
   * both the visible pill and the accessible name on the same truthy check,
   * so a caller never has to remember to pass `count || undefined`.
   */
  badge?: number;
  /**
   * #964 — when true, the trigger's visible/accessible label stays pinned to
   * the static `label` prop instead of the generic "{label}: {selected
   * labels}" summary `displayLabel` normally renders. For a trigger whose
   * job is to reveal a variable set of *other* controls into the toolbar
   * (e.g. "+ Filter", where `selected` drives which facets are expanded,
   * not a filter value) rather than being a single filter itself, letting
   * `selected` also drive the visible label text creates a second,
   * easily-conflated signal alongside the border-color "has a value" state
   * and the `badge` count, and can diverge from the `aria-label` (which is
   * always built from the static `label`) — a WCAG 2.5.3 Label-in-Name
   * mismatch. Default false preserves existing behavior for every other
   * consumer (Assignee, Label, Priority, "+ Custom fields", etc.), whose
   * `selected` genuinely represents the filter's own value.
   */
  hideSelectionSummary?: boolean;
}

function CheckboxDropdownInner<T extends string | number>(
  { label, options, selected, onChange, onOpenChange, badge, hideSelectionSummary }: CheckboxDropdownProps<T>,
  forwardedRef: React.Ref<HTMLButtonElement>,
) {
  const [open, setOpenState] = useState(false);
  // Trigger rect captured at open: the menu is a `fixed` portal, so a scroll
  // region or `overflow` ancestor can never clip it, and it holds user data
  // (assignees, labels) whose length is unbounded (#1482).
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const menuId = `${id}-menu`;

  useImperativeHandle(forwardedRef, () => triggerRef.current as HTMLButtonElement);

  // #964 — onOpenChange fires as a plain call after setOpenState, never
  // inside the updater passed to it: React may invoke a state updater more
  // than once (e.g. Strict Mode's dev-only double-invoke), and a side effect
  // living inside one would double-fire. Every call site below already knows
  // the resolved next value up front (no site needs the previous-state
  // functional form), so there's nothing to gain from routing through one.
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (!next) setAnchor(null);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  useDropdownEscape(open, () => setOpen(false), triggerRef);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // The menu is portaled out of `ref`, so it needs its own check.
      if (menuRef.current?.contains(target)) return;
      if (ref.current && !ref.current.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, setOpen]);

  // Runs once the panel is placed and visible (browsers ignore focus() on a hidden element).
  const focusFirst = useCallback(() => {
    menuRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
  }, []);
  const dismiss = useCallback(() => setOpen(false), [setOpen]);

  const toggle = (value: T) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    );
  };

  const displayLabel = hideSelectionSummary
    ? label
    : selected.length === 0
    ? label
    : selected.length === options.length
    ? `${label}: All`
    : `${label}: ${selected
        .map((v) => options.find((o) => o.value === v)?.label ?? v)
        .join(", ")}`;

  const showBadge = !!badge;

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        onClick={() => {
          if (!open) setAnchor(captureMenuAnchor(triggerRef.current));
          setOpen(!open);
        }}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={showBadge ? `${label}, ${badge} active` : undefined}
        className={`bg-surface border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-sunken ${
          selected.length > 0
            ? "border-primary-soft text-info"
            : "border-line-strong text-fg-secondary hover:border-line-emphasis"
        }`}
      >
        {displayLabel}
        {showBadge && (
          <span
            aria-hidden="true"
            className="bg-primary-emphasis/20 text-info px-2 py-0.5 text-xs rounded-full"
          >
            {badge}
          </span>
        )}
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

      {open && anchor && (
        <AnchoredMenuPanel
          anchor={anchor}
          panelRef={menuRef}
          onDismiss={dismiss}
          onPlaced={focusFirst}
          returnFocusRef={triggerRef}
          minWidth={140}
          deps={[options.length]}
          role="group"
          id={menuId}
          aria-label={label}
        >
          {options.length === 0 ? (
            <p className="px-3 py-2 text-sm text-fg-muted italic">
              No options available
            </p>
          ) : (
            options.map((opt, i) => (
              <div key={opt.value}>
                {i > 0 && (
                  <div role="separator" className="mx-4">
                    <div className="h-px bg-sunken" />
                    <div className="h-px bg-surface-active/50" />
                  </div>
                )}
                <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover cursor-pointer text-sm text-fg-secondary">
                  <input
                    type="checkbox"
                    checked={selected.includes(opt.value)}
                    onChange={() => toggle(opt.value)}
                    className="rounded accent-primary"
                  />
                  {opt.color && (
                    <span
                      className="color-dot w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: opt.color }}
                    />
                  )}
                  {opt.label}
                </label>
              </div>
            ))
          )}
        </AnchoredMenuPanel>
      )}
    </div>
  );
}

// #964 — forwardRef so a caller (FilterBar's "+ Filter" trigger) can hold a
// ref to the trigger button for focus management, while keeping the
// component's existing generic <T> type parameter. forwardRef itself can't
// express a generic component signature, so the export is cast back to one;
// the runtime behavior (an ordinary forwardRef component) is unaffected.
const CheckboxDropdown = forwardRef(CheckboxDropdownInner) as unknown as (<T extends string | number>(
  props: CheckboxDropdownProps<T> & { ref?: React.Ref<HTMLButtonElement> },
) => React.ReactElement);

export default CheckboxDropdown;
