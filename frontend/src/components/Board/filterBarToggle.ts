/**
 * One name for the filter bar toggle (#2691): the Filter panel's header switch, the bar's
 * trailing chevron, the Lens Filters button tooltip and the phone panel all say "filter bar"
 * and name the same F shortcut. A simulated panel found three labels for one control; keep
 * every surface on these strings rather than writing a new one.
 */
export const FILTER_BAR_NAME = "Filter bar";
export const FILTER_BAR_SHORTCUT = "f";
export function filterBarToggleTooltip(shown: boolean): string {
  return shown ? "Hide the filter bar (F)" : "Show the filter bar (F)";
}
