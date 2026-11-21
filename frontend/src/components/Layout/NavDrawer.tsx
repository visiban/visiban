import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Board, User } from "../../types";
import { StatusDot } from "../Page";
import type { SidebarTreeNode } from "../../utils/groupTree";
import { buildSidebarTree } from "../../utils/groupTree";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { shouldIgnoreShortcut } from "../../utils/keyboard";
import { useNavDrawer, useShellNavData } from "../../contexts/ShellNavContext";
import { boardTone } from "./shellNavModel";
import { CloseIcon, FolderIcon, GearIcon, HomeIcon, LogoTile, ShieldIcon } from "./shellIcons";


const ROW = "flex items-center gap-2.5 min-h-9 max-sm:min-h-11 px-3 rounded-md text-sm transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
const ROW_IDLE = "text-fg-secondary hover:bg-surface-hover hover:text-fg";
const ROW_ACTIVE = "bg-surface-active text-fg font-medium";

function countBoards(node: SidebarTreeNode): number {
  return node.boards.length + node.children.reduce((n, c) => n + countBoards(c), 0);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `nav-drawer-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="py-2">
      <h2 id={id} className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-fg-tertiary">{title}</h2>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}

function SkeletonRows() {
  return (
    <div data-testid="nav-drawer-skeleton" aria-hidden="true" className="flex flex-col gap-2 px-3 py-3">
      {[0, 1, 2, 3].map((i) => <div key={i} className="h-5 rounded bg-surface animate-pulse" />)}
    </div>
  );
}

/**
 * The navigation drawer (#2473): a modal dialog opened from the header's menu
 * button or `[`, never a persistent sidebar (the owner's call, 2026-11-21,
 * reversing #106). Mounted only while open; focus moves in on open and goes
 * back to the menu button on close. The backdrop takes clicks but is hidden
 * from assistive tech; Escape and the X are the keyboard ways out.
 */
export default function NavDrawer({ user }: { user: User }) {
  const drawer = useNavDrawer();
  const { loading, groups, boards, starredBoards } = useShellNavData();
  const { pathname } = useLocation();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const open = !!drawer?.open;

  // Opened with `[` from the page body, the trap has no opener: fall back to the menu button.
  useFocusTrap(panelRef, open, () => drawer?.menuButtonRef.current ?? null);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  // Focus goes back to the menu button after the drawer (and its focus trap)
  // unmounts; focusing it before then would be pulled back into the trap.
  const refocusMenu = useRef(false);
  const close = () => {
    refocusMenu.current = true;
    drawer?.setOpen(false);
  };
  useEffect(() => {
    if (!open && refocusMenu.current) {
      refocusMenu.current = false;
      drawer?.menuButtonRef.current?.focus();
    }
  });

  // `[` toggles the drawer on every signed-in page (the shell mounts this
  // component always). Typing contexts are ignored through the same helper
  // as `?` and `g u`.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (shouldIgnoreShortcut(e.target)) return;
      e.preventDefault();
      if (drawer.open) {
        refocusMenu.current = true;
        drawer.setOpen(false);
      } else {
        drawer.setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  useEscapeStack(() => {
    if (!open) return false;
    close();
  }, 20);

  // Close on navigation: a drawer link took the user somewhere.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    drawer?.setOpen(false);
  // drawer identity changes with its open state; only the route matters here.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [pathname]);

  if (!drawer || !open) return null;

  const groupIds = new Set(groups.map((g) => g.id));
  // A board whose group the user can't see (direct board membership only) is listed as personal.
  const personalBoards = boards.filter((b) => b.group === null || !groupIds.has(b.group));
  const tree = buildSidebarTree(groups, boards);

  const boardLink = (b: Board) => {
    const href = `/boards/${b.id}`;
    const current = pathname === href;
    return (
      <li key={b.id}>
        <Link to={href} aria-current={current ? "page" : undefined} className={`${ROW} ${current ? ROW_ACTIVE : ROW_IDLE}`}>
          <StatusDot tone={boardTone(b)} />
          <span className="flex-1 truncate">{b.name}</span>
        </Link>
      </li>
    );
  };

  const groupRows = (nodes: SidebarTreeNode[], depth: number): ReactNode[] =>
    nodes.flatMap((node) => {
      const href = `/groups/${node.group.id}`;
      const current = pathname === href;
      return [
        <li key={node.group.id}>
          <Link
            to={href}
            aria-current={current ? "page" : undefined}
            className={`${ROW} ${current ? ROW_ACTIVE : ROW_IDLE}`}
            style={depth > 0 ? { paddingLeft: `${0.75 + depth * 1}rem` } : undefined}
          >
            <FolderIcon className="w-4 h-4 text-fg-tertiary" />
            <span className="flex-1 truncate">{node.group.name}</span>
            <span className="text-xs text-fg-tertiary tabular-nums">
              {countBoards(node)}<span className="sr-only"> boards</span>
            </span>
          </Link>
        </li>,
        ...groupRows(node.children, depth + 1),
      ];
    });

  return (
    <>
      <div className="fixed inset-0 z-40 bg-backdrop/60" aria-hidden="true" onClick={close} data-testid="nav-drawer-backdrop" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Main navigation"
        className="fixed inset-y-0 left-0 z-50 w-[300px] max-w-[calc(100vw-2rem)] bg-sunken border-r border-line shadow-xl flex flex-col"
      >
        <div className="flex items-center gap-2.5 h-14 px-3 border-b border-line shrink-0">
          <LogoTile />
          <span className="flex-1 text-sm font-semibold text-fg">Visiban</span>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label="Close navigation"
            title="Close navigation"
            className="inline-flex items-center justify-center w-9 h-9 max-sm:w-11 max-sm:h-11 rounded-md text-fg-tertiary hover:text-fg hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            <CloseIcon />
          </button>
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-2">
          <ul className="flex flex-col gap-0.5 pb-1">
            <li>
              <Link to="/" aria-current={pathname === "/" ? "page" : undefined} className={`${ROW} ${pathname === "/" ? ROW_ACTIVE : ROW_IDLE}`}>
                <HomeIcon className="w-4 h-4 text-fg-tertiary" />
                <span className="flex-1">Home</span>
              </Link>
            </li>
          </ul>
          {loading ? (
            <SkeletonRows />
          ) : (
            <>
              {starredBoards.length > 0 && <Section title="Starred">{starredBoards.map(boardLink)}</Section>}
              {tree.length > 0 && <Section title="Groups">{groupRows(tree, 0)}</Section>}
              {personalBoards.length > 0 && <Section title="Personal boards">{personalBoards.map(boardLink)}</Section>}
            </>
          )}
        </nav>
        <div className="border-t border-line px-2 py-2 shrink-0">
          <ul className="flex flex-col gap-0.5">
            {user.is_site_admin && (
              <li>
                <Link to="/admin" aria-current={pathname === "/admin" ? "page" : undefined} className={`${ROW} ${pathname === "/admin" ? ROW_ACTIVE : ROW_IDLE}`}>
                  <ShieldIcon className="w-4 h-4 text-fg-tertiary" />
                  <span className="flex-1">Site admin</span>
                </Link>
              </li>
            )}
            <li>
              <Link to="/settings" aria-current={pathname === "/settings" ? "page" : undefined} className={`${ROW} ${pathname === "/settings" ? ROW_ACTIVE : ROW_IDLE}`}>
                <GearIcon className="w-4 h-4 text-fg-tertiary" />
                <span className="flex-1">Settings</span>
              </Link>
            </li>
          </ul>
          <p className="px-3 pt-2 text-xs text-fg-tertiary">
            Press <kbd className="font-mono px-1 rounded border border-line-strong bg-surface">[</kbd> to toggle this drawer
          </p>
        </div>
      </div>
    </>
  );
}

