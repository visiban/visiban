import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { POPOVER_VIEWPORT_MARGIN, useAnchoredPlacement } from "../../hooks/useAnchoredPlacement";
import { useOverflowFade } from "../../hooks/useOverflowFade";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";

export interface SelectDropdownOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectDropdownOption<T>[];
  disabled?: boolean;
  /** Shown as a tooltip on the trigger when disabled, explaining why. */
  disabledReason?: string;
  /** "xs" for compact inline selects; "sm" for form-level selects */
  size?: "xs" | "sm";
  placeholder?: string;
  className?: string;
  /** Applied to the trigger button so an external <label htmlFor> can target it. */
  id?: string;
  /**
   * Escape-stack priority while the menu is open (#1480). Defaults to 50, above
   * `ModalWrapper` (40) and the card detail panel (30), because this primitive
   * is used inside both and Escape must close only the menu. Claim a different
   * value only if a higher-priority overlay can sit over an open menu.
   */
  escapePriority?: number;
  /**
   * #439 — accessible name for the trigger when no `<label htmlFor>` targets
   * it and its visible text is only the selected value. Applied as
   * `aria-label="<ariaLabel>: <selected label>"`, the same shape as
   * `SingleSelectDropdown`'s `ariaLabel`. A disabled trigger's
   * `disabledReason` still wins.
   */
  ariaLabel?: string;
}

const MIN_MENU_WIDTH = 96;

export default function SelectDropdown<T extends string>({
  value,
  onChange,
  options,
  disabled = false,
  disabledReason,
  size = "sm",
  placeholder,
  className = "",
  id,
  escapePriority = 50,
  ariaLabel,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Trigger rect captured at open time; the menu is a `position: fixed` portal
  // so a scrolling modal or panel ancestor can never clip it (#1480).
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; left: number; minWidth: number } | null>(null);
  const listboxId = useId();
  const optionIdPrefix = useId();

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    setAnchor(null);
  }, []);

  const openMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      // At least trigger-wide, and clamped so it never runs off the right edge.
      const minWidth = Math.max(rect.width, MIN_MENU_WIDTH);
      const left = Math.max(
        POPOVER_VIEWPORT_MARGIN,
        Math.min(rect.left, window.innerWidth - minWidth - POPOVER_VIEWPORT_MARGIN),
      );
      setAnchor({ top: rect.top, bottom: rect.bottom, left, minWidth });
    }
    setOpen(true);
  }, []);

  const top = useAnchoredPlacement(panelRef, {
    anchor: anchor ? { top: anchor.top, bottom: anchor.bottom } : null,
    deps: [open, options.length],
    onResize: close,
    onOutsideScroll: close,
  });
  const { moreBelow, onScroll } = useOverflowFade(listRef, [open, options.length]);

  useDropdownEscape(open, close, triggerRef, escapePriority);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // The menu is portaled out of `containerRef`, so it needs its own check.
      if (panelRef.current?.contains(target)) return;
      if (containerRef.current && !containerRef.current.contains(target)) close();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, close]);

  // Initialize activeIndex to the currently selected option when opening
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setActiveIndex(idx >= 0 ? idx : 0);
    }
  }, [open, value, options]);

  // The list is viewport-capped and scrolls, so arrowing must keep the active
  // option visible (the trigger keeps focus; nothing else scrolls it).
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${optionIdPrefix}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, optionIdPrefix]);

  const handleSelect = (val: T) => {
    onChange(val);
    close();
    // The portaled menu is outside any surrounding dialog; hand focus back so
    // it does not drop to <body> (#1480).
    triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        if (!open) {
          openMenu();
        } else {
          const next = e.key === "ArrowDown"
            ? Math.min(activeIndex + 1, options.length - 1)
            : Math.max(activeIndex - 1, 0);
          setActiveIndex(next);
        }
        break;
      }
      case "Home":
      case "End": {
        if (open) {
          e.preventDefault();
          setActiveIndex(e.key === "Home" ? 0 : options.length - 1);
        }
        break;
      }
      case "Enter":
      case " ": {
        if (!open) {
          e.preventDefault();
          openMenu();
        } else if (activeIndex >= 0 && activeIndex < options.length) {
          e.preventDefault();
          handleSelect(options[activeIndex].value);
        }
        break;
      }
      case "Tab": {
        // Focus stays on the trigger, so the browser's Tab moves on from it.
        if (open) close();
        break;
      }
    }
  };

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? placeholder ?? value;
  const activeDescendant = open && activeIndex >= 0 ? `${optionIdPrefix}-${activeIndex}` : undefined;

  const triggerPadding = size === "xs" ? "px-2 py-1 text-sm" : "px-2.5 py-1.5 text-sm";

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        disabled={disabled}
        title={disabled && disabledReason ? disabledReason : undefined}
        aria-label={
          disabled && disabledReason ? disabledReason : ariaLabel ? `${ariaLabel}: ${label}` : undefined
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDescendant}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
        className={`${triggerPadding} bg-surface border rounded outline-none flex items-center gap-1 transition disabled:opacity-40 disabled:cursor-not-allowed focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-sunken
          ${open
            ? "border-info text-info"
            : "border-line-strong text-fg-secondary hover:border-line-emphasis"
          }`}
      >
        <span className="truncate flex-1 text-left">{label}</span>
        <svg
          className={`w-3 h-3 shrink-0 text-fg-tertiary transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && anchor && createPortal(
        <div
          ref={panelRef}
          style={{
            position: "fixed",
            top: top ?? 0,
            left: anchor.left,
            minWidth: anchor.minWidth,
            // Hidden only for the pre-paint measuring pass.
            visibility: top === null ? "hidden" : undefined,
            maxHeight: `calc(100vh - ${2 * POPOVER_VIEWPORT_MARGIN}px)`,
            maxWidth: `calc(100vw - ${2 * POPOVER_VIEWPORT_MARGIN}px)`,
            display: "flex",
            flexDirection: "column",
          }}
          className="z-50 bg-surface border border-line-strong rounded-lg shadow-lg py-1"
        >
          <div
            id={listboxId}
            ref={listRef}
            onScroll={onScroll}
            role="listbox"
            className="min-h-0 overflow-y-auto"
          >
            {options.map((opt, i) => (
              <div key={opt.value}>
                {i > 0 && (
                  <div role="separator" className="mx-4">
                    <div className="h-px bg-sunken" />
                    <div className="h-px bg-surface-active/50" />
                  </div>
                )}
                <div
                  id={`${optionIdPrefix}-${i}`}
                  role="option"
                  aria-selected={opt.value === value}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSelect(opt.value)}
                  // The trigger (combobox) drives keyboard selection via aria-activedescendant;
                  // this keeps Enter/Space parity if an option ever holds focus (#1376).
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleSelect(opt.value);
                    }
                  }}
                  className={`w-full text-left px-3 py-1.5 text-sm transition cursor-pointer hover:bg-surface-hover
                    ${i === activeIndex ? "bg-surface-hover" : ""}
                    ${opt.value === value ? "text-info" : "text-fg-secondary"}`}
                >
                  {opt.label}
                </div>
              </div>
            ))}
          </div>
          {moreBelow && (
            <div
              data-testid="select-more-below"
              className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-surface to-transparent pointer-events-none rounded-b-lg"
            />
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
