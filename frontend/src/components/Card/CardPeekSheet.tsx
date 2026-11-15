import { useEffect, useMemo, useRef, useState } from "react";
import { getCardMovements } from "../../api/cards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { BOARD_SCROLL_SELECTOR, findBoardCardElement } from "../../hooks/useCardSheetPlacement";
import type { BoardFull, Card, CardMovement } from "../../types";
import { formatDateStr, formatRelativeTime, formatDueDate } from "../../utils/date";
import { failureReason, isLimitFailure } from "../../utils/moveFailure";
import { isHardLimit, limitCounts, limitRefusal, type LimitRefusal } from "../Board/moveBlockedMessages";
import type { MoveOutcome } from "../../hooks/useBoard";
import {
  buildFieldRows,
  buildStatusStrip,
  computeTimeInColumns,
  describeMovement,
  getCardTrackStates,
  pinnedNote,
} from "../../utils/cardPeek";
import CustomFieldValueDisplay from "./CustomFieldValueDisplay";
import Avatar from "../Common/Avatar";

const OUTSIDE_CONTROL_SELECTOR = 'button, a[href], input, select, textarea, label, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"]';

interface Props {
  card: Card;
  board: BoardFull;
  canEdit: boolean;
  onClose: () => void;
  /** Hands the card to the full card detail sheet. */
  onOpenCard: (card: Card) => void;
  onMoveCard: (
    cardId: number,
    columnId: number,
    swimlaneId: number,
    position: number,
  ) => Promise<{ ok?: boolean; error?: unknown } | void>;
  /**
   * Admin override for a soft-limit refusal (useBoard.forceMoveCardTo). The
   * Move-blocked toast's override sits outside this sheet's focus trap, so the
   * sheet offers it itself, as CardDetail's Move popover does (#1772). Omitted:
   * no override is shown.
   */
  onForceMoveCard?: (cardId: number, columnId: number, swimlaneId: number, position: number) => Promise<MoveOutcome>;
  userDateFormat?: string;
  userTimezone?: string;
}

/**
 * The card peek (#2273): a 400px side sheet over the right of the board with
 * the card's status, every field, time in each column and its history, so a
 * card can be read without leaving the board. It floats; it never resizes the
 * grid. Only the full card detail sheet edits.
 *
 * Focus and Escape follow the card detail sheet (frontend/CLAUDE.md § Card
 * detail sheet placement): focus goes to Close on open, and on close returns to
 * the opener, else the card's face, else the board region.
 */
export default function CardPeekSheet({ card, board, canEdit, onClose, onOpenCard, onMoveCard, onForceMoveCard, userDateFormat = "MM/DD/YYYY", userTimezone = "" }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [movements, setMovements] = useState<CardMovement[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [targetColumn, setTargetColumn] = useState(card.column);
  const [targetSwimlane, setTargetSwimlane] = useState(card.swimlane);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveRefusal, setMoveRefusal] = useState<LimitRefusal | null>(null);
  const forcingRef = useRef(false);

  useFocusTrap(panelRef, true, () =>
    findBoardCardElement(card.id) ?? document.querySelector<HTMLElement>(BOARD_SCROLL_SELECTOR));
  useEscapeStack(() => {
    if (moveOpen) {
      setMoveOpen(false);
      return;
    }
    onClose();
  }, 30);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Refetch when the card moves (its own Move, or a remote one) so history and
  // the bar stay current. `version` changes on every server write.
  useEffect(() => {
    let live = true;
    setHistoryFailed(false);
    getCardMovements(board.id, card.id)
      .then((rows) => { if (live) setMovements(rows); })
      .catch(() => { if (live) { setMovements([]); setHistoryFailed(true); } });
    return () => { live = false; };
  }, [board.id, card.id, card.version, card.column]);

  // Click-catcher, mirroring CardDetail's (frontend/CLAUDE.md § Card detail
  // sheet placement): classified at pointerdown, acted on at the following
  // click, so a text selection or scrollbar drag that started in the sheet
  // never closes it. A press on board space is consumed (an empty cell's
  // "+ Add card" must not also fire) and does not move focus, so focus can
  // return to the card on close. A card click is left to the card's own
  // handler, which swaps the peek; a control elsewhere closes the peek AND works.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    let pending: { x: number; y: number; consume: boolean } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      pending = null;
      if (e.button !== 0) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (panelRef.current?.contains(t)) return;
      if (t.closest('[data-card-id], [data-keeps-card-sheet-open], [aria-modal="true"], [role="dialog"]')) return;
      if (t instanceof HTMLElement && t.clientWidth > 0 && (e.offsetX > t.clientWidth || e.offsetY > t.clientHeight)) return;
      pending = {
        x: e.clientX,
        y: e.clientY,
        consume: !t.closest(OUTSIDE_CONTROL_SELECTOR) || !!t.closest(BOARD_SCROLL_SELECTOR),
      };
    };
    const onMouseDown = (e: MouseEvent) => { if (pending?.consume) e.preventDefault(); };
    const onClick = (e: MouseEvent) => {
      const p = pending;
      pending = null;
      if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) return;
      if (p.consume) {
        e.preventDefault();
        e.stopPropagation();
      }
      onCloseRef.current();
    };
    const onCancel = () => { pending = null; };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointercancel", onCancel);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("pointercancel", onCancel);
    };
  }, []);

  // Plain text, entities decoded (`&amp;` shows as "&"); parsed into an inert
  // document, never injected.
  const descriptionText = useMemo(
    () => (card.description ? (new DOMParser().parseFromString(card.description, "text/html").body.textContent ?? "").trim() : ""),
    [card.description],
  );
  const strip = useMemo(() => buildStatusStrip(card, board.columns), [card, board.columns]);
  const tracks = useMemo(() => getCardTrackStates(card), [card]);
  const fields = useMemo(() => buildFieldRows(card, board.custom_field_definitions ?? []), [card, board.custom_field_definitions]);
  const dwell = useMemo(
    () => (movements ? computeTimeInColumns(card, movements, board.columns) : []),
    [card, movements, board.columns],
  );
  const totalMs = dwell.reduce((s, d) => s + d.ms, 0);
  const history = useMemo(
    () => (movements ?? []).slice().sort((a, b) => new Date(b.moved_at).getTime() - new Date(a.moved_at).getTime()),
    [movements],
  );
  const lane = board.swimlanes.find((s) => s.id === card.swimlane);
  const overdue = card.due_date ? formatDueDate(card.due_date, userTimezone || "UTC", userDateFormat).overdue : false;
  const idleDays = card.last_moved_at
    ? Math.floor((Date.now() - new Date(card.last_moved_at).getTime()) / 86_400_000)
    : 0;
  const banner = overdue && card.due_date
    ? `Was due ${formatDateStr(card.due_date, userDateFormat)}`
    : card.is_stale
      ? `No movement for ${idleDays} days`
      : null;

  // Names the column or swimlane for limit refusals (the 409 body carries it).
  const moveFailureMessage = (err: unknown): string => {
    const body = (err as { response?: { data?: { column_name?: unknown; swimlane_name?: unknown } } } | null)?.response?.data;
    if (isLimitFailure(err) && typeof body?.swimlane_name === "string") {
      return `Card could not be moved: swimlane "${body.swimlane_name}" has reached its limit.`;
    }
    if (isLimitFailure(err) && typeof body?.column_name === "string") {
      return `Card could not be moved: "${body.column_name}" has reached its limit.`;
    }
    return `Card could not be moved: ${failureReason(err)}.`;
  };
  const isBoardAdmin = board.current_user_role === "admin" || board.current_user_role === "site_admin";
  // Only a soft limit can be forced, never wip_hard_blocked.
  const canForceMove = isBoardAdmin && onForceMoveCard !== undefined && moveRefusal !== null && !isHardLimit(moveRefusal.code);

  const forceMove = async () => {
    if (!onForceMoveCard || forcingRef.current) return;
    forcingRef.current = true;
    setMoving(true);
    try {
      const result = await onForceMoveCard(card.id, targetColumn, targetSwimlane, 9999);
      if (result.ok === false) {
        setMoveError(moveFailureMessage(result.error));
        setMoveRefusal(limitRefusal(result.error));
        return;
      }
      setMoveError(null);
      setMoveRefusal(null);
      setMoveOpen(false);
    } catch (err) {
      setMoveError(moveFailureMessage(err));
      setMoveRefusal(limitRefusal(err));
    } finally {
      forcingRef.current = false;
      setMoving(false);
    }
  };

  const submitMove = async () => {
    if (targetColumn === card.column && targetSwimlane === card.swimlane) {
      setMoveOpen(false);
      return;
    }
    setMoving(true);
    setMoveError(null);
    setMoveRefusal(null);
    try {
      // 9999 appends to the end of the target cell, as the card sheet's Move does.
      const result = await onMoveCard(card.id, targetColumn, targetSwimlane, 9999);
      if (result && result.ok === false) {
        setMoveError(moveFailureMessage(result.error));
        setMoveRefusal(limitRefusal(result.error));
        return;
      }
      setMoveOpen(false);
    } catch (err) {
      setMoveError(moveFailureMessage(err));
      setMoveRefusal(limitRefusal(err));
    } finally {
      setMoving(false);
    }
  };

  const selectClass = "focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent w-full bg-surface text-fg border border-line-strong rounded-md px-2 py-2 text-sm min-h-[44px] sm:min-h-0 sm:py-1.5";
  const stage = (name: string | undefined, kind: "previous" | "current" | "next") =>
    name ? (
      <span
        key={kind}
        aria-current={kind === "current" ? "step" : undefined}
        className={`px-2 py-1 rounded-full text-xs border ${
          kind === "current"
            ? "font-semibold text-fg border-primary-emphasis bg-primary-emphasis/15"
            : "text-fg-secondary border-line"
        }`}
      >
        <span className="sr-only">{kind === "previous" ? "Previous stage: " : kind === "next" ? "Next stage: " : "Current stage: "}</span>
        {name}
      </span>
    ) : null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="card-peek-title"
      tabIndex={-1}
      data-testid="card-peek-sheet"
      className="fixed z-50 bg-surface text-fg outline-none border border-line shadow-xl flex flex-col max-sm:inset-0 max-sm:rounded-none sm:right-4 sm:top-24 sm:bottom-3 sm:w-[400px] sm:rounded-lg"
    >
      <div className="flex items-start justify-between gap-2 px-4 pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-fg-tertiary">{lane?.name ?? ""}</p>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close card peek"
          className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 -mt-2 -mr-2 p-2 rounded-md text-fg-secondary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-5">
        <div>
          <h2 id="card-peek-title" className="text-lg font-semibold text-fg break-words">{card.title}</h2>
          {descriptionText && (
            <p className="text-sm text-fg-secondary line-clamp-2 break-words">{descriptionText}</p>
          )}
        </div>

        {banner && (
          <p data-testid="card-peek-banner" className="rounded-md bg-warning/15 px-3 py-2 text-sm font-medium text-warning-on-tint">
            {banner}
          </p>
        )}

        <section aria-labelledby="peek-status">
          <h3 id="peek-status" className="text-sm font-semibold mb-2">Status</h3>
          <div className="flex flex-wrap gap-1.5" data-testid="card-peek-strip">
            {stage(strip.previous?.name, "previous")}
            {stage(strip.current?.name, "current")}
            {stage(strip.next?.name, "next")}
          </div>
          {tracks.length > 0 && (
            <ul className="mt-2 space-y-1.5" aria-label="Tracks">
              {tracks.map((t) => (
                <li key={t.id} className="flex justify-between rounded-md border border-line px-3 py-1.5 text-sm">
                  <span>{t.name}</span>
                  <span className="font-semibold">{t.state === "done" ? "✓ Done" : t.state === "open" ? "Open" : "Not applicable"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="peek-fields">
          <div className="flex items-baseline justify-between mb-2">
            <h3 id="peek-fields" className="text-sm font-semibold">Fields</h3>
            <span className="text-xs text-fg-secondary">{pinnedNote(board.custom_field_definitions ?? [])}</span>
          </div>
          <dl className="space-y-2 text-sm">
            {fields.map(({ definition, value }) => (
              <div key={definition.id} className="flex justify-between gap-3">
                <dt className="text-fg-secondary">{definition.name}</dt>
                <dd className={`text-right min-w-0 break-words ${value === null ? "text-fg-tertiary" : "text-fg"}`}>
                  {value === null ? "Not set" : (
                    <CustomFieldValueDisplay definition={definition} value={value} variant="detail" userDateFormat={userDateFormat} />
                  )}
                </dd>
              </div>
            ))}
            <div className="flex justify-between gap-3">
              <dt className="text-fg-secondary">Assignee</dt>
              <dd className={`flex items-center gap-1.5 ${card.assignee ? "text-fg" : "text-fg-tertiary"}`}>
                {card.assignee ? <><Avatar user={card.assignee} size="sm" />{card.assignee.display_name || card.assignee.username}</> : "Not set"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-fg-secondary">Due date</dt>
              <dd className={card.due_date ? "text-fg" : "text-fg-tertiary"}>{card.due_date ? formatDateStr(card.due_date, userDateFormat) : "Not set"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-fg-secondary">Last moved</dt>
              <dd className={card.last_moved_at ? "text-fg" : "text-fg-tertiary"}>{card.last_moved_at ? formatRelativeTime(card.last_moved_at) : "Not set"}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="peek-time">
          <h3 id="peek-time" className="text-sm font-semibold mb-2">Time in each column</h3>
          {movements === null ? (
            <p className="text-sm text-fg-secondary" role="status">Loading history...</p>
          ) : historyFailed ? (
            <p className="text-sm text-fg-secondary">History could not be loaded.</p>
          ) : dwell.length === 0 ? (
            <p className="text-sm text-fg-tertiary">No movement recorded yet.</p>
          ) : (
            <>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-sunken" role="img" aria-label={`Time in each column: ${dwell.map((d) => `${d.name} ${d.days} days`).join(", ")}`}>
                {dwell.map((d) => (
                  <span
                    key={d.columnId ?? d.name}
                    data-testid="card-peek-segment"
                    data-current={d.current ? "true" : "false"}
                    style={{ width: `${totalMs > 0 ? Math.max((d.ms / totalMs) * 100, 2) : 100 / dwell.length}%` }}
                    className="h-full border-r border-surface last:border-r-0 bg-primary-emphasis"
                  />
                ))}
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                {dwell.map((d) => (
                  <li key={d.columnId ?? d.name} className={`flex justify-between ${d.current ? "font-semibold text-fg" : "text-fg-secondary"}`}>
                    <span className="flex items-center gap-2 min-w-0">
                      <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-sm bg-primary-emphasis" />
                      <span className="break-words">{d.name}</span>
                    </span>
                    <span>{d.days} d</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby="peek-history">
          <h3 id="peek-history" className="text-sm font-semibold mb-2">History</h3>
          {movements === null ? (
            <p className="text-sm text-fg-secondary">Loading history...</p>
          ) : historyFailed ? (
            <p className="text-sm text-fg-secondary" role="alert">History could not be loaded.</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-fg-tertiary">No history yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm" data-testid="card-peek-history">
              {history.map((m) => (
                <li key={m.id} className="flex justify-between gap-3">
                  <span className="text-fg min-w-0 break-words">{describeMovement(m)}</span>
                  <span className="text-fg-secondary shrink-0">{formatRelativeTime(m.moved_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="border-t border-line px-4 py-3">
        {moveOpen && (
          <div className="mb-3 space-y-2" data-testid="card-peek-move-form">
            <label className="block text-xs text-fg-secondary">
              Column
              <select className={selectClass} value={targetColumn} onChange={(e) => { setTargetColumn(Number(e.target.value)); setMoveError(null); setMoveRefusal(null); }}>
                {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="block text-xs text-fg-secondary">
              Swimlane
              <select className={selectClass} value={targetSwimlane} onChange={(e) => { setTargetSwimlane(Number(e.target.value)); setMoveError(null); setMoveRefusal(null); }}>
                {board.swimlanes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            {moveError && (
              <div role="alert" className="text-sm">
                <p className="text-danger">{moveError}</p>
                {moveRefusal && <p className="mt-0.5 text-xs text-fg-tertiary">{limitCounts(moveRefusal)}</p>}
              </div>
            )}
            {canForceMove && (
              <button
                type="button"
                onClick={forceMove}
                aria-disabled={moving}
                className="text-xs text-warning hover:text-warning underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
              >{moving ? "Moving anyway…" : "Move anyway (admin override)"}</button>
            )}
            <div className="flex gap-2">
              <button type="button" disabled={moving} onClick={submitMove} className="disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis bg-button-primary hover:bg-button-primary-hover text-on-primary rounded-md px-3 py-2 text-sm font-medium min-h-[44px] sm:min-h-0">{moving ? "Moving..." : "Move card"}</button>
              <button type="button" disabled={moving} onClick={() => setMoveOpen(false)} className="disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-primary-emphasis border border-line-strong text-fg rounded-md px-3 py-2 text-sm min-h-[44px] sm:min-h-0">Cancel</button>
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={() => onOpenCard(card)} className="focus:outline-none focus:ring-2 focus:ring-primary-emphasis bg-button-primary hover:bg-button-primary-hover text-on-primary rounded-md px-4 py-2 text-sm font-medium min-h-[44px] sm:min-h-0">Open card</button>
          {canEdit && !moveOpen && (
            <button
              type="button"
              onClick={() => { setTargetColumn(card.column); setTargetSwimlane(card.swimlane); setMoveError(null); setMoveRefusal(null); setMoveOpen(true); }}
              className="focus:outline-none focus:ring-2 focus:ring-primary-emphasis border border-line-strong text-fg hover:bg-surface-hover rounded-md px-4 py-2 text-sm min-h-[44px] sm:min-h-0"
            >
              Move
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
