import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Message for a live region that must announce every action, including a repeat
 * of the identical text (#2323). React makes no DOM change when a region is set to
 * the string it already holds, so a screen reader stays silent the second time
 * (collapse all, expand one lane by hand, collapse all again). `announce` clears
 * the region first and sets the text on a short timeout so the change is always real.
 * Render `message` in an always-mounted `role="status"` element so assistive tech
 * registers the region before its text changes.
 */
export function useLiveAnnouncer(): { message: string; announce: (text: string) => void } {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const announce = useCallback((text: string) => {
    clearTimeout(timer.current);
    setMessage("");
    timer.current = setTimeout(() => setMessage(text), 50);
  }, []);
  return { message, announce };
}

const countOf = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Collapsed all 3 lanes" / "Expanded all 1 lane"; the count is omitted when unknown. */
export function laneStateMessage(collapsed: boolean, laneCount?: number): string {
  const verb = collapsed ? "Collapsed" : "Expanded";
  if (laneCount === undefined) return `${verb} all lanes`;
  return `${verb} all ${countOf(laneCount, "lane", "lanes")}`;
}

/** "Hid all 4 columns" / "Showed all 1 column"; the count is omitted when unknown (#2338). */
export function columnStateMessage(hidden: boolean, columnCount?: number): string {
  const verb = hidden ? "Hid" : "Showed";
  if (columnCount === undefined) return `${verb} all columns`;
  return `${verb} all ${countOf(columnCount, "column", "columns")}`;
}

/** The `e` shortcut changes lanes and columns together, so one message names both (#2338). Composed from the same parts, not by rewriting the other messages. */
export function boardStateMessage(collapsed: boolean, laneCount: number, columnCount: number): string {
  return `${collapsed ? "Collapsed" : "Expanded"} all ${countOf(laneCount, "lane", "lanes")} and ${countOf(columnCount, "column", "columns")}`;
}
