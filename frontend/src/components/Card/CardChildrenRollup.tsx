import { useEffect, useRef, useState } from "react";
import type { CardChildrenRollup as Rollup, CardChildrenRollupVisible, CardDensity } from "../../types";
import { ROLLUP_SEGMENT_MAX, movementLine, rollupSentence, type Tone } from "./childrenRollup";
import { useSharedMinuteClock } from "../../hooks/useSharedMinuteClock";

/**
 * Same footprint as the real footer at each density so a card never jumps (#2210):
 * comfortable draws two rows, standard and dense one. Announced once.
 */
export function CardChildrenRollupSkeleton({ density = "comfortable" }: { density?: CardDensity }) {
  return (
    <div role="status" aria-busy="true" data-testid="card-children-rollup-loading" className="mt-1.5 pt-1.5 border-t border-line">
      <span className="sr-only">Loading children</span>
      <div aria-hidden="true" className="flex items-center gap-1.5 h-4">
        <span className="h-3 w-3 rounded-sm bg-surface-hover animate-pulse motion-reduce:animate-none" />
        <span className="h-2.5 w-14 rounded bg-surface-hover animate-pulse motion-reduce:animate-none" />
        <span className="h-1.5 flex-1 rounded-sm bg-surface-hover animate-pulse motion-reduce:animate-none" />
      </div>
      {density === "comfortable" && (
        <div aria-hidden="true" className="mt-0.5 flex items-center h-4">
          <span className="h-2.5 w-32 rounded bg-surface-hover animate-pulse motion-reduce:animate-none" />
        </div>
      )}
    </div>
  );
}

const StackGlyph = () => (
  <svg data-testid="rollup-stack-glyph" aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
    <rect x="5" y="2" width="9" height="9" rx="1.5" />
    <path d="M2 5v7.5A1.5 1.5 0 0 0 3.5 14H11" />
  </svg>
);
const CheckGlyph = () => (
  <svg data-testid="rollup-check-glyph" aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
    <path d="M3 8.5l3.2 3L13 4.5" />
  </svg>
);
const BlockedGlyph = () => (
  <svg data-testid="rollup-blocked-glyph" aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" className="shrink-0">
    <circle cx="8" cy="8" r="7" fill="currentColor" />
    <path d="M4.5 8h7" stroke="rgb(var(--surface))" strokeWidth="2" />
  </svg>
);
const ClockGlyph = () => (
  <svg data-testid="rollup-clock-glyph" aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 4.5V8l2.5 1.5" />
  </svg>
);

type SegmentState = "done" | "doing" | "todo" | "blocked";

// The live-change ring sits outside the segment, past a 1px surface-colored offset, so it is
// measured against the card and never against the segment's own fill: an inset ring on Doing was
// the fill's own color (1:1) and on Done 1.04:1 light (#2210). `relative z-10` keeps a later
// sibling from painting over it; the meter is not `overflow-hidden`, which would clip it.
const RING_CLASS = "relative z-10 ring-2 ring-info ring-offset-1 ring-offset-surface";

const SEGMENT_CLASS: Record<SegmentState, string> = {
  done: "bg-success",
  // Info outline with a left-half fill: --info is 5.75:1 (dark) / 5.17:1 (light) on the card,
  // where --primary was 2.83:1 in dark (#2210). The half fill separates it from solid Done.
  doing: "border border-info bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)] text-info",
  todo: "border border-fg-tertiary",
  // Outline plus diagonal stripes: color is never the only cue.
  blocked: "border border-danger bg-[repeating-linear-gradient(135deg,currentColor_0_1px,transparent_1px_3px)] text-danger",
};

/** Segments in board order: to do (first column), blocked, doing, done. */
function segments(r: CardChildrenRollupVisible): SegmentState[] {
  return [
    ...Array<SegmentState>(r.todo).fill("todo"),
    ...Array<SegmentState>(r.blocked).fill("blocked"),
    ...Array<SegmentState>(r.doing).fill("doing"),
    ...Array<SegmentState>(r.done).fill("done"),
  ];
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: "text-fg-tertiary",
  warning: "text-warning-on-tint",
  success: "text-success",
};

interface Props {
  rollup: Rollup;
  density: CardDensity;
  /** The board's stale threshold: no child move for this many days reads "Work idle" (#2210). */
  stalenessDays: number;
  /** Injected for tests; defaults to the clock. */
  now?: number;
}

/**
 * The parent card's child-progress footer (#2210, canvas v24 artboards 1 and 8 § 4).
 *
 * Renders only when the card carries `children_rollup`, which the server sends
 * only on a parent-tier board's per-viewer reads, so a plain board and a share
 * link draw nothing. The footer is one `role="group"` with the whole sentence
 * as its name; the visible rows are `aria-hidden`.
 */
export default function CardChildrenRollup({ rollup, density, stalenessDays, now }: Props) {
  // One shared ticker re-renders the footer each minute so "moved N ago" and
  // "idle" never go stale; an injected `now` (tests) wins.
  const ticked = useSharedMinuteClock();
  const clock = now ?? ticked;
  const visible = rollup.visible ? rollup : null;
  const movement = visible && visible.total > 0 ? movementLine(visible, stalenessDays, clock) : null;
  const sentence = rollupSentence(rollup, movement);

  // Live update (#2210): ring only the segments that gained a child for 2s and
  // announce politely when the counts change after the first render. Under
  // reduced motion the ring has no transition, so it simply appears and drops.
  const counts: Record<SegmentState, number> = visible
    ? { todo: visible.todo, blocked: visible.blocked, doing: visible.doing, done: visible.done }
    : { todo: 0, blocked: 0, doing: 0, done: 0 };
  const key = visible ? `${counts.done}/${counts.doing}/${counts.todo}/${counts.blocked}` : `h${rollup.total}`;
  const prevKey = useRef(key);
  const prevCounts = useRef(counts);
  // Per state, how many segments existed before the change: segments past that
  // index are the changed ones. null while nothing is ringed.
  const [ringFrom, setRingFrom] = useState<Record<SegmentState, number> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // The announcement is read through a ref so the effect depends on the
  // counts alone: a refetch with the same counts (a new object) must not
  // cancel the 2s timer and leave the ring on (ux-review, #2210).
  const spokenRef = useRef("");
  spokenRef.current = visible ? `Children: ${visible.done} of ${visible.total} done` : sentence;
  const countsRef = useRef(counts);
  countsRef.current = counts;
  useEffect(() => {
    if (prevKey.current === key) return;
    prevKey.current = key;
    setRingFrom(prevCounts.current);
    prevCounts.current = countsRef.current;
    setAnnouncement(spokenRef.current);
    const t = window.setTimeout(() => setRingFrom(null), 2000);
    return () => window.clearTimeout(t);
  }, [key]);
  const isChanged = (s: SegmentState, indexInState: number) => ringFrom !== null && indexInState >= ringFrom[s] && counts[s] > ringFrom[s];

  const live = <span className="sr-only" aria-live="polite" data-testid="rollup-live">{announcement}</span>;

  if (!visible || visible.total === 0) {
    return (
      <div role="group" aria-label={sentence} data-testid="card-children-rollup" className="mt-1.5 pt-1.5 border-t border-line">
        <p aria-hidden="true" className="text-xs text-fg-tertiary truncate">
          {visible ? "No children" : `${rollup.total} ${rollup.total === 1 ? "child" : "children"} on a board you can't open`}
        </p>
        {live}
      </div>
    );
  }

  const allDone = visible.done === visible.total;
  const allBlocked = visible.blocked === visible.total;
  const bare = density !== "comfortable";
  const blockedNode = visible.blocked > 0 && (
    <span data-testid="rollup-blocked" className="inline-flex items-center gap-0.5 text-xs font-semibold text-danger-on-tint shrink-0">
      <BlockedGlyph />
      {allBlocked ? "All blocked" : bare ? visible.blocked : `${visible.blocked} blocked`}
    </span>
  );
  const segs = segments(visible);
  const seen: Record<SegmentState, number> = { todo: 0, blocked: 0, doing: 0, done: 0 };
  const indexInState = segs.map((s) => seen[s]++);
  const bar = density === "dense" ? null : segs.length > ROLLUP_SEGMENT_MAX ? (
    <span data-testid="rollup-meter" className={`flex h-1.5 flex-1 min-w-[2rem] rounded-sm border border-fg-tertiary`}>
      {(["todo", "blocked", "doing", "done"] as const).map((s) => {
        const n = visible[s];
        return n > 0 ? <span key={s} data-segment-group={s} data-ringed={isChanged(s, n - 1) ? "true" : undefined} className={`${SEGMENT_CLASS[s]}${isChanged(s, n - 1) ? ` ${RING_CLASS}` : ""}`} style={{ width: `${(n / visible.total) * 100}%` }} /> : null;
      })}
    </span>
  ) : (
    // gap-1 (4px), not gap-0.5: the live ring reaches 3px past a segment (1px offset + 2px ring),
    // so a 2px gap let it cover an unchanged neighbor's outline.
    <span data-testid="rollup-segments" className={`flex flex-1 min-w-0 gap-1 rounded-sm`}>
      {segs.map((s, i) => {
        const ringed = isChanged(s, indexInState[i]);
        return <span key={i} data-segment={s} data-ringed={ringed ? "true" : undefined} className={`h-1.5 w-1.5 shrink-0 rounded-[1px] ${SEGMENT_CLASS[s]}${ringed ? ` ${RING_CLASS}` : ""}`} />;
      })}
    </span>
  );
  // Standard keeps row 1 only; "Work idle" still shows there when nothing is blocked.
  const idleTrailing = density === "standard" && !blockedNode && movement?.idle;

  return (
    <div role="group" aria-label={sentence} data-testid="card-children-rollup" className="mt-1.5 pt-1.5 border-t border-line">
      <div aria-hidden="true" className="flex items-center gap-1.5 min-w-0">
        <span className={allDone ? "text-success" : "text-fg-secondary"}>{allDone ? <CheckGlyph /> : <StackGlyph />}</span>
        <span className="text-xs text-fg-secondary shrink-0 tabular-nums">
          {density === "dense" ? `${visible.done}/${visible.total}` : `${visible.done}/${visible.total} done`}
        </span>
        {bar}
        {blockedNode}
        {idleTrailing && movement && (
          <span className={`inline-flex items-center gap-0.5 text-xs shrink-0 ${TONE_CLASS.warning}`}><ClockGlyph />{movement.text}</span>
        )}
      </div>
      {density === "comfortable" && movement && (
        <p aria-hidden="true" data-testid="rollup-movement" className={`mt-0.5 flex items-center gap-1 text-xs truncate ${TONE_CLASS[movement.tone]}`}>
          {movement.idle && <ClockGlyph />}
          {movement.text}
        </p>
      )}
      {live}
    </div>
  );
}
