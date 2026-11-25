import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { User } from "../../types";
import { userDisplayName } from "../../types";
import Avatar from "../Common/Avatar";
import { avatarVisibleText } from "../Common/avatarText";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { MENU_ITEM_FOCUS_RING } from "../Common/menuItemFocusRing";
import { useTheme } from "../../context/ThemeContext";
import type { ThemePreference } from "../../context/ThemeContext";
import { docsUrl } from "../../help/docsUrl";
import { openShortcutsHelp } from "./shellNavModel";
import { ExternalIcon, GearIcon, HelpIcon, KeyboardIcon, MonitorIcon, MoonIcon, ShieldIcon, SignOutIcon, SunIcon } from "./shellIcons";

interface Props {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLogout: () => void;
}

const ITEM = `w-full flex items-center gap-2.5 text-left px-3 min-h-10 max-sm:min-h-11 text-sm text-fg-secondary hover:bg-surface-hover hover:text-fg transition focus:bg-surface-hover focus:text-fg ${MENU_ITEM_FOCUS_RING}`;

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  { value: "dark", label: "Dark", icon: <MoonIcon /> },
  { value: "light", label: "Light", icon: <SunIcon /> },
  { value: "system", label: "System", icon: <MonitorIcon /> },
];

function Separator() {
  return (
    <div role="separator" className="mx-4 my-1">
      <div className="h-px bg-sunken" />
      <div className="h-px bg-surface-active/50" />
    </div>
  );
}

/**
 * The account menu (#2473). Roving focus over every item (the three theme
 * buttons included), Escape closes and refocuses the trigger. The theme
 * buttons write the same preference as Settings › Appearance; ThemeServerSync
 * saves it to the server.
 */
export default function UserMenu({ user, open, onOpenChange, onLogout }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const { preference, setPreference } = useTheme();

  const displayName = userDisplayName(user) || user.username || "Account";
  const email = user.email?.trim() || "";
  const isAdmin = !!user.is_site_admin;

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
    // #1775: the focused item unmounts with the menu, and the overlay it opens
    // would capture that item as its focus opener. Hand focus to the
    // surviving trigger before the event so the overlay restores to it.
    triggerRef.current?.focus({ preventScroll: true });
    onOpenChange(false);
    openShortcutsHelp();
  };

  // Item indexes follow the visual order so roving focus does too.
  const at = isAdmin ? 1 : 0;
  const IDX = { settings: 0, admin: 1, shortcuts: 1 + at, help: 2 + at, theme: 3 + at, signOut: 6 + at };
  const item = (idx: number) => {
    return {
      ref: (el: HTMLElement | null) => { itemRefs.current[idx] = el; },
      tabIndex: -1,
      onKeyDown: (e: React.KeyboardEvent) => onItemKeyDown(e, idx),
    };
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${avatarVisibleText(user) ? `${avatarVisibleText(user)}, ` : ""}Account menu for ${displayName}`}
        className="flex items-center justify-center rounded-full p-0.5 max-sm:min-h-11 max-sm:min-w-11 transition hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >
        <Avatar user={user} size="trigger" />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label="Account menu"
          className="absolute right-0 top-full mt-1 w-64 bg-surface border border-line-strong rounded-lg shadow-xl py-1 z-50"
        >
          <div className="flex items-center gap-2.5 px-3 py-2" role="none">
            <Avatar user={user} size="md" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg truncate" title={displayName}>{displayName}</p>
              {email && <p className="text-xs text-fg-muted truncate" title={email}>{email}</p>}
            </div>
            {isAdmin && (
              <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium bg-primary-emphasis/10 text-info-on-tint">Site admin</span>
            )}
          </div>

          <Separator />

          <Link {...item(IDX.settings)} to="/settings" role="menuitem" onClick={() => onOpenChange(false)} className={ITEM}>
            <GearIcon />
            <span className="flex-1 truncate">Profile &amp; settings</span>
          </Link>

          {isAdmin && (
            <Link {...item(IDX.admin)} to="/admin" role="menuitem" onClick={() => onOpenChange(false)} className={ITEM}>
              <ShieldIcon />
              <span className="flex-1 truncate">Site admin</span>
            </Link>
          )}

          <button {...item(IDX.shortcuts)} type="button" role="menuitem" onClick={handleOpenShortcuts} aria-keyshortcuts="?" className={ITEM}>
            <KeyboardIcon />
            <span className="flex-1 truncate">Keyboard shortcuts</span>
            <kbd aria-hidden="true" className="text-xs font-mono px-1.5 rounded border border-line-strong bg-sunken text-fg-tertiary">?</kbd>
          </button>

          <a
            {...item(IDX.help)}
            href={docsUrl("home")}
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
            onClick={() => onOpenChange(false)}
            className={ITEM}
          >
            <HelpIcon />
            <span className="flex-1 truncate">Help &amp; docs<span className="sr-only"> (opens in a new tab)</span></span>
            <ExternalIcon className="w-3.5 h-3.5 text-fg-tertiary" />
          </a>

          <div role="group" aria-label="Theme" className="flex items-center gap-2 px-3 min-h-10 max-sm:min-h-11">
            <span aria-hidden="true" className="flex-1 text-sm text-fg-secondary">Theme</span>
            {THEME_OPTIONS.map((t, ti) => (
              <button
                key={t.value}
                {...item(IDX.theme + ti)}
                type="button"
                role="menuitemradio"
                aria-checked={preference === t.value}
                aria-label={t.label}
                title={t.label}
                onClick={() => setPreference(t.value)}
                className={`inline-flex items-center justify-center w-10 h-10 max-sm:w-11 max-sm:h-11 rounded-md transition ${MENU_ITEM_FOCUS_RING} ${
                  preference === t.value
                    ? "bg-surface-active text-fg ring-1 ring-inset ring-line-emphasis"
                    : "text-fg-tertiary hover:bg-surface-hover hover:text-fg"
                }`}
              >
                {t.icon}
              </button>
            ))}
          </div>

          <Separator />

          <button {...item(IDX.signOut)} type="button" role="menuitem" onClick={() => { onOpenChange(false); onLogout(); }} className={ITEM}>
            <SignOutIcon />
            <span className="flex-1">Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}
