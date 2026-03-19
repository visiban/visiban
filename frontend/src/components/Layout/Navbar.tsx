import React, { useState, useEffect, useRef } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import type { User, Notification } from "../../types";
import { userDisplayName } from "../../types";
import { listNotifications, getUnreadCount, markAllRead, markRead } from "../../api/notifications";

interface BreadcrumbItem {
  label: string;
  href?: string;
  suffix?: React.ReactNode;
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
  const bellRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

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
      <header className="h-16 bg-slate-900 border-b border-slate-700 flex items-center px-4 gap-3 shrink-0">
        <Link to="/" className="flex items-center hover:opacity-80 transition">
          <img src="/brand/visiban_fullbleed_pulse_light.png" alt="Visiban" className="h-12 w-12 object-contain rounded-lg" />
        </Link>
        {breadcrumb?.map((item, i) => (
          <span key={i} className="flex items-center gap-2">
            <span className="text-slate-500">/</span>
            {item.href ? (
              <Link to={item.href} className="text-slate-200 text-sm font-medium hover:text-white transition">
                {item.label}
              </Link>
            ) : (
              <span className="text-slate-200 text-sm font-medium">{item.label}</span>
            )}
            {item.suffix}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-3">
          {/* Notification bell */}
          <div ref={bellRef} className="relative">
            <button
              onClick={openBell}
              className="relative text-slate-300 hover:text-white transition p-1"
              title="Notifications"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 2a6 6 0 00-6 6v3l-1.293 1.293A1 1 0 003 14h14a1 1 0 00.707-1.707L16 11V8a6 6 0 00-6-6zM8 17a2 2 0 004 0H8z" />
              </svg>
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>
            {showBell && (
              <div className="absolute right-0 top-8 w-80 bg-slate-800 rounded-lg shadow-xl border border-slate-700 z-50">
                <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
                  <span className="text-xs font-semibold text-slate-300">Notifications</span>
                  <button
                    onClick={handleMarkAll}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    Mark all read
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {notifications.length === 0 && (
                    <p className="text-xs text-slate-400 text-center py-6">No notifications</p>
                  )}
                  {notifications.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => handleClickNotification(n)}
                      className="w-full text-left px-3 py-2.5 border-b border-slate-700 hover:bg-slate-700 transition"
                    >
                      <p className="text-xs text-slate-200 leading-snug">{n.verb}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">{relativeTime(n.created_at)}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <button
            onClick={() => navigate("/settings", { state: { from: location } })}
            className="text-slate-200 text-sm hover:text-white transition"
          >
            {userDisplayName(user)}
          </button>
          <button
            onClick={onLogout}
            className="text-xs text-slate-400 hover:text-white transition"
          >
            Sign out
          </button>
        </div>
      </header>

    </>
  );
}
