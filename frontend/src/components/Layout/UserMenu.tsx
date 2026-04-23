import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import type { User } from "../../types";
import { userDisplayName } from "../../types";
import Avatar from "../Common/Avatar";
import { useEscapeStack } from "../../hooks/useEscapeStack";

interface Props {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLogout: () => void;
}

export default function UserMenu({ user, open, onOpenChange, onLogout }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const location = useLocation();

  const displayName = userDisplayName(user) || user.username || "Account";
  const email = user.email?.trim() || "";
  const onBoardPage = /^\/boards\/\d+/.test(location.pathname);

  // Close on Escape (dropdown priority = 25). Refocus trigger on close.
  useEscapeStack(() => {
    if (!open) return false;
    onOpenChange(false);
    triggerRef.current?.focus();
  }, 25);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onOpenChange]);

  // Focus the first item when the menu opens.
  useEffect(() => {
    if (open) {
      itemRefs.current[0]?.focus();
    }
  }, [open]);

  const focusItem = (idx: number) => {
    const items = itemRefs.current.filter(Boolean) as HTMLElement[];
    if (items.length === 0) return;
    const next = (idx + items.length) % items.length;
    items[next]?.focus();
  };

  const onItemKeyDown = (e: React.KeyboardEvent, idx: number) => {
    const count = itemRefs.current.filter(Boolean).length;
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(idx + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(idx - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(count - 1); }
    else if (e.key === "Tab") { onOpenChange(false); }
  };

  const handleOpenShortcuts = () => {
    onOpenChange(false);
    window.dispatchEvent(new CustomEvent("visiban:open-shortcuts"));
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${displayName}`}
        className="flex items-center gap-1 rounded-full p-0.5 transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-emphasis"
      >
        <Avatar user={user} size="trigger" />
        <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3 text-fg-tertiary">
          <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label="Account menu"
          className="absolute right-0 top-full mt-1 w-56 bg-surface border border-line-strong rounded-lg shadow-xl py-1 z-50"
        >
          <div className="px-3 py-2" role="none">
            <p className="text-sm font-medium text-fg truncate" title={displayName}>{displayName}</p>
            {email && (
              <p className="text-xs text-fg-muted truncate" title={email}>{email}</p>
            )}
          </div>

          <div role="separator" className="mx-4 my-1">
            <div className="h-px bg-sunken" />
            <div className="h-px bg-surface-active/50" />
          </div>

          <Link
            ref={(el) => { itemRefs.current[0] = el; }}
            to="/settings"
            role="menuitem"
            tabIndex={-1}
            onClick={() => onOpenChange(false)}
            onKeyDown={(e) => onItemKeyDown(e, 0)}
            className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover hover:text-fg transition focus:outline-none focus:bg-surface-hover focus:text-fg"
          >
            <span aria-hidden="true" className="w-4 text-center flex-shrink-0">⚙</span>
            <span className="flex-1 truncate">Profile &amp; preferences</span>
          </Link>

          <button
            ref={(el) => { itemRefs.current[1] = el; }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={!onBoardPage}
            onClick={handleOpenShortcuts}
            onKeyDown={(e) => onItemKeyDown(e, 1)}
            title={onBoardPage ? undefined : "Keyboard shortcuts are available while viewing a board"}
            className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover hover:text-fg transition focus:outline-none focus:bg-surface-hover focus:text-fg disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fg-secondary"
          >
            <span aria-hidden="true" className="w-4 text-center flex-shrink-0">⌨</span>
            <span className="flex-1 truncate">Keyboard shortcuts</span>
          </button>

          <a
            ref={(el) => { itemRefs.current[2] = el; }}
            href="https://docs.visiban.com"
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
            tabIndex={-1}
            onClick={() => onOpenChange(false)}
            onKeyDown={(e) => onItemKeyDown(e, 2)}
            className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover hover:text-fg transition focus:outline-none focus:bg-surface-hover focus:text-fg"
          >
            <span aria-hidden="true" className="w-4 text-center flex-shrink-0">❓</span>
            <span className="flex-1 truncate">Help &amp; docs</span>
          </a>

          <div role="separator" className="mx-4 my-1">
            <div className="h-px bg-sunken" />
            <div className="h-px bg-surface-active/50" />
          </div>

          <button
            ref={(el) => { itemRefs.current[3] = el; }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => { onOpenChange(false); onLogout(); }}
            onKeyDown={(e) => onItemKeyDown(e, 3)}
            className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm text-danger hover:bg-danger-bg/20 hover:text-danger transition focus:outline-none focus:bg-danger-bg/20"
          >
            <span aria-hidden="true" className="w-4 text-center flex-shrink-0">🚪</span>
            <span className="flex-1">Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}
