import { useLayoutEffect, useRef, useState } from "react";
import type { KeyFact, KeyFactTarget } from "../../utils/cardKeyFacts";
import Avatar from "../Common/Avatar";
import ThresholdMark from "./ThresholdMark";

interface Props {
  facts: KeyFact[];
  /** Jump to the fact's field. Never gated on edit rights: navigation is reading. */
  onJump: (target: KeyFactTarget, opener?: HTMLElement) => void;
  /** Facts that do nothing when activated (a viewer cannot open Move) render as plain text. */
  inertTargets?: readonly KeyFactTarget[];
  /** Lines the row may use before collapsing into +N. Default 2; 1 on a short window (design 1.2). */
  maxLines?: number;
}

const LINE_GAP = 8;

/** Distinct line index (0-based) of each element, from its offsetTop. */
function lineIndexes(els: HTMLElement[]): number[] {
  // Chips differ in height (the assignee's avatar makes it 1px taller), and
  // items-center then offsets their tops by a pixel or two. Only a jump of at
  // least half a chip is a new line.
  const sorted = [...new Set(els.map((el) => el.offsetTop))].sort((a, b) => a - b);
  const starts: number[] = [];
  for (const top of sorted) if (starts.length === 0 || top - starts[starts.length - 1] >= LINE_GAP) starts.push(top);
  return els.map((el) => {
    let idx = 0;
    starts.forEach((s, i) => { if (el.offsetTop >= s) idx = i; });
    return idx;
  });
}

/**
 * The key-facts row (#1916): one `<ul aria-label="Key facts">` of buttons under
 * the title. It wraps to at most `maxLines` (two) lines; whatever does not fit collapses
 * into a trailing `+N` button that expands the row in place. The overflow is
 * measured, not guessed: all facts render once, the first two lines' worth stay
 * visible, and the +N button is checked to sit on line two or earlier.
 */
export default function CardKeyFacts({ facts, onJump, inertTargets = [], maxLines = 2 }: Props) {
  const listRef = useRef<HTMLUListElement>(null);
  const [expanded, setExpanded] = useState(false);
  // null = unconstrained (measuring); a number = how many facts stay visible.
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  const signature = facts.map((f) => `${f.key}:${f.text}`).join("|");

  // A changed fact list re-measures from scratch (and, being new content,
  // collapses again so a long row never stays expanded across card swaps).
  const lastSignature = useRef(signature);
  useLayoutEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    setExpanded(false);
    setVisibleCount(null);
  }, [signature]);

  // A changed line budget (the window got short or tall) re-measures too.
  const lastMaxLines = useRef(maxLines);
  useLayoutEffect(() => {
    if (lastMaxLines.current === maxLines) return;
    lastMaxLines.current = maxLines;
    setExpanded(false);
    setVisibleCount(null);
  }, [maxLines]);

  // Re-measure when the width changes (dock toggle, window resize).
  useLayoutEffect(() => {
    const ul = listRef.current;
    if (!ul || typeof ResizeObserver === "undefined") return;
    let width = ul.clientWidth;
    const observer = new ResizeObserver(() => {
      if (ul.clientWidth === width) return;
      width = ul.clientWidth;
      setExpanded(false);
      setVisibleCount(null);
    });
    observer.observe(ul);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const ul = listRef.current;
    if (!ul || expanded) return;
    const items = [...ul.querySelectorAll<HTMLElement>("[data-fact-index]")];
    if (visibleCount === null) {
      const lines = lineIndexes(items);
      const fit = lines.filter((l) => l < maxLines).length;
      // Everything fits: no +N. Otherwise start from what fits and let the
      // decrement pass below make room for +N only when it does not fit.
      if (fit < items.length) setVisibleCount(Math.max(1, fit));
      return;
    }
    const more = ul.querySelector<HTMLElement>("[data-fact-more]");
    if (!more) return;
    const lines = lineIndexes([...items.filter((el) => !el.hidden), more]);
    if (lines[lines.length - 1] >= maxLines && visibleCount > 1) setVisibleCount(visibleCount - 1);
  }, [visibleCount, expanded, signature, maxLines]);

  if (facts.length === 0) return null;

  const hiddenCount = !expanded && visibleCount !== null ? Math.max(0, facts.length - visibleCount) : 0;
  const canCollapse = expanded && visibleCount !== null && visibleCount < facts.length;

  return (
    <ul ref={listRef} aria-label="Key facts" data-testid="card-key-facts" className="flex flex-wrap items-center gap-1.5 px-5 pb-3 pt-2 border-b border-line">
      {facts.map((fact, i) => {
        const hidden = !expanded && visibleCount !== null && i >= visibleCount;
        const inert = inertTargets.includes(fact.target);
        const toneClass = fact.tone === "danger" ? "text-danger-on-tint" : "text-fg-secondary";
        const body = (
          <>
            {fact.avatarUser && <Avatar user={fact.avatarUser} size="xs" />}
            {fact.glyph && <span aria-hidden="true">{fact.glyph}</span>}
            {fact.threshold && <ThresholdMark level={fact.threshold.level} direction={fact.threshold.direction} />}
            <span className={`truncate ${fact.threshold ? "font-semibold text-fg" : ""}`}>{fact.text}</span>
          </>
        );
        const chip = `inline-flex items-center gap-1 max-w-[14rem] min-h-6 border border-line rounded px-1.5 py-0.5 text-xs ${toneClass}`;
        return (
          <li key={fact.key} data-fact-index={i} data-fact-key={fact.key} hidden={hidden}>
            {inert ? (
              <span role="group" aria-label={fact.staticLabel} title={fact.title} className={chip}>{body}</span>
            ) : (
              <button
                type="button"
                onClick={(e) => onJump(fact.target, e.currentTarget)}
                aria-label={fact.label}
                title={fact.title}
                className={`${chip} hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
              >
                {body}
              </button>
            )}
          </li>
        );
      })}
      {(hiddenCount > 0 || canCollapse) && (
        <li data-fact-more="">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
            className="inline-flex items-center min-h-6 border border-line rounded px-1.5 py-0.5 text-xs text-fg-tertiary hover:text-fg hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {expanded ? "Show fewer" : (
              <>
                +{hiddenCount}
                <span className="sr-only"> more {hiddenCount === 1 ? "fact" : "facts"}</span>
              </>
            )}
          </button>
        </li>
      )}
    </ul>
  );
}
