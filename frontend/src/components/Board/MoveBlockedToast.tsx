import type { MoveBlockedError } from "../../hooks/useBoard";
import { hardLimitContainer, isHardLimit, toastBody, toastTitle } from "./moveBlockedMessages";

interface Props {
  error: MoveBlockedError;
  isAdmin: boolean;
  onForce: () => void;
  onDismiss: () => void;
}

export default function MoveBlockedToast({ error, isAdmin, onForce, onDismiss }: Props) {
  const hardBlocked = isHardLimit(error.code) || error.code === "permission_denied";
  // maintenance_mode has no override for anyone — a site admin never sees this
  // toast at all, since their own writes succeed — but it keeps the ⚠ glyph
  // (matching MaintenanceBanner's amber tone, not permission_denied's ⛔):
  // per frontend/CLAUDE.md, ⛔ is reserved for the hard WIP blocks (column
  // and, since #1150, swimlane), so the no-override condition and the
  // severity glyph are tracked separately.
  const noOverride = hardBlocked || error.code === "maintenance_mode" || error.code === "move_failed";
  const versionConflict = error.code === "version_conflict";
  const hardContainer = hardLimitContainer(error);
  // Other limits the same move tripped (#1150): the server names only the
  // strictest, so the second line names the rest from board state.
  const also = "also" in error ? error.also ?? [] : [];
  return (
    <div
      role="alert"
      // A click here never closes an open card detail sheet (#1914).
      data-keeps-card-sheet-open
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-start gap-3 bg-surface border border-warning text-fg text-sm rounded-lg px-4 py-3 shadow-xl w-max max-w-[min(24rem,calc(100%-2rem))]"
    >
      <span className="text-warning shrink-0 mt-0.5">{hardBlocked ? "⛔" : "⚠"}</span>
      <div className="flex-1 min-w-0">
        <p>
          <span className="font-medium">{toastTitle(error)}</span> — {toastBody(error)}
        </p>
        {also.length > 0 && (
          <p className="mt-1 text-xs text-fg-tertiary">Also: {also.join(" ")}</p>
        )}
        {versionConflict ? null : noOverride ? (
          // Hard mode: no override possible for any role.
          // A hard WIP block shows a resolution hint naming the column or
          // swimlane it is on; permission_denied has no actionable hint beyond
          // the body text already shown.
          hardContainer !== null && (
            <p className="mt-1.5 text-xs text-fg-tertiary">
              To unblock, move a card out of {hardContainer}, or ask an admin to raise the WIP limit.
            </p>
          )
        ) : (
          isAdmin && (
            <button
              onClick={onForce}
              className="mt-1.5 text-xs text-warning hover:text-warning underline transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
            >
              Move anyway (admin override)
            </button>
          )
        )}
      </div>
      <button
        onClick={onDismiss}
        className="text-fg-muted hover:text-fg transition shrink-0 text-lg leading-none focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
