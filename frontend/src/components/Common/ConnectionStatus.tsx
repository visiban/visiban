import { useEffect, useRef, useState } from "react";
import type { SocketStatus } from "../../hooks/useBoardSocket";
import { useIsStale } from "../../hooks/useIsStale";
import { useEscapeStack } from "../../hooks/useEscapeStack";

interface Props {
  status: SocketStatus;
  lastEventAt: number | null;
  reconnectAttempt?: number;
  /** Fires the board's silent resync (or any consumer-provided refetch). */
  onRefresh?: () => void;
  /** Custom reload implementation for test environments; defaults to window.location.reload. */
  onReloadPage?: () => void;
  className?: string;
  tourStep?: string;
}

type EffectiveState = SocketStatus | "stale";

function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 10_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)} s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}

/**
 * Canonical connection-status indicator (#851).
 *
 * Prominence rule: quiet when healthy (bare green dot + optional "Live" label at lg+),
 * loud when degraded (amber or red background + always-visible label). Clicking the
 * trigger opens a popover with per-state context and — when appropriate — an action
 * (Refresh board, Reload page).
 */
export default function ConnectionStatus({
  status,
  lastEventAt,
  reconnectAttempt,
  onRefresh,
  onReloadPage,
  className = "",
  tourStep,
}: Props) {
  const isStale = useIsStale(status, lastEventAt);
  const effective: EffectiveState = status === "connected" && isStale ? "stale" : status;

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEscapeStack(() => {
    if (!open) return false;
    setOpen(false);
    triggerRef.current?.focus();
  }, 20);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const variant = {
    connected:    { wrapper: "text-success px-1 py-0.5",                                       dot: "w-1.5 h-1.5 rounded-full bg-success-emphasis shrink-0",             label: "Live",           labelClass: "hidden lg:inline",    aria: "Real-time updates active" },
    connecting:   { wrapper: "text-warning bg-warning/10 border border-warning/30 px-2 py-0.5", dot: "w-2 h-2 rounded-full bg-warning-emphasis animate-pulse shrink-0",  label: "Connecting\u2026", labelClass: "",                    aria: "Connecting to real-time updates" },
    reconnecting: { wrapper: "text-warning bg-warning/10 border border-warning/30 px-2 py-0.5", dot: "w-2 h-2 rounded-full bg-warning-emphasis animate-pulse shrink-0",  label: "Reconnecting\u2026", labelClass: "",                  aria: "Reconnecting to real-time updates" },
    stale:        { wrapper: "text-warning bg-warning/10 border border-warning/30 px-2 py-0.5", dot: "w-2 h-2 rounded-full bg-warning-emphasis shrink-0",                label: "Stale",          labelClass: "",                    aria: "Real-time updates delayed" },
    failed:       { wrapper: "text-danger bg-danger-bg/30 border border-danger-emphasis/40 px-2 py-0.5", dot: "w-2 h-2 rounded-full bg-danger-emphasis shrink-0",        label: "Offline",        labelClass: "",                    aria: "Real-time updates unavailable" },
  }[effective];

  const handleReload = () => {
    setOpen(false);
    if (onReloadPage) onReloadPage();
    else window.location.reload();
  };

  const handleRefresh = () => {
    setOpen(false);
    onRefresh?.();
  };

  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={variant.aria}
        data-tour-step={tourStep}
        className={`flex items-center gap-1 text-xs font-medium shrink-0 rounded transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-emphasis ${variant.wrapper}`}
      >
        <span className={variant.dot} aria-hidden="true" />
        {variant.label && <span className={variant.labelClass}>{variant.label}</span>}
        <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {effective === "connected" ? "" : variant.aria}
        </span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Connection status"
          className="absolute right-0 top-full mt-1 w-64 bg-surface border border-line-strong rounded-lg shadow-xl p-3 z-50 flex flex-col gap-2"
        >
          <PopoverBody
            state={effective}
            lastEventAt={lastEventAt}
            reconnectAttempt={reconnectAttempt}
            onRefresh={onRefresh ? handleRefresh : undefined}
            onReload={handleReload}
          />
        </div>
      )}
    </div>
  );
}

interface BodyProps {
  state: EffectiveState;
  lastEventAt: number | null;
  reconnectAttempt?: number;
  onRefresh?: () => void;
  onReload: () => void;
}

function PopoverBody({ state, lastEventAt, reconnectAttempt, onRefresh, onReload }: BodyProps) {
  const now = Date.now();
  const secondary = "text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
  const danger = "bg-danger-bg hover:bg-danger-bg-hover text-on-danger px-3 py-1.5 rounded text-xs font-medium focus:outline-none focus:ring-2 focus:ring-danger-emphasis";

  if (state === "connected") {
    return (
      <>
        <p className="text-sm text-fg-secondary">Real-time updates active.</p>
        {lastEventAt !== null && (
          <p className="text-xs text-fg-muted">Last update: {relativeTime(lastEventAt, now)}</p>
        )}
        {onRefresh && (
          <div className="flex justify-end">
            <button type="button" onClick={onRefresh} className={secondary}>Refresh board</button>
          </div>
        )}
      </>
    );
  }

  if (state === "stale") {
    return (
      <>
        <p className="text-sm text-fg-secondary">No updates for over a minute.</p>
        {lastEventAt !== null && (
          <p className="text-xs text-fg-muted">Last update: {relativeTime(lastEventAt, now)}</p>
        )}
        {onRefresh && (
          <div className="flex justify-end">
            <button type="button" onClick={onRefresh} className={secondary}>Refresh board</button>
          </div>
        )}
      </>
    );
  }

  if (state === "connecting") {
    return <p className="text-sm text-fg-secondary">Establishing real-time connection\u2026</p>;
  }

  if (state === "reconnecting") {
    const n = reconnectAttempt ?? 1;
    return <p className="text-sm text-fg-secondary">Reconnecting\u2026 attempt {n}.</p>;
  }

  // failed
  return (
    <>
      <p className="text-sm text-fg-secondary">Real-time updates unavailable. Refresh the page to reconnect.</p>
      <div className="flex justify-end">
        <button type="button" onClick={onReload} className={danger}>Reload page</button>
      </div>
    </>
  );
}
