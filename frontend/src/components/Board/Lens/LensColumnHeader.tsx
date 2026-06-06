import type { LensAxis } from "../../../types";

interface Props {
  column: LensAxis;
  count: number;
  width: number;
}

/**
 * Read-only column header for the lens grid. A forked, non-interactive sibling
 * of ColumnHeader — no rename, no kebab, no drag handle, no nav arrows. Mirrors
 * the visual treatment (bg-surface, name + single calm stat row) only.
 */
export default function LensColumnHeader({ column, count, width }: Props) {
  return (
    <div
      className="shrink-0 bg-surface px-3 py-2 flex flex-col gap-0.5 border-r border-line-subtle"
      style={{ width }}
    >
      <span className="text-sm font-medium text-fg truncate" title={column.label}>
        {column.label}
      </span>
      <span className="text-xs text-fg-muted" title="Issues in column">
        {count === 1 ? "1 issue" : `${count} issues`}
      </span>
    </div>
  );
}
