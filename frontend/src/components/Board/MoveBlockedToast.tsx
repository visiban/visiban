import type { MoveBlockedError } from "../../hooks/useBoard";

interface Props {
  error: MoveBlockedError;
  isAdmin: boolean;
  onForce: () => void;
  onDismiss: () => void;
}

function toastBody(error: MoveBlockedError): string {
  if (error.code === "version_conflict") {
    return "This card was modified by another user while you were dragging it. The board has been refreshed.";
  }
  if (error.code === "permission_denied") {
    return error.detail;
  }
  if (error.code === "wip_limit_exceeded" || error.code === "wip_hard_blocked") {
    const s = error.wip_limit !== 1 ? "s" : "";
    return `"${error.column_name}" is at its limit of ${error.wip_limit} card${s} (${error.current_count} active).`;
  }
  const proposed = error.current_weight + error.card_weight;
  return `"${error.column_name}" has ${error.current_weight} weight — adding this card (+${error.card_weight}) would reach ${proposed} of ${error.weight_limit}.`;
}

function toastTitle(error: MoveBlockedError): string {
  if (error.code === "version_conflict") return "Card was updated";
  if (error.code === "permission_denied") return "Cannot move this card";
  if (error.code === "wip_hard_blocked") return "Column at capacity — no exceptions";
  return error.code === "wip_limit_exceeded" ? "WIP limit reached" : "Weight limit reached";
}

export default function MoveBlockedToast({ error, isAdmin, onForce, onDismiss }: Props) {
  const hardBlocked = error.code === "wip_hard_blocked" || error.code === "permission_denied";
  const versionConflict = error.code === "version_conflict";
  return (
    <div
      role="alert"
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-start gap-3 bg-surface border border-warning text-fg text-sm rounded-lg px-4 py-3 shadow-xl max-w-sm"
    >
      <span className="text-warning shrink-0 mt-0.5">{hardBlocked ? "⛔" : "⚠"}</span>
      <div className="flex-1 min-w-0">
        <p>
          <span className="font-medium">{toastTitle(error)}</span> — {toastBody(error)}
        </p>
        {versionConflict ? null : hardBlocked ? (
          // Hard mode: no override possible for any role.
          // wip_hard_blocked shows a column-specific resolution hint; permission_denied
          // has no actionable hint beyond the body text already shown.
          error.code === "wip_hard_blocked" && (
            <p className="mt-1.5 text-xs text-fg-tertiary">
              To unblock, move a card out of {error.column_name}, or ask an admin to raise the WIP limit.
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
