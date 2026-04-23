import React, { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { User, Notification } from "../../types";
import { listNotifications, getUnreadCount, markAllRead, markRead } from "../../api/notifications";
import UserMenu from "./UserMenu";
import { formatShortcut, isMacPlatform } from "../../utils/platform";

interface BreadcrumbItem {
  label: string;
  href?: string;
  suffix?: React.ReactNode;
  render?: React.ReactNode;
}

interface Props {
  user: User;
  breadcrumb?: BreadcrumbItem[];
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

export default function Navbar({ user, breadcrumb, onLogout }: Props) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showBell, setShowBell] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Poll the unread count every 30 s. Real-time push via UserConsumer is
  // deferred to 1.1 — the polling interval is intentional until then.
  useEffect(() => {
    const fetchCount = () => getUnreadCount().then(setUnreadCount).catch(() => {});
    fetchCount();
    const interval = setInterval(fetchCount, 30_000);
    return () => clearInterval(interval);
  }, []);

  const openBell = async () => {
    setShowBell((v) => !v);
    if (!showBell) {
      const data = await listNotifications().catch(() => []);
      setNotifications(data);
    }
  };

  const handleMarkAll = async () => {
    await markAllRead();
    setNotifications([]);
    setUnreadCount(0);
  };

  const handleClickNotification = async (n: Notification) => {
    if (!n.read) {
      await markRead([n.id]);
      setNotifications((prev) => prev.filter((x) => x.id !== n.id));
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    setShowBell(false);
    if (n.board_id) {
      const url = n.card_id ? `/boards/${n.board_id}?card=${n.card_id}` : `/boards/${n.board_id}`;
      navigate(url);
    }
  };

  // Close on outside click
  useEffect(() => {
    if (!showBell) return;
    const handler = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setShowBell(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showBell]);

  // `g u` chord shortcut — opens the user menu.
  // `g` primes the chord for 1 s; `u` commits. Guarded against typing contexts.
  useEffect(() => {
    let primedAt = 0;
    const inTypingContext = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (inTypingContext(e.target)) return;
      if (e.key === "g") {
        primedAt = Date.now();
        return;
      }
      if (e.key === "u" && primedAt && Date.now() - primedAt < 1000) {
        e.preventDefault();
        primedAt = 0;
        setUserMenuOpen((v) => (v ? v : true));
        return;
      }
      primedAt = 0;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const relativeTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <>
      <header role="banner" className="h-14 bg-sunken border-b border-line flex items-center px-4 gap-3 shrink-0">
        <Link to="/" className="flex items-center hover:opacity-80 transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
          <img src="/brand/visiban_fullbleed_pulse_light.png" alt="Visiban" className="h-12 w-12 object-contain rounded-lg" />
        </Link>
        {breadcrumb && breadcrumb.length > 0 && (
          <nav aria-label="Breadcrumb" className="flex items-center min-w-0">
            {breadcrumb.map((item, i) => {
              const isLast = i === breadcrumb.length - 1;
              return (
                <span key={i} className="flex items-center min-w-0">
                  <span className="text-fg-faint mx-1.5 select-none" aria-hidden="true">/</span>
                  {item.render ? (
                    item.render
                  ) : item.href ? (
                    <Link
                      to={item.href}
                      className="text-sm text-fg-tertiary hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-emphasis rounded transition max-w-[12rem] truncate"
                      title={item.label}
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <span
                      className="text-sm text-fg font-medium max-w-[18rem] truncate"
                      title={item.label}
                      aria-current={isLast ? "page" : undefined}
                    >
                      {item.label}
                    </span>
                  )}
                  {item.suffix}
                </span>
              );
            })}
          </nav>
        )}
        <div className="ml-auto flex items-center gap-3">
          {/* Global search entry (#852). Reserves the Row 1 slot for #191; until
              then, clicking dispatches visiban:open-palette for BoardView to catch.
              Off-board routes: event has no listener; the slot is still visible
              per #805 chrome contract. */}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("visiban:open-palette"))}
            aria-label={`Search (${isMacPlatform() ? "Cmd+K" : "Ctrl+K"})`}
            title={`Search (${formatShortcut({ mod: true, key: "K" })})`}
            className="flex items-center gap-2 px-2 py-1 text-xs text-fg-tertiary bg-surface border border-line-strong hover:border-line-emphasis rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis w-8 h-8 justify-center lg:w-40 lg:h-auto lg:justify-between shrink-0"
          >
            <span className="flex items-center gap-2">
              <span aria-hidden="true">🔍</span>
              <span className="hidden lg:inline">Search</span>
            </span>
            <span aria-hidden="true" className="hidden lg:inline text-fg-faint">{formatShortcut({ mod: true, key: "K" })}</span>
          </button>

          {/* Notification bell */}
          <div ref={bellRef} className="relative">
            <button
              onClick={openBell}
              className="relative text-fg-secondary hover:text-fg transition p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-emphasis rounded"
              title="Notifications"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 2a6 6 0 00-6 6v3l-1.293 1.293A1 1 0 003 14h14a1 1 0 00.707-1.707L16 11V8a6 6 0 00-6-6zM8 17a2 2 0 004 0H8z" />
              </svg>
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-danger-emphasis text-on-danger text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>
            {showBell && (
              <div className="absolute right-0 top-8 w-80 bg-surface rounded-lg shadow-xl border border-line z-50">
                <div className="flex items-center justify-between px-3 py-2 border-b border-line">
                  <span className="text-xs font-semibold text-fg-secondary">Notifications</span>
                  <button
                    onClick={handleMarkAll}
                    className="text-xs text-info hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-emphasis rounded"
                  >
                    Mark all read
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {notifications.length === 0 && (
                    <p className="text-xs text-fg-tertiary text-center py-6">No notifications</p>
                  )}
                  {notifications.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => handleClickNotification(n)}
                      className="w-full text-left px-3 py-2.5 border-b border-line hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-inset"
                    >
                      <p className="text-xs text-fg leading-snug">{n.verb}</p>
                      <p className="text-[10px] text-fg-tertiary mt-0.5">{relativeTime(n.created_at)}</p>
                      {n.board_id && !n.card_id && (
                        <p className="text-[10px] text-info mt-0.5">View board →</p>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <UserMenu
            user={user}
            open={userMenuOpen}
            onOpenChange={setUserMenuOpen}
            onLogout={onLogout}
          />
        </div>
      </header>

    </>
  );
}
