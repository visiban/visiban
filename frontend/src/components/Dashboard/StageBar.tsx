/**
 * The Home stage bar (#2483): one segment per stage (column) that holds live cards, sized by its
 * share of the board's cards and filled with the column's color, with the first and last stage
 * names at its ends. Drawn on Jump back in tiles and desktop All boards rows; nothing is drawn
 * when the server sends no `stage_counts` (an older server) or the board has no columns.
 */
import type { Board } from "../../types";
import { stageBar } from "./homeModel";

/**
 * `inButton`: the bar sits inside a button (a Jump back in tile). The tile's name already reads
 * the label, and a native tooltip on a 6px bar inside a button is noise, so no `title` there.
 */
export default function StageBar({ board, className = "", inButton = false }: { board: Pick<Board, "stage_counts">; className?: string; inButton?: boolean }) {
  const model = stageBar(board);
  if (!model) return null;
  return (
    <span className={`block min-w-0 ${className}`} data-testid="stage-bar">
      {/* role="img" so the segments read as one figure; the label lists every stage and count. */}
      <span
        role="img"
        aria-label={model.label}
        title={inButton ? undefined : model.label}
        // The outer ring (border-line-boundary, #2381) is what shows the bar's extent: bg-sunken
        // alone is under the 3:1 non-text floor on surface, which leaves an all-zero bar, or a pale
        // column color, invisible. A ring adds no height.
        className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-sunken ring-1 ring-line-boundary"
      >
        {model.segments.map((s) => (
          <span
            key={s.uid}
            data-testid="stage-bar-segment"
            className="h-full"
            // 2px floor so one card among hundreds still shows (the label promises it).
            style={{ flexGrow: s.card_count, flexBasis: 0, minWidth: 2, backgroundColor: s.color }}
          />
        ))}
      </span>
      <span aria-hidden="true" className="mt-1 flex justify-between gap-2 text-xs text-fg-tertiary">
        <span className="truncate">{model.first}</span>
        {model.last && <span className="truncate text-right">{model.last}</span>}
      </span>
    </span>
  );
}
