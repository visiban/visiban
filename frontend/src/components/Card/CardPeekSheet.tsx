import { useId, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cardSubColumnIndex, currentStopIndex, moveStops, stageSubColumns } from "../../utils/stages";
import { getCardMovements } from "../../api/cards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { BOARD_SCROLL_SELECTOR, classifyTransition, findBoardCardElement, useCardSheetPlacement, type SheetPlacement } from "../../hooks/useCardSheetPlacement";
import { useCardSheetDockedPref } from "../../hooks/useCardSheetDockedPref";
import { claimDeparture, departSheet, dropOwnDeparture, playTransition } from "./cardSheetMotion";
import CardSheetDockToggle from "./CardSheetDockToggle";
import type { BoardFull, Card, CardMovement } from "../../types";
import { formatDateStr, formatRelativeTime } from "../../utils/date";
import { isOverdue } from "../../utils/cardUrgency";
import { failureReason, isLimitFailure } from "../../utils/moveFailure";
import { canOverride, overrideEligibility, overrideHint, overrideLabel } from "../../utils/forceOverride";
import OverrideReasonForm from "../Board/OverrideReasonForm";
import { isHardLimit, limitCounts, limitRefusal, type LimitRefusal } from "../Board/moveBlockedMessages";
import type { MoveOutcome } from "../../hooks/useBoard";
import {
  buildFieldRows,
  buildStatusStrip,
  computeTimeInColumns,
  getCardTrackStates,
  pinnedNote,
} from "../../utils/cardPeek";
import CardPeekHistory from "./CardPeekHistory";
import CustomFieldValueDisplay from "./CustomFieldValueDisplay";
import { colorChipStyle } from "../../utils/colorContrast";
import Avatar from "../Common/Avatar";
import { activeDueDate } from "../../utils/plannedFields";
import { agingReference } from "../../utils/agingTint";

const OUTSIDE_CONTROL_SELECTOR = 'button, a[href], input, select, textarea, label, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"]';

/** A key that a deleted column's name cannot collide with a live column's id. */
export const dwellKey = (d: { columnId: number | null; name: string }) =>
  d.columnId != null ? `col:${d.columnId}` : `name:${d.name}`;

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
    /** The target sub-column on a gated stage (#2278); omitted on a plain column. */
    gatesPassed?: number,
  ) => Promise<{ ok?: boolean; error?: unknown } | void>;
  /**
   * Admin override for a soft-limit refusal (useBoard.forceMoveCardTo). The
   * Move-blocked toast's override sits outside this sheet's focus trap, so the
   * sheet offers it itself, as CardDetail's Move popover does (#1772). Omitted:
   * no override is shown.
   */
  onForceMoveCard?: (cardId: number, columnId: number, swimlaneId: number, position: number, gatesPassed?: number, reason?: string) => Promise<MoveOutcome>;
  /** Decides who is offered the assignee override (#1923). */
  currentUserId?: number | null;
  /**
   * The card's place in its cell (#2277). Given, the sheet offers Move earlier /
   * Move later: the phone has no drag, and on the grid a reorder is one. Each
   * calls onMoveCard with the same cell and the raw slot `cellOrderOf` gives
   * (`earlier` / `later`; `null` disables that button).
   */
  cellOrder?: { index: number; count: number; earlier: number | null; later: number | null };
  /** The board is offline (#2325): Move and the reorder steps are disabled, with the reason in text. */
  movesPaused?: boolean;
  userDateFormat?: string;
  userTimezone?: string;
}

/** The peek's width; the card detail sheet is 540px. */
export const PEEK_WIDTH = 400;

/**
 * The card peek (#2273): a 400px side sheet beside the card's column with
 * the card's status, every field, time in each column and its history, so a
 * card can be read without leaving the board. It floats; it never resizes the
 * grid. Only the full card detail sheet edits.
 *
 * Placement, the Dock to edge toggle and its persisted preference, the notch
 * and the transitions are the card detail sheet's, not a second rule (#2507,
 * frontend/CLAUDE.md § Card detail sheet placement); only the width differs.
 *
 * Focus and Escape follow the card detail sheet (frontend/CLAUDE.md § Card
 * detail sheet placement): focus goes to Open card on open (#2358), and on close returns to
 * the opener, else the card's face, else the board region.
 */
export default function CardPeekSheet({ card, board, canEdit, onClose, onOpenCard, onMoveCard, onForceMoveCard, cellOrder, movesPaused = false, currentUserId = null, userDateFormat = "MM/DD/YYYY", userTimezone: _userTimezone = "" }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const [dockedPref, setDockedPref] = useCardSheetDockedPref();
  const sheet = useCardSheetPlacement(card.id, `${card.column}:${card.swimlane}:${card.gates_passed ?? 0}`, dockedPref, PEEK_WIDTH);
  const { placement } = sheet;
  const anchored = placement.mode === "anchored";
  const fullscreen = placement.mode === "fullscreen";

  // Transitions: the card detail sheet's (cardSheetMotion.ts). A swap mounts
  // the next card's peek in the same commit (`key={peekCard.id}`) and claims
  // the departing sheet's ghost, so a same-side swap slides and a side or mode
  // change fades. Visual only.
  const placementRef = useRef<SheetPlacement>(placement);
  placementRef.current = placement;
  const shownPlacementRef = useRef<SheetPlacement | null>(null);
  const shownRectRef = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!sheet.measured || !panel) return;
    let from = shownPlacementRef.current;
    let fromRect = shownRectRef.current;
    let ghost: HTMLElement | null = null;
    let reason: Parameters<typeof classifyTransition>[2] = sheet.reason;
    if (!from) {
      const departed = claimDeparture(card.id);
      if (departed) {
        from = departed.placement;
        fromRect = departed.rect;
        ghost = departed.ghost;
        reason = "swap";
      }
    }
    playTransition(classifyTransition(from, placement, reason), panel, { placement, from: fromRect, ghost });
    shownPlacementRef.current = placement;
    shownRectRef.current = panel.getBoundingClientRect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the placement object: each re-place is a new object, a no-op re-measure keeps the old one
  }, [placement, sheet.measured]);
  useLayoutEffect(() => {
    dropOwnDeparture(card.id);
    const panel = panelRef.current;
    return () => {
      if (panel) departSheet(card.id, placementRef.current, panel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- card.id is fixed for this instance (`key={peekCard.id}`)
  }, []);
  const [movements, setMovements] = useState<CardMovement[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  // Move targets are stops (#2278): a plain column, or one sub-column of a gated stage.
  const stops = useMemo(() => moveStops(board.columns), [board.columns]);
  const ownStop = currentStopIndex(card, board.columns, stops);
  const stopKey = (s: { columnId: number; gatesPassed?: number } | undefined) =>
    s ? (s.gatesPassed === undefined ? String(s.columnId) : `${s.columnId}:${s.gatesPassed}`) : String(card.column);
  const ownKey = stopKey(stops[ownStop]);
  const [targetKey, setTargetKey] = useState(ownKey);
  const target = stops.find((s) => stopKey(s) === targetKey);
  const targetColumn = target?.columnId ?? card.column;
  const targetGates = target?.gatesPassed;
  // The fifth argument only when there is a sub-column to name, so plain moves keep their shape.
  const gateArg = targetGates === undefined ? [] as [] : [targetGates] as [number];
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
    openRef.current?.focus();
  }, []);

  // The socket dropping while the Move form is open: moves are paused, so close the form
  // (it would otherwise keep a live "Move card" / "Move anyway" on a stale board), clear its
  // error, and hand focus back to the Move button once it remounts (#2325).
  const moveBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!movesPaused || !moveOpen) return;
    setMoveOpen(false);
    setMoveError(null);
    setMoveRefusal(null);
    const t = setTimeout(() => moveBtnRef.current?.focus(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the pause edge only
  }, [movesPaused]);

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
  const cardIdRef = useRef(card.id);
  cardIdRef.current = card.id;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    let pending: { x: number; y: number; consume: boolean } | null = null;
    // A press on this card's own face must not move focus onto it, outside the
    // aria-modal dialog (CardDetail does the same).
    let ownFacePress = false;
    const onPointerDown = (e: PointerEvent) => {
      pending = null;
      ownFacePress = false;
      if (e.button !== 0) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (panelRef.current?.contains(t)) return;
      if (t.closest(`[data-card-id="${cardIdRef.current}"]`)) { ownFacePress = true; return; }
      if (t.closest('[data-card-id], [data-keeps-card-sheet-open], [aria-modal="true"], [role="dialog"]')) return;
      if (t instanceof HTMLElement && t.clientWidth > 0 && (e.offsetX > t.clientWidth || e.offsetY > t.clientHeight)) return;
      pending = {
        x: e.clientX,
        y: e.clientY,
        consume: !t.closest(OUTSIDE_CONTROL_SELECTOR) || !!t.closest(BOARD_SCROLL_SELECTOR),
      };
    };
    const onMouseDown = (e: MouseEvent) => { if (ownFacePress || pending?.consume) e.preventDefault(); };
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
  const tracks = useMemo(
    () => getCardTrackStates(
      card,
      board.columns.find((c) => c.id === card.column),
      board.swimlanes.find((l) => l.id === card.swimlane),
      board.custom_field_definitions,
    ),
    [card, board.columns, board.swimlanes, board.custom_field_definitions],
  );
  // A gated stage (#1102) shows its sub-columns in place of the single current stage.
  const currentColumn = board.columns.find((c) => c.id === card.column);
  const peekSubs = stageSubColumns(currentColumn);
  const peekSubIndex = currentColumn ? cardSubColumnIndex(card, currentColumn) : 0;
  const fields = useMemo(() => buildFieldRows(card, board.custom_field_definitions ?? []), [card, board.custom_field_definitions]);
  const dwell = useMemo(
    () => (movements ? computeTimeInColumns(card, movements, board.columns) : []),
    [card, movements, board.columns],
  );
  const totalMs = dwell.reduce((s, d) => s + d.ms, 0);
  const lane = board.swimlanes.find((s) => s.id === card.swimlane);
  // A card payload that omits labels (older server, partial socket update) still opens the sheet (#2391).
  const labels = card.labels ?? [];
  const overdue = isOverdue(activeDueDate(card), !!board.columns.find((c) => c.id === card.column)?.is_done || !!card.archived_at);
  // The card face's aging reference: a released planned child counts from its release (#2371).
  const agingRef = agingReference(card);
  const idleDays = agingRef
    ? Math.floor((Date.now() - new Date(agingRef).getTime()) / 86_400_000)
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
  const eligibility = overrideEligibility({
    role: board.current_user_role,
    userId: currentUserId,
    allowAssigneeOverride: board.allow_assignee_override,
    card,
  });
  // Only a soft limit can be forced, never wip_hard_blocked.
  const softRefusal = onForceMoveCard !== undefined && moveRefusal !== null && !isHardLimit(moveRefusal.code);
  const canForceMove = softRefusal && canOverride(eligibility);
  const forceHint = softRefusal ? overrideHint(eligibility) : null;
  // The assignee override's inline reason box.
  const [reasonOpen, setReasonOpen] = useState(false);
  const overrideLinkRef = useRef<HTMLButtonElement>(null);
  const refusalId = useId();
  // Counts successful forced moves. A layout effect, so the commit that closes the form (and drops its focused
  // control) also focuses the remounted Move button (#2608).
  const [forcedMoves, setForcedMoves] = useState(0);
  useLayoutEffect(() => {
    if (forcedMoves > 0) moveBtnRef.current?.focus();
  }, [forcedMoves]);

  useEffect(() => {
    if (!moveOpen) setReasonOpen(false);
  }, [moveOpen]);

  const forceMove = async (reason?: string) => {
    if (!onForceMoveCard || forcingRef.current || movesPaused) return;
    forcingRef.current = true;
    setMoving(true);
    try {
      const result = reason === undefined
        ? await onForceMoveCard(card.id, targetColumn, targetSwimlane, 9999, ...gateArg)
        : await onForceMoveCard(card.id, targetColumn, targetSwimlane, 9999, gateArg[0], reason);
      if (result.ok === false) {
        const refusal = limitRefusal(result.error);
        setMoveError(moveFailureMessage(result.error));
        setMoveRefusal(refusal);
        // The typed reason survives any failure but a hard block (#1923).
        if (refusal !== null && isHardLimit(refusal.code)) setReasonOpen(false);
        return;
      }
      setMoveError(null);
      setMoveRefusal(null);
      setMoveOpen(false);
      setForcedMoves((n) => n + 1);
    } catch (err) {
      setMoveError(moveFailureMessage(err));
      setMoveRefusal(limitRefusal(err));
    } finally {
      forcingRef.current = false;
      setMoving(false);
    }
  };

  const submitMove = async () => {
    if (movesPaused) return;
    // Only a true no-op closes quietly: a different sub-column of the same stage is a move.
    if (targetKey === ownKey && targetSwimlane === card.swimlane) {
      setMoveOpen(false);
      return;
    }
    setMoving(true);
    setMoveError(null);
    setMoveRefusal(null);
    try {
      // 9999 appends to the end of the target cell, as the card sheet's Move does.
      const result = await onMoveCard(card.id, targetColumn, targetSwimlane, 9999, ...gateArg);
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

  const [reorderError, setReorderError] = useState<string | null>(null);
  const reorder = async (dir: -1 | 1) => {
    // The endpoint's raw slot for the step (`cellOrderOf`), not index + 1:
    // a same-cell move does not compact the slot the card leaves.
    const position = !cellOrder ? null : dir === -1 ? cellOrder.earlier : cellOrder.later;
    if (position === null || moving) return;
    setMoving(true);
    setReorderError(null);
    try {
      const result = await onMoveCard(card.id, card.column, card.swimlane, position);
      if (result && result.ok === false) setReorderError(moveFailureMessage(result.error));
    } catch (err) {
      setReorderError(moveFailureMessage(err));
    } finally {
      setMoving(false);
    }
  };
  const canReorder = canEdit && cellOrder !== undefined && cellOrder.count > 1 && !moveOpen;

  const selectClass = "focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent w-full bg-surface text-fg border border-line-strong rounded-md px-2 py-2 text-sm min-h-[44px] sm:min-h-0 sm:py-1.5";
  const stage = (name: string | undefined, kind: "previous" | "current" | "next") =>
    name ? (
      <span
        key={kind}
        aria-current={kind === "current" ? "step" : undefined}
        className={`px-2 py-1 rounded-md text-xs border ${
          kind === "current"
            ? "font-semibold text-fg border-primary-emphasis bg-primary-emphasis/15"
            : "text-fg-secondary border-line"
        }`}
      >
        <span className="sr-only">{kind === "previous" ? "Previous stage: " : kind === "next" ? "Next stage: " : "Current stage: "}</span>
        {name}
      </span>
    ) : null;

  // Geometry per mode, as the card detail sheet's: anchored is rounded and
  // elevated below the board toolbar; docked is full height at the right edge,
  // square with a left border; full-screen is the whole viewport.
  const panelModeClass = anchored
    ? "rounded-lg border border-primary-emphasis shadow-2xl"
    : fullscreen
      ? "inset-0"
      : "top-0 bottom-0 right-0 w-[400px] border-l border-line shadow-2xl";
  const notch = anchored ? placement.notch : null;

  return (
    <div className="contents">
      {placement.mode === "docked" && (
        <div className="fixed inset-0 z-50 bg-backdrop/20 pointer-events-none" aria-hidden="true" data-testid="card-peek-backdrop" />
      )}
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="card-peek-title"
      tabIndex={-1}
      data-testid="card-peek-sheet"
      data-sheet-mode={placement.mode}
      data-sheet-side={anchored ? placement.side ?? undefined : undefined}
      style={anchored ? { left: placement.left ?? undefined, top: placement.top, bottom: placement.bottom, width: PEEK_WIDTH } : undefined}
      className={`fixed z-50 bg-surface text-fg outline-none flex flex-col ${panelModeClass}`}
    >
      {/* Notch: the card detail sheet's speech-bubble tail (#1946), a child of the overflow-visible root. */}
      {notch && (
        <svg
          aria-hidden="true"
          focusable="false"
          width={7}
          height={24}
          viewBox="0 0 7 24"
          data-testid="card-sheet-notch"
          data-clamped={notch.clamped ? "true" : "false"}
          data-direction={notch.clamped ? notch.direction : undefined}
          className={`pointer-events-none absolute z-20 fill-primary-emphasis ${
            placement.side === "right" ? "-left-[7px]" : "-right-[7px] -scale-x-100"
          }`}
          style={{ top: notch.y - 13 }}
        >
          <path d={notch.clamped ? (notch.direction === "up" ? "M7 6H1L7 18Z" : "M7 6L1 18H7Z") : "M7 6L1 12L7 18Z"} />
        </svg>
      )}
      <div className={`flex h-full min-h-0 flex-col overflow-hidden ${anchored ? "rounded-[7px]" : ""}`}>
      <div className="flex items-start justify-between gap-2 px-4 pt-4">
        <p className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-fg-tertiary" title={lane?.name ?? undefined}>{lane?.name ?? ""}</p>
        <div className="flex items-center gap-1 -mt-2 -mr-2">
        {!fullscreen && <CardSheetDockToggle docked={dockedPref} onToggle={setDockedPref} />}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close card peek"
          className={`shrink-0 ${fullscreen ? "min-h-[44px] min-w-[44px]" : ""} p-2 rounded-md text-fg-secondary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
        </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-5">
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
            {peekSubs.length === 0 ? stage(strip.current?.name, "current") : (
              // Same current-step treatment as stage() above, plus a dot so color is not the only cue;
              // aria-current alone names the current step (no extra "(current)" text).
              <ol data-testid="card-peek-sub-columns" aria-label={`${strip.current?.name ?? ""} sub-columns`} className="inline-flex flex-wrap gap-1.5">
                {peekSubs.map((s, i) => {
                  const on = i === peekSubIndex;
                  return (
                    <li
                      key={s.id}
                      aria-current={on ? "step" : undefined}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border ${on ? "font-semibold text-fg border-primary-emphasis bg-primary-emphasis/15" : "text-fg-secondary border-line"}`}
                    >
                      {on && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
                      {strip.current?.name}: {s.name}
                    </li>
                  );
                })}
              </ol>
            )}
            {stage(strip.next?.name, "next")}
          </div>
          {tracks.length > 0 && (
            <>
            <ul className="mt-2 space-y-1.5" aria-label="Tracks">
              {tracks.map((t) => (
                <li key={t.id} className="flex justify-between rounded-md border border-line px-3 py-1.5 text-sm">
                  <span>{t.name}</span>
                  <span className="font-semibold">
                    {t.state === "done" ? <><span aria-hidden="true">✓ </span>Done</> : t.state === "open" ? "Open" : "Not applicable"}
                    {t.fromLane && <span className="font-normal text-fg-secondary"> for this swimlane</span>}
                  </span>
                </li>
              ))}
            </ul>
            {/* #2542: static, visible where-to-set line for keyboard users; chips and rows are not controls. */}
            <p data-testid="peek-track-hint" className="mt-1.5 text-xs text-fg-muted">Set in the card's Custom fields.</p>
            </>
          )}
        </section>

        <section aria-labelledby="peek-fields">
          <div className="flex items-baseline justify-between mb-2">
            <h3 id="peek-fields" className="text-sm font-semibold">Fields</h3>
            {(board.custom_field_definitions ?? []).length > 0 && (
              <span className="text-xs text-fg-secondary">{pinnedNote(board.custom_field_definitions ?? [])}</span>
            )}
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
            {/* Labels (#2391, owner decision): at Dense the face draws none, so
                the peek sheet lists them beside the due date. */}
            <div className="flex justify-between gap-3">
              <dt className="text-fg-secondary">Labels</dt>
              <dd className={labels.length > 0 ? "min-w-0" : "text-fg-tertiary"}>
                {labels.length > 0 ? (
                  <ul className="flex flex-wrap justify-end gap-1" aria-label="Labels" data-testid="card-peek-sheet-labels">
                    {labels.map((label) => (
                      <li
                        key={label.id}
                        className="cf-choice-badge border text-xs font-semibold px-1 py-0.5 rounded leading-none max-w-full truncate"
                        style={colorChipStyle(label.color)}
                        title={label.name}
                      >
                        {label.name}
                      </li>
                    ))}
                  </ul>
                ) : "None"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-fg-secondary">Last moved</dt>
              <dd className={card.last_moved_at ? "text-fg" : "text-fg-tertiary"}>{card.last_moved_at ? formatRelativeTime(card.last_moved_at) : "Never moved"}</dd>
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
                    key={dwellKey(d)}
                    data-testid="card-peek-segment"
                    data-current={d.current ? "true" : "false"}
                    style={{ width: `${totalMs > 0 ? Math.max((d.ms / totalMs) * 100, 2) : 100 / dwell.length}%` }}
                    className="h-full border-r border-surface last:border-r-0 bg-primary-emphasis"
                  />
                ))}
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                {dwell.map((d) => (
                  <li key={dwellKey(d)} className={`flex justify-between ${d.current ? "font-semibold text-fg" : "text-fg-secondary"}`}>
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
          {/* Movements plus in-stage sub-column moves (#2365). */}
          <CardPeekHistory
            boardId={board.id}
            cardId={card.id}
            refreshKey={`${card.version}:${card.column}`}
            movements={movements}
            movementsFailed={historyFailed}
            userDateFormat={userDateFormat}
          />
        </section>
      </div>

      <div className="border-t border-line px-4 py-3">
        {moveOpen && (
          <div className="mb-3 space-y-2" data-testid="card-peek-move-form">
            <label className="block text-xs text-fg-secondary">
              Column
              <select className={selectClass} value={targetKey} onChange={(e) => { setTargetKey(e.target.value); setMoveError(null); setMoveRefusal(null); setReasonOpen(false); }}>
                {stops.map((s) => <option key={stopKey(s)} value={stopKey(s)}>{s.label}</option>)}
              </select>
            </label>
            <label className="block text-xs text-fg-secondary">
              Swimlane
              <select className={selectClass} value={targetSwimlane} onChange={(e) => { setTargetSwimlane(Number(e.target.value)); setMoveError(null); setMoveRefusal(null); setReasonOpen(false); }}>
                {board.swimlanes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            {moveError && (
              <div id={refusalId} role="alert" className="text-sm">
                <p className="text-danger">{moveError}</p>
                {moveRefusal && <p className="mt-0.5 text-xs text-fg-tertiary">{limitCounts(moveRefusal)}</p>}
              </div>
            )}
            {forceHint && <p id={`${refusalId}-hint`} className="text-xs text-fg-tertiary">{forceHint}</p>}
            {canForceMove && !reasonOpen && (
              <button
                ref={overrideLinkRef}
                type="button"
                aria-describedby={refusalId}
                onClick={() => (eligibility.kind === "assignee" ? setReasonOpen(true) : void forceMove())}
                aria-disabled={moving}
                className="max-sm:min-h-11 text-xs text-warning hover:text-warning underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
              >{moving ? "Moving anyway…" : overrideLabel(eligibility)}</button>
            )}
            {reasonOpen && eligibility.kind === "assignee" && (
              <OverrideReasonForm
                busy={moving}
                escapePriority={36.5}
                onSubmit={(reason) => void forceMove(reason)}
                onCancel={() => {
                  setReasonOpen(false);
                  requestAnimationFrame(() => overrideLinkRef.current?.focus());
                }}
              />
            )}
            {!reasonOpen && <div className="flex gap-2">
              <button type="button" disabled={moving} onClick={submitMove} aria-describedby={forceHint ? `${refusalId}-hint` : undefined} className="disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis bg-button-primary hover:bg-button-primary-hover text-on-primary rounded-md px-3 py-2 text-sm font-medium min-h-[44px] sm:min-h-0">{moving ? "Moving..." : "Move card"}</button>
              <button type="button" disabled={moving} onClick={() => setMoveOpen(false)} className="disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-primary-emphasis text-fg-secondary hover:text-fg rounded-md px-3 py-2 text-sm min-h-[44px] sm:min-h-0 hover:bg-surface-hover">Cancel</button>
            </div>}
          </div>
        )}
        <div className="flex gap-2">
          <button ref={openRef} type="button" onClick={() => onOpenCard(card)} className="focus:outline-none focus:ring-2 focus:ring-primary-emphasis bg-button-primary hover:bg-button-primary-hover text-on-primary rounded-md px-4 py-2 text-sm font-medium min-h-[44px] sm:min-h-0">Open card</button>
          {canEdit && !moveOpen && (
            <button
              type="button"
              ref={moveBtnRef}
              // § Withheld actions: aria-disabled keeps it in the tab order, the reason is in text below.
              aria-disabled={movesPaused || undefined}
              aria-describedby={movesPaused ? "card-peek-moves-paused" : undefined}
              onClick={movesPaused ? undefined : () => { setTargetKey(ownKey); setTargetSwimlane(card.swimlane); setMoveError(null); setMoveRefusal(null); setMoveOpen(true); }}
              className="focus:outline-none focus:ring-2 focus:ring-primary-emphasis border border-line-strong text-fg hover:bg-surface-hover aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent rounded-md px-4 py-2 text-sm min-h-[44px] sm:min-h-0"
            >
              Move
            </button>
          )}
        </div>
        {canReorder && (
          <div className="mt-2 flex gap-2" data-testid="card-peek-reorder">
            <button type="button" disabled={moving || cellOrder.earlier === null} aria-disabled={movesPaused || undefined} aria-describedby={movesPaused ? "card-peek-moves-paused" : undefined} onClick={movesPaused ? undefined : () => void reorder(-1)} className="disabled:opacity-40 disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent focus:outline-none focus:ring-2 focus:ring-primary-emphasis border border-line-strong text-fg hover:bg-surface-hover rounded-md px-4 py-2 text-sm min-h-[44px]">Move earlier</button>
            <button type="button" disabled={moving || cellOrder.later === null} aria-disabled={movesPaused || undefined} aria-describedby={movesPaused ? "card-peek-moves-paused" : undefined} onClick={movesPaused ? undefined : () => void reorder(1)} className="disabled:opacity-40 disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent focus:outline-none focus:ring-2 focus:ring-primary-emphasis border border-line-strong text-fg hover:bg-surface-hover rounded-md px-4 py-2 text-sm min-h-[44px]">Move later</button>
          </div>
        )}
        {reorderError && <p role="alert" className="mt-2 text-sm text-danger">{reorderError}</p>}
        {canEdit && movesPaused && (
          <p id="card-peek-moves-paused" className="mt-2 text-sm text-fg-secondary">Moves are paused while the board is offline.</p>
        )}
      </div>
      </div>
    </div>
    </div>
  );
}
