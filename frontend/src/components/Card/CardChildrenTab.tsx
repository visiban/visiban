import { useEffect, useLayoutEffect, useRef, useState } from "react";
import axios from "axios";
import { getChildBoardOptions, moveCard, unlinkCardChild } from "../../api/cards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import type { BoardFull, CardChildRow, CardChildrenColumn } from "../../types";
import { formatBlockedDuration } from "../../utils/blockedState";
import { isImeComposing } from "../../utils/imeComposition";
import Avatar from "../Common/Avatar";
import AddChildDialog from "./AddChildDialog";
import ChildCardPicker from "./ChildCardPicker";
import { CHILDREN_BOARD_ESCAPE_PRIORITY, CHILD_MOVE_ESCAPE_PRIORITY, WIDE_MIN_PX, WRITE_ROLES, describeChildrenChange, type ChildrenState } from "./cardChildren";

type Segment = "done" | "doing" | "blocked" | "todo";

function segmentOf(child: CardChildRow, columns: CardChildrenColumn[]): Segment {
  const col = columns.find((c) => c.id === child.column_id);
  if (col?.is_done) return "done";
  if (child.blocked) return "blocked";
  return columns[0]?.id === child.column_id ? "todo" : "doing";
}

/** The board treats a `wip_limit` of 0 as no limit (ColumnHeader, PhoneBoard); so does this tab. */
function hasLimit(col: CardChildrenColumn): col is CardChildrenColumn & { wip_limit: number } {
  return col.wip_limit != null && col.wip_limit > 0;
}

function atLimit(col: CardChildrenColumn): boolean {
  return hasLimit(col) && col.card_count >= col.wip_limit;
}

interface Props {
  board: Pick<BoardFull, "id" | "name" | "cards_can_have_children" | "current_user_role">;
  cardId: number;
  cardTitle: string;
  /** The parent's column, for the Add child dialog's header line. */
  cardColumnName?: string;
  state: ChildrenState;
  /** Escape from the board returns focus to the tab list. */
  onExitToTabs: () => void;
  /**
   * Bumps on every `card.children_changed` ping. The ping carries no actor, so this tab cannot tell its own echo
   * from someone else's; it therefore treats every re-read that lands while one of its own writes is pending as
   * that write's (rule C's accepted trade-off). Accepted for compatibility with the caller's prop contract and
   * currently unused.
   */
  remoteSignal?: number;
}

/**
 * The Children tab (#2209): a lens over the parent's one child board, scoped to this card (owner design note
 * 2026-11-16). Children stay real cards on their own board; every column, count, color and limit here is the
 * child board's own, and a move goes through the child board's move endpoint and role, so its WIP limits,
 * `CardMovement` history and broadcasts apply unchanged. The parent board's role never authorizes a write on
 * the child board: Move needs member on the child board, Add child and Link existing member on both.
 */
export default function CardChildrenTab({ board, cardId, cardTitle, cardColumnName, state, onExitToTabs }: Props) {
  const { data, error, loading, reload } = state;
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const linkRef = useRef<HTMLButtonElement>(null);
  const [wide, setWide] = useState(true);
  const [adding, setAdding] = useState(false);
  const [linkBoards, setLinkBoards] = useState<{ id: number; name: string }[] | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [announcement, setAnnouncementState] = useState({ text: "", n: 0 });
  // Every call re-announces, even identical text: the counter alternates a trailing no-break space so the live
  // region's content changes (frontend/CLAUDE.md § Children tab (#2209), rule C). A timer below clears stale text.
  const setAnnouncement = (text: string) => setAnnouncementState((a) => ({ text, n: a.n + 1 }));
  const [activeId, setActiveId] = useState<number | null>(null);
  const [shownColumnId, setShownColumnId] = useState<number | null>(null);
  const [moving, setMoving] = useState<CardChildRow | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // After a write unmounts the focused control, focus goes back to the card (or Add child) once the re-read lands.
  const pendingFocus = useRef<number | "add" | null>(null);
  // A re-read after this tab's own write is announced by that write; any other re-read (a
  // `card.children_changed` ping, #2209 row 13) announces what changed, once.
  const prevData = useRef(data);
  // Set at the START of a write, before its await: the actor's own socket receives the parent-board ping too,
  // and that echo (or a genuine ping) landing before the write's re-read must not replace the write's message.
  // Any re-read that lands while the flag is set is swallowed (the data still refreshes). The accepted
  // trade-off: a truly simultaneous remote change is not announced separately.
  const localWrite = useRef(false);
  const beginWrite = () => { localWrite.current = true; };
  const reloadAfterWrite = () => { localWrite.current = true; reload(); };
  const tgt = wide ? "" : "min-h-11";

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= WIDE_MIN_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEscapeStack(() => {
    if (!gridRef.current?.contains(document.activeElement)) return false;
    onExitToTabs();
    return true;
  }, CHILDREN_BOARD_ESCAPE_PRIORITY);

  const parentRole = board.current_user_role ?? "";
  const childBoard = data?.board;
  const columns = childBoard?.columns ?? [];
  const children = data?.visible ? data.results : [];
  const canLinkHere = board.cards_can_have_children && WRITE_ROLES.has(parentRole);
  // With children, the child board's role is known; with none, the chooser decides (#2208).
  const canAddOrLink = canLinkHere && data?.visible !== false && (!childBoard || WRITE_ROLES.has(childBoard.role));
  const canMove = !!childBoard && WRITE_ROLES.has(childBoard.role);
  const boardName = childBoard?.name ?? "";
  const childUrl = (id: number) => `/boards/${childBoard?.id}?card=${id}`;

  const byColumn = (colId: number) =>
    children.filter((c) => c.column_id === colId).sort((a, b) => a.position - b.position || a.id - b.id);
  const nonEmpty = columns.filter((c) => byColumn(c.id).length > 0);
  const shownColumn = columns.find((c) => c.id === shownColumnId) ?? nonEmpty[0] ?? columns[0];
  const shownColumns = wide ? columns : shownColumn ? [shownColumn] : [];

  const counts = { done: 0, doing: 0, blocked: 0, todo: 0 } as Record<Segment, number>;
  for (const c of children) counts[segmentOf(c, columns)] += 1;
  const total = children.length;
  const doneLine = (n: number) => `${n} of ${total} done`;

  const openLinkExisting = async () => {
    setLinkError(null);
    try {
      const o = await getChildBoardOptions(board.id, cardId);
      const fixed = o.fixed_board && !o.fixed_board.hidden ? [{ id: o.fixed_board.id, name: o.fixed_board.name }] : null;
      const boards = fixed ?? (o.default ? [o.default] : o.boards.map((b) => ({ id: b.id, name: b.name })));
      if (boards.length === 0) setLinkError("There is no board you can link children from.");
      else setLinkBoards(boards);
    } catch {
      setLinkError("Couldn't load the child boards. Try again.");
    }
  };

  const unlink = async (child: CardChildRow) => {
    setActionError(null);
    beginWrite();
    try {
      await unlinkCardChild(board.id, cardId, child.id);
      setAnnouncement(`Unlinked ${child.title}.`);
      const list = byColumn(child.column_id).filter((c) => c.id !== child.id);
      pendingFocus.current = list[0]?.id ?? children.find((c) => c.id !== child.id)?.id ?? "add";
      reloadAfterWrite();
    } catch {
      localWrite.current = false;
      setActionError(`Couldn't unlink ${child.title}. Try again.`);
    }
  };

  const move = async (child: CardChildRow, col: CardChildrenColumn) => {
    if (!childBoard) return;
    setMoveError(null);
    beginWrite();
    try {
      await moveCard(childBoard.id, child.id, { column_id: col.id, swimlane_id: child.swimlane_id, position: col.card_count });
      const doneAfter = counts.done
        + (col.is_done ? 1 : 0)
        - (columns.find((c) => c.id === child.column_id)?.is_done ? 1 : 0);
      setAnnouncement(`${child.title} moved to ${col.name}. ${doneLine(doneAfter)}.`);
      setMoving(null);
      setActiveId(child.id);
      pendingFocus.current = child.id;
      focusCard(child.id);
      reloadAfterWrite();
    } catch (err) {
      localWrite.current = false;
      const detail = axios.isAxiosError(err) ? (err.response?.data as { detail?: unknown } | undefined)?.detail : undefined;
      setMoveError(typeof detail === "string" ? detail : `Couldn't move ${child.title}. Try again.`);
    }
  };

  // Roving focus (#2206 rule 9): the board is one Tab stop; arrows move inside it.
  const focusCard = (id: number) => {
    setActiveId(id);
    queueMicrotask(() => gridRef.current?.querySelector<HTMLElement>(`[data-child-id="${id}"]`)?.focus());
  };
  const onCardKeyDown = (e: React.KeyboardEvent, child: CardChildRow) => {
    if (isImeComposing(e)) return;
    const visibleCols = shownColumns.filter((c) => byColumn(c.id).length > 0);
    const ci = visibleCols.findIndex((c) => c.id === child.column_id);
    const list = byColumn(child.column_id);
    const ri = list.findIndex((c) => c.id === child.id);
    let target: CardChildRow | undefined;
    if (e.key === "ArrowDown") target = list[ri + 1];
    else if (e.key === "ArrowUp") target = list[ri - 1];
    else if (e.key === "Home") target = list[0];
    else if (e.key === "End") target = list[list.length - 1];
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const next = visibleCols[ci + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) {
        const nl = byColumn(next.id);
        target = nl[Math.min(ri, nl.length - 1)];
      }
    } else return;
    e.preventDefault();
    if (target) focusCard(target.id);
  };
  const rovingId = children.some((c) => c.id === activeId && shownColumns.some((s) => s.id === c.column_id))
    ? activeId
    : shownColumns.flatMap((c) => byColumn(c.id))[0]?.id ?? null;

  useEffect(() => {
    const prev = prevData.current;
    prevData.current = data;
    if (localWrite.current) {
      localWrite.current = false;
      return;
    }
    // Access to the child board lost: drop any title the live region still holds.
    if (data && !data.visible) { setAnnouncement(""); return; }
    const msg = describeChildrenChange(prev, data);
    if (msg) setAnnouncement(msg);
  }, [data]);
  // A failed re-read leaves the data as it was; the next change is someone else's.
  useEffect(() => { if (error) localWrite.current = false; }, [error]);

  // Stale text must not linger for a screen reader's virtual cursor; the visible default-not-set notice stays.
  useEffect(() => {
    if (!announcement.text || announcement.text.includes("default was not changed")) return;
    const t = setTimeout(() => setAnnouncementState((a) => (a.n === announcement.n ? { text: "", n: a.n } : a)), 8000);
    return () => clearTimeout(t);
  }, [announcement]);

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null || !data) return;
    pendingFocus.current = null;
    if (target === "add") addRef.current?.focus();
    else focusCard(target);
  }, [data]);

  const onColumnButtonsKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = columns.findIndex((c) => c.id === shownColumn?.id);
    const next = columns[(i + (e.key === "ArrowRight" ? 1 : columns.length - 1)) % columns.length];
    setShownColumnId(next.id);
    queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>(`[data-column-button="${next.id}"]`)?.focus());
  };

  const actions = canAddOrLink && (
    <div className={`flex gap-2 items-center ${wide ? "" : "flex-col items-stretch"}`}>
      <button
        ref={addRef}
        type="button"
        onClick={() => setAdding(true)}
        className={`${tgt} px-3 py-1.5 text-sm font-medium rounded bg-button-primary hover:bg-button-primary-hover text-on-primary focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
      >
        {wide ? "Add child" : `Add child${boardName ? ` to ${boardName}` : ""}`}
      </button>
      <button
        ref={linkRef}
        type="button"
        onClick={() => void openLinkExisting()}
        className={`${tgt} px-3 py-1.5 text-sm text-fg-secondary border border-line rounded hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
      >
        {wide ? "Link existing" : "Link existing card"}
      </button>
    </div>
  );

  const body = (() => {
    if (loading && !data) {
      return (
        <div className="flex flex-col gap-3">
        {actions}
        <div role="status" aria-label="Loading children" className="flex flex-col gap-3" data-testid="children-skeleton">
          <div className="h-5 w-40 rounded bg-surface-hover" />
          <div className="h-2 w-full rounded bg-surface-hover" />
          <div className="flex gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-8 flex-1 rounded bg-surface-hover" />)}</div>
        </div>
        </div>
      );
    }
    if (error && !data) {
      return (
        <div role="alert" className="flex flex-col gap-2 items-start">
          <p className="text-sm font-medium text-fg">The children didn&apos;t load</p>
          <p className="text-xs text-fg-muted">Check your connection and try again. The rollup on the card face stays as last known.</p>
          <button type="button" onClick={reload} className={`${tgt} px-3 py-1.5 text-sm text-fg-secondary border border-line rounded hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}>Try again</button>
        </div>
      );
    }
    // Count 0 (every child archived) falls through to the ordinary no-children state, so a
    // hidden board's former links are not disclosed.
    if (data && !data.visible && data.count > 0) {
      // Accepted disclosure (#1104 sign-off 2026-11-17): the number only, nothing else.
      return <p className="text-sm text-fg-muted" data-testid="children-hidden">{data.count} {data.count === 1 ? "child" : "children"} on a board you can&apos;t open</p>;
    }
    if (total === 0) {
      return (
        <div className="flex flex-col gap-2 items-start" data-testid="children-empty">
          <p className="text-sm font-medium text-fg">No children yet</p>
          <p className="text-xs text-fg-muted">Children are cards on {boardName || "another board"} that belong to this one. They move on their own board.</p>
          {actions}
        </div>
      );
    }
    const hiddenOthers = columns.reduce((n, c) => n + c.card_count, 0) - total;
    const segments: [Segment, string, string][] = [
      ["done", "done", "bg-success"],
      ["doing", "doing", "bg-info"],
      ["blocked", "blocked", "bg-danger"],
      ["todo", "to do", "bg-fg-tertiary"],
    ];
    return (
      <div className="flex flex-col gap-4">
        <div className={`flex gap-3 ${wide ? "items-center justify-between" : "flex-col"}`}>
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-base font-semibold text-fg">{doneLine(counts.done)}</span>
              {counts.blocked > 0 && <span className="text-sm text-danger"><span aria-hidden="true">⊘ </span>{counts.blocked} blocked</span>}
            </div>
            <div
              role="img"
              aria-label={segments.map(([k, label]) => `${counts[k]} ${label}`).join(", ")}
              className="flex h-2 w-full rounded overflow-hidden bg-surface-hover"
            >
              {segments.map(([k, , cls]) => counts[k] > 0 && (
                <span key={k} className={cls} style={{ width: `${(counts[k] / total) * 100}%` }} />
              ))}
            </div>
          </div>
          {wide && columns[0] && canAddOrLink && <span className="text-xs text-fg-muted">New children go to {boardName} · {columns[0].name}</span>}
          {actions}
          {!wide && columns[0] && canAddOrLink && <span className="text-xs text-fg-muted">New children go to {boardName} · {columns[0].name}</span>}
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-fg">{boardName} board · this card&apos;s {total} {total === 1 ? "child" : "children"}</h4>
            <a href={`/boards/${childBoard?.id}?f_parent=${cardId}`} className={`${tgt} inline-flex items-center text-sm text-link hover:underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded`}>Open on {boardName}</a>
          </div>
          <p className="text-xs text-fg-muted">A filtered view of {boardName}. Columns, limits and history are {boardName}&apos;s own.</p>
        </div>

        {!wide && (
          <div role="group" aria-label={`Columns on ${boardName}`} className="flex gap-1 overflow-x-auto" onKeyDown={onColumnButtonsKeyDown}>
            {columns.map((c) => (
              <button
                key={c.id}
                type="button"
                data-column-button={c.id}
                aria-pressed={c.id === shownColumn?.id}
                tabIndex={c.id === shownColumn?.id ? 0 : -1}
                onClick={() => setShownColumnId(c.id)}
                className={`min-h-11 inline-flex items-center gap-1.5 px-3 text-sm rounded border focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${c.id === shownColumn?.id ? "border-info text-fg" : "border-line text-fg-secondary"}`}
              >
                <span aria-hidden="true" className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />
                {c.name}
                <span className="text-fg-tertiary">{byColumn(c.id).length}</span>
              </button>
            ))}
          </div>
        )}

        <div
          ref={gridRef}
          role="group"
          aria-label={`${boardName} board, this card's children`}
          className={wide ? "grid gap-3" : "flex flex-col"}
          style={wide ? { gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))` } : undefined}
        >
          {shownColumns.map((col) => {
            const list = byColumn(col.id);
            // WIP state in words, never color alone (frontend/CLAUDE.md § Children tab (#2209), rule B): at the limit and over it are both said.
            const wipState = hasLimit(col) ? (col.card_count > col.wip_limit ? "over limit" : col.card_count === col.wip_limit ? "at limit" : "") : "";
            const limit = hasLimit(col) ? ` · limit ${col.wip_limit}${wipState ? `, ${wipState}` : ""}` : "";
            return (
              <section key={col.id} aria-label={col.name} className="flex flex-col gap-2 min-w-0">
                <div className="flex flex-col gap-0.5 border-t-2 pt-1.5" style={{ borderTopColor: col.color }}>
                  {wide && <span className="text-xs font-semibold text-fg-secondary uppercase">{col.name}</span>}
                  {/* Narrow (one column at a time): the limit line under the column buttons (#2209 row 12). */}
                  <span className="text-xs text-fg-muted" data-testid="children-limit-line">
                    {wide ? `${list.length} of ${col.card_count} on ${boardName}${limit}` : `${list.length} of ${col.card_count} on ${boardName} are this card's${limit}`}
                  </span>
                  {hasLimit(col) && (
                    // The child board's own WIP meter for the whole column; the line above says it in words.
                    <span aria-hidden="true" data-testid="children-wip-meter" className="block h-1 w-full rounded bg-surface-hover overflow-hidden">
                      <span
                        className={`block h-full ${col.card_count > col.wip_limit ? "bg-warning" : "bg-fg-tertiary"}`}
                        // Non-color cue: over limit is striped, at limit is full width with a solid end cap.
                        style={{
                          width: `${Math.min(100, (col.card_count / col.wip_limit) * 100)}%`,
                          ...(col.card_count > col.wip_limit ? { backgroundImage: "repeating-linear-gradient(45deg, transparent 0 3px, rgb(0 0 0 / 0.35) 3px 5px)" } : {}),
                          ...(col.card_count === col.wip_limit ? { borderRight: "3px solid currentColor" } : {}),
                        }}
                      />
                    </span>
                  )}
                </div>
                {list.map((child, i) => (
                  <div key={child.id} className="flex flex-col gap-1 rounded border border-line bg-surface p-2">
                    <a
                      href={childUrl(child.id)}
                      data-child-id={child.id}
                      tabIndex={child.id === rovingId ? 0 : -1}
                      onFocus={() => setActiveId(child.id)}
                      onKeyDown={(e) => onCardKeyDown(e, child)}
                      aria-label={`${child.title}, ${col.name}${child.assignee ? `, ${child.assignee.display_name || child.assignee.username}` : ""}${child.blocked ? ", blocked" : ""}, ${i + 1} of ${list.length}`}
                      className={`${tgt} ${wide ? "" : "flex items-center"} text-sm text-fg hover:underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded`}
                    >
                      {child.title}
                    </a>
                    <div className="flex items-center gap-2 text-xs">
                      {child.blocked && (
                        <span className="text-danger">
                          <span aria-hidden="true">⊘</span>
                          {child.blocked_at ? ` ${formatBlockedDuration(Date.now() - Date.parse(child.blocked_at), 1)}` : ""}
                        </span>
                      )}
                      {child.assignee && <Avatar user={child.assignee} size="sm" />}
                      <span className="flex-1" />
                      {canMove && (
                        <button
                          type="button"
                          tabIndex={child.id === rovingId ? 0 : -1}
                          aria-label={`Move ${child.title}`}
                          onClick={() => setMoving(child)}
                          className={`${tgt} ${wide ? "" : "min-w-11"} px-2 py-0.5 text-xs text-fg-secondary rounded hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
                        >
                          Move
                        </button>
                      )}
                      {canLinkHere && data?.visible && (
                        <button
                          type="button"
                          tabIndex={child.id === rovingId ? 0 : -1}
                          aria-label={`Unlink child ${child.title}`}
                          onClick={() => void unlink(child)}
                          className={`${tgt} ${wide ? "" : "min-w-11"} px-2 py-0.5 text-xs text-fg-secondary rounded hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
                        >
                          Unlink
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            );
          })}
        </div>

        {hiddenOthers > 0 && <p className="text-xs text-fg-muted">{hiddenOthers} other {hiddenOthers === 1 ? "card" : "cards"} on {boardName} {hiddenOthers === 1 ? "is" : "are"} hidden by this view.</p>}
        <p className="text-xs text-fg-muted">Arrows move between cards · Enter open on {boardName} · Esc back</p>
      </div>
    );
  })();

  return (
    <div ref={rootRef} className="flex flex-col gap-4" data-testid="card-children-tab">
      {body}
      {error && data && (
        <div role="alert" className="flex items-center gap-2 text-xs text-danger">
          <span>Couldn&apos;t refresh the children.</span>
          <button type="button" onClick={reload} className={`${tgt} px-2 text-xs text-fg-secondary border border-line rounded hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}>Try again</button>
        </div>
      )}
      {linkError && <p role="alert" className="text-xs text-danger">{linkError}</p>}
      <p role="alert" className={actionError ? "text-xs text-danger" : "sr-only"}>{actionError ?? ""}</p>
      <p role="status" aria-live="polite" aria-atomic="true" className={announcement.text.includes("default was not changed") ? "text-xs text-fg-secondary" : "sr-only"}>{announcement.text ? announcement.text + (announcement.n % 2 ? "\u00A0" : "") : ""}</p>
      {moving && childBoard && (
        <ChildMovePopover
          child={moving}
          boardName={boardName}
          columns={columns}
          error={moveError}
          onMove={(col) => void move(moving, col)}
          onClose={() => { const id = moving.id; setMoving(null); setMoveError(null); focusCard(id); }}
        />
      )}
      {adding && (
        <AddChildDialog
          boardId={board.id}
          boardName={board.name}
          cardId={cardId}
          parentTitle={cardTitle}
          parentColumn={cardColumnName}
          onWriteStart={beginWrite}
          onWriteFailed={() => { localWrite.current = false; }}
          onClose={() => { setAdding(false); queueMicrotask(() => addRef.current?.focus()); }}
          onAdded={({ boardName: b, title, defaultNotSet }) => {
            setAdding(false);
            // Visible as well as announced: the default-not-set notice is the only word the user gets
            // that the checkbox's second write failed (#2208).
            setAnnouncement(`Added "${title}" to ${b}${defaultNotSet ? "; the default was not changed" : ""}.`);
            reloadAfterWrite();
            queueMicrotask(() => addRef.current?.focus());
          }}
        />
      )}
      {linkBoards && (
        <ChildCardPicker
          boardId={board.id}
          cardId={cardId}
          cardTitle={cardTitle}
          boards={linkBoards}
          onWriteStart={beginWrite}
          onWriteFailed={() => { localWrite.current = false; }}
          onClose={() => { setLinkBoards(null); queueMicrotask(() => linkRef.current?.focus()); }}
          onLinked={(child) => {
            setLinkBoards(null);
            setAnnouncement(`Linked ${child.title}.`);
            reloadAfterWrite();
            queueMicrotask(() => linkRef.current?.focus());
          }}
        />
      )}
    </div>
  );
}

interface MoveProps {
  child: CardChildRow;
  boardName: string;
  columns: CardChildrenColumn[];
  error: string | null;
  onMove: (col: CardChildrenColumn) => void;
  onClose: () => void;
}

/**
 * The in-sheet Move picker (#2209 rulings 2026-11-17): a radio group named "Column on <board>", rows with the
 * child board's counts, at-limit columns disabled with their reason. The server re-checks the limit; its
 * refusal is shown as the tab's error line.
 */
function ChildMovePopover({ child, boardName, columns, error, onMove, onClose }: MoveProps) {
  const [choice, setChoice] = useState<number>(child.column_id);
  const firstRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // A modal over the sheet: its targets are 44px at every width.
  const tgt = "min-h-11";
  useFocusTrap(dialogRef, true);
  useEscapeStack(() => { onClose(); return true; }, CHILD_MOVE_ESCAPE_PRIORITY);
  useEffect(() => { firstRef.current?.focus(); }, []);
  const target = columns.find((c) => c.id === choice);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center max-sm:items-end">
    <div className="absolute inset-0 bg-backdrop/40" aria-hidden="true" onClick={onClose} />
    <div ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} aria-label={`Move ${child.title}`} className="relative w-[24rem] max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface shadow-xl p-4 flex flex-col gap-3 outline-none max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-fg">Move {child.title}</span>
        <button type="button" aria-label="Close move" onClick={onClose} className="w-11 h-11 flex items-center justify-center rounded text-fg-secondary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"><span aria-hidden="true">✕</span></button>
      </div>
      <div role="radiogroup" aria-label={`Column on ${boardName}`} className="flex flex-col gap-1">
        {columns.map((c) => {
          const current = c.id === child.column_id;
          const full = !current && atLimit(c);
          const label = current ? `${c.name} · current` : hasLimit(c) ? `${c.name} ${c.card_count} of ${c.wip_limit}` : c.name;
          return (
            <label key={c.id} className={`min-h-11 flex items-center gap-2 px-2 rounded ${full ? "text-fg-muted cursor-not-allowed" : "text-fg cursor-pointer hover:bg-surface-hover"}`}>
              <input
                ref={current ? firstRef : undefined}
                type="radio"
                className="accent-primary"
                name={`move-${child.id}`}
                checked={choice === c.id}
                disabled={full}
                onChange={() => setChoice(c.id)}
              />
              <span className="flex-1">{label}</span>
              {full && <span className="text-xs">At its limit of {c.wip_limit}</span>}
            </label>
          );
        })}
      </div>
      <p role="alert" className={error ? "text-xs text-danger" : "sr-only"}>{error ?? ""}</p>
      <div className="flex justify-end gap-3">
        <button type="button" onClick={onClose} className="min-h-11 px-3 py-1.5 text-sm text-fg-secondary rounded hover:bg-surface-hover hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
        <button
          type="button"
          disabled={!target || choice === child.column_id}
          onClick={() => target && onMove(target)}
          className={`${tgt} px-3 py-1.5 text-sm font-medium rounded bg-button-primary hover:bg-button-primary-hover text-on-primary focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40`}
        >
          Move
        </button>
      </div>
    </div>
    </div>
  );
}
