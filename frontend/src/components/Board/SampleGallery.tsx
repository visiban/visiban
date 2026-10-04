import { useEffect, useRef, useState } from "react";
import type { SampleBoardInclude, SampleBoardSummary } from "../../types";

export type SampleListState = "loading" | "ready" | "unavailable";

export interface SampleFocusRequest {
  id: string;
  /** Bumped per request so asking for the same card twice still fires. */
  n: number;
}

interface Props {
  samples: SampleBoardSummary[];
  listState: SampleListState;
  /** The sample being fetched, or the one whose fetch failed. */
  pending: { id: string; status: "loading" | "error" } | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSelect: (sample: SampleBoardSummary) => void;
  onRetryList: () => void;
  /** Move focus to a card (after Change, a canceled load, or a failed load). */
  focusRequest: SampleFocusRequest | null;
}

const INCLUDE_LABELS: Record<SampleBoardInclude, string> = {
  labels: "Labels",
  checklists: "Checklists",
  comments: "Comments",
  history: "History",
};

// Tailwind's `min-[560px]` below: under it the grid is one column and the
// collapsed view shows 3 samples instead of 4 (#1452).
const NARROW_QUERY = "(max-width: 559px)";

function useIsNarrow(): boolean {
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

function IncludesBadges({ includes }: { includes: SampleBoardInclude[] }) {
  return (
    <div role="group" aria-label="Includes" className="flex flex-wrap gap-1 mt-1.5 first:mt-0">
      {includes.map((inc) => (
        <span key={inc} className="text-xs text-fg-tertiary border border-line rounded px-1.5 py-0.5">
          {INCLUDE_LABELS[inc]}
        </span>
      ))}
    </div>
  );
}

/**
 * The "Start from a sample" section of the Import Board modal (#1452).
 *
 * Self-contained on purpose — it takes `onSelect` and owns no import logic — so
 * user-defined templates (#442) can add an entry point beside it. It is named
 * "sample", not "template", because `BoardTemplate` is a different concept.
 *
 * The cards form one roving Tab stop (arrow keys move, Enter/Space select).
 * Each card's only focusable element is its button; clicking anywhere else on
 * the card is a pointer shortcut for that button.
 */
export default function SampleGallery({
  samples,
  listState,
  pending,
  expanded,
  onExpandedChange,
  onSelect,
  onRetryList,
  focusRequest,
}: Props) {
  const narrow = useIsNarrow();
  const cols = narrow ? 1 : 2;
  const collapsedCount = narrow ? 3 : 4;
  const canCollapse = samples.length > collapsedCount;
  const visible = expanded || !canCollapse ? samples : samples.slice(0, collapsedCount);

  const [activeId, setActiveId] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const toggleRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  // A card to focus once it is rendered (it may first need the list expanded).
  const wantFocus = useRef<string | null>(null);

  // The remembered card falls back to the last visible one when "Show fewer"
  // hides it; before any focus the first card is the tab stop.
  const firstId = visible[0]?.id ?? null;
  const rovingId = !activeId
    ? firstId
    : visible.some((s) => s.id === activeId)
      ? activeId
      : (visible[visible.length - 1]?.id ?? null);

  useEffect(() => {
    if (focusRequest) wantFocus.current = focusRequest.id;
    const id = wantFocus.current;
    if (!id) return;
    const btn = buttons.current.get(id);
    if (btn) {
      wantFocus.current = null;
      btn.focus();
    } else if (!expanded && samples.some((s) => s.id === id)) {
      onExpandedChange(true); // the card is behind "Show all"
    }
  }, [focusRequest, expanded, samples, onExpandedChange]);

  // The modal opens with focus on the first card (or on Retry when the list is
  // unavailable) — but only when focus is still on the dialog or has been lost,
  // never over a control the user already reached.
  useEffect(() => {
    const active = document.activeElement;
    const lost = !active || active === document.body || active.getAttribute("role") === "dialog";
    if (!lost) return;
    if (listState === "ready" && firstId) buttons.current.get(firstId)?.focus();
    else if (listState === "unavailable") retryRef.current?.focus();
  }, [listState, firstId]);

  const move = (from: number, key: string): number => {
    const last = visible.length - 1;
    switch (key) {
      case "ArrowRight": return Math.min(from + 1, last);
      case "ArrowLeft": return Math.max(from - 1, 0);
      case "ArrowDown": return from + cols <= last ? from + cols : from;
      case "ArrowUp": return from - cols >= 0 ? from - cols : from;
      case "Home": return 0;
      case "End": return last;
      default: return from;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next = move(index, e.key);
    buttons.current.get(visible[next].id)?.focus();
  };

  const toggle = () => {
    if (expanded) {
      onExpandedChange(false);
    } else {
      onExpandedChange(true);
      // Card 5 is the first one revealed.
      wantFocus.current = samples[collapsedCount]?.id ?? null;
    }
  };

  const loadingAny = pending?.status === "loading";
  // When every sample carries the same features the per-card chip row is pure
  // repetition (and ~28px per card), so it is shown once under the helper text
  // and comes back by itself as soon as any sample differs.
  const sameIncludes =
    samples.length > 0 && samples.every((x) => x.includes.join() === samples[0].includes.join());

  return (
    <section aria-labelledby="import-samples-heading" className="space-y-2">
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-1">
          <h3 id="import-samples-heading" className="text-xs font-medium text-fg-tertiary uppercase tracking-wide">
            Start from a sample
          </h3>
          {listState === "ready" && <span className="text-xs text-fg-tertiary">{samples.length} {samples.length === 1 ? "sample" : "samples"}</span>}
        </div>
        {listState !== "unavailable" && (
          <p className="text-xs text-fg-tertiary">
            No file? Pick a sample to get a ready-made board with realistic cards. You&rsquo;ll choose what to include next.
          </p>
        )}
        {listState === "ready" && sameIncludes && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-fg-tertiary">
            <span>Every sample includes</span>
            <IncludesBadges includes={samples[0].includes} />
          </div>
        )}
      </div>

      {listState === "loading" && <p className="text-xs text-fg-tertiary">Loading samples&hellip;</p>}

      {listState === "unavailable" && (
        <div className="flex items-start justify-between gap-3 bg-surface-hover/50 border border-line-strong rounded-lg px-3 py-2.5 text-xs text-fg-secondary">
          <div>
            <p className="font-medium text-fg">Samples aren&rsquo;t available right now.</p>
            <p className="mt-0.5">You can still upload your own file below.</p>
          </div>
          <button
            ref={retryRef}
            type="button"
            onClick={onRetryList}
            className="shrink-0 border border-line-strong text-fg-secondary hover:text-fg hover:bg-surface-hover text-xs font-medium px-2.5 py-1 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Retry
          </button>
        </div>
      )}

      {listState === "ready" && (
        <>
          <ul className="grid grid-cols-1 min-[560px]:grid-cols-2 gap-2">
            {visible.map((s, index) => {
              const isLoading = pending?.id === s.id && pending.status === "loading";
              const isError = pending?.id === s.id && pending.status === "error";
              const blocked = loadingAny && !isLoading;
              const tone = isError
                ? "border-danger"
                : isLoading
                  ? "border-primary-emphasis bg-primary/15"
                  : "border-line hover:border-line-strong hover:shadow focus-within:border-primary-emphasis";
              return (
                <li key={s.id} className="flex">
                  {/* The button is the one control; its ::after stretches over the card so a click
                      anywhere on it selects (the stretched-button pattern, no div handler). */}
                  <div
                    className={`group relative flex flex-col w-full rounded-lg border bg-surface p-3 transition focus-within:ring-2 focus-within:ring-primary-emphasis ${tone} ${blocked ? "opacity-60" : "cursor-pointer"}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <h4 title={s.title} className="text-sm font-medium text-fg truncate">{s.title}</h4>
                      <span className="shrink-0 text-xs text-fg-tertiary">~{s.card_count} cards</span>
                    </div>
                    <p className="text-xs text-fg-secondary mt-0.5">{s.description}</p>
                    <p className="text-xs text-fg-tertiary mt-0.5">Swimlanes by {s.swimlane_theme}</p>
                    {!sameIncludes && <IncludesBadges includes={s.includes} />}
                    <div className="mt-auto pt-2">
                      {isError && (
                        <p role="alert" className="text-xs text-danger mb-2">
                          Couldn&rsquo;t load this sample.
                          <span className="sr-only">
                            {" "}The {s.title} sample didn&rsquo;t load. Try again, pick another sample, or upload your own file.
                          </span>
                        </p>
                      )}
                      <button
                        ref={(el) => {
                          if (el) buttons.current.set(s.id, el);
                          else buttons.current.delete(s.id);
                        }}
                        type="button"
                        tabIndex={s.id === rovingId ? 0 : -1}
                        aria-disabled={blocked || isLoading ? true : undefined}
                        aria-label={isError ? `Try again, ${s.title} sample` : `Use this sample: ${s.title}`}
                        onClick={() => {
                          if (!loadingAny) onSelect(s);
                        }}
                        onFocus={() => setActiveId(s.id)}
                        onKeyDown={(e) => onKeyDown(e, index)}
                        className="border border-line-strong text-fg-secondary text-xs font-medium px-3 py-1 rounded transition outline-none after:absolute after:inset-0 after:content-[''] group-hover:bg-button-primary group-hover:text-on-primary group-hover:border-transparent aria-disabled:group-hover:bg-transparent aria-disabled:group-hover:text-fg-secondary aria-disabled:group-hover:border-line-strong"
                      >
                        {isError ? "Try again" : "Use this sample"}
                      </button>
                      {/* Visual only: the modal's persistent live region announces the load once. */}
                      {isLoading && <p aria-hidden="true" className="text-xs text-fg-secondary mt-2 mb-1">Loading sample&hellip;</p>}
                      {isLoading && (
                        <div className="h-1.5 rounded-full bg-sunken overflow-hidden" aria-hidden="true">
                          {/* Indeterminate; at reduced motion a static partial bar, not a "done" one. */}
                          <div className="h-full w-full bg-button-primary animate-pulse motion-reduce:animate-none motion-reduce:w-1/3" />
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {canCollapse && (
            <button
              ref={toggleRef}
              type="button"
              aria-expanded={expanded}
              onClick={toggle}
              className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              {expanded ? "Show fewer samples" : `Show all ${samples.length} samples`}
              <span aria-hidden="true"> {expanded ? "▴" : "▾"}</span>
            </button>
          )}
        </>
      )}

      <div className="flex items-center gap-3 text-xs text-fg-tertiary pt-1">
        <span className="h-px flex-1 bg-line" aria-hidden="true" />
        {listState === "unavailable" ? "Upload your own file" : "or upload your own file"}
        <span className="h-px flex-1 bg-line" aria-hidden="true" />
      </div>
    </section>
  );
}
