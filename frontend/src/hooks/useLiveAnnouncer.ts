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

/** "Collapsed all 3 lanes" / "Expanded all 1 lane"; the count is omitted when unknown. */
export function laneStateMessage(collapsed: boolean, laneCount?: number): string {
  const verb = collapsed ? "Collapsed" : "Expanded";
  if (laneCount === undefined) return `${verb} all lanes`;
  return `${verb} all ${laneCount} ${laneCount === 1 ? "lane" : "lanes"}`;
}

/** "Hid all 4 columns" / "Showed all 1 column"; the count is omitted when unknown (#2338). */
export function columnStateMessage(hidden: boolean, columnCount?: number): string {
  const verb = hidden ? "Hid" : "Showed";
  if (columnCount === undefined) return `${verb} all columns`;
  return `${verb} all ${columnCount} ${columnCount === 1 ? "column" : "columns"}`;
}

/** The `e` shortcut changes lanes and columns together, so one message names both (#2338). */
export function boardStateMessage(collapsed: boolean, laneCount: number, columnCount: number): string {
  const lanes = laneStateMessage(collapsed, laneCount).replace(/^(Collapsed|Expanded) all /, "");
  const cols = columnStateMessage(collapsed, columnCount).replace(/^(Hid|Showed) all /, "");
  return `${collapsed ? "Collapsed" : "Expanded"} all ${lanes} and ${cols}`;
}
