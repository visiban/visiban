import { useState, useRef } from "react";
import { createColumn } from "../../api/boards";
import type { Column } from "../../types";

const DRAG_THRESHOLD = 4; // px — movement beyond this is a resize, not a click

interface Props {
  boardId: number;
  insertPosition: number;
  isAdmin: boolean;
  onColumnAdded: (column: Column) => void;
  /** Width of the element immediately to the left of this separator. */
  currentWidth: number;
  /** Called continuously while dragging to update that element's width. */
  setWidth: (w: number) => void;
}

export default function ColumnSeparator({
  boardId, insertPosition, isAdmin, onColumnAdded, currentWidth, setWidth,
}: Props) {
  const [hovered, setHovered] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number; dragging: boolean } | null>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isAdmin) return;
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
      if (dragState.current && !dragState.current.dragging) {
        // Plain click — open inline add
        setAdding(true);
        setDraft("");
      }
      dragState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleAdd = async () => {
    const name = draft.trim();
    if (!name) { setAdding(false); return; }
    setSaving(true);
    try {
      const column = await createColumn(boardId, { name });
      onColumnAdded(column);
    } finally {
      setSaving(false);
      setAdding(false);
      setDraft("");
    }
  };

  return (
    <div
      className="relative shrink-0 flex items-stretch select-none"
      style={{ width: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      onMouseDown={handleMouseDown}
    >
      {/* Left line */}
      <div
        className={`w-px self-stretch transition-colors ${hovered ? "bg-blue-400/60" : "bg-slate-700"}`}
      />

      {/* Centre zone — shows "+" on hover */}
      <div className={`flex-1 flex items-center justify-center transition-colors ${hovered ? "bg-blue-500/8" : ""}`}>
        {isAdmin && hovered && !adding && (
          <span className="text-blue-400 text-xs font-bold leading-none pointer-events-none">+</span>
        )}
      </div>

      {/* Right line */}
      <div
        className={`w-px self-stretch transition-colors ${hovered ? "bg-blue-400/60" : "bg-slate-700"}`}
      />

      {/* Resize cursor overlay (behind the + text) */}
      <div className="absolute inset-0 cursor-col-resize" />

      {/* Inline add-column input — floats below the header */}
      {adding && (
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 mt-0.5 z-50"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); handleAdd(); }
              if (e.key === "Escape") { e.preventDefault(); setAdding(false); }
            }}
            onBlur={() => { if (!saving) setAdding(false); }}
            placeholder="Column name…"
            className="w-36 text-xs border border-blue-500 rounded-md px-2 py-1.5 bg-slate-800 text-slate-100 placeholder-slate-500 outline-none shadow-xl"
          />
        </div>
      )}
    </div>
  );
}
