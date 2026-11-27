import Tooltip from "../Common/Tooltip";
import { FILTER_BAR_NAME, FILTER_BAR_SHORTCUT, filterBarToggleTooltip } from "./filterBarToggle";

/**
 * Trailing chevron-up control that closes a filter row in one click (#2459).
 * Shared by the board filter row and the Lens filter row so the label,
 * shortcut hint and 44px phone target stay identical. The caller owns what
 * "hide" does, including returning focus to the toolbar Filters trigger.
 */
export default function HideFilterBarButton({ onHide }: { onHide: () => void }) {
  return (
    <span className="ml-auto shrink-0 inline-flex">
      <Tooltip content={filterBarToggleTooltip(true)}>
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide filter bar"
          aria-keyshortcuts={FILTER_BAR_SHORTCUT}
          className="w-8 h-8 max-sm:w-11 max-sm:h-11 rounded hover:bg-surface-hover text-fg-tertiary hover:text-fg flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 15l7-7 7 7" />
          </svg>
        </button>
      </Tooltip>
    </span>
  );
}

/**
 * The Filter panel header's "Filter bar" switch (#2691), the sibling of the chevron above: the
 * same name, tooltip and F shortcut, but it both shows and hides the bar, so it states on or off
 * with `aria-pressed` instead of naming one action. Clicking it keeps the panel open and focus on
 * the switch; the caller only flips the shared show/hide state.
 */
export function FilterBarSwitch({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <Tooltip content={filterBarToggleTooltip(shown)}>
      <span className="inline-flex shrink-0">
        <button
          type="button"
          aria-pressed={shown}
          aria-keyshortcuts={FILTER_BAR_SHORTCUT}
          onClick={onToggle}
          data-filter-bar-switch
          className="inline-flex items-center gap-2 h-8 px-2 rounded text-sm text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          <span>{FILTER_BAR_NAME}</span>
          <kbd aria-hidden="true" className="text-xs text-fg-secondary border border-line-strong rounded px-1 leading-4 max-sm:hidden">F</kbd>
          <span
            aria-hidden="true"
            data-testid="filter-bar-switch-track"
            className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors ${shown ? "bg-primary border-primary" : "bg-surface-active border-line-boundary"}`}
          >
            <span className={`inline-block h-3 w-3 rounded-full bg-fg shadow transition-transform ${shown ? "translate-x-[12px]" : "translate-x-[1px]"}`} />
          </span>
        </button>
      </span>
    </Tooltip>
  );
}

/** Focus the toolbar Filters trigger after its filter row is hidden. Deferred so the row has unmounted first. */
export function focusFiltersTrigger() {
  setTimeout(() => document.querySelector<HTMLElement>("[data-filters-trigger]")?.focus(), 0);
}
