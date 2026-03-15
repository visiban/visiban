import { useRef } from "react";

const DRAG_THRESHOLD = 4; // px — movement beyond this is a resize, not a click

interface Props {
  isAdmin: boolean;
  /** Called when the user clicks (no drag). Opens the add-column modal in the parent. */
  onOpenAdd: () => void;
  /** Width of the element immediately to the left of this separator. */
  currentWidth: number;
  /** Called continuously while dragging to update that element's width. */
  setWidth: (w: number) => void;
  /** Position index (0 = far-left). Used to coordinate hover highlight across all rows. */
  sepIndex: number;
  /** Which separator index is currently highlighted — lifted from the parent. */
  hoveredSepIndex: number | null;
  onSepHoverChange: (idx: number | null) => void;
}

export default function ColumnSeparator({ isAdmin, onOpenAdd, currentWidth, setWidth, sepIndex, hoveredSepIndex, onSepHoverChange }: Props) {
  const highlighted = hoveredSepIndex === sepIndex;
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
      onMouseEnter={() => onSepHoverChange(sepIndex)}
      onMouseLeave={() => onSepHoverChange(null)}
      onMouseDown={handleMouseDown}
    >
      <div className={`w-px self-stretch transition-colors ${highlighted ? "bg-blue-400/50" : "bg-slate-600/70"}`} />
      <div className={`flex-1 transition-colors ${highlighted ? "bg-blue-400/5" : "bg-slate-900/70"}`} />
      <div className={`w-px self-stretch transition-colors ${highlighted ? "bg-blue-400/50" : "bg-slate-600/70"}`} />

      {isAdmin && highlighted && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-blue-400 text-[10px] font-bold leading-none bg-slate-900 px-0.5 rounded-sm">+</span>
        </div>
      )}
    </div>
  );
}
