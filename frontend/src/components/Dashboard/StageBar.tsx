/**
 * The Home stage bar (#2483): one segment per stage (column) that holds live cards, sized by its
 * share of the board's cards and filled with the column's color, with the first and last stage
 * names at its ends. Drawn on Jump back in tiles and desktop All boards rows; nothing is drawn
 * when the server sends no `stage_counts` (an older server) or the board has no columns.
 */
import type { Board } from "../../types";
import { stageBar } from "./homeModel";

export default function StageBar({ board, className = "" }: { board: Pick<Board, "stage_counts">; className?: string }) {
  const model = stageBar(board);
  if (!model) return null;
  return (
    <span className={`block min-w-0 ${className}`} data-testid="stage-bar">
      {/* role="img" so the segments read as one figure; the label lists every stage and count. */}
      <span
        role="img"
        aria-label={model.label}
        title={model.label}
        className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-sunken"
      >
        {model.segments.map((s) => (
          <span
            key={s.uid}
            data-testid="stage-bar-segment"
            className="h-full"
            style={{ flexGrow: s.card_count, flexBasis: 0, backgroundColor: s.color }}
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
