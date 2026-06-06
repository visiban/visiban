import { relativeTime } from "../../../utils/relativeTime";

interface Props {
  /** ISO 8601 timestamp from LensData.fetched_at. */
  fetchedAt: string;
  /** True while a refresh is in flight — shows an inline spinner. */
  refetching: boolean;
  onRefresh: () => void;
}

/**
 * "Synced X ago" + Refresh control for the lens. Reuses the shared
 * relativeTime() helper (never forks a second relative-time formatter — see
 * frontend/CLAUDE.md).
 */
export default function LensFreshness({ fetchedAt, refetching, onRefresh }: Props) {
  const ts = Date.parse(fetchedAt);
  const synced = Number.isNaN(ts) ? null : relativeTime(ts, Date.now());

  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted">
      {refetching ? (
        <span className="flex items-center gap-1.5">
          <span
            className="w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin"
            role="status"
            aria-label="Refreshing"
          />
          Refreshing…
        </span>
      ) : (
        synced && <span>Synced {synced}</span>
      )}
      <button
        type="button"
        onClick={onRefresh}
        disabled={refetching}
        className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Refresh
      </button>
    </div>
  );
}
