import { useRef, useState } from "react";

interface Props {
  /** Current width of the element whose right edge this handle sits on. */
  currentWidth: number;
  /** Called continuously while dragging (and on each keyboard nudge) with the new width — the caller clamps. */
  setWidth: (w: number) => void;
  /** Accessible name — describes what this handle resizes, e.g. "Resize Doing column" or "Resize swimlane label width". */
  ariaLabel: string;
  /** Keyboard nudge step in px; Shift multiplies by 4. */
  step?: number;
}

/**
 * Absolutely-positioned, zero-layout-width resize handle for the lens grid
 * (#1065). A forked, simplified sibling of the native board's
 * `ColumnSeparator`/`RowSeparator`:
 *
 * - No insert-column (or insert-anything) affordance — a plain click does
 *   nothing, so unlike the native separator there is no drag-vs-click
 *   disambiguation to do.
 * - Lives only in the header row (one instance per column, plus one on the
 *   sidebar corner cell) rather than being re-rendered as a 16px layout
 *   gutter in every swimlane row. All rows already read the same shared
 *   width state, so a single header-level handle keeps them in sync without
 *   the per-row separator elements the native board renders for its
 *   continuous hover-highlight strip. The tradeoff — the resize affordance
 *   and hover highlight don't extend down through the body rows — is
 *   accepted deliberately for this read-only, lower-chrome view.
 * - `translate-x-1/2` centers the hit target on the column's own right
 *   border rather than adding to the column's layout width, so header and
 *   swimlane-row cells (which read the same width value) never drift apart.
 */
export default function LensResizeHandle({ currentWidth, setWidth, ariaLabel, step = 8 }: Props) {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { startX: e.clientX, startWidth: currentWidth };
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      setWidth(dragState.current.startWidth + (ev.clientX - dragState.current.startX));
    };
    const onUp = () => {
      dragState.current = null;
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setWidth(currentWidth - (e.shiftKey ? step * 4 : step));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setWidth(currentWidth + (e.shiftKey ? step * 4 : step));
    }
  };

  const active = hovered || dragging;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(currentWidth)}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={handleKeyDown}
      className="absolute top-0 right-0 bottom-0 w-2 translate-x-1/2 z-10 flex justify-center cursor-col-resize select-none touch-none focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded-sm"
    >
      <div className={`h-full w-px transition-colors ${active ? "bg-info" : "bg-transparent"}`} />
    </div>
  );
}
