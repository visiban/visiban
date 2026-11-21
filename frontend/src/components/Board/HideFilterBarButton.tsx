import Tooltip from "../Common/Tooltip";

/**
 * Trailing chevron-up control that closes a filter row in one click (#2459).
 * Shared by the board filter row and the Lens filter row so the label,
 * shortcut hint and 44px phone target stay identical. The caller owns what
 * "hide" does, including returning focus to the toolbar Filters trigger.
 */
export default function HideFilterBarButton({ onHide }: { onHide: () => void }) {
  return (
    <span className="ml-auto shrink-0 inline-flex">
      <Tooltip content="Hide filters (F)">
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide filter bar"
          aria-keyshortcuts="f"
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

/** Focus the toolbar Filters trigger after its filter row is hidden. Deferred so the row has unmounted first. */
export function focusFiltersTrigger() {
  setTimeout(() => document.querySelector<HTMLElement>("[data-filters-trigger]")?.focus(), 0);
}
