import axios from "axios";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useInRouterContext } from "react-router-dom";
import { getChildrenView, moveCard } from "../../api/cards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { CardChildrenColumn, ChildrenView, ChildrenViewBoard, ChildrenViewChild, ChildrenViewLane, ChildrenViewRow } from "../../types";
import {
  CHILDREN_MODE_ESCAPE_PRIORITY, LARGE_LANE_PARENTS, blockedDays, cellName, changesPillText, childBoardSwitchLabel, childBoardSwitchName, childCardName, columnOverLimit, compactRowLabel, foldLabel,
  columnHeadCaption, columnMeterPct, holdRowOrder, isFoldedRow, laneBandName, laneBlockedLabel, laneIdleLabel, laneLink, laneSubtitle, laneTotalLabel, laneTotalParts, phoneHiddenLabel, lockedRowText, moreParentsLabel,
  parentsLabel, pendingRowChanges, isBlockedColumnName, phoneBlockedColumnNote, phoneColumnCount, phoneEmptyCellText, rowDoneLabel, shownInProgress, visibleChildren, type ChildrenModeOptions,
  addPage, frontierLane, pageRowCount, type LaneRows, type LaneStore,
} from "../../utils/childrenMode";
import { columnTintStyle } from "../../utils/colorContrast";
import { ChildMovePopover } from "../Card/CardChildrenTab";
import { WRITE_ROLES, moveTargetState } from "../Card/cardChildren";
import ChildStateBar from "../Card/ChildStateBar";
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
  /** `?lane=` (the shared link): that lane expanded and the others collapsed; null for the default expansion. */
  laneId: number | null;
  /**
   * Focus (the band's Focus button, the View menu's Lanes): only that lane is drawn; null for every lane. Kept apart
   * from `laneId`, which never hides a lane (#2370 fix A1).
   */
  focusLaneId?: number | null;
  /** The Children lane action (#2370 fix A2): scroll to this lane and put focus on its collapse button once drawn. */
  laneFocusRequest?: number | null;
  onLaneFocusDone?: () => void;
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
  /** Focus (everyone): show only that lane, or every lane on null. */
  onFocusLane?: (laneId: number | null) => void;
  /** Admin ⋮ "Edit swimlane…"; absent for a non-admin, which hides the menu. */
  onEditLane?: (laneId: number) => void;
  /** Admin ⋮ "Change field order…", when the board has lane fields to order. */
  onEditFieldOrder?: () => void;
  /** For the Move picker's assignee override and planned-date "today" (item 11). */
  currentUserId?: number | null;
  userTimezone?: string;
  /** The board's stale threshold: a collapsed band reads "Work idle Nd" past it (the card rollup's idle rule). */
  stalenessDays?: number;
  /** Desktop: the host draws the board total beside the Show control; without it the view draws its own line. */
  onBoardTotal?: (inProgress: number | null) => void;
}

// 44px on phone and under a coarse pointer at any width; 32px only for a fine pointer from `sm` up (#2370 ruling).
const tgt = "min-h-11 sm:[@media(pointer:fine)]:min-h-8";
const FOCUS = "focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

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

type Head = Omit<ChildrenView, "rows" | "next_cursor">;
type Params = { boardId: number; scope: number | null; laneId: number | null; showDone: boolean };

const mergeBoards = (a: ChildrenViewBoard[], b: ChildrenViewBoard[]) => [...a, ...b.filter((x) => !a.some((y) => y.id === x.id))];

/**
 * Reads one scope (the board, or one lane) into `store`, following next_cursor until it holds `minRows` rows, so a
 * live re-read never shrinks what "+N more parents" loaded (frontend/CLAUDE.md).
 */
async function readPages(p: Params, store: LaneStore, scope: number | null, owner: LaneRows["owner"], minRows: number, signal: AbortSignal) {
  let d = await getChildrenView(p.boardId, { lane: scope, done: p.showDone }, signal);
  const ids = d.lanes.map((l) => l.id);
  let st = addPage(store, ids, d, scope, owner);
  let boards = d.child_boards;
  let n = d.rows.length;
  while (d.next_cursor && n < minRows) {
    const from = scope == null ? frontierLane(st) : null;
    d = await getChildrenView(p.boardId, { lane: scope, cursor: d.next_cursor, done: p.showDone }, signal);
    st = addPage(st, ids, d, scope, owner, from);
    boards = mergeBoards(boards, d.child_boards);
    n += d.rows.length;
  }
  return { store: st, head: { board_total: d.board_total, lanes: d.lanes, child_boards: boards } as Head };
}

export default function ChildrenModeView({ boardId, laneId: laneProp, focusLaneId: focusProp = null, laneFocusRequest = null, onLaneFocusDone, options, onOptionsChange, onOpenParent, refreshKey = 0, phone = false, laneColors, boardName = "this board", onFocusLane, onEditLane, onEditFieldOrder, currentUserId = null, userTimezone = "", stalenessDays = 14, onBoardTotal }: Props) {
  // A lane the server no longer finds (deleted since the board loaded) is treated as no lane: Children mode
  // renders with the default expansion, never an error, and a missing lane reads the same as a hidden one (#2370 item 1).
  const [goneLane, setGoneLane] = useState<number | null>(null);
  const laneId = laneProp != null && laneProp === goneLane ? null : laneProp;
  const focusLane = focusProp != null && focusProp === goneLane ? null : focusProp;
  // The main read: the focused lane, else the linked lane, else the board. Other lanes read their own rows on demand.
  const scope = focusLane ?? laneId;
  const inRouter = useInRouterContext();
  const [head, setHead] = useState<Head | null>(null);
  const [laneRows, setLaneRows] = useState<LaneStore>({});
  const [readSeq, setReadSeq] = useState(0);
  const [error, setError] = useState(false);
  const [loadingLane, setLoadingLane] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [foldOpen, setFoldOpen] = useState<Set<number>>(new Set());
  const [plannedOpen, setPlannedOpen] = useState<Set<number>>(new Set());
  const [rowOpen, setRowOpen] = useState<Map<number, boolean>>(new Map());
  const [active, setActive] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string>("");
  const [copiedLane, setCopiedLane] = useState<{ id: number; ok: boolean } | null>(null);
  const [moreError, setMoreError] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const laneParamRef = useRef(laneId);
  // The user's own collapse choices survive a re-read; a new ?lane= resets them.
  const collapseTouched = useRef(false);
  // A read generation: a lane page from an older read (lane, Focus or Show done changed) is dropped.
  const generation = useRef(0);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  // Live updates (item 9): per lane, the server's fresh row order that waits while focus is in a grid.
  const [held, setHeld] = useState<Record<number, ChildrenViewRow[]> | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const headRef = useRef(head);
  headRef.current = head;
  const laneRowsRef = useRef(laneRows);
  laneRowsRef.current = laneRows;
  const heldRef = useRef(held);
  heldRef.current = held;
  const params = useRef<Params>({ boardId, scope, laneId, showDone: options.showDone });
  params.current = { boardId, scope, laneId, showDone: options.showDone };
  // One read in flight at a time (#2370 fix A12): a board event during a read asks for one trailing re-read
  // instead of aborting it, so a slow read is never starved by a busy board.
  const inFlight = useRef<AbortController | null>(null);
  const trailing = useRef(false);
  // Where focus sits in a grid (a child card, or a row's other stops), and what to put it back on after a re-read.
  const gridFocus = useRef<{ childId: number | null; rowId: number; title: string } | null>(null);
  const restoreFocus = useRef<{ childId: number | null; rowId: number; title: string } | null>(null);
  const focusLaneGrid = useRef<number | null>(null);
  // A "N done · Show" press: focus stays in that cell while the done cards load (#2370 fix A3).
  const cellFocus = useRef<{ rowId: number; colId: number; seq: number } | null>(null);
  // A linked lane is scrolled to once it draws (#2370 fix A2).
  const scrollToLane = useRef<number | null>(null);
  // Bumped by the pill: its own blur may already have applied the order, so a data change alone can't place focus.
  const [focusTick, setFocusTick] = useState(0);
  const [moving, setMoving] = useState<{ child: ChildrenViewChild; rowId: number; board: ChildrenViewBoard } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  // Phone only: the child board shown per lane (lane id → board id) and the column shown per section (grid key → column id).
  const [phoneBoard, setPhoneBoard] = useState<Record<number, number>>({});
  const [phoneCol, setPhoneCol] = useState<Record<string, number>>({});

  const runRead = useCallback(function run(live: boolean) {
    const p = params.current;
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    if (!live) generation.current += 1;
    const read = async () => {
      const shown = laneRowsRef.current;
      // A live re-read covers every row on screen: the main read as far as it was paged, then each lane that
      // was opened on its own (a collapsed lane expanded, or a lane past the main read's pages).
      const main = await readPages(p, {}, p.scope, "page", live ? pageRowCount(shown) : 0, ctrl.signal);
      let { store, head: h } = main;
      if (live) {
        for (const [key, v] of Object.entries(shown)) {
          const id = Number(key);
          if (v.owner !== "lane" || !h.lanes.some((l) => l.id === id)) continue;
          const rest: Record<number, LaneRows> = { ...store };
          delete rest[id];
          const one = await readPages(p, rest, id, "lane", v.rows.length, ctrl.signal);
          store = one.store;
          h = { ...one.head, child_boards: mergeBoards(h.child_boards, one.head.child_boards) };
        }
      }
      return { store, head: h };
    };
    setError(false);
    read()
      .then(({ store, head: h }) => {
        const el = document.activeElement as HTMLElement | null;
        const inGrid = !!el && !!rootRef.current?.contains(el) && !!el.closest("[data-children-grid]");
        if (live && inGrid) {
          // Rows never re-sort under focus: the fresh read keeps each lane's order on screen until the pill or a
          // blur applies it.
          const shown = laneRowsRef.current;
          const next: Record<number, LaneRows> = { ...store };
          const wait: Record<number, ChildrenViewRow[]> = {};
          for (const [key, v] of Object.entries(store)) {
            const s = shown[Number(key)];
            if (!s) continue;
            const kept = holdRowOrder(s.rows, v.rows);
            if (kept.some((r, i) => r.id !== v.rows[i]?.id)) { wait[Number(key)] = v.rows; next[Number(key)] = { ...v, rows: kept }; }
          }
          setLaneRows(next);
          setHeld(Object.keys(wait).length ? wait : null);
          if (gridFocus.current) restoreFocus.current = { ...gridFocus.current };
        } else {
          setLaneRows(store);
          setHeld(null);
        }
        setHead(h);
        setReadSeq((n) => n + 1);
        if (live) return;
        if (laneParamRef.current !== p.laneId) collapseTouched.current = false;
        if (!collapseTouched.current) {
          laneParamRef.current = p.laneId;
          // A linked lane opens expanded with the others collapsed; they read their rows when opened.
          setCollapsed(new Set(p.laneId == null ? [] : h.lanes.filter((l) => l.id !== p.laneId).map((l) => l.id)));
        }
        if (p.laneId != null) scrollToLane.current = p.laneId;
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e as { name?: string })?.name === "CanceledError") return;
        if (p.scope != null && (e as { response?: { status?: number } })?.response?.status === 404) { setGoneLane(p.scope); return; }
        setError(true);
      })
      .finally(() => {
        if (inFlight.current !== ctrl) return;
        inFlight.current = null;
        if (trailing.current) { trailing.current = false; run(true); }
      });
  }, []);

  // A board event or a Move: one live re-read, or one trailing re-read when a read is in flight. Declared before
  // the query effect, so a query change in the same render cancels it.
  const liveKey = `${refreshKey}|${reloadTick}`;
  const lastLiveKey = useRef(liveKey);
  useEffect(() => {
    if (lastLiveKey.current === liveKey) return;
    lastLiveKey.current = liveKey;
    if (inFlight.current) { trailing.current = true; return; }
    if (headRef.current) runRead(true);
  }, [liveKey, runRead]);

  // A new query (board, Focus, linked lane, Show done, Try again) replaces the read in flight.
  useEffect(() => {
    trailing.current = false;
    inFlight.current?.abort();
    runRead(false);
    return () => { inFlight.current?.abort(); inFlight.current = null; };
  }, [boardId, scope, laneId, options.showDone, retry, runRead]);

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
  }, [laneRows, focusTick]);

  // "N done · Show" unmounts under the press: focus goes to that cell's first stop, then to its first done card
  // once the read with done cards lands (#2370 fix A3).
  useLayoutEffect(() => {
    const want = cellFocus.current;
    if (!want) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-cell="${want.rowId}:${want.colId}"] [data-stop]`)?.focus();
    if (readSeq > want.seq) cellFocus.current = null;
  }, [readSeq, laneRows, options.showDone]);

  // The linked lane scrolls into view; the Children lane action also puts focus on its collapse button (#2370 fix A2).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !head) return;
    const target = scrollToLane.current;
    if (target != null) {
      scrollToLane.current = null;
      root.querySelector<HTMLElement>(`[data-lane-section="${target}"]`)?.scrollIntoView?.({ block: "start" });
    }
    if (laneFocusRequest == null) return;
    const toggleBtn = root.querySelector<HTMLElement>(`[data-lane-toggle="${laneFocusRequest}"]`);
    if (toggleBtn) toggleBtn.focus({ preventScroll: true });
    onLaneFocusDone?.();
  }, [head, laneFocusRequest, onLaneFocusDone]);

  const applyHeld = useCallback(() => {
    const h = heldRef.current;
    if (h) {
      setLaneRows((s) => {
        const n: Record<number, LaneRows> = { ...s };
        for (const [key, rows] of Object.entries(h)) if (n[Number(key)]) n[Number(key)] = { ...n[Number(key)], rows };
        return n;
      });
    }
    setHeld(null);
  }, []);

  /**
   * "+N more parents" for one lane (#2370 fix A5): the main board-wide read's last lane continues that read (which
   * also fills the lanes after it); any other lane reads its own rows (`?lane=`), so a lane past the loaded pages
   * or a collapsed lane opened later is never empty, and the button never depends on which lane is last.
   */
  const loadLane = useCallback(async (id: number) => {
    const p = params.current;
    const gen = generation.current;
    const st = laneRowsRef.current[id];
    const boardWide = p.scope == null && st?.owner === "page" && frontierLane(laneRowsRef.current) === id;
    setLoadingLane(id);
    setMoreError(null);
    try {
      const d = await getChildrenView(p.boardId, { lane: boardWide ? null : id, cursor: st?.cursor ?? null, done: p.showDone });
      if (gen !== generation.current) return;
      const ids = d.lanes.map((l) => l.id);
      setLaneRows((s) => (boardWide ? addPage(s, ids, d, null, "page", id) : addPage(s, ids, d, id, p.scope === id ? "page" : "lane")));
      setHead((h) => h && { board_total: d.board_total, lanes: d.lanes, child_boards: mergeBoards(h.child_boards, d.child_boards) });
    } catch {
      if (gen === generation.current) setMoreError(id);
    } finally {
      setLoadingLane(null);
    }
  }, []);

  const boardTotal = head ? shownInProgress(head.board_total) : null;
  useEffect(() => { onBoardTotal?.(boardTotal); }, [boardTotal, onBoardTotal]);
  useEffect(() => () => onBoardTotal?.(null), [onBoardTotal]);

  // Escape leaves the grid (board tier, below the View menu's 25): focus goes to the lane's collapse button.
  useEscapeStack(() => {
    const el = document.activeElement as HTMLElement | null;
    const grid = el?.closest<HTMLElement>("[data-children-grid]");
    if (!grid || !rootRef.current?.contains(grid)) return false;
    rootRef.current.querySelector<HTMLElement>(`[data-lane-toggle="${grid.dataset.childrenGrid}"]`)?.focus();
    return true;
  }, CHILDREN_MODE_ESCAPE_PRIORITY);

  const boards = useMemo(() => new Map((head?.child_boards ?? []).map((b) => [b.id, b])), [head]);

  if (error && !head) {
    return (
      <div role="alert" className="p-4 text-sm text-danger flex items-center gap-3">
        Children didn&apos;t load.
        <button type="button" onClick={() => setRetry((n) => n + 1)} className={`${FOCUS} ${tgt} px-3 rounded border border-line-strong text-fg hover:bg-surface-hover`}>Try again</button>
      </div>
    );
  }
  if (!head) {
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
      setCopiedLane({ id: lane.id, ok: true });
    } catch {
      // Said on screen too, not only to screen readers (#2370 fix A11).
      setCopied("Couldn't copy the link");
      setCopiedLane({ id: lane.id, ok: false });
    }
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedLane(null), 4000);
  };
  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };

  // Focus draws one lane; a linked lane (`?lane=`) only changes which lanes start expanded (#2370 fix A1).
  const lanes = focusLane == null ? head.lanes : head.lanes.filter((l) => l.id === focusLane);
  // A board with no parent rows anywhere says so once, instead of a column of empty bands (#2370 fix A6).
  const empty = head.lanes.every((l) => l.parents === 0);

  const renderChild = (child: ChildrenViewChild, colName: string, stop: Stop, gridKey: string, focusProps: (s: Stop) => object, row: ChildrenViewRow, board: ChildrenViewBoard) => {
    const days = blockedDays(child);
    // Move renders only for MEMBER+ on the child board. It is the card's own action (canvas 2f h), an icon inside
    // the card, never a text button beside it, and lives inside the card's roving stop (Right reaches it).
    const canMove = WRITE_ROLES.has(board.role);
    const href = `/boards/${row.child_board_id}?card=${child.id}&from_parent=${row.id}`;
    const cardProps = {
      "aria-label": childCardName(child, colName),
      ...focusProps(stop),
      "data-grid": gridKey,
      "data-child-card": child.id,
      // The Move icon overlays the avatar on hover and focus; on touch it is always shown, so room is kept for it.
      className: `${FOCUS} min-h-11 flex flex-col justify-center gap-1 min-w-0 rounded-lg border bg-surface shadow-sm px-2.5 py-1.5 text-[13px] text-fg hover:bg-surface-hover ${canMove ? "[@media(hover:none)]:pr-11" : ""} ${child.planned ? "border-dashed border-line-strong" : "border-line"}`,
    };
    const body = (
      <>
        <span className="flex items-center justify-between gap-1.5">
          <span data-child-title className="min-w-0 font-semibold leading-snug break-words">{child.title}</span>
          {child.assignee && <Avatar user={child.assignee} size="sm" />}
        </span>
        {(child.planned || child.blocked) && (
          <span className="flex items-center gap-1.5 text-xs text-fg-secondary">
            {child.planned && <span>Planned</span>}
            {child.blocked && <span className="text-danger font-semibold"><span aria-hidden="true">⊘</span>{days != null ? ` ${days}d` : " Blocked"}</span>}
          </span>
        )}
      </>
    );
    return (
      <div key={child.id} className="group/card relative">
        {/* An in-app route, as every board link (#2370 fix A11); a bare render (tests, no router) falls back to <a>. */}
        {inRouter ? <Link to={href} {...cardProps}>{body}</Link> : <a href={href} {...cardProps}>{body}</a>}
        {canMove && (
          <button
            type="button"
            tabIndex={-1}
            data-move-for={stop.key}
            aria-label={`Move ${child.title}`}
            title={`Move ${child.title}`}
            onClick={() => { setMoveError(null); setMoving({ child, rowId: row.id, board }); }}
            className={`${FOCUS} absolute right-0 top-0 inline-flex items-center justify-center min-w-11 min-h-11 sm:[@media(pointer:fine)]:min-w-8 sm:[@media(pointer:fine)]:min-h-8 rounded bg-surface text-fg-secondary hover:text-fg hover:bg-surface-hover opacity-0 group-hover/card:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100`}
          >
            {/* Move glyph: two opposed arrows, inline SVG on currentColor. */}
            <svg aria-hidden="true" viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 5h10M9 2l3 3-3 3M14 11H4M7 8l-3 3 3 3" />
            </svg>
          </button>
        )}
      </div>
    );
  };

  const renderSection = (lane: ChildrenViewLane, board: ChildrenViewBoard, rows: ChildrenViewRow[], layout: { maxCols: number; narrowDone: boolean; first: boolean }, large: boolean) => {
    const gridKey = `${lane.id}-${board.id}`;
    const allCols = board.columns;
    const firstColId = allCols[0]?.id;
    // Phone (#2370 item 12): one child-board column at a time, chosen with the column buttons; the first open
    // column until the viewer picks one (the planned fold lives in the first column).
    const phoneColumn = phone ? (allCols.find((c) => c.id === phoneCol[gridKey]) ?? allCols.find((c) => !c.is_done) ?? allCols[0]) : undefined;
    const cols = phone ? (phoneColumn ? [phoneColumn] : []) : allCols;
    // A board with fewer columns keeps the empty space before its Done column, so Done lines up (canvas 6a).
    const padCount = phone ? 0 : Math.max(0, layout.maxCols - allCols.length);
    const doneAt = cols.findIndex((c) => c.is_done);
    const padAt = doneAt < 0 ? cols.length : doneAt;
    // The roving stops in reading order: each row's parent cell, then each column's cards (or the cell).
    const stops: Stop[] = [];
    const cellsByRow = rows.map((row, r) => {
      // A board the viewer can't open: the parent, then one locked cell spanning the columns.
      if (!row.rollup.visible) {
        stops.push({ r, c: 0, i: 0, key: `${gridKey}:${r}:0:0` }, { r, c: 1, i: 0, key: `${gridKey}:${r}:1:0` });
        return { row, open: false, cells: [] as { col: typeof cols[number]; kids: ChildrenViewChild[]; planned: ChildrenViewChild[]; plannedShown: boolean }[] };
      }
      const open = !large || (rowOpen.get(row.id) ?? (row.rollup.visible && row.rollup.blocked > 0));
      stops.push({ r, c: 0, i: 0, key: `${gridKey}:${r}:0:0` });
      // A one-line row's Open is its own stop under the title: Down reaches it (#2370 fix A4).
      if (large) stops.push({ r, c: 0, i: 1, key: `${gridKey}:${r}:0:1` });
      if (!open) return { row, open, cells: [] as { col: typeof cols[number]; kids: ChildrenViewChild[]; planned: ChildrenViewChild[]; plannedShown: boolean }[] };
      const shown = visibleChildren(row.children, options);
      const cells = cols.map((col, ci) => {
        const inCol = shown.filter((k) => k.column_id === col.id);
        // The planned fold is a toggle (#2370 fix A3): open, its cards join the cell and the button stays to fold them.
        const planned = col.id === firstColId && options.planned === "any" ? inCol.filter((k) => k.planned) : [];
        const plannedShown = planned.length > 0 && plannedOpen.has(row.id);
        const plannedSet = new Set(planned);
        const kids = plannedShown ? inCol : inCol.filter((k) => !plannedSet.has(k));
        const n = Math.max(1, kids.length + (planned.length ? 1 : 0));
        for (let i = 0; i < n; i++) stops.push({ r, c: ci + 1, i, key: `${gridKey}:${r}:${ci + 1}:${i}` });
        return { col, kids, planned, plannedShown };
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
    // Header and body share one template and one minimum width, so their columns stay aligned: fixed minimums with
    // an equal 1fr, never content-sized tracks. The folded Done column is narrow (canvas 6a).
    const wide = layout.maxCols - (layout.narrowDone ? 1 : 0);
    const template = `17.5rem repeat(${wide}, minmax(11rem, 1fr))${layout.narrowDone ? " 9.5rem" : ""}`;
    const minWidth = `${17.5 + wide * 11 + (layout.narrowDone ? 9.5 : 0) + layout.maxCols * 0.5}rem`;
    const pads = (prefix: string) => Array.from({ length: padCount }, (_, i) => <div key={`${prefix}-${i}`} data-pad aria-hidden="true" />);
    // Whole-column counts and the limit meter are the child board's own (artboard 6a); the phone draws the shown column's.
    const columnHead = (col: CardChildrenColumn) => {
      const pct = columnMeterPct(col);
      const shownHere = rows.reduce((n, r) => n + r.children.filter((k) => k.column_id === col.id).length, 0);
      return (
        <>
          {/* Past the limit: warning tone and the word "over", never danger (the board's column-head rule). */}
          <span className={columnOverLimit(col) ? "text-warning-on-tint font-semibold" : "text-fg-secondary"}>{columnHeadCaption(col, shownHere, board.name, options.showDone, padCount > 0)}</span>
          {pct != null && !col.is_done && (
            <span
              role="meter"
              aria-label={`${col.name} on ${board.name}: ${col.card_count} of limit ${col.wip_limit}`}
              aria-valuemin={0}
              aria-valuemax={col.wip_limit ?? 0}
              aria-valuenow={Math.min(col.card_count, col.wip_limit ?? 0)}
              aria-valuetext={`${col.card_count} of limit ${col.wip_limit}${col.card_count > (col.wip_limit ?? 0) ? ", over limit" : ""}`}
              className="mt-1 block h-[3px] w-full overflow-hidden rounded-full bg-surface-active"
            >
              <span className="block h-full bg-primary-emphasis" style={{ width: `${pct}%` }} />
            </span>
          )}
        </>
      );
    };
    // Tinted with the column color, as the board's column heads (text on the tint is fg / fg-secondary only).
    const headPanel = (col: CardChildrenColumn) => (
      <div key={col.id} className="rounded-lg border border-line bg-surface px-3 py-2 text-xs flex flex-col gap-0.5" style={columnTintStyle(col.color)} data-testid="children-column-head">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-fg min-w-0">
          <span aria-hidden="true" className="w-2.5 h-2.5 shrink-0 rounded-full color-dot" style={{ backgroundColor: col.color }} />
          <span className="min-w-0 break-words">{col.name}</span>
        </span>
        {columnHead(col)}
      </div>
    );
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
      <div key={board.id} className={phone ? "pt-2 flex flex-col gap-2" : "overflow-x-auto ml-6 pt-2 px-0.5 pb-0.5"}>
        {phone ? (
          <div className="flex flex-col gap-1 text-xs">
            <span className="text-fg-secondary">Children on <a href={`/boards/${board.id}`} className={`${FOCUS} inline-flex items-center min-h-11 text-link hover:underline rounded`}>{board.name}</a></span>
            <div role="group" aria-label={`Columns on ${board.name}`} data-testid="children-phone-columns" className="flex gap-1.5 overflow-x-auto px-0.5 py-1 -mx-0.5" onKeyDown={onColumnButtonsKeyDown}>
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
                    className={`${FOCUS} flex-1 shrink-0 inline-flex items-center justify-center gap-1 min-h-11 px-2 rounded-md border text-[13px] ${on ? "border-info bg-primary/20 text-fg font-semibold" : "border-line bg-surface text-fg-secondary hover:border-line-strong"}`}
                  >
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
        <div className="gap-2 pb-2" style={{ display: "grid", gridTemplateColumns: template, minWidth }}>
          <div className="pb-1 text-xs text-fg-secondary flex flex-col justify-end gap-0.5">
            <span className="block font-semibold uppercase tracking-wide">Parent · column on {boardName}</span>
            <span>Children on <a href={`/boards/${board.id}`} className={`${FOCUS} text-link underline rounded`}>{board.name}</a>{layout.first ? "" : ", its own columns"}</span>
          </div>
          {cols.slice(0, padAt).map((c) => headPanel(c))}
          {pads("head-pad")}
          {cols.slice(padAt).map((c) => headPanel(c))}
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
            if (rowEl) gridFocus.current = { childId: card ? Number(card.dataset.childCard) : null, rowId: Number(rowEl.dataset.rowId), title: card?.querySelector("[data-child-title]")?.textContent ?? "" };
          }}
          onBlur={(e) => {
            // Focus leaving every grid for another control applies the held order; a removed node (null) does not,
            // and the pill applies it itself on activation (applying here would unmount it under the click).
            const to = e.relatedTarget as HTMLElement | null;
            if (to && !to.closest("[data-children-grid]") && !to.hasAttribute("data-changes-pill")) { gridFocus.current = null; applyHeld(); }
          }}
          className="flex flex-col gap-2"
          style={phone ? undefined : { minWidth }}
        >
          {cellsByRow.map(({ row, open, cells }, r) => {
            const rollup = row.rollup.visible ? row.rollup : null;
            const blocked = !!rollup && rollup.blocked > 0;
            const locked = !rollup;
            // A large lane's closed row is one line: parent, bar, count (canvas 8 § 5).
            const compact = large && !open && !locked;
            const toggles = large && !locked;
            const accent = blocked ? "border-l-[3px] border-l-danger" : "";
            const title = (
              <button
                type="button"
                {...focusProps({ r, c: 0, i: 0, key: `${gridKey}:${r}:0:0` })}
                data-parent-row={row.id}
                onClick={() => (toggles ? setRowOpen((m) => new Map(m).set(row.id, !open)) : onOpenParent(row.id))}
                onKeyDown={(e) => { if (toggles && e.key === "Enter" && e.shiftKey) { e.preventDefault(); onOpenParent(row.id); } }}
                {...(toggles ? { "aria-expanded": open } : {})}
                className={`${FOCUS} min-w-0 break-words text-left hover:underline rounded ${compact ? "flex-1 min-h-11 sm:[@media(pointer:fine)]:min-h-9" : tgt} ${phone && !compact ? "text-xs font-semibold uppercase tracking-wide text-fg-secondary" : "text-[13px] font-semibold text-fg"}`}
              >
                {row.title}
              </button>
            );
            // No visible Open at rest: it shows on row hover and its own focus, and on touch once the row is open.
            const openControl = toggles && (
              <button
                type="button"
                {...focusProps({ r, c: 0, i: 1, key: `${gridKey}:${r}:0:1` })}
                aria-label={`Open ${row.title}`}
                onClick={() => onOpenParent(row.id)}
                className={`${FOCUS} ${tgt} shrink-0 self-center px-2 text-xs text-link rounded hover:bg-surface-hover opacity-0 group-hover/row:opacity-100 focus:opacity-100 ${open ? "[@media(hover:none)]:opacity-100" : "[@media(hover:none)]:pointer-events-none [@media(hover:none)]:focus:pointer-events-auto"}`}
              >
                Open
              </button>
            );
            const meta = (
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-fg-secondary">
                <span className="rounded-full bg-surface-hover px-2 py-0.5 font-semibold text-fg-secondary">{row.column_name}</span>
                {row.assignee && <Avatar user={row.assignee} size="sm" />}
                {/* Blocked is text too, never the left accent alone. */}
                {blocked && <span className="text-danger font-semibold">{rollup.blocked} blocked</span>}
              </span>
            );
            const bar = rollup && <ChildStateBar perChild counts={{ done: rollup.done, doing: rollup.doing, blocked: rollup.blocked, todo: rollup.todo, planned: row.planned ?? 0 }} className={compact ? "w-32 shrink-0" : "flex-1 min-w-10"} />;
            return (
              <div
                role="row"
                key={row.id}
                data-row-id={row.id}
                className={`group/row ${phone ? "flex flex-col gap-1" : "gap-2"} ${compact ? `rounded-lg border border-line bg-surface ${accent}` : ""}`}
                style={phone || compact ? undefined : { display: "grid", gridTemplateColumns: template }}
              >
                {compact ? (
                  <div role="rowheader" className="flex items-center gap-2 px-3 min-w-0">
                    {title}
                    {openControl}
                    {!phone && bar}
                    {phone && blocked ? (
                      <span className="shrink-0 text-xs font-semibold text-danger"><span aria-hidden="true">⊘ </span>{rollup.blocked}<span className="sr-only"> blocked</span></span>
                    ) : (
                      <span className={`shrink-0 text-xs ${blocked ? "text-danger font-semibold" : "text-fg-secondary"}`}>{compactRowLabel(row)}</span>
                    )}
                  </div>
                ) : phone ? (
                  // Phone: parent names are headings inside the shown column (canvas 6b).
                  <div role="rowheader" className="flex items-center gap-2 min-w-0">
                    <h4 className="m-0 flex-1 min-w-0 flex">{title}</h4>
                    {openControl}
                  </div>
                ) : (
                  <div role="rowheader" className={`flex flex-col gap-1.5 min-w-0 rounded-lg border border-line bg-surface px-3 py-2.5 ${accent}`}>
                    {title}
                    <span className="flex items-center justify-between gap-2">{meta}{openControl}</span>
                    {rollup && (
                      <span className="flex items-center gap-1.5 text-xs text-fg-secondary">
                        {bar}
                        <span className="shrink-0">{rowDoneLabel(row)}</span>
                      </span>
                    )}
                  </div>
                )}
                {locked && (
                  <div
                    role="gridcell"
                    {...focusProps({ r, c: 1, i: 0, key: `${gridKey}:${r}:1:0` })}
                    data-testid="children-locked-cell"
                    className={`${FOCUS} flex items-center gap-2 min-h-11 rounded-lg border border-dashed border-line-strong px-3 py-2 text-[13px] text-fg-secondary`}
                    style={{ gridColumn: "2 / -1" }}
                  >
                    <LockIcon />
                    <span>{lockedRowText(row.rollup.total)}</span>
                  </div>
                )}
                {open && cells.flatMap(({ col, kids, planned, plannedShown }, ci) => {
                  const base = { r, c: ci + 1 };
                  const count = plannedShown ? kids.length : kids.length + planned.length;
                  const doneFolded = col.is_done && !options.showDone;
                  const cell = (
                    <div role="gridcell" key={col.id} data-cell={`${row.id}:${col.id}`} aria-label={cellName(row.title, col.name, count)} className={`flex flex-col gap-1.5 min-w-0 ${phone ? "" : "rounded-lg bg-canvas p-1.5"} ${doneFolded ? "items-center justify-center" : ""}`}>
                      {col.is_done && !options.showDone ? (
                        row.rollup.visible && row.rollup.done > 0 ? (
                          <button
                            type="button"
                            {...focusProps({ ...base, i: 0, key: `${gridKey}:${r}:${ci + 1}:0` })}
                            aria-label={`${row.rollup.done} done. Show done cards`}
                            onClick={() => { cellFocus.current = { rowId: row.id, colId: col.id, seq: readSeq }; onOptionsChange({ ...options, showDone: true }); }}
                            className={`${FOCUS} ${tgt} w-full text-[13px] text-fg-secondary hover:text-fg rounded`}
                          >
                            {row.rollup.done} done · <span className="text-link underline">Show</span>
                          </button>
                        ) : (
                          <span {...focusProps({ ...base, i: 0, key: `${gridKey}:${r}:${ci + 1}:0` })} className={`${FOCUS} text-[13px] text-fg-secondary rounded`}>0 done</span>
                        )
                      ) : (
                        <>
                          {kids.map((k, i) => renderChild(k, col.name, { ...base, i, key: `${gridKey}:${r}:${ci + 1}:${i}` }, gridKey, focusProps, row, board))}
                          {planned.length > 0 && (
                            <button
                              type="button"
                              {...focusProps({ ...base, i: kids.length, key: `${gridKey}:${r}:${ci + 1}:${kids.length}` })}
                              aria-expanded={plannedShown}
                              onClick={() => {
                                setPlannedOpen((s) => toggle(s, row.id));
                                // The button keeps focus and moves past (or back over) the planned cards: keep it the stop.
                                const i = plannedShown ? kids.length - planned.length : kids.length + planned.length;
                                setActive((a) => ({ ...a, [gridKey]: `${gridKey}:${r}:${ci + 1}:${i}` }));
                              }}
                              className={`${FOCUS} ${tgt} text-left rounded border border-dashed border-line-strong px-2 text-xs text-fg-secondary hover:text-fg`}
                            >
                              {planned.length} planned · <span className="text-link">{plannedShown ? "Hide" : "Show"}</span>
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
                  return !phone && ci === padAt ? [...pads(`pad-${row.id}`), cell] : [cell];
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
      {(phone || !onBoardTotal) && (
        <p data-testid="children-board-total" className="px-4 pt-2 text-xs text-fg-secondary">{boardTotal} in progress</p>
      )}
      <span role="status" aria-live="polite" className="sr-only">{copied}</span>
      <div aria-hidden="true" className="h-3" />
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
      {empty && (
        <div data-testid="children-empty" className="mx-3 rounded-lg border border-line bg-surface px-4 py-8 text-center">
          <p className="text-sm font-medium text-fg">No cards on this board have children yet.</p>
          <p className="mt-1 text-sm text-fg-secondary">Add a child from a card&apos;s Children tab, and its parent shows here under its lane.</p>
        </div>
      )}
      {!empty && lanes.map((lane) => {
        const isCollapsed = collapsed.has(lane.id);
        const st = laneRows[lane.id];
        const rowsHere = st?.rows ?? [];
        const large = lane.parents > LARGE_LANE_PARENTS;
        const unfolded = rowsHere.filter((r) => r.rollup.visible && !isFoldedRow(r, options.planned));
        const folded = rowsHere.filter((r) => isFoldedRow(r, options.planned));
        const locked = rowsHere.filter((r) => !r.rollup.visible);
        const foldShown = foldOpen.has(lane.id);
        const drawn = [...unfolded, ...(foldShown ? folded : [])]
          .filter((r) => !options.blockedOnly || (r.rollup.visible && r.rollup.blocked > 0));
        const sectionIds = [...new Set(drawn.map((r) => r.child_board_id).filter((id): id is number => id != null))];
        const sectionColumns = sectionIds.map((id) => boards.get(id)?.columns ?? []);
        const maxCols = Math.max(0, ...sectionColumns.map((c) => c.length));
        const narrowDone = !options.showDone && sectionColumns.every((c) => c.length > 0 && c[c.length - 1].is_done);
        const remaining = lane.parents - rowsHere.length;
        // Every lane pages on its own, loaded or not: never only the lane holding the last loaded row (#2370 fix A5).
        const canLoadMore = remaining > 0 && (st == null || st.cursor != null);
        // lane.planned_only is a subset of lane.folded; "Only planned" unfolds those rows, so they leave the button.
        const plannedOnlyFolded = options.planned === "only" ? 0 : lane.planned_only;
        const foldedCount = options.planned === "only" ? lane.folded - lane.planned_only : lane.folded;
        // Phone: one child board per lane at a time; the others are "Onboarding · 2 children · Columns ›" switches.
        const phoneBoardId = phone ? (sectionIds.includes(phoneBoard[lane.id]) ? phoneBoard[lane.id] : sectionIds[0]) : undefined;
        const shownSectionIds = phoneBoardId != null ? [phoneBoardId] : sectionIds;
        // Desktop: a locked row sits in the lane's first child-board section, in row order. The server never says
        // which board it is, so it can't be placed by board. Phone, or a lane with no section, lists them below.
        const lockedInGrid = !phone && sectionIds.length > 0;
        const sectionRows = (id: number) => {
          const own = rowsHere.filter((r) => drawn.includes(r) ? r.child_board_id === id : lockedInGrid && id === sectionIds[0] && !r.rollup.visible);
          return own;
        };
        const total = laneTotalParts(lane);
        const idle = isCollapsed ? laneIdleLabel(lane, stalenessDays) : null;
        const actions = (
          <>
            {/* Lane actions beside the name: Focus (everyone), Copy link (this mode only), the admin ⋮. */}
            {onFocusLane && (
              <button
                type="button"
                aria-pressed={focusLane === lane.id}
                aria-label={`Focus on ${lane.name}`}
                onClick={() => onFocusLane(focusLane === lane.id ? null : lane.id)}
                className={`${FOCUS} ${tgt} px-2 text-xs rounded border ${focusLane === lane.id ? "border-info text-info-on-tint bg-info/10" : "border-line-strong text-fg-secondary hover:bg-surface-hover hover:text-fg"}`}
              >
                Focus
              </button>
            )}
            <button type="button" onClick={() => void copyLink(lane)} aria-label={copiedLane?.id === lane.id ? undefined : `Copy link to ${lane.name}`} className={`${FOCUS} ${tgt} px-2 text-xs text-fg-secondary rounded border border-line-strong hover:bg-surface-hover hover:text-fg`}>
              {copiedLane?.id === lane.id ? (copiedLane.ok ? "Link copied" : "Copy link") : "Copy link"}
            </button>
            {copiedLane?.id === lane.id && !copiedLane.ok && <span className="text-xs text-danger">Couldn&apos;t copy the link</span>}
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
        const toggleLane = () => {
          collapseTouched.current = true;
          // A lane opened after the first read reads its own rows (#2370 fix A1).
          if (isCollapsed && st == null && lane.parents > 0) void loadLane(lane.id);
          setCollapsed((s) => toggle(s, lane.id));
        };
        return (
          <section key={lane.id} data-lane-section={lane.id} aria-label={`${lane.name} lane`} className="mx-3 mb-2">
            {phone ? (
              // Phone band (canvas 6b, as PhoneBoard's): tinted with the lane color; line one is the collapse button
              // with the name and total, line two the blocked count and "+N on a board you can't open", then the
              // lane actions row, styled as PhoneBoard's phone-lane-footer (#2498). Text on the tint is fg / fg-secondary / *-on-tint only.
              <div role="group" aria-label={laneBandName(lane)} data-testid="children-phone-band" style={columnTintStyle(laneColors?.[lane.id])} className="flex flex-col rounded-lg border border-line-strong bg-surface">
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
                    {laneColors?.[lane.id] && <span aria-hidden="true" data-testid="children-lane-swatch" className="w-2.5 h-2.5 shrink-0 rounded-sm color-dot" style={{ backgroundColor: laneColors[lane.id] }} />}
                    <span className="text-[17px] font-semibold text-fg min-w-0 break-words">{lane.name}</span>{" "}
                    <span className="min-w-0 text-xs text-fg-secondary">{laneTotalLabel(lane)}</span>
                  </button>
                </h3>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-9 pr-3 pb-2 text-xs">
                  <span className={lane.blocked > 0 ? "text-danger-on-tint font-semibold" : "text-fg-secondary"}>{laneBlockedLabel(lane)}</span>
                  {lane.hidden > 0 && <span className="inline-flex items-center gap-1 text-fg-secondary"><LockIcon />{phoneHiddenLabel(lane.hidden)}</span>}
                  {idle && <span className="text-warning-on-tint font-semibold">{idle}</span>}
                </div>
                {/* Collapsed, the band is the canvas's two lines; the actions return with the lane. */}
                {!isCollapsed && <div data-testid="children-lane-actions" className="flex flex-wrap items-center gap-2 border-t border-line-subtle px-3 pb-2.5 pt-2">{actions}</div>}
              </div>
            ) : (
            <div role="group" aria-label={laneBandName(lane)} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 min-h-11 pr-3 py-1 rounded-lg border border-line-strong bg-surface">
              <h3 className="m-0">
                <button
                  type="button"
                  data-lane-toggle={lane.id}
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${lane.name}`}
                  onClick={toggleLane}
                  className={`${FOCUS} ${tgt} flex items-center gap-2 rounded pl-3 pr-1 text-[17px] font-semibold text-fg text-left`}
                >
                  <svg aria-hidden="true" className={`w-3 h-3 shrink-0 text-fg-secondary ${isCollapsed ? "-rotate-90" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6l5 5 5-5" /></svg>
                  {lane.name}
                </button>
              </h3>
              {/* A collapsed band is its name and totals only (canvas 6a); the actions return with the lane. */}
              {!isCollapsed && actions}
              <span className="text-xs text-fg-secondary">{isCollapsed ? parentsLabel(lane.parents) : laneSubtitle(lane)}</span>
              <ChildStateBar counts={lane} className="w-52" />
              <span className="text-xs text-fg-secondary">
                <b className="font-semibold text-fg">{total.active}</b>{total.rest}
                {lane.blocked === 0 && <> · {laneBlockedLabel(lane)}</>}
              </span>
              {lane.blocked > 0 && <span className="text-xs text-danger font-semibold"><span aria-hidden="true">⊘</span> {laneBlockedLabel(lane)}</span>}
              {idle && <span className="text-xs text-warning font-semibold">{idle}</span>}
              {lane.hidden > 0 && <span className="inline-flex items-center gap-1 text-xs text-fg-secondary lg:ml-auto"><LockIcon />+{lane.hidden} on a board you can&apos;t open</span>}
            </div>
            )}
            {!isCollapsed && (
              <div className="flex flex-col pb-1">
                <ChangesPill
                  count={held?.[lane.id] ? pendingRowChanges(rowsHere, held[lane.id], lane.id) : 0}
                  laneName={lane.name}
                  phone={phone}
                  onShow={() => { focusLaneGrid.current = lane.id; gridFocus.current = null; applyHeld(); setFocusTick((n) => n + 1); }}
                />
                {shownSectionIds.map((id) => {
                  const b = boards.get(id);
                  return b ? renderSection(lane, b, sectionRows(id), { maxCols, narrowDone, first: id === sectionIds[0] }, large) : null;
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
                      className={`${FOCUS} mt-2 w-full min-h-11 px-3 flex items-center justify-between gap-2 text-sm text-fg rounded border border-line-strong hover:bg-surface-hover`}
                    >
                      <span className="min-w-0 break-words text-left">{childBoardSwitchLabel(b.name, drawn.filter((r) => r.child_board_id === id))}</span>
                      <span className="shrink-0 text-xs text-fg-secondary">Columns <span aria-hidden="true">›</span></span>
                    </button>
                  );
                })}
                {!lockedInGrid && locked.map((row) => (
                  <div key={row.id} data-testid="children-locked-row" className="mt-2 flex items-center gap-2 rounded border border-dashed border-line-strong px-3 py-2 text-sm text-fg-secondary">
                    <LockIcon />
                    {/* One run of text (canvas 2f g), never squeezed columns at phone width. */}
                    <span className="min-w-0 break-words"><span className="font-medium text-fg">{row.title}</span> · {lockedRowText(row.rollup.total)}</span>
                  </div>
                ))}
                {folded.length > 0 && (
                  <button
                    type="button"
                    aria-expanded={foldShown}
                    onClick={() => setFoldOpen((s) => toggle(s, lane.id))}
                    className={`${FOCUS} ${tgt} mt-2 px-3 text-[13px] text-fg rounded-md border border-dashed border-line-strong bg-surface hover:bg-surface-hover ${phone ? "" : "ml-6 self-start"}`}
                  >
                    {foldLabel(foldedCount, plannedOnlyFolded)}
                  </button>
                )}
                {canLoadMore && (
                  <button
                    type="button"
                    disabled={loadingLane === lane.id}
                    onClick={() => void loadLane(lane.id)}
                    className={`${FOCUS} ${tgt} mt-2 px-3 text-sm text-link rounded hover:bg-surface-hover ${phone ? "" : "ml-6 self-start"}`}
                  >
                    {moreParentsLabel(remaining, phone)}
                  </button>
                )}
                {moreError === lane.id && <p role="alert" className="mx-2 mt-1 text-sm text-danger">Couldn&apos;t load more parents. Try again.</p>}
                {drawn.length === 0 && rowsHere.some((r) => r.rollup.visible) && (options.blockedOnly || options.planned === "only") && !foldShown && (
                  <p className="px-3 py-2 text-sm text-fg-secondary">{options.blockedOnly ? "No blocked children in this lane." : "No planned children in this lane."} Change it in View.</p>
                )}
                {rowsHere.length === 0 && lane.parents === 0 && <p className="px-3 py-2 text-sm text-fg-secondary">No parents in this lane.</p>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
