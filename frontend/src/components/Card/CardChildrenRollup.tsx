import { useEffect, useRef, useState } from "react";
import type { CardChildrenRollup as Rollup, CardChildrenRollupVisible, CardDensity } from "../../types";
import { ROLLUP_SEGMENT_MAX, movementLine, rollupSentence, type Tone } from "./childrenRollup";

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
    <path d="M4.5 8h7" stroke="var(--color-surface, #fff)" strokeWidth="2" />
  </svg>
);
const ClockGlyph = () => (
  <svg data-testid="rollup-clock-glyph" aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 4.5V8l2.5 1.5" />
  </svg>
);

type SegmentState = "done" | "doing" | "todo" | "blocked";

const SEGMENT_CLASS: Record<SegmentState, string> = {
  done: "bg-success",
  doing: "bg-primary",
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
  const clock = now ?? Date.now();
  const visible = rollup.visible ? rollup : null;
  const movement = visible && visible.total > 0 ? movementLine(visible, stalenessDays, clock) : null;
  const sentence = rollupSentence(rollup, movement);

  // Live update (#2210): ring the bar for 2s and announce politely when the
  // counts change after the first render. Under reduced motion the ring has
  // no transition, so it simply appears and drops.
  const key = visible ? `${visible.done}/${visible.doing}/${visible.todo}/${visible.blocked}` : `h${rollup.total}`;
  const prevKey = useRef(key);
  const [ringed, setRinged] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (prevKey.current === key) return;
    prevKey.current = key;
    setRinged(true);
    setAnnouncement(visible ? `Children: ${visible.done} of ${visible.total} done` : sentence);
    const t = window.setTimeout(() => setRinged(false), 2000);
    return () => window.clearTimeout(t);
  }, [key, visible, sentence]);

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
  const bar = density === "dense" ? null : segs.length > ROLLUP_SEGMENT_MAX ? (
    <span data-testid="rollup-meter" className={`flex h-1.5 flex-1 min-w-[2rem] overflow-hidden rounded-sm border border-fg-tertiary ${ringed ? "ring-2 ring-primary" : ""}`}>
      {(["blocked", "doing", "done"] as const).map((s) => {
        const n = visible[s];
        return n > 0 ? <span key={s} className={SEGMENT_CLASS[s]} style={{ width: `${(n / visible.total) * 100}%` }} /> : null;
      })}
    </span>
  ) : (
    <span data-testid="rollup-segments" className={`flex flex-1 min-w-0 gap-0.5 rounded-sm ${ringed ? "ring-2 ring-primary" : ""}`}>
      {segs.map((s, i) => (
        <span key={i} data-segment={s} className={`h-1.5 w-1.5 shrink-0 rounded-[1px] ${SEGMENT_CLASS[s]}`} />
      ))}
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
