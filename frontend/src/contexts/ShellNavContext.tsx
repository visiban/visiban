import { createContext, useContext } from "react";
import type { MutableRefObject } from "react";
import type { Board, Group } from "../types";
import type { RecentBoardEntry } from "../hooks/useRecentBoardsPref";

/**
 * The app shell's navigation state (#2473). Replaces MobileNavContext (#2344).
 *
 * The shell owns the navigation drawer; the page's header (Navbar) carries the
 * menu button that opens it, so the header attaches `menuButtonRef` and the
 * drawer returns focus there on close. `registerHeader` lets the shell show a
 * bare fallback bar only while no header is mounted (a route still loading),
 * so there is always a way into the drawer.
 */
export interface NavDrawerValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  menuButtonRef: MutableRefObject<HTMLButtonElement | null>;
  /** Called by a mounted header; returns its unregister function. Stable identity. */
  registerHeader: () => () => void;
}

export const NavDrawerContext = createContext<NavDrawerValue | null>(null);

export function useNavDrawer(): NavDrawerValue | null {
  return useContext(NavDrawerContext);
}

/**
 * The boards and groups the shell loads once for the drawer and the board
 * switcher, plus this device's recent boards. One fetch serves both surfaces.
 */
export interface ShellNavData {
  loading: boolean;
  groups: Group[];
  boards: Board[];
  starredBoards: Board[];
  recentBoards: RecentBoardEntry[];
}

export const EMPTY_SHELL_NAV_DATA: ShellNavData = {
  loading: false,
  groups: [],
  boards: [],
  starredBoards: [],
  recentBoards: [],
};

export const ShellNavDataContext = createContext<ShellNavData>(EMPTY_SHELL_NAV_DATA);

export function useShellNavData(): ShellNavData {
  return useContext(ShellNavDataContext);
}
