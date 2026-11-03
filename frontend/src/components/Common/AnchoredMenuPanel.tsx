import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { POPOVER_VIEWPORT_MARGIN, useAnchoredPlacement } from "../../hooks/useAnchoredPlacement";
import { useOverflowFade } from "../../hooks/useOverflowFade";
import type { MenuAnchor } from "../../utils/menuAnchor";

interface Props {
  /** Captured at open; `null` while closed (renders nothing). */
  anchor: MenuAnchor | null;
  panelRef: RefObject<HTMLDivElement | null>;
  /** Called on window resize and on any scroll outside the panel (#1455). */
  onDismiss: () => void;
  /** Which trigger edge the panel lines up with. */
  align?: "left" | "right";
  /** Width the panel is expected to need; only used to keep it on screen horizontally. */
  minWidth: number;
  /**
   * `portal` (default) renders into `document.body`, so no scroll region or
   * `overflow-hidden` ancestor can clip it (#1482). `inline` keeps the panel in
   * the DOM tree as `position: fixed`: required inside the card detail sheet,
   * whose focus trap and click-outside dismissal treat a body portal as
   * outside the dialog (the Move popover does the same, #1732).
   */
  mode?: "portal" | "inline";
  /** Re-measure when content that changes the panel's height changes. */
  deps?: readonly unknown[];
  /** Called once the panel has been measured and is visible: the moment focus may move into it. */
  onPlaced?: () => void;
  className?: string;
  children: ReactNode;
  role?: string;
  id?: string;
  "aria-label"?: string;
}

/**
 * Anchored, `position: fixed` menu panel for the in-flow `absolute top-full`
 * menus audited in #1482: placed from its measured height (below, else above,
 * else pinned), capped at the viewport, with a bottom fade while it scrolls
 * (frontend/CLAUDE.md § Modals and dialogs, #1455). Callers keep their own
 * outside-click, Escape and focus handling; an outside-click handler must
 * treat `panelRef` as part of the menu because a portaled panel is not a DOM
 * child of the trigger's wrapper.
 */
export default function AnchoredMenuPanel({
  anchor, panelRef, onDismiss, align = "left", minWidth, mode = "portal",
  deps = [], onPlaced, className = "", children, ...aria
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const top = useAnchoredPlacement(panelRef, {
    anchor: anchor ? { top: anchor.top, bottom: anchor.bottom } : null,
    deps,
    onResize: onDismiss,
    onOutsideScroll: onDismiss,
  });
  const { moreBelow, onScroll } = useOverflowFade(listRef, [anchor !== null, ...deps]);

  // Focus only once placed: browsers ignore focus() on a hidden element.
  const placed = top !== null;
  const onPlacedRef = useRef(onPlaced);
  onPlacedRef.current = onPlaced;
  useEffect(() => {
    if (placed) onPlacedRef.current?.();
  }, [placed]);

  if (!anchor) return null;

  const horizontal = align === "right"
    ? { right: Math.max(POPOVER_VIEWPORT_MARGIN, window.innerWidth - anchor.right) }
    : {
        left: Math.max(
          POPOVER_VIEWPORT_MARGIN,
          Math.min(anchor.left, window.innerWidth - minWidth - POPOVER_VIEWPORT_MARGIN),
        ),
      };

  const panel = (
    <div
      ref={panelRef}
      {...aria}
      style={{
        position: "fixed",
        top: top ?? 0,
        ...horizontal,
        minWidth,
        // Hidden only for the pre-paint measuring pass.
        visibility: top === null ? "hidden" : undefined,
        maxHeight: `calc(100vh - ${2 * POPOVER_VIEWPORT_MARGIN}px)`,
        maxWidth: `calc(100vw - ${2 * POPOVER_VIEWPORT_MARGIN}px)`,
        display: "flex",
        flexDirection: "column",
      }}
      className={`${mode === "inline" ? "z-[60]" : "z-50"} bg-surface border border-line-strong rounded-lg shadow-lg py-1 ${className}`}
    >
      <div ref={listRef} onScroll={onScroll} className="min-h-0 overflow-y-auto">
        {children}
      </div>
      {moreBelow && (
        <div
          aria-hidden="true"
          data-testid="menu-more-below"
          className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-surface to-transparent pointer-events-none rounded-b-lg"
        />
      )}
    </div>
  );

  return mode === "portal" ? createPortal(panel, document.body) : panel;
}
