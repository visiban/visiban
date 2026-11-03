import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { colorName } from "../../constants/colors";
import { POPOVER_VIEWPORT_MARGIN, useAnchoredPlacement } from "../../hooks/useAnchoredPlacement";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useOverflowFade } from "../../hooks/useOverflowFade";
import { normalizeHex } from "../../utils/colorContrast";
import { DISMISS_LAYER_ATTR } from "../../utils/dismissLayer";
import CustomColorPanel from "./CustomColorPanel";

/**
 * Escape priority of the open custom color popover. It renders inside modals (40) and
 * inside `CardDetail`, so it must clear both. Not an integer on purpose: 59 is the card
 * panel's Activity filter, equal priorities resolve by registration order rather than by
 * what is on top, and the command palette at 60 must stay above this. See the allocation
 * list in frontend/CLAUDE.md.
 */
export const CUSTOM_COLOR_ESCAPE_PRIORITY = 59.5;

const SWATCH_FOCUS =
  "transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-2 focus:ring-offset-surface";
const SWATCH_SELECTED = "border-fg scale-110 ring-2 ring-fg ring-offset-2 ring-offset-surface";

/**
 * Touch hit area of the trigger, 44px tall. It is last in the DOM, so it paints over its
 * neighbors and must stop at their edges or it takes their taps. Insets measure from the
 * padding box, so each reaches 2px less past the button than it says.
 * `md` (44x44): 8px every way, the row's `gap-2`, which can also wrap.
 * `sm` (34x44): 8px left to the swatch; 6px right, since the `CardDetail` row puts the
 * cancel button a `gap-1.5` away; 10px up to the chips above; 14px down to nothing.
 */
const TRIGGER_HIT_AREA = {
  md: "[@media(pointer:coarse)]:before:-inset-2.5",
  sm: "[@media(pointer:coarse)]:before:-left-2.5 [@media(pointer:coarse)]:before:-right-2 [@media(pointer:coarse)]:before:-top-3 [@media(pointer:coarse)]:before:-bottom-4",
} as const;
/**
 * Cancels the selected `scale-110` on the hit area, which would push it back over a neighbor.
 * `sm`'s hit area is off-center (8px left, 6px right), so the scale also carries its left edge
 * ~1.1px further out than 1/1.1 undoes and it would touch the swatch; it narrows to clear it,
 * leaving the 44px height alone.
 */
const HIT_AREA_UNSCALED = {
  md: "[@media(pointer:coarse)]:before:scale-[0.909]",
  sm: "[@media(pointer:coarse)]:before:scale-x-[0.85] [@media(pointer:coarse)]:before:scale-y-[0.909]",
} as const;

interface Props {
  /** Palette to render, one swatch per entry (hex strings). */
  colors: readonly string[];
  /** Currently selected hex, or null/undefined when nothing is selected. */
  value: string | null | undefined;
  onChange: (color: string) => void;
  /** "md" = 28px (modals), "sm" = 20px (inline popovers). Default "md". */
  size?: "sm" | "md";
  /** Override the accessible name; defaults to "Select color {Name}". Never put hex in it. */
  getAriaLabel?: (color: string, name: string) => string;
  /** Classes for the wrapping row (default "flex gap-2 flex-wrap"). */
  className?: string;
  /** Accessible name for the group. */
  groupLabel?: string;
  /** Adds the custom color trigger, last in the row (#2095). */
  allowCustom?: boolean;
  /** Wording of the custom panel's primary button. Default "Apply". */
  applyLabel?: string;
}

/**
 * The one swatch row (#1893). Selection is a themed ring (`border-fg` plus an offset
 * `ring-fg` ring) that reads on both the light and dark `bg-surface`; a white border
 * vanishes in the light theme. The scale bump is an extra cue, never the only one.
 * The focus ring is a separate `focus:ring-primary-emphasis`, and the selected
 * `border-fg` stays visible while focused.
 *
 * Stored colors can differ from the palette only in case, so selection compares
 * canonical hex; a stored `#3b82f6` is the Blue swatch, not a custom color.
 */
export default function ColorSwatchPicker({
  colors,
  value,
  onChange,
  size = "md",
  getAriaLabel,
  className = "flex gap-2 flex-wrap",
  groupLabel = "Color",
  allowCustom = false,
  applyLabel,
}: Props) {
  const dim = size === "sm" ? "w-5 h-5" : "w-7 h-7";
  const current = normalizeHex(value);
  return (
    <div className={className} role="group" aria-label={groupLabel}>
      {colors.map((c) => {
        const selected = current !== null && current === normalizeHex(c);
        const name = colorName(c);
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-label={getAriaLabel ? getAriaLabel(c, name) : `Select color ${name}`}
            aria-pressed={selected}
            title={name}
            className={`${dim} rounded-full border-2 ${SWATCH_FOCUS} ${selected ? SWATCH_SELECTED : "border-transparent"}`}
            style={{ backgroundColor: c }}
          />
        );
      })}
      {allowCustom && (
        <CustomColorControl
          colors={colors}
          value={value}
          size={size}
          dim={dim}
          onChange={onChange}
          applyLabel={applyLabel}
        />
      )}
    </div>
  );
}

interface ControlProps {
  colors: readonly string[];
  value: string | null | undefined;
  size: "sm" | "md";
  dim: string;
  onChange: (color: string) => void;
  applyLabel?: string;
}

/** The trigger, which shows a custom value itself, plus the popover while open. */
function CustomColorControl({ colors, value, size, dim, onChange, applyLabel }: ControlProps) {
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const open = anchor !== null;

  const current = normalizeHex(value);
  const custom = current !== null && !colors.some((c) => normalizeHex(c) === current) ? current : null;

  const close = (refocus: boolean) => {
    setAnchor(null);
    if (refocus) triggerRef.current?.focus();
  };

  const toggle = () => {
    if (open) {
      close(true);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left });
  };

  const apply = (hex: string) => {
    // A draft that lands on a preset is that preset, in its literal spelling,
    // so the row shows the swatch selected and the trigger empty.
    onChange(colors.find((c) => normalizeHex(c) === hex) ?? hex);
    close(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        // While open, pressing the trigger must not move focus to it: the panel's blur
        // would close it and this click would then open it again.
        onMouseDown={(e) => { if (open) e.preventDefault(); }}
        aria-label={custom ? "Custom color, selected" : "Choose custom color"}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Custom color"
        className={`relative ${dim} rounded-full border-2 flex items-center justify-center [@media(pointer:coarse)]:before:absolute ${TRIGGER_HIT_AREA[size]} ${SWATCH_FOCUS} ${
          custom ? `${SWATCH_SELECTED} ${HIT_AREA_UNSCALED[size]}` : "border-dashed border-line-strong text-fg-tertiary hover:text-fg"
        }`}
        style={custom ? { backgroundColor: custom } : undefined}
      >
        {!custom && (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            aria-hidden="true"
            className={size === "sm" ? "w-3 h-3" : "w-4 h-4"}
          >
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
        )}
      </button>
      {anchor && (
        <CustomColorPopover
          anchor={anchor}
          triggerRef={triggerRef}
          value={value}
          fallbackColor={colors[0] ?? "#000000"}
          applyLabel={applyLabel}
          onApply={apply}
          onClose={close}
        />
      )}
    </>
  );
}

interface PopoverProps {
  anchor: { top: number; bottom: number; left: number };
  triggerRef: RefObject<HTMLButtonElement | null>;
  value: string | null | undefined;
  fallbackColor: string;
  applyLabel?: string;
  onApply: (color: string) => void;
  onClose: (refocus: boolean) => void;
}

/**
 * Mounted only while open, so the draft dies with it and Escape is registered only then.
 * Not portaled: it has to stay inside a host modal's focus trap.
 */
function CustomColorPopover({ anchor, triggerRef, value, fallbackColor, applyLabel, onApply, onClose }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(anchor.left);

  // A phone keyboard opening over a panel field resizes the viewport and scrolls the
  // page. Dismissing on those would throw the draft away as the user starts to type.
  const dismissUnlessTyping = () => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && panelRef.current?.contains(active)) return;
    onClose(false);
  };

  const top = useAnchoredPlacement(panelRef, {
    anchor,
    onResize: dismissUnlessTyping,
    onOutsideScroll: dismissUnlessTyping,
  });
  const { moreBelow, onScroll } = useOverflowFade(panelRef, [top]);

  useLayoutEffect(() => {
    const width = panelRef.current?.offsetWidth ?? 0;
    const maxLeft = window.innerWidth - width - POPOVER_VIEWPORT_MARGIN;
    setLeft(Math.max(POPOVER_VIEWPORT_MARGIN, Math.min(anchor.left, maxLeft)));
  }, [anchor.left]);

  useEscapeStack(() => { onClose(true); }, CUSTOM_COLOR_ESCAPE_PRIORITY);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose, triggerRef]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Custom color"
      {...{ [DISMISS_LAYER_ATTR]: "" }}
      onScroll={onScroll}
      // Every control in here is its own Tab stop, so focus scrolls the region and it
      // needs no tabIndex of its own. scroll-pb-8 is the fade's height: focus clears the
      // fade, and on the last button reaches the true end, so the fade goes away.
      onBlur={(e) => {
        // relatedTarget is null when the window loses focus and on a Safari button
        // click. Neither is the user leaving: an outside click has its own listener.
        const next = e.relatedTarget as Node | null;
        if (next && !e.currentTarget.contains(next)) onClose(false);
      }}
      className="fixed z-50 bg-surface border border-line-strong rounded-lg shadow-xl p-3 max-h-[calc(100dvh-1rem)] overflow-y-auto scroll-pb-8"
      style={{ top: top ?? 0, left, visibility: top === null ? "hidden" : undefined }}
    >
      <CustomColorPanel
        value={value}
        fallbackColor={fallbackColor}
        onChange={onApply}
        onCancel={() => onClose(true)}
        applyLabel={applyLabel}
        focusSquare={top !== null}
      />
      {moreBelow && (
        <div aria-hidden="true" className="sticky bottom-0 -mt-8 h-8 bg-gradient-to-t from-surface to-transparent pointer-events-none" />
      )}
    </div>
  );
}
