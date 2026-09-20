import type { LensAxis } from "../../../types";
import LensResizeHandle from "./LensResizeHandle";

interface Props {
  column: LensAxis;
  count: number;
  width: number;
  /** Called continuously while the trailing resize handle is dragged (#1065). */
  onResize: (width: number) => void;
}

/**
 * Read-only column header for the lens grid. A forked, non-interactive sibling
 * of ColumnHeader — no rename, no kebab, no drag handle, no nav arrows. Mirrors
 * the visual treatment (bg-surface, name + single calm stat row) plus a
 * resize handle on the trailing edge (#1065) — see LensResizeHandle for why
 * that handle lives here and not repeated in every swimlane row.
 */
export default function LensColumnHeader({ column, count, width, onResize }: Props) {
  return (
    <div
      className="relative shrink-0 bg-surface px-3 py-2 flex flex-col gap-0.5 border-r border-line-subtle"
      style={{ width }}
    >
      <span className="text-sm font-medium text-fg truncate" title={column.label}>
        {column.label}
      </span>
      <span className="text-xs text-fg-muted" title="Issues in column">
        {count === 1 ? "1 issue" : `${count} issues`}
      </span>
      <LensResizeHandle
        currentWidth={width}
        setWidth={onResize}
        ariaLabel={`Resize ${column.label} column`}
      />
    </div>
  );
}
