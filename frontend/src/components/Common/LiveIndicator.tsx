import type { SocketStatus } from "../../hooks/useBoardSocket";

interface Props {
  status: SocketStatus;
  onReload?: () => void;
  className?: string;
  /** Forwarded to the inner span — preserves the existing BoardView tour step hook. */
  tourStep?: string;
}

/**
 * Canonical live-connection indicator used by any page that subscribes to a
 * WebSocket channel (board, group). Moved out of BoardView so the boards-list
 * view on GroupDetail can reuse the exact same copy and states (#753).
 */
export default function LiveIndicator({ status, onReload, className = "", tourStep }: Props) {
  const label =
    status === "connected" ? "Live"
    : status === "reconnecting" || status === "connecting" ? "Reconnecting…"
    : "Offline";
  const dotClass =
    status === "connected" ? "bg-success-emphasis animate-pulse"
    : status === "reconnecting" || status === "connecting" ? "bg-warning-emphasis animate-pulse"
    : "bg-fg-muted";
  const textClass =
    status === "connected" ? "text-success"
    : status === "reconnecting" || status === "connecting" ? "text-warning"
    : "text-fg-muted";
  const ariaLabel =
    status === "connected" ? "Real-time updates active"
    : status === "reconnecting" ? "Reconnecting"
    : status === "connecting" ? "Connecting"
    : "Real-time updates unavailable";
  const title =
    status === "connected" ? "Live — real-time updates active"
    : status === "reconnecting" ? "Reconnecting…"
    : status === "connecting" ? "Connecting…"
    : "Offline — real-time updates unavailable";

  return (
    <span
      data-tour-step={tourStep}
      className={`flex items-center gap-1 text-xs font-medium shrink-0 ${textClass} ${className}`}
      role="status"
      aria-label={ariaLabel}
      title={title}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      <span className="hidden lg:inline">{label}</span>
      {status === "failed" && onReload && (
        <button
          type="button"
          onClick={onReload}
          className="ml-1.5 text-xs text-info hover:text-info underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
        >
          Reload
        </button>
      )}
    </span>
  );
}
