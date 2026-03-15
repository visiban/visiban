import { useState, useRef } from "react";

const DRAG_THRESHOLD = 4; // px — movement beyond this is a resize, not a click

interface Props {
  isAdmin: boolean;
  /** Called when the user clicks (no drag). Opens the add-column modal in the parent. */
  onOpenAdd: () => void;
  /** Width of the element immediately to the left of this separator. */
  currentWidth: number;
  /** Called continuously while dragging to update that element's width. */
  setWidth: (w: number) => void;
}

export default function ColumnSeparator({ isAdmin, onOpenAdd, currentWidth, setWidth }: Props) {
  const [hovered, setHovered] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number; dragging: boolean } | null>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { startX: e.clientX, startWidth: currentWidth, dragging: false };

    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      const delta = ev.clientX - dragState.current.startX;
      if (!dragState.current.dragging && Math.abs(delta) > DRAG_THRESHOLD) {
        dragState.current.dragging = true;
      }
      if (dragState.current.dragging) {
        setWidth(dragState.current.startWidth + delta);
      }
    };

    const onUp = () => {
      if (dragState.current && !dragState.current.dragging && isAdmin) {
        onOpenAdd();
      }
      dragState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className="relative shrink-0 flex items-stretch select-none cursor-col-resize"
      style={{ width: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={handleMouseDown}
    >
      {/* Left line */}
      <div className={`w-px self-stretch transition-colors ${hovered ? "bg-blue-400/50" : "bg-slate-600/70"}`} />
      {/* Dark gap middle */}
      <div className={`flex-1 transition-colors ${hovered ? "bg-blue-400/5" : "bg-slate-900/70"}`} />
      {/* Right line */}
      <div className={`w-px self-stretch transition-colors ${hovered ? "bg-blue-400/50" : "bg-slate-600/70"}`} />

      {/* Multiple "+" signs spread vertically — makes click intent obvious */}
      {isAdmin && hovered && (
        <div className="absolute inset-0 flex flex-col items-center justify-around py-3 pointer-events-none">
          {[0, 1, 2].map((i) => (
            <span key={i} className="text-blue-400 text-[10px] font-bold leading-none bg-slate-900 px-0.5 rounded-sm">+</span>
          ))}
        </div>
      )}
    </div>
  );
}
