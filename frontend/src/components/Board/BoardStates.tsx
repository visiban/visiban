/**
 * Redesigned board states (#2276): loading skeleton, empty board, offline banner, load error
 * and view-only line. Spec: docs/development/board-redesign.md § States.
 */
import { Link } from "react-router-dom";
import { emptyBoardSentence } from "./boardStateCopy";
import { BAND_MAX_WIDTH } from "./boardGrid";

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
  /**
   * #2324 — the group's import flow (`/groups/:id?import=1`). Undefined when the
   * board has no group or the viewer cannot place boards in it. The flow imports
   * a file as a new board in the group (owner ruling, 2026-11-16).
   */
  importHref?: string;
}

// No text color here: each call site sets one, so two color utilities never compete.
const SECONDARY_BTN =
  "inline-flex items-center justify-center min-h-11 px-4 py-2 rounded text-sm border border-line-strong hover:bg-surface-hover hover:text-fg transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

/** Empty board: renders below the column headers (zero counts), above the lanes. */
export function BoardEmptyState({ firstColumnName, onAddCard, importHref }: EmptyProps) {
  return (
    <div role="status" className="sticky left-4 mx-4 my-3 rounded-lg bg-canvas px-5 py-8 text-center" style={{ maxWidth: BAND_MAX_WIDTH }} data-testid="board-empty-state">
      <h2 className="text-base font-semibold text-fg">No cards yet</h2>
      <p className="mt-2 mx-auto max-w-[44ch] text-sm text-fg-secondary break-words">
        {emptyBoardSentence(firstColumnName, !!onAddCard, !!importHref)}
      </p>
      {(onAddCard || importHref) && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {onAddCard && (
            <button
              type="button"
              onClick={onAddCard}
              className="min-h-11 text-sm bg-button-primary hover:bg-button-primary-hover text-on-primary px-4 py-2 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Add a card
            </button>
          )}
          {/* A link, not a button: it navigates to the group's import flow. */}
          {importHref && (
            <Link to={importHref} className={`${SECONDARY_BTN} text-fg-secondary`}>
              Import cards
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/** #2324 — below the lanes (each shrunk to its band) when nothing matches. */
export function BoardNoMatchState({ line, onShowAll }: { line: string; onShowAll: () => void }) {
  return (
    <div role="status" className="sticky left-4 mx-4 my-3 rounded-lg bg-canvas px-5 py-5 text-center" style={{ maxWidth: BAND_MAX_WIDTH }} data-testid="board-no-match">
      <p className="text-sm font-semibold text-fg break-words">{line}</p>
      <button type="button" onClick={onShowAll} className={`mt-3 ${SECONDARY_BTN} text-fg`}>
        Show all cards
      </button>
    </div>
  );
}

/** Shown while the socket is down; the connection status in the toolbar reads Offline. */
export function BoardOfflineBanner({ failed = false }: { failed?: boolean }) {
  return (
    <div
      role="status"
      data-testid="board-offline-banner"
      className="mx-4 mt-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm font-medium text-warning-on-tint"
    >
      {failed
        ? "Live updates are off, so other people's changes may not show. Reload the page to reconnect."
        : "You're offline. Changes may not save until the board reconnects."}
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
