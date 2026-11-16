/**
 * Redesigned board states (#2276): loading skeleton, empty board, offline banner, load error
 * and view-only line. Spec: docs/development/board-redesign.md § States.
 */

const BLOCK = "bg-surface-hover rounded-lg animate-pulse motion-reduce:animate-none";

/** Skeleton at the final sizes of column headers, one lane band and card blocks. */
export function BoardSkeleton() {
  return (
    <div role="status" aria-busy="true" className="p-4" data-testid="board-skeleton">
      <span className="sr-only">Loading board</span>
      <div aria-hidden="true" className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className={`${BLOCK} h-11`} />)}
        </div>
        <div className={`${BLOCK} h-12`} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[2, 1, 2, 0].map((n, i) => (
            <div key={i} className="rounded-lg bg-canvas p-2 space-y-2 min-h-40">
              {Array.from({ length: n }, (_, j) => <div key={j} className={`${BLOCK} h-16`} />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface EmptyProps {
  firstColumnName: string;
  /** Undefined when the viewer cannot add cards: the sentence stays, the button goes. */
  onAddCard?: () => void;
}

/** Empty board: column headers (zero counts) stay above; this fills the lane area. */
export function BoardEmptyState({ firstColumnName, onAddCard }: EmptyProps) {
  return (
    <div role="status" className="mx-4 my-3 rounded-lg bg-canvas px-6 py-8 text-center" data-testid="board-empty-state">
      <h2 className="text-base font-semibold text-fg">No cards yet</h2>
      <p className="mt-2 text-sm text-fg-secondary break-words">
        {onAddCard ? `Add the first card to ${firstColumnName}.` : "Cards added to this board will show up here."}
      </p>
      {onAddCard && (
        <button
          type="button"
          onClick={onAddCard}
          className="mt-4 min-h-11 text-sm bg-button-primary hover:bg-button-primary-hover text-on-primary px-4 py-2 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Add a card
        </button>
      )}
    </div>
  );
}

/**
 * Shown while the socket is down; the connection status in the toolbar reads Offline too.
 * Moves are paused until the board is live again (#2325, spec § States): drag and every
 * Move path are disabled, and this banner is the text that says why.
 */
export function BoardOfflineBanner({ failed = false }: { failed?: boolean }) {
  return (
    <div
      role="status"
      data-testid="board-offline-banner"
      className="mx-4 mt-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm font-medium text-warning-on-tint"
    >
      {failed
        ? "Offline. Live updates are off and moves are paused. Reload the page to reconnect."
        : "Offline. Reconnecting. Moves are paused until the board is live again."}
    </div>
  );
}

export function BoardLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="m-4 flex items-center justify-between gap-4 rounded-lg border border-danger-emphasis/50 bg-surface px-4 py-3" data-testid="board-load-error">
      <p className="min-w-0 text-sm text-fg-secondary">
        <strong className="font-semibold text-fg">The board didn't load.</strong> Check your connection and try again.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 text-sm bg-button-primary hover:bg-button-primary-hover text-on-primary px-4 py-2 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >
        Try again
      </button>
    </div>
  );
}

export function ViewOnlyNotice() {
  return (
    <div role="note" data-testid="board-view-only" className="mx-4 mt-2 flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2 text-sm text-fg-secondary">
      <svg aria-hidden="true" className="w-4 h-4 shrink-0 text-fg-tertiary" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
        <circle cx="8" cy="8" r="2" />
      </svg>
      <span><strong className="font-semibold text-fg">View only.</strong> You can open cards and filter, but not move or edit them.</span>
    </div>
  );
}
