import { useRef } from "react";
import SeparatorPlus from "./SeparatorPlus";
import { renderedTrackLeftOf, resizedColumnWidth, startInsertGesture } from "./boardGrid";

interface Props {
  isAdmin: boolean;
  /** Called on a click (no drag) by an admin. Opens the add-column modal in the parent. */
  onOpenAdd: () => void;
  /** Saved width of the column to the left of this separator. Omit (with setWidth) for a click-only separator. */
  currentWidth?: number;
  /** Called while dragging with that column's new saved width. Omit when nothing to the left resizes. */
  setWidth?: (w: number) => void;
  /** Position index (0 = far-left). Used to coordinate hover highlight across all rows. */
  sepIndex: number;
  /** Which separator index is currently highlighted — lifted from the parent. */
  hoveredSepIndex: number | null;
  onSepHoverChange: (idx: number | null) => void;
}

/**
 * A header-row column separator: click to insert a column here, drag to resize the
 * column to its left (#1990). Columns are fr tracks of the shared grid template
 * (#2300), so a drag changes the column's weight (saved width / 220); see
 * `resizedColumnWidth` in boardGrid.ts for how the px drag becomes a saved width.
 */
export default function ColumnSeparator({ isAdmin, onOpenAdd, currentWidth, setWidth, sepIndex, hoveredSepIndex, onSepHoverChange }: Props) {
  const highlighted = hoveredSepIndex === sepIndex;
  const ref = useRef<HTMLDivElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    const startWidth = currentWidth ?? 0;
    // Measured once at the press: the track's rendered width before the drag.
    const rendered = setWidth ? renderedTrackLeftOf(ref.current, sepIndex) : 0;
    startInsertGesture(
      e,
      () => {
        if (isAdmin) onOpenAdd();
      },
      setWidth ? (delta) => setWidth(resizedColumnWidth(startWidth, rendered, delta)) : undefined,
    );
  };

  return (
    <div
      ref={ref}
      // No fixed width: the separator fills its track of the board's shared grid
      // template (#2300), 16px at the outer edges and 8px between columns.
      className={`relative flex items-stretch select-none ${setWidth ? "cursor-col-resize" : "cursor-pointer"}`}
      data-testid="column-separator"
      onMouseEnter={() => onSepHoverChange(sepIndex)}
      onMouseLeave={() => onSepHoverChange(null)}
      onMouseDown={handleMouseDown}
    >
      <div className={`w-px self-stretch transition-colors ${highlighted ? "bg-info/50" : "bg-surface-active/70"}`} />
      <div className={`flex-1 transition-colors ${highlighted ? "bg-info/5" : "bg-sunken/70"}`} />
      <div className={`w-px self-stretch transition-colors ${highlighted ? "bg-info/50" : "bg-surface-active/70"}`} />

      {isAdmin && highlighted && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <SeparatorPlus className="text-[10px]" />
        </div>
      )}
    </div>
  );
}
