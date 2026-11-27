import { ROLLUP_SEGMENT_MAX, SEGMENT_CLASS, type SegmentState } from "./childrenRollup";

type Counts = Partial<Record<SegmentState, number>>;

/** Canvas 6a order for Children mode: done, doing, blocked, to do, then planned. */
const ORDER: SegmentState[] = ["done", "doing", "blocked", "todo", "planned"];

/**
 * Children mode's segmented bar (#2370): the card footer's segment looks (shape, not color alone). A parent row
 * draws one segment per child up to the footer's limit; a lane (and a larger row) one segment per state, sized by
 * its count. Decorative: the counts beside it are the text.
 */
export default function ChildStateBar({ counts, perChild = false, className = "" }: { counts: Counts; perChild?: boolean; className?: string }) {
  const total = ORDER.reduce((n, s) => n + (counts[s] ?? 0), 0);
  if (total === 0) return null;
  const each = perChild && total <= ROLLUP_SEGMENT_MAX;
  return (
    <span aria-hidden="true" data-testid="children-state-bar" className={`flex gap-0.5 ${className}`}>
      {ORDER.flatMap((s) => {
        const n = counts[s] ?? 0;
        if (n === 0) return [];
        return (each ? Array<number>(n).fill(1) : [n]).map((grow, i) => (
          <span key={`${s}-${i}`} data-segment={s} style={{ flexGrow: grow }} className={`block h-1.5 basis-0 min-w-0 rounded-[1px] ${SEGMENT_CLASS[s]}`} />
        ));
      })}
    </span>
  );
}
