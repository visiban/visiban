import { useEffect, useRef } from "react";
import { POPOVER_VIEWPORT_MARGIN, useAnchoredPlacement } from "../../hooks/useAnchoredPlacement";
import { useOverflowFade } from "../../hooks/useOverflowFade";

interface Props {
  anchorRect: DOMRect;
  choices: string[];
  selected: string;
  onSelect: (value: string) => void;
  onDismiss: () => void;
}

const POPOVER_WIDTH = 190;

/**
 * The dropdown quick-edit popover for a pinned custom-field chip on the card
 * face (#371) — click a dropdown chip, pick a value, never open the card.
 * Positioning technique borrowed from `CardPeekPopover` (anchor rect +
 * viewport-edge flip); the listbox a11y model is a lighter version of
 * `SelectDropdown`'s (role="listbox"/"option" + Escape + click-outside),
 * not a full roving-tabindex fork — this is a small, single-purpose chooser
 * over a chip, not a general-purpose dropdown.
 *
 * A field may define many choices, so the panel follows the #1455 rules for
 * anchored `fixed` popovers: sized to content up to the viewport, placed from
 * its measured height (below, else above, else bottom-pinned), dismissed on
 * resize and on any scroll outside the panel (never its own list), and — when the list overflows — a focusable scroll region with a
 * bottom fade that takes focus after placement.
 */
export default function CustomFieldQuickEditPopover({ anchorRect, choices, selected, onSelect, onDismiss }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const top = useAnchoredPlacement(ref, {
    anchor: { top: anchorRect.top, bottom: anchorRect.bottom },
    deps: [choices.length],
    onResize: onDismiss,
    onOutsideScroll: onDismiss,
  });
  const { moreBelow, onScroll } = useOverflowFade(listRef, [choices.length]);

  // Focus the list only when it overflows, and only once placed: a browser
  // ignores focus() on the hidden measuring pass. A short list keeps the
  // previous behavior (no focus move). One-shot so re-placement never steals it.
  const focusedRef = useRef(false);
  const placed = top !== null;
  useEffect(() => {
    if (!placed || focusedRef.current) return;
    focusedRef.current = true;
    const list = listRef.current;
    if (list && list.scrollHeight > list.clientHeight) list.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onDismiss]);

  const wouldOverflowRight = anchorRect.left + POPOVER_WIDTH > window.innerWidth;
  const style: React.CSSProperties = {
    position: "fixed",
    top: top ?? 0,
    // Hidden only for the pre-paint measuring pass.
    visibility: top === null ? "hidden" : undefined,
    zIndex: 50,
    width: POPOVER_WIDTH,
    ...(wouldOverflowRight
      ? { right: window.innerWidth - anchorRect.right }
      : { left: anchorRect.left }),
  };

  return (
    <div
      ref={ref}
      data-testid="custom-field-quick-edit-popover"
      style={{ ...style, maxHeight: `calc(100vh - ${2 * POPOVER_VIEWPORT_MARGIN}px)` }}
      className="flex flex-col bg-surface border border-line-strong rounded-lg shadow-xl py-1.5"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="relative min-h-0 flex flex-col">
      <div
        ref={listRef}
        role="listbox"
        aria-label="Choices"
        tabIndex={0}
        onScroll={onScroll}
        className="min-h-0 overflow-y-auto focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis"
      >
      <button
        role="option"
        aria-selected={selected === ""}
        onClick={() => { onSelect(""); onDismiss(); }}
        className={`w-full text-left px-2.5 py-1 text-xs rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${selected === "" ? "bg-surface-hover text-fg" : "text-fg-muted hover:bg-surface-hover"}`}
      >
        — No value —
      </button>
      {choices.map((choice) => (
        <button
          key={choice}
          role="option"
          aria-selected={selected === choice}
          onClick={() => { onSelect(choice); onDismiss(); }}
          className={`w-full text-left px-2.5 py-1 text-xs rounded transition flex items-center justify-between gap-2 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${selected === choice ? "bg-surface-hover text-fg" : "text-fg-secondary hover:bg-surface-hover"}`}
        >
          <span className="truncate">{choice}</span>
          {selected === choice && <span className="text-info shrink-0">✓</span>}
        </button>
      ))}
      </div>
      {moreBelow && (
        <div
          data-testid="quick-edit-more-below"
          className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-surface to-transparent pointer-events-none"
        />
      )}
      </div>
    </div>
  );
}
