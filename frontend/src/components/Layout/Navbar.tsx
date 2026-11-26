import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { User, Notification } from "../../types";
import { listNotifications, getUnreadCount, markAllRead, markRead } from "../../api/notifications";
import UserMenu from "./UserMenu";
import { formatShortcut } from "../../utils/platform";
import { useNavbarSearchLabel } from "../../hooks/useNavbarSearchLabel";
import { DEMO_MARK_READ_REASON } from "../../constants/demoCopy";
import { useInstanceFlags } from "../../contexts/InstanceFlagsContext";
import { useNavDrawer } from "../../contexts/ShellNavContext";
import { shouldIgnoreGlobalShortcut } from "../../utils/keyboard";
import { LogoTile, MenuIcon, SearchIcon } from "./shellIcons";

interface BreadcrumbItem {
  label: string;
  href?: string;
  suffix?: React.ReactNode;
  render?: React.ReactNode;
}

interface Props {
  user: User;
  breadcrumb?: BreadcrumbItem[];
  /** The page has no board loaded (e.g. Unavailable on a board URL): search copy never promises cards. */
  searchBoardsOnly?: boolean;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
  /** The page's one primary action (for example New board), placed before notifications. */
  primaryAction?: React.ReactNode;
}

export default function Navbar({ user, breadcrumb, onLogout, primaryAction, searchBoardsOnly }: Props) {
  // Hosted demo (#1193): mark-read is not on DEMO_ALLOWED_WRITES.
  const demoMode = useInstanceFlags().demo_mode;
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showBell, setShowBell] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const searchLabel = useNavbarSearchLabel(searchBoardsOnly);
  // The header carries the drawer's menu button (#2473); the shell shows its
  // fallback bar only while no header is registered.
  const drawer = useNavDrawer();
  const registerHeader = drawer?.registerHeader;
  // Layout effect: the shell hides its fallback bar before the first paint, never showing two menu buttons.
  useLayoutEffect(() => registerHeader?.(), [registerHeader]);

  // Poll the unread count every 30 s. Real-time push via UserConsumer is
  // deferred to 1.1 — the polling interval is intentional until then.
  useEffect(() => {
    const fetchCount = () => getUnreadCount().then(setUnreadCount).catch(() => {});
    // fetchCount's own .catch() above already swallows the rejection, so the
    // returned promise can never reject — safe to fire without awaiting.
    void fetchCount();
    const interval = setInterval(fetchCount, 30_000);
    return () => clearInterval(interval);
  }, []);

  const openBell = async () => {
    setShowBell((v) => !v);
    if (!showBell) {
      const data = await listNotifications().catch(() => []);
      // #2081: the server marks a row read once its board is unavailable to
      // the reader, so it normally never arrives here. A row that still does
      // with `target_available: false` (a race) is hidden, with no tag. Only
      // an explicit false hides: a server older than 1.3 omits the field.
      setNotifications(data.filter((n) => n.target_available !== false));
    }
  };

  const handleMarkAll = async () => {
    if (demoMode) return;
    await markAllRead();
    setNotifications([]);
    setUnreadCount(0);
  };

  const handleClickNotification = async (n: Notification) => {
    // Hosted demo (#1193): clicking a notification is primarily a navigation
    // action — the visitor asked to see the related card, not to manage read
    // state — so the row itself stays a live link rather than becoming
    // aria-disabled, which would also block the one way into the card from
    // here. Marking it read is a background side effect of that click, not a
    // control the visitor reached for; DEMO_ALLOWED_WRITES refuses it either
    // way, so skip the request rather than let it 403 into the fallback
    // toast for something the visitor never asked to save. See the Mark all
    // read button below for the one explicit, standalone control here.
    if (!n.read && !demoMode) {
      await markRead([n.id]);
      setNotifications((prev) => prev.filter((x) => x.id !== n.id));
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    setShowBell(false);
    if (n.board_id) {
      // #863: a webhook_disabled notice opens the board's Webhooks settings.
      // The link names no subscription; the tab focuses the first Stopped row.
      const url = n.action_type === "webhook_disabled"
        ? `/boards/${n.board_id}?settings=webhooks`
        : n.card_id
          // Only a mention recorded as coming from a comment opens the Comments tab (#2203).
          // A description mention, or one from before the source was recorded, stays on the
          // default tab. Same rule as the email link (notifications_email.card_link).
          ? `/boards/${n.board_id}?card=${n.card_id}${
              n.action_type === "mentioned" && n.mention_source === "comment" ? "&tab=comments" : ""
            }`
          : `/boards/${n.board_id}`;
      // Fire-and-forget: the declarative router resolves navigate() synchronously,
      // and any failure is handled by its own error boundary.
      void navigate(url);
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
  // `g` primes the chord for 1 s; `u` commits. Typing contexts are ignored by
  // the same helper as `[` and `?` (#2473).
  useEffect(() => {
    let primedAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (shouldIgnoreGlobalShortcut(e.target)) return;
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

  const crumbs: BreadcrumbItem[] = breadcrumb && breadcrumb.length > 0
    ? [{ label: "Home", href: "/" }, ...breadcrumb]
    : [{ label: "Home" }];

  return (
    <>
      <header role="banner" className="h-14 max-sm:h-12 max-sm:relative bg-sunken border-b border-line flex items-center px-4 max-sm:px-1 gap-3 max-sm:gap-1 shrink-0">
        {/* Menu button (#2473): opens the navigation drawer; replaces the old home logo link.
            Home is reached from the breadcrumb root and the drawer. */}
        {drawer && (
          <button
            ref={drawer.menuButtonRef}
            type="button"
            onClick={drawer.toggle}
            aria-label="Open navigation"
            aria-expanded={drawer.open}
            aria-keyshortcuts="["
            title="Menu  ["
            className="inline-flex items-center gap-1.5 h-9 max-sm:h-11 max-sm:min-w-11 px-1.5 shrink-0 rounded-md border border-line-strong max-sm:border-transparent text-fg-tertiary hover:text-fg hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis justify-center"
          >
            <MenuIcon />
            <LogoTile className="w-[26px] h-[26px] max-sm:hidden" />
          </button>
        )}
        <nav aria-label="Breadcrumb" className="flex items-center min-w-0 max-sm:flex-1">
          {crumbs.map((item, i) => {
            const isLast = i === crumbs.length - 1;
            // Phones show only the last crumb, so its star and health controls always fit
            // beside it and the name, not the controls, gives way (#2333). No clip on the nav:
            // it would cut the focus rings off every crumb control.
            const body = item.render ? (
              item.render
            ) : item.href && !isLast ? (
              <Link
                to={item.href}
                className="text-sm text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded transition max-w-[12rem] truncate max-sm:inline-block max-sm:leading-[2.75rem]"
                title={item.label}
              >
                {item.label}
              </Link>
            ) : (
              <span
                className="text-sm text-fg font-semibold max-w-[18rem] truncate block"
                title={item.label}
                aria-current={isLast ? "page" : undefined}
              >
                {item.label}
              </span>
            );
            return (
              <span key={i} className={`flex items-center min-w-0${isLast ? "" : " max-sm:hidden"}`}>
                {i > 0 && <span className="text-fg-faint mx-1.5 select-none max-sm:hidden" aria-hidden="true">/</span>}
                {/* The last crumb is the page's only h1 (#2473). */}
                {isLast ? <h1 className="min-w-0 flex items-center text-sm">{body}</h1> : body}
                {item.suffix && <span className="flex items-center max-sm:shrink-0">{item.suffix}</span>}
              </span>
            );
          })}
        </nav>
        <div className="flex-1 flex justify-center min-w-0 max-sm:flex-none">
          {/* Global search entry (#852, #869). Dispatches visiban:open-palette
              which GlobalCommandPalette at the shell / board-page level
              listens for. The placeholder adapts per surface (see
              useNavbarSearchLabel) so the copy matches what the palette can
              actually do there. */}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("visiban:open-palette"))}
            aria-label={searchLabel.ariaLabel}
            title={searchLabel.title}
            className="flex items-center gap-2 px-3 text-sm text-fg-tertiary bg-surface border border-line-strong hover:border-line-emphasis rounded-md transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis h-[38px] w-full max-w-md justify-between max-sm:w-11 max-sm:h-11 max-sm:px-0 max-sm:justify-center max-sm:border-transparent max-sm:bg-transparent"
          >
            <span className="flex items-center gap-2 min-w-0">
              <SearchIcon />
              <span className="max-sm:hidden truncate">{searchLabel.placeholder}</span>
            </span>
            {/* The space keeps the placeholder and shortcut as separate words in the button's text, which the aria-label must contain (#2467). */}
            {" "}
            <kbd aria-hidden="true" className="max-sm:hidden text-xs font-mono px-1.5 rounded border border-line-strong bg-sunken text-fg-muted">{formatShortcut({ mod: true, key: "K" })}</kbd>
          </button>
        </div>
        <div className="flex items-center gap-3 max-sm:gap-0 shrink-0">
          {primaryAction}

          {/* Notification bell */}
          <div ref={bellRef} className="relative max-sm:static">
            <button
              type="button"
              onClick={openBell}
              className="relative text-fg-secondary hover:text-fg transition p-1 max-sm:inline-flex max-sm:items-center max-sm:justify-center max-sm:min-h-11 max-sm:min-w-11 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
              aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
              title={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M10 2a6 6 0 00-6 6v3l-1.293 1.293A1 1 0 003 14h14a1 1 0 00.707-1.707L16 11V8a6 6 0 00-6-6zM8 17a2 2 0 004 0H8z" />
              </svg>
              {unreadCount > 0 && (
                <span aria-hidden="true" className="absolute -top-1 -right-1 bg-danger-emphasis text-on-danger text-xs font-bold rounded-full min-w-[18px] h-[18px] px-0.5 flex items-center justify-center">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>
            {/* Phones (#2333): anchored to the header, not the bell, so the panel spans the
                header's width minus 1rem each side and opens just below it, whatever sits above. */}
            {showBell && (
              <div className="absolute right-0 top-8 w-80 max-sm:top-full max-sm:mt-1 max-sm:inset-x-4 max-sm:w-auto bg-surface rounded-lg shadow-xl border border-line-strong z-50">
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-xs font-semibold text-fg-secondary">Notifications</span>
                  {/* Hosted demo (#1193): mark-read is refused by the server
                      fence; sub-pattern (B) — a compact panel-header button,
                      reason folded into title + aria-label. */}
                  <button
                    onClick={handleMarkAll}
                    aria-disabled={demoMode ? true : undefined}
                    aria-label={demoMode ? `Mark all read. ${DEMO_MARK_READ_REASON}` : undefined}
                    title={demoMode ? `Mark all read. ${DEMO_MARK_READ_REASON}` : undefined}
                    className={`text-xs max-sm:min-h-11 max-sm:px-2 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded ${
                      demoMode ? "text-fg-muted opacity-40 cursor-not-allowed" : "text-info hover:text-info"
                    }`}
                  >
                    Mark all read
                  </button>
                </div>
                <div role="separator" className="mx-4">
                  <div className="h-px bg-sunken" />
                  <div className="h-px bg-surface-active/50" />
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {notifications.length === 0 && (
                    <p className="text-xs text-fg-tertiary text-center py-6">No notifications</p>
                  )}
                  {notifications.map((n, i) => (
                    <React.Fragment key={n.id}>
                    {i > 0 && (
                      <div role="separator" className="mx-4">
                        <div className="h-px bg-sunken" />
                        <div className="h-px bg-surface-active/50" />
                      </div>
                    )}
                    <button
                      onClick={() => handleClickNotification(n)}
                      className="w-full max-sm:min-h-11 text-left px-3 py-2.5 hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-inset"
                    >
                      <p className="text-xs text-fg leading-snug">{n.verb}</p>
                      <p className="text-xs text-fg-tertiary mt-0.5">{relativeTime(n.created_at)}</p>
                      {n.board_id && !n.card_id && (
                        <p className="text-xs text-info mt-0.5">
                          {n.action_type === "webhook_disabled" ? "Open board settings →" : "View board →"}
                        </p>
                      )}
                    </button>
                    </React.Fragment>
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
