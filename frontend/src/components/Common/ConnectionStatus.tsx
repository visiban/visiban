import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SocketStatus } from "../../hooks/useBoardSocket";
import { useIsStale } from "../../hooks/useIsStale";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { relativeTime } from "../../utils/relativeTime";

interface Props {
  status: SocketStatus;
  lastEventAt: number | null;
  reconnectAttempt?: number;
  /** Chip text while reconnecting. The Board passes "Offline" to match its banner; pages with no banner keep the default. */
  reconnectingLabel?: string;
  /** Fires the board's silent resync (or any consumer-provided refetch). */
  onRefresh?: () => void;
  /** Custom reload implementation for test environments; defaults to window.location.reload. */
  onReloadPage?: () => void;
  className?: string;
  tourStep?: string;
  /** Phone chrome (#2348): drop the healthy dot below 640px; a degraded state (stale, offline, failed) still shows. */
  hideWhenHealthyOnPhone?: boolean;
}

type EffectiveState = SocketStatus | "stale";

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
  reconnectingLabel = "Reconnecting…",
  onRefresh,
  onReloadPage,
  className = "",
  tourStep,
  hideWhenHealthyOnPhone = false,
}: Props) {
  const isStale = useIsStale(status, lastEventAt);
  const effective: EffectiveState = status === "connected" && isStale ? "stale" : status;

  const [open, setOpen] = useState(false);
  // Popover anchor captured at click time. `null` = closed. Stored as state
  // (not ref) so position survives a re-render without re-measuring.
  // We portal the popover to document.body to escape the board toolbar's
  // `overflow-x-auto` (which forces overflow-y clipping per CSS spec) —
  // without the portal, the popover is hidden below the toolbar row.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEscapeStack(() => {
    if (!open) return false;
    setOpen(false);
    setAnchor(null);
    triggerRef.current?.focus();
  }, 20);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
      setAnchor(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // #1171: the panel is anchored once, at click time, and the trigger label is
  // `hidden lg:inline`, so crossing the lg breakpoint moves the trigger. Dismiss
  // rather than re-measure (frontend/CLAUDE.md); a scroll inside the panel is not one.
  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      setOpen(false);
      setAnchor(null);
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && popoverRef.current?.contains(e.target)) return;
      dismiss();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const toggleOpen = () => {
    if (open) {
      setOpen(false);
      setAnchor(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen(true);
  };

  // Reconnecting reads "Offline" (#2325, spec § States): the board banner says the
  // same word, and the popover still says it is reconnecting and on which attempt.
  const variant = {
    connected:    { wrapper: "text-success px-1 py-0.5",                                       dot: "w-1.5 h-1.5 rounded-full bg-success-emphasis shrink-0",             label: "Live",           labelClass: "hidden lg:inline",    aria: "Real-time updates active" },
    connecting:   { wrapper: "text-warning-on-tint bg-warning/10 border border-warning/30 rounded px-2 py-0.5", dot: "w-2 h-2 rounded-full bg-warning-emphasis animate-pulse motion-reduce:animate-none shrink-0",  label: "Connecting\u2026", labelClass: "",                    aria: "Connecting to real-time updates" },
    reconnecting: { wrapper: "text-warning-on-tint bg-warning/10 border border-warning/30 rounded px-2 py-0.5", dot: "w-2 h-2 rounded-full bg-warning-emphasis animate-pulse motion-reduce:animate-none shrink-0",  label: reconnectingLabel, labelClass: "",                    aria: "Offline, reconnecting to real-time updates" },
    stale:        { wrapper: "text-warning-on-tint bg-warning/10 border border-warning/30 rounded px-2 py-0.5", dot: "w-2 h-2 rounded-full bg-warning-emphasis shrink-0",                label: "Stale",          labelClass: "",                    aria: "Real-time updates delayed" },
    failed:       { wrapper: "text-danger-on-tint bg-danger-bg/30 border border-danger-emphasis/40 rounded px-2 py-0.5", dot: "w-2 h-2 rounded-full bg-danger-emphasis shrink-0",        label: "Offline",        labelClass: "",                    aria: "Offline, real-time updates unavailable" },
  }[effective];

  const handleReload = () => {
    setOpen(false);
    setAnchor(null);
    if (onReloadPage) onReloadPage();
    else window.location.reload();
  };

  const handleRefresh = () => {
    setOpen(false);
    setAnchor(null);
    onRefresh?.();
  };

  const panel = open && anchor ? (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Connection status"
      style={{ position: "fixed", top: anchor.top, right: anchor.right }}
      className="w-64 bg-surface border border-line-strong rounded-lg shadow-xl p-3 z-50 flex flex-col gap-2"
    >
      <PopoverBody
        state={effective}
        lastEventAt={lastEventAt}
        reconnectAttempt={reconnectAttempt}
        onRefresh={onRefresh ? handleRefresh : undefined}
        onReload={handleReload}
      />
    </div>
  ) : null;

  return (
    <div className={className}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggleOpen}
        onMouseDown={(e) => { if (open) e.stopPropagation(); }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={variant.aria}
        data-tour-step={tourStep}
        className={`flex items-center justify-center gap-1 max-sm:min-h-11 max-sm:min-w-11 text-xs font-medium shrink-0 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${variant.wrapper}${hideWhenHealthyOnPhone && effective === "connected" ? " max-sm:hidden" : ""}`}
      >
        <span className={variant.dot} aria-hidden="true" />
        {variant.label && <span className={variant.labelClass}>{variant.label}</span>}
        <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {effective === "connected" ? "" : variant.aria}
        </span>
      </button>
      {panel && createPortal(panel, document.body)}
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
    return <p className="text-sm text-fg-secondary">Establishing real-time connection…</p>;
  }

  if (state === "reconnecting") {
    const n = reconnectAttempt ?? 1;
    return <p className="text-sm text-fg-secondary">Reconnecting… attempt {n}.</p>;
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
