// Plain data and helpers shared by the app shell's pieces (#2473): the drawer,
// the board switcher and the shortcuts help. Kept out of the component files
// so those export components only.
import type { Board } from "../../types";
import type { ShellNavData } from "../../contexts/ShellNavContext";

/** A board's status as the drawer and switcher show it: the effective status, or none. */
export function boardTone(board: Pick<Board, "effective_health_status"> | undefined) {
  return board?.effective_health_status ?? "none";
}

/** Any surface (the account menu, the palette) asks for the help with this window event. */
export const OPEN_SHORTCUTS_EVENT = "visiban:open-shortcuts";
/**
 * Cancelable; the host dispatches it first. A mounted BoardView claims it
 * (preventDefault) and shows the full board list, so the off-board help never
 * opens on top of it. With no board mounted the host shows its own help.
 */
export const SHOW_BOARD_SHORTCUTS_EVENT = "visiban:show-board-shortcuts";

/** Open the keyboard shortcuts help from anywhere. */
export function openShortcutsHelp(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT));
}

export interface SwitcherOption {
  id: number;
  name: string;
  tone: ReturnType<typeof boardTone>;
  /** "<N> ago" for a Recent row; absent elsewhere or when the entry has no openedAt. */
  ago?: string;
}

export interface SwitcherSection {
  title: string;
  options: SwitcherOption[];
}

function ago(openedAt: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - openedAt) / 60000));
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * The switcher's sections (#2473): Starred, then Recent on this device, then
 * the rest of the current board's group ("Personal boards" on a personal
 * board). Each board appears once, in the first section that has it, and a
 * section left empty (after the query) is dropped.
 */
export function buildSwitcherSections(
  current: Pick<Board, "id" | "group"> & { group_name?: string | null },
  data: Pick<ShellNavData, "boards" | "starredBoards" | "recentBoards">,
  query: string,
  now: number = Date.now(),
): SwitcherSection[] {
  const q = query.trim().toLowerCase();
  const byId = new Map(data.boards.map((b) => [b.id, b]));
  const seen = new Set<number>();
  const take = (o: SwitcherOption) => {
    if (seen.has(o.id) || (q && !o.name.toLowerCase().includes(q))) return false;
    seen.add(o.id);
    return true;
  };
  const fromBoard = (b: Board): SwitcherOption => ({ id: b.id, name: b.name, tone: boardTone(byId.get(b.id) ?? b) });

  const starred = data.starredBoards.map(fromBoard).filter(take);
  // #2474 adds `openedAt` to each recents entry. Until an entry carries it,
  // the row simply omits the "<N> ago" text.
  const recent = data.recentBoards
    .map((e): SwitcherOption => ({
      id: e.id,
      name: byId.get(e.id)?.name ?? e.name,
      tone: boardTone(byId.get(e.id)),
      ago: typeof e.openedAt === "number" ? ago(e.openedAt, now) : undefined,
    }))
    .filter(take);
  const personal = current.group === null;
  const rest = data.boards
    .filter((b) => (personal ? b.group === null : b.group === current.group))
    .map(fromBoard)
    .filter(take);
  return [
    { title: "Starred", options: starred },
    { title: "Recent on this device", options: recent },
    { title: personal ? "Personal boards" : current.group_name || "This group", options: rest },
  ].filter((s) => s.options.length > 0);
}

