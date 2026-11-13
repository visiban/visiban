import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BOARD_SCROLL_SELECTOR } from "./useCardSheetPlacement";

interface LaneLike {
  id: number;
  name: string;
}

interface Options {
  swimlanes: readonly LaneLike[];
  /** Lanes the lane filter hides right now (empty while focus mode pauses it). */
  hiddenIds: ReadonlySet<number>;
  /** Identity of the effective lane rules; a change means the user edited them. */
  filterKey: string;
  focusedSwimlaneId: number | null;
  /** Swimlane of the card open in the detail panel, if any. */
  openCardSwimlaneId: number | null;
}

/**
 * The "a lane stopped matching" notice and focus recovery (#2205).
 *
 * A lane whose field values change so it no longer matches the lane filters
 * hides at once (the count and the "Reads as" line would otherwise disagree
 * with the screen). That is jarring when the user was working in that lane,
 * so a notice explains it — but only when it concerns them: this client made
 * the edit, keyboard focus was inside the lane, or the open card is in it. A
 * lane this client just created always gets it. Anything else (a teammate's
 * edit to a lane you are not in) hides silently and only the count changes.
 *
 * Not shown after a rule edit or a focus-mode change: those are the user's own
 * filter actions, and the status count already covers them. Any of them also
 * clears an open notice. There is no timeout.
 */
export function useLaneFilterNotice({ swimlanes, hiddenIds, filterKey, focusedSwimlaneId, openCardSwimlaneId }: Options) {
  const [notice, setNotice] = useState<string | null>(null);
  // Lanes this client edited or created since the last evaluation.
  const localEditsRef = useRef(new Set<number>());
  // Closest [data-swimlane-id] of the last focused element. Not cleared when
  // the focused element is removed with its lane (that drop is what recovery
  // detects), but cleared when the user moves focus out themselves (a deferred
  // check after focusout; see below).
  const focusedLaneIdRef = useRef<number | null>(null);
  // The lane focus was recovered from in this commit. Layout effects run
  // before the notice effect, and the recovery focus() itself fires focusin,
  // so the notice reads this snapshot rather than focusedLaneIdRef.
  const recoveredLaneIdRef = useRef<number | null>(null);
  const prevRef = useRef<{ filterKey: string; focus: number | null; laneIds: Set<number>; hidden: ReadonlySet<number> } | null>(null);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target instanceof Element ? e.target.closest("[data-swimlane-id]") : null;
      focusedLaneIdRef.current = el ? Number(el.getAttribute("data-swimlane-id")) : null;
    };
    // Focus that leaves the page content for a non-focusable area (relatedTarget
    // null) fires focusout but no focusin, so without this the ref would keep
    // naming a lane the user is no longer in. The event alone cannot tell that
    // apart from two cases that must keep the ref: Chromium fires focusout
    // synchronously while removing a focused element (relatedTarget null, target
    // still connected), which is the lane being hidden under focus; and a window
    // or tab blur fires it while the element stays activeElement. So decide in a
    // microtask, after React's commit (and the recovery layout effect) has run:
    // clear only if the target is still in the document, the document has focus,
    // and focus truly landed on <body>.
    let disposed = false;
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget !== null || !(e.target instanceof Element)) return;
      const target = e.target;
      queueMicrotask(() => {
        if (disposed) return;
        if (target.isConnected && document.hasFocus() && document.activeElement === document.body) focusedLaneIdRef.current = null;
      });
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      disposed = true;
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  const markLocalEdit = useCallback((id: number) => {
    localEditsRef.current.add(id);
  }, []);

  useEffect(() => {
    const prev = prevRef.current;
    const laneIds = new Set(swimlanes.map((s) => s.id));
    prevRef.current = { filterKey, focus: focusedSwimlaneId, laneIds, hidden: hiddenIds };
    const edits = localEditsRef.current;
    localEditsRef.current = new Set();
    const focusedLane = recoveredLaneIdRef.current ?? focusedLaneIdRef.current;
    recoveredLaneIdRef.current = null;
    if (!prev) return;
    if (prev.filterKey !== filterKey || prev.focus !== focusedSwimlaneId) {
      setNotice(null);
      return;
    }
    const hit: { name: string; isNew: boolean }[] = [];
    for (const lane of swimlanes) {
      if (!hiddenIds.has(lane.id)) continue;
      if (!prev.laneIds.has(lane.id)) {
        if (edits.has(lane.id)) hit.push({ name: lane.name, isNew: true });
      } else if (!prev.hidden.has(lane.id)) {
        if (edits.has(lane.id) || focusedLane === lane.id || openCardSwimlaneId === lane.id) {
          hit.push({ name: lane.name, isNew: false });
        }
      }
    }
    if (hit.length === 0) return;
    if (hit.length > 1) setNotice(`${hit.length} lanes are now hidden because they no longer match your lane filters.`);
    else if (hit[0].isNew) setNotice(`New lane “${hit[0].name}” is hidden because it doesn't match your lane filters.`);
    else setNotice(`“${hit[0].name}” is now hidden because it no longer matches your lane filters.`);
  }, [swimlanes, hiddenIds, filterKey, focusedSwimlaneId, openCardSwimlaneId]);

  // Before paint: if the lane holding keyboard focus just unmounted, focus
  // would sit on <body>; send it to the board scroll region instead (the
  // focusCardOrBoard precedent, #1775). Never to the notice's buttons.
  useLayoutEffect(() => {
    const lane = focusedLaneIdRef.current;
    if (lane === null || !hiddenIds.has(lane)) return;
    const active = document.activeElement;
    if (active && active !== document.body && document.body.contains(active)) return;
    focusedLaneIdRef.current = null;
    recoveredLaneIdRef.current = lane;
    document.querySelector<HTMLElement>(BOARD_SCROLL_SELECTOR)?.focus();
  }, [hiddenIds]);

  const dismiss = useCallback(() => setNotice(null), []);

  return { notice, dismiss, markLocalEdit };
}
