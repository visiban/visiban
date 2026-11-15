import SeparatorPlus from "./SeparatorPlus";
import { startInsertGesture } from "./boardGrid";

interface Props {
  isAdmin: boolean;
  /** Called on a click (no drag) by an admin. Opens the add-column modal in the parent. */
  onOpenAdd: () => void;
  /** Position index (0 = far-left). Used to coordinate hover highlight across all rows. */
  sepIndex: number;
  /** Which separator index is currently highlighted — lifted from the parent. */
  hoveredSepIndex: number | null;
  onSepHoverChange: (idx: number | null) => void;
}

/**
 * A header-row column separator: click to insert a column here. Columns are not
 * resizable since the shared grid template (#2300) made every track `minmax(0, 1fr)`,
 * so there is no drag-to-resize.
 */
export default function ColumnSeparator({ isAdmin, onOpenAdd, sepIndex, hoveredSepIndex, onSepHoverChange }: Props) {
  const highlighted = hoveredSepIndex === sepIndex;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    startInsertGesture(e, () => {
      if (isAdmin) onOpenAdd();
    });
  };

  return (
    <div
      // No fixed width: the separator fills its track of the board's shared grid
      // template (#2300), 16px at the outer edges and 8px between columns.
      className="relative flex items-stretch select-none cursor-pointer"
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
