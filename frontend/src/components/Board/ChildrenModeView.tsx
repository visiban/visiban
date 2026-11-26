import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getChildrenView } from "../../api/cards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { ChildrenView, ChildrenViewBoard, ChildrenViewChild, ChildrenViewLane, ChildrenViewRow } from "../../types";
import {
  CHILDREN_MODE_ESCAPE_PRIORITY, LARGE_LANE_PARENTS, blockedDays, cellName, childCardName, compactRowLabel, foldLabel,
  columnHeadCaption, columnMeterPct, isFoldedRow, laneBandName, laneBlockedLabel, laneLink, laneSubtitle, laneTotalLabel, lockedRowText, moreParentsLabel,
  parentsLabel, rowDoneLabel, shownInProgress, visibleChildren, type ChildrenModeOptions,
} from "../../utils/childrenMode";
import Avatar from "../Common/Avatar";
import OverflowMenu from "../Layout/OverflowMenu";

/**
 * Children mode on the Board tab (#2370, planned sections #2550; canvas 6a/6b/7/8 §3): one row per parent, grouped
 * under its lane, with the parent's children in their real columns on the child board. Read-only here: Move and the
 * live-update pill are not built yet. Every count is the server's per-viewer count; a locked row is a count only.
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
  phone?: boolean;
  /** This (parent) board's name, for the child-board heading "Parent · column on {board}". */
  boardName?: string;
  /** Focus (everyone): show only that lane (`?lane=`), or every lane on null. */
  onFocusLane?: (laneId: number | null) => void;
  /** Admin ⋮ "Edit swimlane…"; absent for a non-admin, which hides the menu. */
  onEditLane?: (laneId: number) => void;
  /** Admin ⋮ "Change field order…", when the board has lane fields to order. */
  onEditFieldOrder?: () => void;
}

const tgt = "min-h-11 sm:min-h-8";
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

// Inline SVG on currentColor, never an emoji: it tracks the theme (frontend/CLAUDE.md § Swimlane bands).
const LockIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="inline-block w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="7" width="10" height="7" rx="1" />
    <path d="M5 7V5a3 3 0 0 1 6 0v2" />
  </svg>
);

export default function ChildrenModeView({ boardId, laneId: laneProp, options, onOptionsChange, onOpenParent, refreshKey = 0, phone = false, boardName = "this board", onFocusLane, onEditLane, onEditFieldOrder }: Props) {
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

  useEffect(() => {
    const ctrl = new AbortController();
    generation.current += 1;
    setError(false);
    setMoreError(false);
    getChildrenView(boardId, { lane: laneId, done: options.showDone }, ctrl.signal)
      .then((d) => {
        setData(d);
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
  }, [boardId, laneId, options.showDone, refreshKey, retry]);

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

  const renderChild = (child: ChildrenViewChild, colName: string, stop: Stop, gridKey: string, focusProps: (s: Stop) => object, row: ChildrenViewRow) => {
    const days = blockedDays(child);
    return (
      <a
        key={child.id}
        href={`/boards/${row.child_board_id}?card=${child.id}&from_parent=${row.id}`}
        aria-label={childCardName(child, colName)}
        {...focusProps(stop)}
        data-grid={gridKey}
        className={`${FOCUS} block max-sm:min-h-11 rounded border bg-surface px-2 py-1 text-xs text-fg hover:bg-surface-hover ${child.planned ? "border-dashed border-line-strong" : "border-line"}`}
      >
        <span className="block font-medium leading-snug">{child.title}</span>
        <span className="mt-0.5 flex items-center gap-1 text-fg-secondary">
          {child.assignee && <Avatar user={child.assignee} size="sm" />}
          {child.planned && <span>Planned</span>}
          {child.blocked && <span className="text-danger font-medium"><span aria-hidden="true">⊘</span>{days != null ? ` ${days}d` : " Blocked"}</span>}
        </span>
      </a>
    );
  };

  const renderSection = (lane: ChildrenViewLane, board: ChildrenViewBoard, rows: ChildrenViewRow[], maxCols: number, large: boolean) => {
    const gridKey = `${lane.id}-${board.id}`;
    const cols = board.columns;
    const firstColId = cols[0]?.id;
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
        const kids = inCol.filter((k) => !planned.includes(k));
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
      const key = (e.target as HTMLElement).dataset.stop;
      const cur = stops.find((s) => s.key === key);
      if (!cur) return;
      let next: Stop | undefined;
      if (e.key === "ArrowDown") next = stops.find((s) => s.c === cur.c && (s.r > cur.r || (s.r === cur.r && s.i > cur.i)));
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
    return (
      <div key={board.id} className="overflow-x-auto">
        <div className="min-w-max" style={{ display: "grid", gridTemplateColumns: template }}>
          <div className="px-2 py-1 text-xs text-fg-secondary flex flex-col justify-end">
            <span className="block font-medium text-fg">Parent · column on {boardName}</span>
            <span>Children on <a href={`/boards/${board.id}`} className={`${FOCUS} text-link hover:underline rounded`}>{board.name}</a></span>
          </div>
          {cols.map((col) => {
            // Whole-column counts and the limit meter are the child board's own (artboard 6a).
            const pct = columnMeterPct(col);
            const shownHere = rows.reduce((n, r) => n + r.children.filter((k) => k.column_id === col.id).length, 0);
            return (
              <div key={col.id} className="px-2 py-1 text-xs border-l border-line" data-testid="children-column-head">
                <span className="block font-medium text-fg">{col.name}</span>
                <span className="text-fg-secondary">{columnHeadCaption(col, shownHere, board.name, options.showDone)}</span>
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
                    <span className={`block h-full ${col.card_count > (col.wip_limit ?? 0) ? "bg-danger" : "bg-primary-emphasis"}`} style={{ width: `${pct}%` }} />
                  </span>
                )}
              </div>
            );
          })}
          {Array.from({ length: maxCols - cols.length }, (_, i) => <div key={`pad-${i}`} aria-hidden="true" />)}
        </div>
        <div
          role="grid"
          aria-label={`${lane.name} children on ${board.name}, by parent`}
          data-children-grid={lane.id}
          onKeyDown={onKeyDown}
          className="min-w-max"
        >
          {cellsByRow.map(({ row, open, cells }, r) => {
            const blocked = row.rollup.visible && row.rollup.blocked > 0;
            return (
              <div
                role="row"
                key={row.id}
                className={`border-t border-line ${blocked ? "border-l-[3px] border-l-danger" : "border-l-[3px] border-l-transparent"}`}
                style={{ display: "grid", gridTemplateColumns: template }}
              >
                <div role="rowheader" className="px-2 py-1.5 flex flex-col gap-1 min-w-0">
                  <button
                    type="button"
                    {...focusProps({ r, c: 0, i: 0, key: `${gridKey}:${r}:0:0` })}
                    onClick={() => (large ? setRowOpen((m) => new Map(m).set(row.id, !open)) : onOpenParent(row.id))}
                    onKeyDown={(e) => { if (large && e.key === "Enter" && e.shiftKey) { e.preventDefault(); onOpenParent(row.id); } }}
                    {...(large ? { "aria-expanded": open } : {})}
                    className={`${FOCUS} ${tgt} text-left text-sm font-medium text-link hover:underline rounded`}
                  >
                    {row.title}
                  </button>
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
                    <div role="gridcell" key={col.id} aria-label={cellName(row.title, col.name, count)} className="px-2 py-1.5 border-l border-line flex flex-col gap-1">
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
                          {kids.map((k, i) => renderChild(k, col.name, { ...base, i, key: `${gridKey}:${r}:${ci + 1}:${i}` }, gridKey, focusProps, row))}
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
                            <span {...focusProps({ ...base, i: 0, key: `${gridKey}:${r}:${ci + 1}:0` })} className={`${FOCUS} block min-h-6 rounded`} />
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
        const plannedOnlyFolded = options.planned === "only" ? 0 : lane.planned_only;
        return (
          <section key={lane.id} aria-label={`${lane.name} lane`} className="mx-3 mb-3 rounded-lg border border-line bg-surface">
            <div role="group" aria-label={laneBandName(lane)} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 bg-surface-raised rounded-t-lg">
              <h3 className="m-0">
                <button
                  type="button"
                  data-lane-toggle={lane.id}
                  aria-expanded={!isCollapsed}
                  aria-label={phone
                    ? `${isCollapsed ? "Expand" : "Collapse"} lane ${lane.name}, ${shownInProgress(lane)} in progress of ${lane.total}`
                    : `${isCollapsed ? "Expand" : "Collapse"} ${lane.name}`}
                  onClick={() => { collapseTouched.current = true; setCollapsed((s) => toggle(s, lane.id)); }}
                  className={`${FOCUS} ${tgt} flex items-center gap-2 rounded text-[17px] font-semibold text-fg`}
                >
                  <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                  {lane.name}
                </button>
              </h3>
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
                  ariaLabel={`${lane.name} lane menu`}
                  triggerClassName={`${FOCUS} inline-flex items-center justify-center min-w-11 sm:min-w-8 ${tgt} rounded text-fg-secondary hover:text-fg hover:bg-surface-hover`}
                  items={[
                    { id: "edit", label: "Edit swimlane…", onSelect: () => onEditLane(lane.id) },
                    ...(onEditFieldOrder ? [{ id: "field-order", label: "Change field order…", onSelect: onEditFieldOrder }] : []),
                  ]}
                />
              )}
              <span className="text-xs text-fg-secondary">{isCollapsed ? parentsLabel(lane.parents) : laneSubtitle(lane)}</span>
              <span className="text-sm text-fg">{laneTotalLabel(lane)}</span>
              <LaneBar lane={lane} />
              <span className={`text-sm ${lane.blocked > 0 ? "text-danger font-medium" : "text-fg-secondary"}`}>{laneBlockedLabel(lane)}</span>
              {lane.hidden > 0 && <span className="inline-flex items-center gap-1 text-sm text-fg-secondary"><LockIcon />+{lane.hidden} on a board you can&apos;t open</span>}
            </div>
            {!isCollapsed && (
              <div className="pb-2">
                {sectionIds.map((id) => {
                  const b = boards.get(id);
                  return b ? renderSection(lane, b, drawn.filter((r) => r.child_board_id === id), maxCols, large) : null;
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
                    {foldLabel(lane.folded, plannedOnlyFolded)}
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
