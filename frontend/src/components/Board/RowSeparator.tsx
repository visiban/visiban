import { useState, useRef } from "react";

const DRAG_THRESHOLD = 4; // px — movement beyond this is a resize, not a click

interface Props {
  isAdmin: boolean;
  onInsert: () => void;
  /** Stored min-height of the swimlane immediately above this separator. Undefined on first use. */
  currentHeight?: number;
  /** Called continuously while dragging to resize the swimlane above. */
  setHeight?: (h: number) => void;
  /** Called when the separator gains or loses hover — lets the parent highlight the adjacent row. */
  onHoverChange?: (hovered: boolean) => void;
}

export default function RowSeparator({ isAdmin, onInsert, currentHeight, setHeight, onHoverChange }: Props) {
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
      className="relative flex items-center select-none"
      style={{ height: 8 }}
      onMouseEnter={() => { setHovered(true); onHoverChange?.(true); }}
      onMouseLeave={() => { setHovered(false); onHoverChange?.(false); }}
      onMouseDown={handleMouseDown}
    >
      {/* Single hairline */}
      <div className={`w-full h-px transition-colors ${hovered && isAdmin ? "bg-blue-400/50" : "bg-slate-700/50"}`} />

      {/* Multiple "+" signs spread horizontally — makes click intent obvious */}
      {isAdmin && hovered && (
        <div className="absolute inset-0 flex items-center justify-around px-8 pointer-events-none">
          {[0, 1, 2].map((i) => (
            <span key={i} className="text-blue-400 text-[10px] font-bold leading-none bg-slate-900 px-1 rounded-sm">+</span>
          ))}
        </div>
      )}

      {/* Cursor */}
      {isAdmin && (
        <div className={`absolute inset-0 ${canResize ? "cursor-row-resize" : "cursor-pointer"}`} />
      )}
    </div>
  );
}
