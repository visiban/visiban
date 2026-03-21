import type { MoveBlockedError } from "../../hooks/useBoard";

interface Props {
  error: MoveBlockedError;
  isAdmin: boolean;
  onForce: () => void;
  onDismiss: () => void;
}

function toastBody(error: MoveBlockedError): string {
  if (error.code === "wip_limit_exceeded") {
    const s = error.wip_limit !== 1 ? "s" : "";
    return `"${error.column_name}" is at its limit of ${error.wip_limit} card${s} (${error.current_count} active).`;
  }
  const proposed = error.current_weight + error.card_weight;
  return `"${error.column_name}" has ${error.current_weight} weight — adding this card (+${error.card_weight}) would reach ${proposed} of ${error.weight_limit}.`;
}

function toastTitle(error: MoveBlockedError): string {
  return error.code === "wip_limit_exceeded" ? "WIP limit reached" : "Weight limit reached";
}

export default function MoveBlockedToast({ error, isAdmin, onForce, onDismiss }: Props) {
  return (
    <div
      role="alert"
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-start gap-3 bg-slate-800 border border-amber-600 text-slate-200 text-sm rounded-lg px-4 py-3 shadow-xl max-w-sm"
    >
      <span className="text-amber-400 shrink-0 mt-0.5">⚠</span>
      <div className="flex-1 min-w-0">
        <p>
          <span className="font-medium">{toastTitle(error)}</span> — {toastBody(error)}
        </p>
        {isAdmin && (
          <button
            onClick={onForce}
            className="mt-1.5 text-xs text-amber-400 hover:text-amber-200 underline transition"
          >
            Move anyway (admin override)
          </button>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="text-slate-500 hover:text-slate-200 transition shrink-0 text-lg leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
