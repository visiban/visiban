import { useState, useRef } from "react";
import SeparatorPlus from "./SeparatorPlus";
import { columnTrackLine, separatorTrackLine } from "./boardGrid";

const DRAG_THRESHOLD = 4; // px — movement beyond this is a resize, not a click

interface Props {
  isAdmin: boolean;
  onInsert: () => void;
  /** Stored min-height of the swimlane immediately above this separator. Undefined on first use. */
  currentHeight?: number;
  /** Called continuously while dragging to resize the swimlane above. */
  setHeight?: (h: number) => void;
  /** The board's shared `grid-template-columns` (#2300). The "+" glyphs and the
   *  hovered column strip are laid out on it, so they line up with the columns
   *  without any pixel math. Omitted: neither renders. */
  gridTemplate?: string;
  /** Number of column tracks in `gridTemplate`: one "+" per column when hovered. */
  columnCount?: number;
  /** Index of the hovered column separator (0 = far left), continued through this row. */
  hoveredSepIndex?: number | null;
}

export default function RowSeparator({ isAdmin, onInsert, currentHeight, setHeight, gridTemplate, columnCount = 0, hoveredSepIndex }: Props) {
  const [hovered, setHovered] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startY: number; startHeight: number; dragging: boolean } | null>(null);

  const canResize = setHeight !== undefined;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    if (canResize) {
      // Use stored height if available, otherwise measure the preceding row from the DOM.
      const prevRow = containerRef.current?.previousElementSibling as HTMLElement | null;
      const startHeight = currentHeight ?? (prevRow ? prevRow.getBoundingClientRect().height : 80);
      dragState.current = { startY: e.clientY, startHeight, dragging: false };

      const onMove = (ev: MouseEvent) => {
        if (!dragState.current) return;
        const delta = ev.clientY - dragState.current.startY;
        if (!dragState.current.dragging && Math.abs(delta) > DRAG_THRESHOLD) {
          dragState.current.dragging = true;
        }
        if (dragState.current.dragging) {
          setHeight!(dragState.current.startHeight + delta);
        }
      };

      const onUp = () => {
        if (dragState.current && !dragState.current.dragging && isAdmin) {
          onInsert();
        }
        dragState.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    } else if (isAdmin) {
      onInsert();
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col select-none w-full ${canResize ? "cursor-row-resize" : isAdmin ? "cursor-pointer" : ""}`}
      style={{ height: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={handleMouseDown}
    >
      {/* Top line */}
      <div className={`w-full h-px transition-colors ${hovered ? "bg-info/50" : "bg-surface-active/70"}`} />
      {/* Dark gap middle — mirrors ColumnSeparator */}
      <div className={`flex-1 w-full transition-colors ${hovered ? "bg-info/5" : "bg-sunken/70"}`} />
      {/* Bottom line */}
      <div className={`w-full h-px transition-colors ${hovered ? "bg-info/50" : "bg-surface-active/70"}`} />

      {gridTemplate && ((isAdmin && hovered && columnCount > 0) || hoveredSepIndex != null) && (
        <div className="absolute inset-0 grid pointer-events-none" style={{ gridTemplateColumns: gridTemplate }}>
          {/* "+" at each column center — mirrors ColumnSeparator showing "+" at each swimlane row */}
          {isAdmin && hovered && Array.from({ length: columnCount }, (_, i) => (
            <div key={i} className="flex items-center justify-center" style={{ gridColumn: columnTrackLine(i), gridRow: 1 }}>
              <SeparatorPlus className="text-[10px]" />
            </div>
          ))}
          {/* Column separator continuation — keeps the highlighted column strip unbroken through this row */}
          {hoveredSepIndex != null && (
            <div className="flex" style={{ gridColumn: separatorTrackLine(hoveredSepIndex), gridRow: 1 }} data-testid="row-separator-column-strip">
              <div className="w-px self-stretch bg-info/50" />
              <div className="flex-1 bg-info/5" />
              <div className="w-px self-stretch bg-info/50" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
