import axios from "axios";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getChildrenView, moveCard } from "../../api/cards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { CardChildrenColumn, ChildrenView, ChildrenViewBoard, ChildrenViewChild, ChildrenViewLane, ChildrenViewRow } from "../../types";
import {
  CHILDREN_MODE_ESCAPE_PRIORITY, LARGE_LANE_PARENTS, blockedDays, cellName, changesPillText, childBoardSwitchLabel, childBoardSwitchName, childCardName, columnOverLimit, compactRowLabel, foldLabel,
  columnHeadCaption, columnMeterPct, holdRowOrder, isFoldedRow, laneBandName, laneBlockedLabel, laneLink, laneSubtitle, laneTotalLabel, lockedRowText, moreParentsLabel,
  parentsLabel, pendingRowChanges, isBlockedColumnName, phoneBlockedColumnNote, phoneColumnCount, phoneEmptyCellText, rowDoneLabel, shownInProgress, visibleChildren, type ChildrenModeOptions,
} from "../../utils/childrenMode";
import { columnTintStyle } from "../../utils/colorContrast";
import { ChildMovePopover } from "../Card/CardChildrenTab";
import { WRITE_ROLES, moveTargetState } from "../Card/cardChildren";
import Avatar from "../Common/Avatar";
import OverflowMenu from "../Layout/OverflowMenu";

/**
 * Children mode on the Board tab (#2370, planned sections #2550; canvas 6a/6b/7/8 §3): one row per parent, grouped
 * under its lane, with the parent's children in their real columns on the child board. Every count is the server's
 * per-viewer count; a locked row is a count only. A child moves only through the Move picker (column change only,
 * MEMBER+ on the child board, no drag), and a live re-read never re-sorts rows under focus (item 9).
 */

interface Props {
  boardId: number;
  /** `?lane=`: that lane expanded and the others collapsed; null for every lane. */
  laneId: number | null;
  options: ChildrenModeOptions;
  onOptionsChange: (next: ChildrenModeOptions) => void;
  /** Opens the parent's sheet on this board. */
  onOpenParent: (parentId: number) => void;
  /** Bumped by the host on a board change, to re-read in place. */
  refreshKey?: number;
  /**
   * Below the phone breakpoint (#2370 item 12, canvas 6b / 2f g): two-line tinted bands, one child board per lane and
   * one of its columns at a time (the phone board's column buttons), parent names as headings inside the column.
   */
  phone?: boolean;
  /** Lane id → lane color, for the phone band tint (`columnTintStyle`, as `PhoneBoard`'s bands). */
  laneColors?: Readonly<Record<number, string>>;
  /** This (parent) board's name, for the child-board heading "Parent · column on {board}". */
  boardName?: string;
  /** Focus (everyone): show only that lane (`?lane=`), or every lane on null. */
  onFocusLane?: (laneId: number | null) => void;
  /** Admin ⋮ "Edit swimlane…"; absent for a non-admin, which hides the menu. */
  onEditLane?: (laneId: number) => void;
  /** Admin ⋮ "Change field order…", when the board has lane fields to order. */
  onEditFieldOrder?: () => void;
  /** For the Move picker's assignee override and planned-date "today" (item 11). */
  currentUserId?: number | null;
  userTimezone?: string;
}

// 44px on phone and under a coarse pointer at any width; 32px only for a fine pointer from `sm` up (#2370 ruling).
const tgt = "min-h-11 sm:[@media(pointer:fine)]:min-h-8";
const FOCUS = "focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

function LaneBar({ lane }: { lane: Pick<ChildrenViewLane, "done" | "doing" | "blocked" | "todo" | "total"> }) {
  if (lane.total === 0) return null;
  const seg = (n: number, cls: string, pattern?: string) =>
    n > 0 ? <span className={`block h-full ${cls}`} style={{ width: `${(n / lane.total) * 100}%`, ...(pattern ? { backgroundImage: pattern } : {}) }} /> : null;
  return (
    <span aria-hidden="true" className="flex h-1.5 w-32 overflow-hidden rounded bg-surface-active">
      {seg(lane.done, "bg-success")}
      {seg(lane.doing, "bg-primary")}
      {seg(lane.blocked, "bg-danger", "repeating-linear-gradient(45deg, transparent 0 3px, rgb(0 0 0 / 0.3) 3px 5px)")}
      {seg(lane.todo, "bg-fg-tertiary")}
    </span>
  );
}

interface Stop { r: number; c: number; i: number; key: string }

/** A value that changes at most once per `ms` (the first change and a clear show at once): the live pill's text. */
function useThrottledValue<T>(value: T, ms: number, immediate: (v: T) => boolean): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = last.current + ms - Date.now();
    if (wait <= 0 || immediate(value)) {
      if (!immediate(value)) last.current = Date.now();
      setShown(value);
      return;
    }
    const t = setTimeout(() => { last.current = Date.now(); setShown(value); }, wait);
    return () => clearTimeout(t);
  }, [value, shown, ms, immediate]);
  return shown;
}

const isZero = (n: number) => n === 0;

/** "3 changes in Acme Corp · Show" (#2370 item 9): `role="status"`, polite, its text changing at most once per 10s. */
function ChangesPill({ count, laneName, phone, onShow }: { count: number; laneName: string; phone: boolean; onShow: () => void }) {
  const shown = useThrottledValue(count, 10_000, isZero);
  return (
    <div role="status" aria-live="polite" className={shown > 0 ? "px-3 pt-2" : "sr-only"}>
      {shown > 0 && (
        <button type="button" data-changes-pill onClick={onShow} className={`${FOCUS} ${tgt} px-3 rounded-full border border-info text-sm text-fg bg-surface hover:bg-surface-hover`}>
          {changesPillText(shown, laneName, phone)} · <span className="text-link">Show</span>
        </button>
      )}
    </div>
  );
}

// Inline SVG on currentColor, never an emoji: it tracks the theme (frontend/CLAUDE.md § Swimlane bands).
const LockIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="inline-block w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="7" width="10" height="7" rx="1" />
    <path d="M5 7V5a3 3 0 0 1 6 0v2" />
  </svg>
);

export default function ChildrenModeView({ boardId, laneId: laneProp, options, onOptionsChange, onOpenParent, refreshKey = 0, phone = false, laneColors, boardName = "this board", onFocusLane, onEditLane, onEditFieldOrder, currentUserId = null, userTimezone = "" }: Props) {
  // A lane the server no longer finds (deleted since the board loaded) is treated as no lane: Children mode
  // renders with the default expansion, never an error, and a missing lane reads the same as a hidden one (#2370 item 1).
  const [goneLane, setGoneLane] = useState<number | null>(null);
  const laneId = laneProp != null && laneProp === goneLane ? null : laneProp;
  const [data, setData] = useState<ChildrenView | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [foldOpen, setFoldOpen] = useState<Set<number>>(new Set());
  const [plannedOpen, setPlannedOpen] = useState<Set<number>>(new Set());
  const [rowOpen, setRowOpen] = useState<Map<number, boolean>>(new Map());
  const [active, setActive] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string>("");
  const [copiedLane, setCopiedLane] = useState<number | null>(null);
  const [moreError, setMoreError] = useState(false);
  const [retry, setRetry] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const laneParamRef = useRef(laneId);
  // The user's own collapse choices survive a re-read; a new ?lane= resets them.
  const collapseTouched = useRef(false);
  // A read generation: a "load more" page from an older read (lane or Show done changed) is dropped.
  const generation = useRef(0);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  // Live updates (item 9): the server's fresh read whose row order waits while focus is in a grid.
  const [held, setHeld] = useState<ChildrenView | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const dataRef = useRef<ChildrenView | null>(null);
  dataRef.current = data;
  const queryRef = useRef("");
  // Where focus sits in a grid (a child card, or a row's other stops), and what to put it back on after a re-read.
  const gridFocus = useRef<{ childId: number | null; rowId: number; title: string } | null>(null);
  const restoreFocus = useRef<{ childId: number | null; rowId: number; title: string } | null>(null);
  const focusLaneGrid = useRef<number | null>(null);
  // Bumped by the pill: its own blur may already have applied the order, so a data change alone can't place focus.
  const [focusTick, setFocusTick] = useState(0);
  const [moving, setMoving] = useState<{ child: ChildrenViewChild; rowId: number; board: ChildrenViewBoard } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  // Phone only: the child board shown per lane (lane id → board id) and the column shown per section (grid key → column id).
  const [phoneBoard, setPhoneBoard] = useState<Record<number, number>>({});
  const [phoneCol, setPhoneCol] = useState<Record<string, number>>({});

  useEffect(() => {
    const ctrl = new AbortController();
    generation.current += 1;
    setError(false);
    setMoreError(false);
    const query = `${boardId}|${laneId}|${options.showDone}`;
    // A re-read of the same query (a board event, a Move) is live: it updates in place.
    const live = queryRef.current === query && dataRef.current != null;
    // A live re-read keeps every page "Load more" added (frontend/CLAUDE.md): it follows next_cursor until it covers
    // as many rows as are on screen, so a board event never shrinks the view to page 1 or drops a focused card.
    const loaded = live ? dataRef.current!.rows.length : 0;
    const readAll = async () => {
      let d = await getChildrenView(boardId, { lane: laneId, done: options.showDone }, ctrl.signal);
      while (d.next_cursor && d.rows.length < loaded) {
        const next = await getChildrenView(boardId, { lane: laneId, cursor: d.next_cursor, done: options.showDone }, ctrl.signal);
        d = {
          ...next,
          rows: [...d.rows, ...next.rows],
          child_boards: [...d.child_boards, ...next.child_boards.filter((b) => !d.child_boards.some((x) => x.id === b.id))],
        };
      }
      return d;
    };
    readAll()
      .then((d) => {
        queryRef.current = query;
        const el = document.activeElement as HTMLElement | null;
        const inGrid = !!el && !!rootRef.current?.contains(el) && !!el.closest("[data-children-grid]");
        if (live && inGrid && dataRef.current) {
          // Rows never re-sort under focus: the fresh read keeps the order on screen until the pill or a blur applies it.
          const kept = holdRowOrder(dataRef.current.rows, d.rows);
          setData({ ...d, rows: kept });
          setHeld(kept.some((r, i) => r.id !== d.rows[i]?.id) ? d : null);
          if (gridFocus.current) restoreFocus.current = { ...gridFocus.current };
        } else {
          setData(d);
          setHeld(null);
        }
        if (laneParamRef.current !== laneId) collapseTouched.current = false;
        if (!collapseTouched.current) {
          laneParamRef.current = laneId;
          // A linked lane opens expanded with the others collapsed.
          setCollapsed(new Set(laneId == null ? [] : d.lanes.filter((l) => l.id !== laneId).map((l) => l.id)));
        }
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e as { name?: string })?.name === "CanceledError") return;
        if (laneId != null && (e as { response?: { status?: number } })?.response?.status === 404) { setGoneLane(laneId); return; }
        setError(true);
      });
    return () => ctrl.abort();
  }, [boardId, laneId, options.showDone, refreshKey, retry, reloadTick]);

  // A focused card that moves keeps focus in its new cell; one that leaves the view hands focus to its row's
  // parent cell, announced. Layout effect, so focus lands before paint (frontend/CLAUDE.md focus restore).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const lane = focusLaneGrid.current;
    if (lane != null) {
      focusLaneGrid.current = null;
      (root.querySelector<HTMLElement>(`[data-children-grid="${lane}"] [tabindex="0"]`) ?? root.querySelector<HTMLElement>(`[data-lane-toggle="${lane}"]`))?.focus();
      return;
    }
    const want = restoreFocus.current;
    if (!want) return;
    restoreFocus.current = null;
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body && root.contains(el)) return;
    const card = want.childId != null ? root.querySelector<HTMLElement>(`[data-child-card="${want.childId}"]`) : null;
    if (card) { card.focus(); return; }
    root.querySelector<HTMLElement>(`[data-parent-row="${want.rowId}"]`)?.focus();
    if (want.childId != null) setCopied(`${want.title} left this view.`);
  }, [data, focusTick]);

  const applyHeld = useCallback(() => {
    setHeld((h) => {
      if (h) setData((d) => d && { ...d, rows: h.rows });
      return null;
    });
  }, []);

  const loadMore = useCallback(async () => {
    if (!data?.next_cursor) return;
    setLoadingMore(true);
    setMoreError(false);
    const gen = generation.current;
    try {
      const next = await getChildrenView(boardId, { lane: laneId, cursor: data.next_cursor, done: options.showDone });
      if (gen !== generation.current) return;
      setData((d) => d && {
        ...next,
        rows: [...d.rows, ...next.rows],
        child_boards: [...d.child_boards, ...next.child_boards.filter((b) => !d.child_boards.some((x) => x.id === b.id))],
      });
    } catch {
      if (gen === generation.current) setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [boardId, laneId, data, options.showDone]);

  // Escape leaves the grid (board tier, below the View menu's 25): focus goes to the lane's collapse button.
  useEscapeStack(() => {
    const el = document.activeElement as HTMLElement | null;
    const grid = el?.closest<HTMLElement>("[data-children-grid]");
    if (!grid || !rootRef.current?.contains(grid)) return false;
    rootRef.current.querySelector<HTMLElement>(`[data-lane-toggle="${grid.dataset.childrenGrid}"]`)?.focus();
    return true;
  }, CHILDREN_MODE_ESCAPE_PRIORITY);

  const boards = useMemo(() => new Map((data?.child_boards ?? []).map((b) => [b.id, b])), [data]);

  if (error && !data) {
    return (
      <div role="alert" className="p-4 text-sm text-danger flex items-center gap-3">
        Children didn&apos;t load.
        <button type="button" onClick={() => setRetry((n) => n + 1)} className={`${FOCUS} ${tgt} px-3 rounded border border-line-strong text-fg hover:bg-surface-hover`}>Try again</button>
      </div>
    );
  }
  if (!data) {
    return <div role="status" aria-label="Loading children" className="p-4 text-sm text-fg-secondary">Loading children…</div>;
  }

  const focusChildCard = (id: number) => queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>(`[data-child-card="${id}"]`)?.focus());
  const closeMove = () => {
    const id = moving?.child.id;
    setMoving(null);
    setMoveError(null);
    if (id != null) focusChildCard(id);
  };
  // Column change only, through the child board's move endpoint with that board's role, limits and reasons (item 11).
  const doMove = async (col: CardChildrenColumn, reason?: string) => {
    if (!moving) return;
    const { child, rowId, board } = moving;
    setMoveError(null);
    try {
      const target = moveTargetState(col, board, { userId: currentUserId, child });
      await moveCard(board.id, child.id, { column_id: col.id, swimlane_id: child.swimlane_id, position: col.card_count, ...(reason ? { override_reason: reason } : {}) }, target.force);
      setCopied(`${child.title} moved to ${col.name}.`);
      restoreFocus.current = { childId: child.id, rowId, title: child.title };
      setMoving(null);
      focusChildCard(child.id);
      setReloadTick((n) => n + 1);
    } catch (err) {
      const detail = axios.isAxiosError(err) ? (err.response?.data as { detail?: unknown } | undefined)?.detail : undefined;
      setMoveError(typeof detail === "string" ? detail : `Couldn't move ${child.title}. Try again.`);
    }
  };

  const copyLink = async (lane: ChildrenViewLane) => {
    try {
      await navigator.clipboard.writeText(laneLink(window.location.origin, boardId, lane.id));
      setCopied(`Link to ${lane.name} copied`);
      setCopiedLane(lane.id);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedLane(null), 2000);
    } catch {
      setCopied("Couldn't copy the link");
    }
  };
  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };

  const lanes = laneId == null ? data.lanes : data.lanes.filter((l) => l.id === laneId);
  const loadedPerLane = new Map<number, number>();
  data.rows.forEach((r) => loadedPerLane.set(r.swimlane_id, (loadedPerLane.get(r.swimlane_id) ?? 0) + 1));
  const lastLaneWithRows = data.rows.length ? data.rows[data.rows.length - 1].swimlane_id : null;

  const renderChild = (child: ChildrenViewChild, colName: string, stop: Stop, gridKey: string, focusProps: (s: Stop) => object, row: ChildrenViewRow, board: ChildrenViewBoard) => {
    const days = blockedDays(child);
    // Move renders only for MEMBER+ on the child board, and lives inside the card's roving stop (Right reaches it).
    const canMove = WRITE_ROLES.has(board.role);
    return (
      <div key={child.id} className="flex items-start gap-1">
      <a
        href={`/boards/${row.child_board_id}?card=${child.id}&from_parent=${row.id}`}
        aria-label={childCardName(child, colName)}
        {...focusProps(stop)}
        data-grid={gridKey}
        data-child-card={child.id}
        className={`${FOCUS} ${tgt} block flex-1 min-w-0 rounded border bg-surface px-2 py-1 text-xs text-fg hover:bg-surface-hover ${child.planned ? "border-dashed border-line-strong" : "border-line"}`}
      >
        <span className="block font-medium leading-snug">{child.title}</span>
        <span className="mt-0.5 flex items-center gap-1 text-fg-secondary">
          {child.assignee && <Avatar user={child.assignee} size="sm" />}
          {child.planned && <span>Planned</span>}
          {child.blocked && <span className="text-danger font-medium"><span aria-hidden="true">⊘</span>{days != null ? ` ${days}d` : " Blocked"}</span>}
        </span>
      </a>
      {canMove && (
        <button
          type="button"
          tabIndex={-1}
          data-move-for={stop.key}
          aria-label={`Move ${child.title}`}
          onClick={() => { setMoveError(null); setMoving({ child, rowId: row.id, board }); }}
          className={`${FOCUS} ${tgt} min-w-11 sm:[@media(pointer:fine)]:min-w-8 px-1 text-xs text-fg-secondary rounded hover:bg-surface-hover hover:text-fg`}
        >
          Move
        </button>
      )}
      </div>
    );
  };

  const renderSection = (lane: ChildrenViewLane, board: ChildrenViewBoard, rows: ChildrenViewRow[], maxCols: number, large: boolean) => {
    const gridKey = `${lane.id}-${board.id}`;
    const allCols = board.columns;
    const firstColId = allCols[0]?.id;
    // Phone (#2370 item 12): one child-board column at a time, chosen with the column buttons; the first open
    // column until the viewer picks one (the planned fold lives in the first column).
    const phoneColumn = phone ? (allCols.find((c) => c.id === phoneCol[gridKey]) ?? allCols.find((c) => !c.is_done) ?? allCols[0]) : undefined;
    const cols = phone ? (phoneColumn ? [phoneColumn] : []) : allCols;
    // The roving stops in reading order: each row's parent cell, then each column's cards (or the cell).
    const stops: Stop[] = [];
    const cellsByRow = rows.map((row, r) => {
      const open = !large || (rowOpen.get(row.id) ?? (row.rollup.visible && row.rollup.blocked > 0));
      stops.push({ r, c: 0, i: 0, key: `${gridKey}:${r}:0:0` });
      if (!open) return { row, open, cells: [] as { col: typeof cols[number]; kids: ChildrenViewChild[]; planned: ChildrenViewChild[] }[] };
      const shown = visibleChildren(row.children, options);
      const cells = cols.map((col, ci) => {
        const inCol = shown.filter((k) => k.column_id === col.id);
        const planned = col.id === firstColId && options.planned === "any" && !plannedOpen.has(row.id) ? inCol.filter((k) => k.planned) : [];
        const plannedSet = new Set(planned);
        const kids = inCol.filter((k) => !plannedSet.has(k));
        const n = Math.max(1, kids.length + (planned.length ? 1 : 0));
        for (let i = 0; i < n; i++) stops.push({ r, c: ci + 1, i, key: `${gridKey}:${r}:${ci + 1}:${i}` });
        return { col, kids, planned };
      });
      return { row, open, cells };
    });
    const activeKey = active[gridKey] && stops.some((s) => s.key === active[gridKey]) ? active[gridKey] : stops[0]?.key;
    const focusProps = (s: Stop) => ({
      "data-stop": s.key,
      tabIndex: s.key === activeKey ? 0 : -1,
      onFocus: () => setActive((a) => ({ ...a, [gridKey]: s.key })),
    });
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement;
      const moveFor = t.dataset.moveFor;
      // A card's Move button is inside its stop: Right from the card reaches it, Left goes back; every other key
      // acts from the button as from its card.
      if (moveFor && e.key === "ArrowLeft") {
        e.preventDefault();
        e.currentTarget.querySelector<HTMLElement>(`[data-stop="${moveFor}"]`)?.focus();
        return;
      }
      if (!moveFor && e.key === "ArrowRight" && t.dataset.stop) {
        const btn = e.currentTarget.querySelector<HTMLElement>(`[data-move-for="${t.dataset.stop}"]`);
        if (btn) { e.preventDefault(); btn.focus(); return; }
      }
      const key = moveFor ?? t.dataset.stop;
      const cur = stops.find((s) => s.key === key);
      if (!cur) return;
      let next: Stop | undefined;
      // Phone: one column stacked under each parent heading, so Up and Down follow reading order.
      if (phone && (e.key === "ArrowDown" || e.key === "ArrowUp")) next = stops[stops.indexOf(cur) + (e.key === "ArrowDown" ? 1 : -1)];
      else if (e.key === "ArrowDown") next = stops.find((s) => s.c === cur.c && (s.r > cur.r || (s.r === cur.r && s.i > cur.i)));
      else if (e.key === "ArrowUp") next = [...stops].reverse().find((s) => s.c === cur.c && (s.r < cur.r || (s.r === cur.r && s.i < cur.i)));
      else if (e.key === "ArrowRight") next = stops.find((s) => s.r === cur.r && s.c > cur.c);
      else if (e.key === "ArrowLeft") next = [...stops].reverse().find((s) => s.r === cur.r && s.c < cur.c);
      // Home/End: the row's first cell (the parent) and last stop; with Ctrl, the grid's first and last (#2370 item 10).
      else if (e.key === "Home") next = e.ctrlKey ? stops[0] : stops.find((s) => s.r === cur.r);
      else if (e.key === "End") next = e.ctrlKey ? stops[stops.length - 1] : [...stops].reverse().find((s) => s.r === cur.r);
      else return;
      e.preventDefault();
      if (!next) return;
      setActive((a) => ({ ...a, [gridKey]: next!.key }));
      e.currentTarget.querySelector<HTMLElement>(`[data-stop="${next.key}"]`)?.focus();
    };
    const template = `minmax(14rem, 18rem) repeat(${maxCols}, 12rem)`; // fixed tracks: the header and body grids stay aligned
    // Whole-column counts and the limit meter are the child board's own (artboard 6a); the phone draws the shown column's.
    const columnHead = (col: CardChildrenColumn) => {
      const pct = columnMeterPct(col);
      const shownHere = rows.reduce((n, r) => n + r.children.filter((k) => k.column_id === col.id).length, 0);
      return (
        <>
          {/* Past the limit: warning tone and the word "over", never danger (the board's column-head rule). */}
          <span className={columnOverLimit(col) ? "text-warning font-semibold" : "text-fg-secondary"}>{columnHeadCaption(col, shownHere, board.name, options.showDone)}</span>
          {pct != null && !col.is_done && (
            <span
              role="meter"
              aria-label={`${col.name} on ${board.name}: ${col.card_count} of limit ${col.wip_limit}`}
              aria-valuemin={0}
              aria-valuemax={col.wip_limit ?? 0}
              aria-valuenow={Math.min(col.card_count, col.wip_limit ?? 0)}
              aria-valuetext={`${col.card_count} of limit ${col.wip_limit}${col.card_count > (col.wip_limit ?? 0) ? ", over limit" : ""}`}
              className="mt-1 block h-1 w-full overflow-hidden rounded bg-surface-active"
            >
              <span className="block h-full bg-primary-emphasis" style={{ width: `${pct}%` }} />
            </span>
          )}
        </>
      );
    };
    // The phone board's column buttons (as the Children tab's narrow layout): a group of aria-pressed buttons, one
    // Tab stop, Left/Right moving the pressed column and wrapping.
    const showColumn = (id: number, focus: boolean) => {
      setPhoneCol((m) => ({ ...m, [gridKey]: id }));
      if (focus) queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>(`[data-column-button="${gridKey}:${id}"]`)?.focus());
    };
    const onColumnButtonsKeyDown = (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const i = allCols.findIndex((c) => c.id === phoneColumn?.id);
      showColumn(allCols[(i + (e.key === "ArrowRight" ? 1 : allCols.length - 1)) % allCols.length].id, true);
    };
    return (
      <div key={board.id} className={phone ? "px-3 pt-2 flex flex-col gap-2" : "overflow-x-auto"}>
        {phone ? (
          <div className="flex flex-col gap-1 text-xs">
            <span className="text-fg-secondary">Children on <a href={`/boards/${board.id}`} className={`${FOCUS} inline-flex items-center min-h-11 text-link hover:underline rounded`}>{board.name}</a></span>
            <div role="group" aria-label={`Columns on ${board.name}`} data-testid="children-phone-columns" className="flex gap-1 overflow-x-auto px-0.5 py-1 -mx-0.5" onKeyDown={onColumnButtonsKeyDown}>
              {allCols.map((c) => {
                const on = c.id === phoneColumn?.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    data-column-button={`${gridKey}:${c.id}`}
                    aria-pressed={on}
                    tabIndex={on ? 0 : -1}
                    onClick={() => showColumn(c.id, false)}
                    className={`${FOCUS} shrink-0 inline-flex items-center gap-2 min-h-11 px-3 rounded border text-sm ${on ? "border-info bg-primary/20 text-fg font-semibold" : "border-line bg-surface text-fg-secondary hover:border-line-strong"}`}
                  >
                    <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full color-dot" style={{ backgroundColor: c.color }} />
                    <span className="whitespace-nowrap">{c.name}</span>
                    <span>{phoneColumnCount(rows, c, options)}</span>
                  </button>
                );
              })}
            </div>
            {phoneColumn && <div data-testid="children-column-head" className="flex flex-col">{columnHead(phoneColumn)}</div>}
            {phoneColumn && isBlockedColumnName(phoneColumn.name) && <span className="text-fg-secondary">{phoneBlockedColumnNote(board.name)}</span>}
          </div>
        ) : (
        <div className="min-w-max" style={{ display: "grid", gridTemplateColumns: template }}>
          <div className="px-2 py-1 text-xs text-fg-secondary flex flex-col justify-end">
            <span className="block font-medium text-fg">Parent · column on {boardName}</span>
            <span>Children on <a href={`/boards/${board.id}`} className={`${FOCUS} text-link hover:underline rounded`}>{board.name}</a></span>
          </div>
          {cols.map((col) => (
            <div key={col.id} className="px-2 py-1 text-xs border-l border-line" data-testid="children-column-head">
              <span className="block font-medium text-fg">{col.name}</span>
              {columnHead(col)}
            </div>
          ))}
          {Array.from({ length: maxCols - cols.length }, (_, i) => <div key={`pad-${i}`} aria-hidden="true" />)}
        </div>
        )}
        <div
          role="grid"
          aria-label={`${lane.name} children on ${board.name}, by parent`}
          data-children-grid={lane.id}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            const t = e.target as HTMLElement;
            const rowEl = t.closest<HTMLElement>("[data-row-id]");
            const card = t.closest<HTMLElement>("[data-child-card]") ?? (t.dataset.moveFor ? e.currentTarget.querySelector<HTMLElement>(`[data-stop="${t.dataset.moveFor}"]`) : null);
            if (rowEl) gridFocus.current = { childId: card ? Number(card.dataset.childCard) : null, rowId: Number(rowEl.dataset.rowId), title: card?.querySelector("span")?.textContent ?? "" };
          }}
          onBlur={(e) => {
            // Focus leaving every grid for another control applies the held order; a removed node (null) does not,
            // and the pill applies it itself on activation (applying here would unmount it under the click).
            const to = e.relatedTarget as HTMLElement | null;
            if (to && !to.closest("[data-children-grid]") && !to.hasAttribute("data-changes-pill")) { gridFocus.current = null; applyHeld(); }
          }}
          className={phone ? "flex flex-col rounded border border-line" : "min-w-max"}
        >
          {cellsByRow.map(({ row, open, cells }, r) => {
            const blocked = row.rollup.visible && row.rollup.blocked > 0;
            const title = (
                  <button
                    type="button"
                    {...focusProps({ r, c: 0, i: 0, key: `${gridKey}:${r}:0:0` })}
                    data-parent-row={row.id}
                    onClick={() => (large ? setRowOpen((m) => new Map(m).set(row.id, !open)) : onOpenParent(row.id))}
                    onKeyDown={(e) => { if (large && e.key === "Enter" && e.shiftKey) { e.preventDefault(); onOpenParent(row.id); } }}
                    {...(large ? { "aria-expanded": open } : {})}
                    className={`${FOCUS} ${tgt} text-left text-sm font-medium text-link hover:underline rounded`}
                  >
                    {row.title}
                  </button>
            );
            return (
              <div
                role="row"
                key={row.id}
                data-row-id={row.id}
                className={`${r > 0 || !phone ? "border-t border-line" : ""} ${blocked ? "border-l-[3px] border-l-danger" : "border-l-[3px] border-l-transparent"} ${phone ? "flex flex-col" : ""}`}
                style={phone ? undefined : { display: "grid", gridTemplateColumns: template }}
              >
                <div role="rowheader" className="px-2 py-1.5 flex flex-col gap-1 min-w-0">
                  {/* Phone: parent names are headings inside the shown column (canvas 6b). */}
                  {phone ? <h4 className="m-0">{title}</h4> : title}
                  {large && (
                    // A one-line row's title expands it; opening the parent is its own visible control.
                    <button type="button" tabIndex={-1} aria-label={`Open ${row.title}`} onClick={() => onOpenParent(row.id)} className={`${FOCUS} ${tgt} self-start px-2 text-xs text-link rounded hover:bg-surface-hover`}>
                      Open
                    </button>
                  )}
                  <span className="flex items-center gap-1.5 text-xs text-fg-secondary">
                    <span className="rounded border border-line px-1">{row.column_name}</span>
                    {row.assignee && <Avatar user={row.assignee} size="sm" />}
                    <span className={blocked && large ? "text-danger font-medium" : ""}>{large ? compactRowLabel(row) : rowDoneLabel(row)}</span>
                    {/* Blocked is text too, never the left accent alone. */}
                    {!large && row.rollup.visible && row.rollup.blocked > 0 && <span className="text-danger font-medium">{row.rollup.blocked} blocked</span>}
                  </span>
                </div>
                {open && cells.map(({ col, kids, planned }, ci) => {
                  const base = { r, c: ci + 1 };
                  const count = kids.length + planned.length;
                  return (
                    <div role="gridcell" key={col.id} aria-label={cellName(row.title, col.name, count)} className={`px-2 flex flex-col gap-1 ${phone ? "pb-2" : "py-1.5 border-l border-line"}`}>
                      {col.is_done && !options.showDone ? (
                        row.rollup.visible && row.rollup.done > 0 ? (
                          <button
                            type="button"
                            {...focusProps({ ...base, i: 0, key: `${gridKey}:${r}:${ci + 1}:0` })}
                            aria-label={`${row.rollup.done} done. Show done cards`}
                            onClick={() => onOptionsChange({ ...options, showDone: true })}
                            className={`${FOCUS} ${tgt} text-left text-xs text-fg-secondary hover:text-fg rounded`}
                          >
                            {row.rollup.done} done · <span className="text-link">Show</span>
                          </button>
                        ) : (
                          <span {...focusProps({ ...base, i: 0, key: `${gridKey}:${r}:${ci + 1}:0` })} className={`${FOCUS} text-xs text-fg-secondary rounded`}>0 done</span>
                        )
                      ) : (
                        <>
                          {kids.map((k, i) => renderChild(k, col.name, { ...base, i, key: `${gridKey}:${r}:${ci + 1}:${i}` }, gridKey, focusProps, row, board))}
                          {planned.length > 0 && (
                            <button
                              type="button"
                              {...focusProps({ ...base, i: kids.length, key: `${gridKey}:${r}:${ci + 1}:${kids.length}` })}
                              aria-expanded={false}
                              onClick={() => setPlannedOpen((s) => toggle(s, row.id))}
                              className={`${FOCUS} ${tgt} text-left rounded border border-dashed border-line-strong px-2 text-xs text-fg-secondary hover:text-fg`}
                            >
                              {planned.length} planned · <span className="text-link">Show</span>
                            </button>
                          )}
                          {kids.length === 0 && planned.length === 0 && (
                            phone ? (
                              // Phone: the empty shown column is said in plain words ("Nothing blocked", canvas 6b).
                              <span {...focusProps({ ...base, i: 0, key: `${gridKey}:${r}:${ci + 1}:0` })} className={`${FOCUS} block py-1 text-xs text-fg-secondary rounded`}>{phoneEmptyCellText(col.name)}</span>
                            ) : (
                              <span {...focusProps({ ...base, i: 0, key: `${gridKey}:${r}:${ci + 1}:0` })} className={`${FOCUS} block min-h-6 rounded`}><span className="sr-only">{cellName(row.title, col.name, 0)}</span></span>
                            )
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div ref={rootRef} data-testid="children-mode" className="flex-1 min-h-0 overflow-y-auto bg-surface-sunken">
      <div className="flex items-center gap-3 px-4 py-2 text-sm text-fg-secondary">
        <span data-testid="children-board-total"><span className="font-semibold text-fg">{shownInProgress(data.board_total)}</span> in progress</span>
        <span role="status" aria-live="polite" className="sr-only">{copied}</span>
      </div>
      {moving && (
        <ChildMovePopover
          child={{ ...moving.child, due_date: null }}
          boardName={moving.board.name}
          columns={moving.board.columns}
          board={moving.board}
          currentUserId={currentUserId}
          error={moveError}
          userTimezone={userTimezone}
          onMove={doMove}
          onClose={closeMove}
        />
      )}
      {lanes.map((lane) => {
        const isCollapsed = collapsed.has(lane.id);
        const laneRows = data.rows.filter((r) => r.swimlane_id === lane.id);
        const large = lane.parents > LARGE_LANE_PARENTS;
        const unfolded = laneRows.filter((r) => r.rollup.visible && !isFoldedRow(r, options.planned));
        const folded = laneRows.filter((r) => isFoldedRow(r, options.planned));
        const locked = laneRows.filter((r) => !r.rollup.visible);
        const foldShown = foldOpen.has(lane.id);
        const drawn = [...unfolded, ...(foldShown ? folded : [])]
          .filter((r) => !options.blockedOnly || (r.rollup.visible && r.rollup.blocked > 0));
        const sectionIds = [...new Set(drawn.map((r) => r.child_board_id).filter((id): id is number => id != null))];
        const maxCols = Math.max(0, ...sectionIds.map((id) => boards.get(id)?.columns.length ?? 0));
        const remaining = lane.parents - (loadedPerLane.get(lane.id) ?? 0);
        // lane.planned_only is a subset of lane.folded; "Only planned" unfolds those rows, so they leave the button.
        const plannedOnlyFolded = options.planned === "only" ? 0 : lane.planned_only;
        const foldedCount = options.planned === "only" ? lane.folded - lane.planned_only : lane.folded;
        // Phone: one child board per lane at a time; the others are "Onboarding · 2 children · Columns ›" switches.
        const phoneBoardId = phone ? (sectionIds.includes(phoneBoard[lane.id]) ? phoneBoard[lane.id] : sectionIds[0]) : undefined;
        const shownSectionIds = phoneBoardId != null ? [phoneBoardId] : sectionIds;
        const actions = (
          <>
            {/* Lane actions beside the name: Focus (everyone), Copy link (this mode only), the admin ⋮. */}
            {onFocusLane && (
              <button
                type="button"
                aria-pressed={laneId === lane.id}
                aria-label={`Focus on ${lane.name}`}
                onClick={() => onFocusLane(laneId === lane.id ? null : lane.id)}
                className={`${FOCUS} ${tgt} px-2 text-xs rounded border ${laneId === lane.id ? "border-info text-info-on-tint bg-info/10" : "border-line-strong text-fg-secondary hover:bg-surface-hover hover:text-fg"}`}
              >
                Focus
              </button>
            )}
            <button type="button" onClick={() => void copyLink(lane)} aria-label={copiedLane === lane.id ? undefined : `Copy link to ${lane.name}`} className={`${FOCUS} ${tgt} px-2 text-xs text-fg-secondary rounded border border-line-strong hover:bg-surface-hover hover:text-fg`}>
              {copiedLane === lane.id ? "Link copied" : "Copy link"}
            </button>
            {onEditLane && (
              <OverflowMenu
                ariaLabel={`Actions for swimlane "${lane.name}"`}
                triggerClassName={`${FOCUS} inline-flex items-center justify-center min-w-11 sm:[@media(pointer:fine)]:min-w-8 ${tgt} rounded text-fg-secondary hover:text-fg hover:bg-surface-hover`}
                items={[
                  { id: "edit", label: "Edit swimlane…", onSelect: () => onEditLane(lane.id) },
                  ...(onEditFieldOrder ? [{ id: "field-order", label: "Change field order…", onSelect: onEditFieldOrder }] : []),
                ]}
              />
            )}
          </>
        );
        const toggleLane = () => { collapseTouched.current = true; setCollapsed((s) => toggle(s, lane.id)); };
        return (
          <section key={lane.id} aria-label={`${lane.name} lane`} className="mx-3 mb-3 rounded-lg border border-line bg-surface">
            {phone ? (
              // Phone band (canvas 6b, as PhoneBoard's): tinted with the lane color; line one is the collapse button
              // with the name and total, line two the blocked count and "+N on a board you can't open", then the
              // lane actions row, styled as PhoneBoard's phone-lane-footer (#2498). Text on the tint is fg / fg-secondary / *-on-tint only.
              <div role="group" aria-label={laneBandName(lane)} data-testid="children-phone-band" style={columnTintStyle(laneColors?.[lane.id])} className={`flex flex-col bg-surface-raised ${isCollapsed ? "rounded-lg" : "rounded-t-lg border-b border-line"}`}>
                <h3 className="m-0">
                  <button
                    type="button"
                    data-lane-toggle={lane.id}
                    aria-expanded={!isCollapsed}
                    aria-label={`${isCollapsed ? "Expand" : "Collapse"} lane ${lane.name}, ${shownInProgress(lane)} in progress of ${lane.total}`}
                    onClick={toggleLane}
                    className={`${FOCUS} flex items-center gap-2 min-h-11 w-full text-left rounded px-3 pt-2.5 pb-1`}
                  >
                    <svg aria-hidden="true" className={`w-4 h-4 shrink-0 text-fg-secondary ${isCollapsed ? "-rotate-90" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6l4 4 4-4" /></svg>
                    <span className="text-[17px] font-semibold text-fg min-w-0 break-words">{lane.name}</span>{" "}
                    <span className="ml-auto text-xs font-semibold text-fg whitespace-nowrap">{laneTotalLabel(lane)}</span>
                  </button>
                </h3>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-9 pr-3 pb-2 text-xs">
                  <span className={lane.blocked > 0 ? "text-danger-on-tint font-semibold" : "text-fg-secondary"}>{laneBlockedLabel(lane)}</span>
                  {lane.hidden > 0 && <span className="inline-flex items-center gap-1 text-fg-secondary"><LockIcon />+{lane.hidden} on a board you can&apos;t open</span>}
                </div>
                {/* Collapsed, the band is the canvas's two lines; the actions return with the lane. */}
                {!isCollapsed && <div data-testid="children-lane-actions" className="flex flex-wrap items-center gap-2 border-t border-line-subtle px-3 pb-2.5 pt-2">{actions}</div>}
              </div>
            ) : (
            <div role="group" aria-label={laneBandName(lane)} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 bg-surface-raised rounded-t-lg">
              <h3 className="m-0">
                <button
                  type="button"
                  data-lane-toggle={lane.id}
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${lane.name}`}
                  onClick={toggleLane}
                  className={`${FOCUS} ${tgt} flex items-center gap-2 rounded text-[17px] font-semibold text-fg`}
                >
                  <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                  {lane.name}
                </button>
              </h3>
              {actions}
              <span className="text-xs text-fg-secondary">{isCollapsed ? parentsLabel(lane.parents) : laneSubtitle(lane)}</span>
              <span className="text-sm text-fg">{laneTotalLabel(lane)}</span>
              <LaneBar lane={lane} />
              <span className={`text-sm ${lane.blocked > 0 ? "text-danger font-medium" : "text-fg-secondary"}`}>{laneBlockedLabel(lane)}</span>
              {lane.hidden > 0 && <span className="inline-flex items-center gap-1 text-sm text-fg-secondary"><LockIcon />+{lane.hidden} on a board you can&apos;t open</span>}
            </div>
            )}
            {!isCollapsed && (
              <div className="pb-2">
                <ChangesPill
                  count={held ? pendingRowChanges(data.rows, held.rows, lane.id) : 0}
                  laneName={lane.name}
                  phone={phone}
                  onShow={() => { focusLaneGrid.current = lane.id; gridFocus.current = null; applyHeld(); setFocusTick((n) => n + 1); }}
                />
                {shownSectionIds.map((id) => {
                  const b = boards.get(id);
                  return b ? renderSection(lane, b, drawn.filter((r) => r.child_board_id === id), maxCols, large) : null;
                })}
                {phone && sectionIds.filter((id) => id !== phoneBoardId).map((id) => {
                  const b = boards.get(id);
                  if (!b) return null;
                  return (
                    <button
                      key={`switch-${id}`}
                      type="button"
                      data-board-switch={id}
                      aria-label={childBoardSwitchName(b.name, drawn.filter((r) => r.child_board_id === id))}
                      onClick={() => {
                        setPhoneBoard((m) => ({ ...m, [lane.id]: id }));
                        // The switch unmounts under the tap: focus goes to that board's pressed column button.
                        queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>(`[data-column-button^="${lane.id}-${id}:"][aria-pressed="true"]`)?.focus());
                      }}
                      className={`${FOCUS} mx-3 mt-2 w-[calc(100%-1.5rem)] min-h-11 px-3 flex items-center justify-between gap-2 text-sm text-fg rounded border border-line-strong hover:bg-surface-hover`}
                    >
                      <span className="min-w-0 break-words text-left">{childBoardSwitchLabel(b.name, drawn.filter((r) => r.child_board_id === id))}</span>
                      <span className="shrink-0 text-xs text-fg-secondary">Columns <span aria-hidden="true">›</span></span>
                    </button>
                  );
                })}
                {locked.map((row) => (
                  <div key={row.id} className="mx-2 mt-2 flex items-center gap-2 rounded border border-dashed border-line-strong px-3 py-2 text-sm text-fg-secondary">
                    <LockIcon />
                    <span className="font-medium text-fg">{row.title}</span>
                    <span>{lockedRowText(row.rollup.total)}</span>
                  </div>
                ))}
                {folded.length > 0 && (
                  <button
                    type="button"
                    aria-expanded={foldShown}
                    onClick={() => setFoldOpen((s) => toggle(s, lane.id))}
                    className={`${FOCUS} ${tgt} mx-2 mt-2 px-3 text-sm text-fg-secondary rounded border border-line hover:bg-surface-hover`}
                  >
                    {foldLabel(foldedCount, plannedOnlyFolded)}
                  </button>
                )}
                {remaining > 0 && lastLaneWithRows === lane.id && data.next_cursor && (
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                    className={`${FOCUS} ${tgt} mx-2 mt-2 px-3 text-sm text-link rounded hover:bg-surface-hover`}
                  >
                    {moreParentsLabel(remaining, phone)}
                  </button>
                )}
                {moreError && lastLaneWithRows === lane.id && <p role="alert" className="mx-2 mt-1 text-sm text-danger">Couldn&apos;t load more parents. Try again.</p>}
                {drawn.length === 0 && laneRows.some((r) => r.rollup.visible) && (options.blockedOnly || options.planned === "only") && !foldShown && (
                  <p className="px-3 py-2 text-sm text-fg-secondary">{options.blockedOnly ? "No blocked children in this lane." : "No planned children in this lane."} Change it in View.</p>
                )}
                {laneRows.length === 0 && lane.parents === 0 && <p className="px-3 py-2 text-sm text-fg-secondary">No parents in this lane.</p>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
