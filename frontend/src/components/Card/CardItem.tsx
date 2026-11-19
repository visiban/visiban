import { Fragment, useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, memo } from "react";
import { checklistFaceSuffix, checklistToday } from "../../utils/checklistFaceSuffix";
import { createPortal } from "react-dom";
import { useDraggable } from "@dnd-kit/core";
import type { Card, CardDensity, CustomFieldDefinition } from "../../types";
import { colorForPriority } from "../../constants/colors";
import {
  blockedElapsedMs, blockedIndicatorLabel, formatBlockedDuration, isCardBlocked, isManuallyBlocked,
} from "../../utils/blockedState";
import Avatar from "../Common/Avatar";
import { formatDueDate } from "../../utils/date";
import { agingReference, agingTint, formatAgingTooltip, staleBadgeToneClass, urgencyBadgeToneClass } from "../../utils/agingTint";
import AgingCue from "./AgingCue";
import UrgencyGlyph from "./UrgencyGlyph";
import { buildCardStatusLine, type CardStatusKind } from "../../utils/cardStatusLine";
import { classifyCardUrgency } from "../../utils/cardUrgency";
import CardPeekPopover from "./CardPeekPopover";
import CustomFieldQuickEditPopover from "./CustomFieldQuickEditPopover";
import CustomFieldLink from "./CustomFieldLink";
import MultiSelectChips from "./MultiSelectChips";
import { chipValueText, explicitChoiceColor, formatCustomFieldValue, formatNumberCompact, isValidForType, parseMultiSelect, thresholdLevel, thresholdPhrase, withCustomFieldValue } from "../../utils/customFieldValue";
import ThresholdMark from "./ThresholdMark";
import { ChoiceBadge, ChoiceDot } from "./ChoiceValue";
import { updateCard } from "../../api/cards";
import { PROVIDER_LABELS, isHttpUrl } from "../../utils/externalRef";
import ExternalRefGlyph from "./ExternalRefGlyph";
import { colorChipStyle } from "../../utils/colorContrast";
import type { CardMenuAnchor } from "./CardContextMenu";
import TrackChips, { GateProgress } from "./TrackChips";
import { isDimensionField, type CardTrackState } from "../../utils/stages";



const EMPTY_DEFS: CustomFieldDefinition[] = [];

interface Props {
  card: Card;
  /** `{ peek: true }` (Shift+click, Shift+Enter, the Show summary button) asks for the read-only peek (#2358). */
  onClick?: (opts?: { peek?: boolean }) => void;
  overlay?: boolean;
  selected?: boolean;
  highlighted?: boolean;
  /**
   * This card is the one open in the card detail sheet (#1914): a 2px
   * `primary-emphasis` border plus a 2px ring at a 2px offset, and
   * `aria-current="true"`, so color is never the only signal. Takes
   * precedence over the selection and highlight rings while it lasts.
   */
  current?: boolean;
  onSelect?: () => void;
  /**
   * Per-board card layout density (#961, #2272). Drives how much metadata renders on
   * the card face. ``comfortable`` (default) is a status line, one label, chips and
   * assignee. ``standard`` adds due date, weight, attachments and a second label.
   * ``dense`` is ONE row: title, short status, the first pinned field, assignee;
   * everything else is carried as screen-reader text and by the hover peek.
   * Default is ``comfortable`` so any caller that forgets to pass the prop (e.g. drag
   * overlay constructed without a board) degrades gracefully.
   */
  density?: CardDensity;
  userTimezone?: string;
  /** #445: the viewer, for the checklist "mine" suffix. Absent: no "mine" suffix. */
  currentUserId?: number;
  userDateFormat?: string;
  /** When true, the card is non-interactive: no drag, no hover lift, no onClick. Used on the share page. */
  readOnly?: boolean;
  /** When true, the hover peek never starts or renders (#1918). BoardView sets it
   *  for every card while the card detail sheet is open, because a floating peek
   *  would cover the fields being edited. Not folded into `readOnly`: hover lift,
   *  `hovered` styling, click-to-swap and the aging tooltip all stay live. */
  peekSuppressed?: boolean;
  /** When true, renders a compact single-line card with reduced padding (per-user layout pref, distinct from density). */
  compact?: boolean;
  staleness_threshold_days?: number;
  stale_warning_pct?: number;
  /** The card sits in a done column (`column.is_done`): it is finished, so it
   *  gets no aging tint, no aging tooltip and no "Stale" badge (#1841). */
  inDoneColumn?: boolean;
  /** Every board custom field definition (#371) — not pre-filtered; this
   *  component filters to pinned (`show_on_card`) ones for the chip row and
   *  passes the full list through to `CardPeekPopover` for the non-pinned
   *  ones. */
  customFieldDefinitions?: CustomFieldDefinition[];
  boardId?: number;
  /**
   * Visibility-only twin of the quick-edit opt-in (#2193): the drag overlay
   * gets no `boardId`/`onCardUpdated` (it must stay inert) but must still
   * render the same empty-pinned ghost chips as the in-cell card, or the
   * dragged preview's height differs. Never makes anything interactive.
   */
  canEdit?: boolean;
  /** Another card in the same cell is expanded (hovered or focused): this one
   *  is blurred and faded to near-invisible so the expanded card reads as the
   *  cell's only content. Driven by BoardCell from `onExpandChange`. */
  dimmed?: boolean;
  /** Reports the in-place expansion starting or ending, with the card id, so
   *  the cell can dim its other cards. One stable callback per cell. */
  onExpandChange?: (cardId: number, expanded: boolean) => void;
  /**
   * Called after a quick-edit write succeeds, with the full updated card —
   * same shape as the WS `card.updated` → `onCardUpdated` path in
   * `BoardView`, which already replaces the full card by id in local state.
   * Quick-edit chips (checkbox/dropdown) are interactive only when this is
   * provided; omit it (as the share-page / read-only call sites do) to get
   * plain, non-interactive chips.
   */
  onCardUpdated?: (card: Card) => void;
  /**
   * Opens the card context menu (#2059) for this card at `anchor`: right-click,
   * `Menu` / `Shift+F10` while the card has focus, or the `⋯ More actions`
   * button at coarse pointer. One stable callback for every card (it takes the
   * card), so the memo comparator stays cheap. Omit it and none of those paths
   * exist (share page, drag overlay, while the card detail sheet is open).
   */
  onOpenMenu?: (card: Card, anchor: CardMenuAnchor) => void;
  /** The context menu is open on this card alone (outside the selection): a
   *  transient `ring-info` outline marks what it will act on (#2059). */
  contextTarget?: boolean;
  /** Track states for this card on its stage (#1920); omit or [] for none. */
  trackStates?: CardTrackState[];
  /** Spell the track state out on each chip ("Technical: done"), phone width. */
  trackStatesSpelledOut?: boolean;
  /** Gate progress (#1102) when a split stage renders at normal width. */
  gateProgress?: { index: number; names: string[] } | null;
}

/** True when focus arrived by keyboard. Falls back to true where `:focus-visible` is unsupported. */
function isKeyboardFocus(el: HTMLElement): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

// Custom comparator for React.memo — avoids re-renders when the card object
// is referentially new but semantically identical.  We compare the scalar
// fields that affect rendering plus label/assignee identity.
function arePropsEqual(prev: Props, next: Props): boolean {
  if (
    prev.card.id !== next.card.id ||
    prev.card.updated_at !== next.card.updated_at ||
    prev.card.title !== next.card.title ||
    prev.card.column !== next.card.column ||
    prev.card.swimlane !== next.card.swimlane ||
    prev.card.position !== next.card.position ||
    prev.card.priority !== next.card.priority ||
    prev.card.due_date !== next.card.due_date ||
    prev.card.weight !== next.card.weight ||
    prev.card.description !== next.card.description ||
    prev.card.last_moved_at !== next.card.last_moved_at ||
    prev.card.last_move_is_creation !== next.card.last_move_is_creation ||
    prev.card.attachment_count !== next.card.attachment_count ||
    prev.card.checklist_total !== next.card.checklist_total ||
    prev.card.checklist_done !== next.card.checklist_done ||
    // #445: the face suffix reads these; a remote assign or due change must re-render.
    (prev.card.checklist_open_due_dates ?? []).join() !== (next.card.checklist_open_due_dates ?? []).join() ||
    (prev.card.checklist_open_assignee_ids ?? []).join() !== (next.card.checklist_open_assignee_ids ?? []).join() ||
    prev.card.is_stale !== next.card.is_stale ||
    prev.card.blocker_count !== next.card.blocker_count ||
    prev.card.blocked_at !== next.card.blocked_at ||
    prev.card.blocked_reason !== next.card.blocked_reason ||
    prev.card.external_ref?.url !== next.card.external_ref?.url ||
    prev.card.external_ref?.ref !== next.card.external_ref?.ref ||
    prev.card.external_ref?.provider !== next.card.external_ref?.provider ||
    prev.card.archived_at !== next.card.archived_at ||
    prev.card.assignee?.id !== next.card.assignee?.id ||
    prev.card.labels.length !== next.card.labels.length ||
    prev.card.custom_field_values.length !== next.card.custom_field_values.length
  ) return false;

  // Shallow label identity check
  for (let i = 0; i < prev.card.labels.length; i++) {
    const pl = prev.card.labels[i];
    const nl = next.card.labels[i];
    // name/color too: label.updated rewrites the embedded label in place (#1888).
    if (pl.id !== nl.id || pl.name !== nl.name || pl.color !== nl.color) return false;
  }

  // Custom field value check (#371) — NOT a copy of the labels loop above.
  // Labels' identity check is sufficient because membership *is* the datum
  // (present/absent); a custom field's value can change while its
  // field_definition id stays constant, so an id-only check here would
  // silently miss value edits and stale-render the chip. Assumes stable
  // array ordering from the API per card, the same pre-existing assumption
  // the labels loop already makes.
  for (let i = 0; i < prev.card.custom_field_values.length; i++) {
    const p = prev.card.custom_field_values[i];
    const n = next.card.custom_field_values[i];
    if (p.field_definition !== n.field_definition || p.value !== n.value) return false;
  }

  return (
    prev.onClick === next.onClick &&
    prev.overlay === next.overlay &&
    prev.selected === next.selected &&
    prev.highlighted === next.highlighted &&
    prev.current === next.current &&
    prev.onSelect === next.onSelect &&
    prev.density === next.density &&
    prev.userTimezone === next.userTimezone &&
    prev.currentUserId === next.currentUserId &&
    prev.userDateFormat === next.userDateFormat &&
    prev.readOnly === next.readOnly &&
    prev.peekSuppressed === next.peekSuppressed &&
    prev.compact === next.compact &&
    prev.staleness_threshold_days === next.staleness_threshold_days &&
    prev.stale_warning_pct === next.stale_warning_pct &&
    prev.inDoneColumn === next.inDoneColumn &&
    prev.customFieldDefinitions === next.customFieldDefinitions &&
    prev.boardId === next.boardId &&
    prev.canEdit === next.canEdit &&
    prev.dimmed === next.dimmed &&
    prev.onExpandChange === next.onExpandChange &&
    prev.onCardUpdated === next.onCardUpdated &&
    prev.onOpenMenu === next.onOpenMenu &&
    prev.contextTarget === next.contextTarget &&
    // Sub-columns and tracks (#2278): a remap or a track value change must
    // repaint the chips and the progress bar. Compared by content, since the
    // phone board derives a fresh array per render.
    prev.card.gates_passed === next.card.gates_passed &&
    prev.card.version === next.card.version &&
    prev.trackStatesSpelledOut === next.trackStatesSpelledOut &&
    sameTrackStates(prev.trackStates, next.trackStates) &&
    sameGateProgress(prev.gateProgress, next.gateProgress)
  );
}

function sameTrackStates(a: CardTrackState[] | undefined, b: CardTrackState[] | undefined): boolean {
  if (a === b) return true;
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((t, i) => t.id === y[i].id && t.name === y[i].name && t.state === y[i].state && t.fromLane === y[i].fromLane);
}

function sameGateProgress(a: Props["gateProgress"], b: Props["gateProgress"]): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return a.index === b.index && a.names.length === b.names.length && a.names.every((n, i) => n === b.names[i]);
}

const CardItem = memo(function CardItem({ card, onClick, overlay, selected, highlighted, current = false, onSelect, density = "comfortable", userTimezone = "", currentUserId, userDateFormat = "MM/DD/YYYY", readOnly = false, peekSuppressed = false, compact = false, staleness_threshold_days = 14, stale_warning_pct = 50, inDoneColumn = false, customFieldDefinitions: allFieldDefinitions = EMPTY_DEFS, boardId, canEdit = false, dimmed = false, onExpandChange, onCardUpdated, onOpenMenu, contextTarget = false, trackStates, trackStatesSpelledOut = false, gateProgress = null }: Props) {
  // Dimension fields (#1921) are tracks, shown as chips; they never pin to the card face.
  const customFieldDefinitions = useMemo(() => allFieldDefinitions.filter((d) => !isDimensionField(d)), [allFieldDefinitions]);
  // Per-density visibility booleans (#961, #2272). The decision tree:
  //   comfortable → status line, one label, checklist, assignee
  //   standard    → adds due date (when not in the status line), weight (>1), attachments, second label
  //   dense       → one row (see `denseRow`); the booleans below only gate the non-dense faces
  // The middle tier is named ``standard`` rather than ``compact`` to avoid
  // colliding with the per-user *Card layout: Compact / Expanded* toolbar pref.
  const showDueDatePill = density !== "comfortable";
  const showAttachments = density !== "comfortable";
  const showWeight = density !== "comfortable";
  // Compact layout only: the dense row draws neither, and the non-compact faces never did.
  const showRecentlyMovedDot = density === "dense";
  const showPriorityBadge = density === "dense";
  // MR/PR badge (#352): glyph + ref at standard/dense, glyph only at
  // comfortable (the ref is in the accessible name, title, and peek).
  const showExternalRefText = density !== "comfortable";
  const externalRef = card.external_ref ?? null;
  const labelLimit = density === "standard" ? 2 : 1;
  // useDraggable must be called unconditionally (hook rules). When readOnly,
  // we do not attach its ref or event listeners so the card is non-draggable.
  const draggable = useDraggable({ id: card.id, disabled: readOnly });
  const { attributes, listeners, setNodeRef, isDragging } = draggable;
  const [hovered, setHovered] = useState(false);
  // Quick-edit dropdown popover state (#371) — which pinned field's chip
  // opened it, and the chip's own rect for anchoring. Checkbox chips toggle
  // directly on click with no popover.
  const [quickEditFieldId, setQuickEditFieldId] = useState<number | null>(null);
  const [quickEditAnchor, setQuickEditAnchor] = useState<DOMRect | null>(null);
  // Tracks tooltip visibility for the aging indicator. We manage this with
  // local state rather than wrapping the card in <Tooltip> (which uses
  // cloneElement and would clobber ref={setNodeRef} from useDraggable).
  const [showTooltip, setShowTooltip] = useState(false);

  // --- Card peek state ---
  // Internal peek state — no prop changes needed, so arePropsEqual doesn't need updating.
  const [peekVisible, setPeekVisible] = useState(false);
  // Captured DOMRect of the card element at hover-start time, stored as state so
  // the popover re-renders at the correct position even if the card scrolls.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  // Ref to the card's outer div so we can capture its bounding rect on hover.
  const cardRef = useRef<HTMLDivElement>(null);
  // Context menu (#2059): the pointer type of the last press, so a touch
  // long-press (dnd-kit's drag start, #1287) never opens the menu, and the
  // time a key opened it, so the native `contextmenu` event the Menu key and
  // Shift+F10 also fire does not open it a second time.
  const lastPointerType = useRef<string | null>(null);
  const keyboardMenuAt = useRef(0);
  const rectAnchor = (el: HTMLElement): CardMenuAnchor => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left };
  };
  const menuEnabled = !!onOpenMenu && !readOnly && !overlay;
  // Title padding for the Show summary button follows the card, not the menu: BoardView drops
  // onOpenMenu while a sheet is open, and gating on it would re-wrap every title on open/close (#2358).
  const boardFace = !readOnly && (!!onClick || !!overlay);
  // Ref to the peek timer so we can clear it on mouseleave / drag start.
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- In-place hover expansion ---
  // On hover (or keyboard focus inside the metadata row) the row stops
  // clipping and wraps so every chip is readable. That used to happen in
  // flow: the card grew, the cell grew with it, and so did every cell in the
  // swimlane row, so the whole board jumped under the pointer. The expansion
  // is now an overlay: the wrapper div freezes at the card's at-rest height
  // (`expandBase`) and the card itself goes `absolute`, so nothing around it
  // moves. `expandClamp` then keeps the overlay inside its cell: the card is
  // shifted up when it would run past the cell's bottom edge, and capped at
  // the cell's inner height. Covering the sibling cards in the same cell is
  // the intent; growing or leaving the cell is not.
  // `rowFocused` tracks focus inside the metadata row (a chip's quick-edit
  // button, the MR/PR link), the former `focus-within:` case.
  // `cardFocused` (#1414) is the keyboard twin of `hovered`: keyboard focus on
  // the card itself. Without it a card whose overflow is all non-interactive
  // (labels, text chips, checklist/due pills) had no keyboard path to the
  // expansion, while a mouse user got it by resting anywhere on the card.
  // Pointer-click focus does not count (the pointer is already hovering), and
  // focus on another control on the card (checkbox, ⋯) does not either, the
  // same gate as the aging tooltip.
  const [rowFocused, setRowFocused] = useState(false);
  const [cardFocused, setCardFocused] = useState(false);
  const [expandBase, setExpandBase] = useState<number | null>(null);
  const [expandClamp, setExpandClamp] = useState<{ top: number; maxHeight: number } | null>(null);
  const wantExpand = (hovered || rowFocused || cardFocused) && !isDragging && !overlay;
  const expanded = wantExpand && expandBase !== null;

  // #1305 — mouseleave/drag-start already clear this timer during normal
  // interaction, but a card can also unmount directly out from under a
  // pending hover (e.g. a WebSocket move/delete broadcast while the pointer
  // is still resting on it), which neither of those handlers would see.
  useEffect(() => {
    return () => {
      if (peekTimer.current !== null) clearTimeout(peekTimer.current);
    };
  }, []);

  // Combine dnd-kit's setNodeRef with our own cardRef using a stable callback ref.
  // setNodeRef is stable for the lifetime of the draggable hook instance.
  const compositeRef = useCallback(
    (el: HTMLDivElement | null) => {
      setNodeRef(el);
      (cardRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [setNodeRef],
  );

  // Both effects are layout effects so the measure → re-render happens before
  // the browser paints: the card is never painted in flow and wrapped (the
  // old layout jump) on its way to being an overlay.
  useLayoutEffect(() => {
    if (!wantExpand) {
      setExpandBase(null);
      setExpandClamp(null);
      return;
    }
    // Still in flow at this point (expandBase is null), so the wrapper's
    // height is the card's at-rest footprint. The fractional rect height,
    // not offsetHeight: a rounded value would still nudge the cell by a
    // sub-pixel.
    const wrapper = cardRef.current?.parentElement;
    if (wrapper) setExpandBase(wrapper.getBoundingClientRect().height);
  }, [wantExpand]);

  useLayoutEffect(() => {
    if (expandBase === null) return;
    const el = cardRef.current;
    const cell = el?.closest<HTMLElement>("[data-board-cell]");
    const wrapper = el?.parentElement;
    if (!el || !cell || !wrapper) return;
    // The card is now absolute and wrapped, so offsetHeight is its full
    // expanded height. Clamp it to the cell's content box.
    const cs = getComputedStyle(cell);
    const cellRect = cell.getBoundingClientRect();
    const cellTop = cellRect.top + (parseFloat(cs.paddingTop) || 0);
    const cellBottom = cellRect.bottom - (parseFloat(cs.paddingBottom) || 0);
    const slotTop = wrapper.getBoundingClientRect().top;
    const roomBelow = cellBottom - slotTop;
    const overflow = el.offsetHeight - roomBelow;
    const shift = overflow > 0 ? Math.max(0, Math.min(overflow, slotTop - cellTop)) : 0;
    setExpandClamp({ top: -shift, maxHeight: Math.max(0, cellBottom - cellTop) });
  }, [expandBase]);

  // Tell the cell when this card's expansion starts and ends, so it can dim
  // the others. Also reports the end on unmount (a card moved or deleted out
  // from under the pointer), or the cell would stay dimmed.
  useEffect(() => {
    if (!onExpandChange || !expanded) return;
    onExpandChange(card.id, true);
    return () => onExpandChange(card.id, false);
  }, [expanded, onExpandChange, card.id]);

  const handleMouseEnter = () => {
    setHovered(true);
    setShowTooltip(true);
    // Disabled when: readOnly, overlay prop set. isDragging is checked in the timer callback.
    if (readOnly || overlay || peekSuppressed) return;
    peekTimer.current = setTimeout(() => {
      // Bail out if dragging started while we were waiting.
      if (cardRef.current) {
        setAnchorRect(cardRef.current.getBoundingClientRect());
        setPeekVisible(true);
      }
    }, 600);
  };

  const handleMouseLeave = () => {
    setHovered(false);
    setShowTooltip(false);
    if (peekTimer.current !== null) {
      clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
    setPeekVisible(false);
  };

  // When dragging starts, clear the timer and hide peek immediately.
  // Using useEffect so we never call setState during render.
  useEffect(() => {
    if (isDragging) {
      if (peekTimer.current !== null) {
        clearTimeout(peekTimer.current);
        peekTimer.current = null;
      }
      setPeekVisible(false);
      setQuickEditFieldId(null);
    }
  }, [isDragging]);

  // #1918 — the card detail sheet opening clears a pending timer and unmounts a
  // visible peek in the same commit. Closing does nothing: the peek only comes
  // back on the next mouseenter.
  useEffect(() => {
    if (peekSuppressed) {
      if (peekTimer.current !== null) {
        clearTimeout(peekTimer.current);
        peekTimer.current = null;
      }
      setPeekVisible(false);
    }
  }, [peekSuppressed]);

  // 24h is intentional here — it represents "moved in the current working session",
  // not the board's staleness threshold. The two concepts are independent:
  // staleness_threshold_days flags cards that need attention; the 24h window
  // controls which cards show a dot (very recent) vs. a text label (older).
  // A creation-only history is not a move (#1576): no dot, no "moved" text.
  const isRecent = card.last_moved_at && !card.last_move_is_creation
    ? Date.now() - new Date(card.last_moved_at).getTime() < 86_400_000
    : false;

  // Graduated aging ramp (#1841): agingTint is the single source for the stage,
  // the idle days and the tint classes — never recompute the ratio here.
  // A card in a done column is finished, not idle: no tint, tooltip or Stale
  // badge, whatever the server's is_stale says (it does not look at columns).
  const aging = agingTint(inDoneColumn ? null : agingReference(card), staleness_threshold_days, stale_warning_pct);
  const { overlayClass, bodyOpacityClass, metaClass } = aging;
  const agingTooltip = overlayClass !== null
    ? formatAgingTooltip(aging, staleness_threshold_days, stale_warning_pct, card.is_stale, card.blocker_count, isManuallyBlocked(card))
    : null;

  const dueInfo = card.due_date ? formatDueDate(card.due_date, userTimezone, userDateFormat) : null;
  const checklistSuffix = card.checklist_total > 0
    ? checklistFaceSuffix(card, checklistToday(userTimezone), currentUserId)
    : null;
  // #2272, #2279: the face is calm: only an overdue card carries a colored
  // border. Priority and blocked (manual or by a relation) move into text (the
  // accessible name, the blocked indicator) and draw no border of their own.
  // The Classic preset id resolves to this face; there is no other.
  // #2272: the calm Dense tier is ONE row: title, short status, first pinned field (and the
  // assignee at the end). Everything else Dense used to carry moves to the hover peek.
  const denseRow = !compact && density === "dense";
  // A fragment outside the dense row, so every other face keeps its DOM byte for byte.
  const RowWrap: React.ElementType = denseRow ? "div" : Fragment;
  // The one pinned field the Dense row carries: the first (by position) that has a
  // value, else the first pinned field as a dashed ghost (#2193), so an unset
  // dropdown or checkbox can still be set from the card face without a second row.
  const denseFieldId = (() => {
    if (!denseRow) return null;
    const pinned = customFieldDefinitions.filter((d) => d.show_on_card).sort((a, b) => a.position - b.position);
    const withValue = pinned.find((d) => card.custom_field_values.some((v) => v.field_definition === d.id && v.value !== ""));
    return (withValue ?? pinned[0])?.id ?? null;
  })();
  // The face puts the assignee avatar at the end of the label row; the
  // compact layout keeps the absolutely-positioned bottom-right avatar (#1411).
  const avatarInRow = !compact && !!card.assignee;
  const AvatarWrap: React.ElementType = avatarInRow ? "div" : Fragment;
  // The overdue rule (#2313): finished work (a Done column, or archived) is never overdue.
  const cardClosed = inDoneColumn || !!card.archived_at;
  // One clock reading for every classification in this render (#2393): the
  // badge, the status line and the border must classify the same instant, so a
  // midnight or due-soon boundary can never fall between two calls.
  const urgencyNow = Date.now();
  const isOverdueCard = classifyCardUrgency({ due_date: card.due_date, closed: cardClosed, is_stale: false, last_moved_at: null }, urgencyNow)?.kind === "overdue";
  const priorityColor = colorForPriority(card.priority);
  const borderColor = isOverdueCard ? "rgb(var(--danger-emphasis))" : undefined;
  // Urgency now owns the border, so priority (otherwise read from its hue) goes
  // into the card's accessible name instead; the peek already states it.
  const prioritySuffix = card.priority !== "low"
    ? `, Priority: ${card.priority}`
    : "";
  const blockedLabel = isCardBlocked(card) ? blockedIndicatorLabel(card) : "";

  // Worst-offender urgency (#961), computed for comfortable / standard only.
  // Dense is the one-row calm face (#2272): it has no urgency badge, and its
  // status and due date come from the status line and the sr-only text below.
  // With a status line the badge only ever shows the calm "Just moved" cue.
  const urgency = density === "dense"
    ? null
    : classifyCardUrgency(
        { due_date: card.due_date, closed: cardClosed, is_stale: card.is_stale && !inDoneColumn, last_moved_at: card.last_moved_at, last_move_is_creation: card.last_move_is_creation },
        urgencyNow,
      );
  // The status line (#2272) is the one place the status shows,
  // at every density: a text line under the metadata at Comfortable, inline in
  // the row at Standard, a short form at Dense. The compact layout keeps the
  // AgingCue glyph and has no status line.
  const statusUrgency = !compact
    ? classifyCardUrgency({ due_date: card.due_date, closed: cardClosed, is_stale: card.is_stale && !inDoneColumn, last_moved_at: null }, urgencyNow)
    : null;
  const status = statusUrgency && (statusUrgency.kind === "overdue" || statusUrgency.kind === "due-soon" || statusUrgency.kind === "stale")
    ? buildCardStatusLine({
        kind: statusUrgency.kind as CardStatusKind,
        dueDate: card.due_date,
        dueLabel: dueInfo?.label ?? null,
        idleDays: aging.stage !== "none" ? aging.idleDays : 0,
      })
    : null;
  const statusInline = status !== null && density !== "comfortable";
  const statusRow = status !== null && density === "comfortable";
  // The badge is only ever the calm "Just moved" cue (#2393). `urgency` and
  // `statusUrgency` classify the same inputs at the same instant and differ only
  // in `last_moved_at`, which decides nothing but the lowest-priority "recent"
  // kind, so whenever `urgency` is overdue, due soon or stale the status line
  // already shows that kind. `cardUrgencyAgreement.test.ts` pins this.
  const justMovedBadge = !status && urgency?.kind === "recent" ? urgency : null;
  const dueAlreadyInUrgency = status?.kind === "overdue" || status?.kind === "due-soon";
  // The one-row Dense face draws none of these, so each is carried as words for
  // assistive technology (visible: the hover peek / peek panel).
  const denseSrText = (() => {
    if (!denseRow) return "";
    const parts: string[] = [];
    if (card.labels.length > 0) parts.push(`Labels: ${card.labels.map((l) => l.name).join(", ")}`);
    if (card.checklist_total > 0) parts.push(`Checklist ${card.checklist_done} of ${card.checklist_total}`);
    if (card.attachment_count > 0) parts.push(`${card.attachment_count} attachment${card.attachment_count === 1 ? "" : "s"}`);
    if (card.weight > 1) parts.push(`Weight ${card.weight}`);
    // The Dense status text is only "Overdue" or "Due soon" (no date), so the date
    // is always spoken here whatever the status kind is.
    // `dueInfo.label` already starts with "Due" ("Due tomorrow", "Due 01/15/2099").
    if (dueInfo) parts.push(dueInfo.label);
    if (externalRef) parts.push(`${PROVIDER_LABELS[externalRef.provider] ?? externalRef.provider} ${externalRef.ref}`);
    return parts.length > 0 ? `, ${parts.join(". ")}` : "";
  })();
  // Comfortable draws no on-track due date (the status line carries only an
  // overdue or due-soon one), so the date is spoken here instead (#2399, owner
  // decision): the face stays calm and the hover peek shows it visibly.
  const comfortableDueSrText = !compact && density === "comfortable" && dueInfo && !dueAlreadyInUrgency
    ? `, ${dueInfo.label}`
    : "";
  // The standalone due pill (Standard, outside the status line) is always a
  // plain, on-track date (#2393). Any date `formatDueDate` calls past (the
  // user's zone) is overdue or due soon under `classifyCardUrgency` (the
  // instance zone), whose status line then carries the date and hides the pill,
  // so the pill never needs an urgency glyph or tone.

  // Suppress the recently-moved dot when urgency is already showing "Just moved".
  const recentAlreadyInUrgency = urgency?.kind === "recent";
  // The badge sits on the card's aging tint whenever one is shown, so its text
  // uses an on-tint token that clears 4.5:1 on that stage (#1550, #1841).
  const justMovedToneClass = justMovedBadge ? urgencyBadgeToneClass(justMovedBadge.tone, aging.stage) : "";
  // Wherever that badge is not on the card face, the title carries the
  // AgingCue stage glyph instead, so an aging tint (including the yellow
  // warning stage, which never gets the badge) is never color-only (#1843, #1863).
  const staleBadgeShown = status?.kind === "stale";

  // Pinned custom fields (#371, Direction A). Quick-edit is only wired when
  // the caller opted in by passing both boardId and onCardUpdated — the
  // share page / any read-only render simply omits them and gets plain,
  // non-interactive chips, the same opt-in shape as onSelect above.
  const pinnedFields = customFieldDefinitions.filter((d) => d.show_on_card).sort((a, b) => a.position - b.position);
  const quickEditEnabled = !readOnly && boardId !== undefined && !!onCardUpdated;
  // Whether quick edit can set this field from the card face (#371).
  const isQuickEditable = (d: CustomFieldDefinition) =>
    quickEditEnabled && (d.field_type === "checkbox" || d.field_type === "dropdown");
  // Empty-value handling: dense renders a ghost for every unset pinned
  // field; comfortable/standard render one only for a quick-editable field
  // (#2193, superseding the #371 §2 "omit entirely" rule, which left a
  // cleared dropdown or checkbox with no way back from the card face). A
  // ghost counts toward "is there anything in this row", like a set chip.
  const showsPinnedChip = (d: CustomFieldDefinition) => {
    const v = card.custom_field_values.find((cv) => cv.field_definition === d.id);
    const ghostVisible = (quickEditEnabled || (!!overlay && canEdit && !readOnly)) && (d.field_type === "checkbox" || d.field_type === "dropdown");
    return (v && v.value !== "") || density === "dense" || ghostVisible;
  };
  const hasVisibleCustomFieldChips = pinnedFields.some(showsPinnedChip);

  const commitCustomFieldValue = async (fieldId: number, value: string) => {
    if (boardId === undefined || !onCardUpdated) return;
    const nextValues = withCustomFieldValue(card.custom_field_values, fieldId, value);
    try {
      const updated = await updateCard(boardId, card.id, { custom_field_values: nextValues });
      onCardUpdated(updated);
    } catch {
      // Silent rollback — matches the existing label/priority quick-toggle
      // precedent in CardDetail: the card simply stays at its last-known-good
      // server state since we never optimistically mutated `card` itself here
      // (only local UI state). A failure toast through the shared region
      // (frontend/CLAUDE.md § Toasts) would be a design change, not done here.
    }
  };

  // card.assignee stays in this OR-chain even though the avatar itself no
  // longer renders inside the row (#1411): the row is what reserves the
  // absolutely-positioned avatar's footprint, so when the assignee is the
  // card's ONLY metadata the row must still render. An empty row has zero
  // height, though, so `pr-7` alone reserves nothing vertically — the row also
  // carries `min-h-5` (20px, the xs Avatar's height) whenever an assignee is
  // set. Height + right padding together reserve the avatar's box below the
  // title; without the min-height the 20px avatar (bottom-1.5) overlaps the
  // last title line by ~12px.
  //
  // Only what renders in the compact layout may count without `!compact`
  // (#1843): counting an item the compact branch never renders gives a compact
  // card an empty row and 6px of extra height.
  // Title: text before " -- " is the bold company name, the rest a subtitle (#2272).
  const sepAt = card.title.indexOf(" -- ");
  const splitTitle = !compact && sepAt > 0 && sepAt + 4 < card.title.length
    ? { head: card.title.slice(0, sepAt), rest: card.title.slice(sepAt + 4) }
    : null;
  const showSubtitle = splitTitle !== null && density === "comfortable";
  const statusToneClass = !status
    ? ""
    : status.kind === "overdue"
    ? urgencyBadgeToneClass("danger", aging.stage)
    : status.kind === "stale"
    ? staleBadgeToneClass(aging.stage)
    : "text-fg-secondary";
  const statusNode = status ? (
    <span
      data-testid="card-status-line"
      data-status-kind={status.kind}
      className={`inline-flex items-center gap-1 text-xs font-semibold shrink-0 ${statusToneClass}`}
      title={status.kind === "stale" ? agingTooltip ?? status.text : status.kind === "overdue" || status.kind === "due-soon" ? `Due ${card.due_date}` : undefined}
    >
      <UrgencyGlyph kind={status.kind === "overdue" ? "overdue" : status.kind === "due-soon" ? "due-soon-flag" : "stale"} />
      {density === "dense" ? (
        <>
          {status.shortSrPrefix && <span className="sr-only">{status.shortSrPrefix}</span>}
          {status.shortText}
        </>
      ) : (
        status.text
      )}
    </span>
  ) : null;

  const hasMetadataRow =
    !!card.assignee ||
    isCardBlocked(card) ||
    (denseRow && (statusInline || denseFieldId !== null)) ||
    (!denseRow && showRecentlyMovedDot && isRecent && !recentAlreadyInUrgency) ||
    (!denseRow && showPriorityBadge && card.priority !== "low") ||
    (!compact && !denseRow && (
      card.labels.length > 0 ||
      card.checklist_total > 0 ||
      (showAttachments && card.attachment_count > 0) ||
      (showDueDatePill && !!dueInfo && !dueAlreadyInUrgency) ||
      (showWeight && card.weight > 1) ||
      !!justMovedBadge ||
      statusInline ||
      hasVisibleCustomFieldChips ||
      !!externalRef
    ));

  return (
    <>
    {/* While expanded, this wrapper holds the card's at-rest height so the
        overlay below it never changes the cell's layout. */}
    <div
      className={`relative transition-[opacity,filter] duration-150 ${dimmed ? "opacity-[0.08] blur-[2px]" : ""}`}
      data-dimmed={dimmed ? "true" : undefined}
      style={expanded ? { height: expandBase } : undefined}
    >
      {/* Sibling tooltip — rendered as an absolutely-positioned overlay so we
          never need to wrap the card root div in cloneElement-based <Tooltip>,
          which would clobber ref={setNodeRef} from useDraggable. */}
      {overlayClass && showTooltip && agingTooltip && (
        <div
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-50 bg-sunken text-fg text-xs rounded px-2 py-1 shadow-lg w-max max-w-[16rem] text-center pointer-events-none"
        >
          {agingTooltip}
        </div>
      )}
    <div
      ref={compositeRef}
      {...attributes}
      {...listeners}
      // Sanctioned exception to the "no bare onKeyDown on a div" rule (frontend/CLAUDE.md): this
      // forwards the dnd-kit KeyboardSensor listener, and the div already has role="button" and
      // tabIndex from dnd-kit `attributes`. Behavior is identical to the spread; restating it
      // makes the keyboard handler visible to static analysis (S1082) (#1376).
      onKeyDown={(e) => {
        // Menu / Shift+F10 on the focused card opens its context menu, anchored
        // to the card's bottom-left (#2059). Platform keys, no letters.
        if (menuEnabled && e.target === e.currentTarget && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
          e.preventDefault();
          e.stopPropagation();
          keyboardMenuAt.current = Date.now();
          onOpenMenu?.(card, rectAnchor(e.currentTarget));
          return;
        }
        // Enter or Space on the focused card itself opens it (Shift: the peek, #2358). The div is
        // role="button", so the browser never turns the key into a click; keys typed
        // in a child control (checkbox, menu button, inputs) have another target.
        if (!readOnly && onClick && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick(e.shiftKey ? { peek: true } : undefined);
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
      onPointerDown={menuEnabled ? (e) => { lastPointerType.current = e.pointerType; } : undefined}
      // The card owns right-click (#2059): it stops here, so the cell's
      // add-card shortcut fires only from empty cell space (BoardCell also
      // ignores a contextmenu from inside a card face).
      onContextMenu={menuEnabled ? (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (isDragging) return;
        // A touch long-press is the drag start (#1287); release-without-movement
        // is unverified on device (#2104), so the touch path is the ⋯ button only.
        const native = e.nativeEvent as MouseEvent & { pointerType?: string };
        if (native.pointerType === "touch" || lastPointerType.current === "touch") return;
        if (Date.now() - keyboardMenuAt.current < 500) return;
        // A keyboard-generated contextmenu has no pointer position.
        const fromKeyboard = e.clientX === 0 && e.clientY === 0;
        onOpenMenu?.(card, fromKeyboard ? rectAnchor(e.currentTarget) : { top: e.clientY, bottom: e.clientY, left: e.clientX });
      } : undefined}
      onClick={readOnly || !onClick ? undefined : (e) => onClick(e.shiftKey ? { peek: true } : undefined)}
      // The card detail sheet finds the open card's face by this (#1914). The
      // drag-overlay copy has none, so it never matches.
      data-card-id={overlay ? undefined : card.id}
      aria-current={current ? "true" : undefined}
      data-no-pan
      data-tour-step="card"
      // A selected card drops its bg-primary-emphasis/20 fill while an aging tint is shown:
      // the fill under the tint pulled the badge to 3.7:1 (#1841). The
      // selection ring alone still marks it.
      className={`group bg-surface rounded-md select-none transition-all border z-0
        ${expanded ? "absolute left-0 right-0 overflow-hidden" : "relative"}
        ${readOnly ? "cursor-default" : `cursor-pointer hover:-translate-y-px hover:z-20`}
        ${!current && !isOverdueCard ? "border-line hover:border-line-strong" : ""}
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-emphasis focus-visible:ring-offset-2 focus-visible:ring-offset-sunken
        ${isDragging && !overlay ? "opacity-25 !shadow-none !translate-y-0" : ""}
        ${overlay ? "rotate-2 opacity-95 !-translate-y-1 shadow-2xl motion-reduce:rotate-0 motion-reduce:!translate-y-0" : ""}
        ${current ? "border-2 -m-px border-primary-emphasis ring-2 ring-primary-emphasis ring-offset-2 ring-offset-sunken" : contextTarget ? `ring-1 ring-info${overlayClass ? "" : " bg-info/10"}` : highlighted ? "ring-2 ring-primary-soft ring-offset-1 ring-offset-sunken animate-pulse motion-reduce:animate-none" : selected ? `ring-2 ring-primary-soft${overlayClass ? "" : " bg-primary-emphasis/20"}` : ""}
      `}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      // The aging tooltip states the idle days (#1841), so keyboard users get it
      // too: shown on keyboard focus, never on a pointer click's focus. The same
      // gate expands the metadata row (#1414), the keyboard twin of hover.
      onFocus={(e) => {
        if (e.target === e.currentTarget && isKeyboardFocus(e.currentTarget)) {
          setShowTooltip(true);
          setCardFocused(true);
        }
      }}
      onBlur={() => { setShowTooltip(false); setCardFocused(false); }}
      style={{
        // The open card's border is the primary-emphasis class above; the
        // -m-px offsets its extra pixel so the card stack does not shift.
        borderColor: current ? undefined : borderColor,
        // Overlay clamp: shifted up when the expansion would run past the
        // cell's bottom edge, never taller than the cell's content box.
        top: expanded && expandClamp ? expandClamp.top : undefined,
        maxHeight: expanded && expandClamp ? expandClamp.maxHeight : undefined,
        // The lifted copy takes the spec's deep shadow as the `shadow-2xl` token (#2326),
        // so it is left to the class here; an inline value would override it.
        boxShadow: isDragging && !overlay
          ? "none"
          : overlay
          ? undefined
          : hovered
          ? "0 4px 0 rgba(0,0,0,0.5), 0 6px 16px rgba(0,0,0,0.35)"
          : "0 2px 0 rgba(0,0,0,0.45), 0 1px 6px rgba(0,0,0,0.25)",
      }}
    >
      {overlayClass && (
        <div className={overlayClass} aria-hidden="true" />
      )}
      {/* top-[7px], not top-1: the grid cell is a 6px well (5px padding + 1px border, #2270), so the
          13px dwell-overlay tab above a card only clears the checkbox when the checkbox sits 7px
          down (6 + 1px card border + 7 = 14). See frontend/CLAUDE.md (grid overlay value badge). */}
      {onSelect && (
        <div
          role="checkbox"
          aria-checked={selected}
          tabIndex={0}
          className={`absolute top-[7px] right-1 w-4 h-4 rounded border flex items-center justify-center cursor-pointer transition z-10
            focus:outline-none focus:ring-2 focus:ring-primary-emphasis
            ${selected ? "bg-primary-emphasis border-primary-emphasis text-on-primary opacity-100" : "border-line-strong bg-surface-hover opacity-0 group-hover:opacity-100 focus:opacity-100"}
          `}
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); onSelect(); }}
          onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onSelect(); } }}
          // Drags start on mousedown / touchstart (#1287), not pointerdown, so all
          // three must stop here or pressing the checkbox and moving drags the card.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          {selected && (
            <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2 6l3 3 5-5" />
            </svg>
          )}
        </div>
      )}
      {/* ⋯ More actions (#2059): the guaranteed touch path to the context menu,
          on the selected or focused card at coarse pointer only. Never a
          hover reveal (§ Hover-reveal controls); 44px target. Presses stop
          here so they neither open the card nor start a drag (#1287). */}
      {menuEnabled && (
        <button
          type="button"
          aria-label="More actions"
          aria-haspopup="menu"
          data-testid="card-more-actions"
          onClick={(e) => { e.stopPropagation(); onOpenMenu?.(card, rectAnchor(e.currentTarget)); }}
          onKeyDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          className={`absolute top-0 right-5 z-10 w-11 h-11 items-center justify-center rounded-full text-fg-secondary hidden ${
            selected ? "[@media(pointer:coarse)]:flex" : "[@media(pointer:coarse)]:group-focus-within:flex"
          } focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
        >
          <span aria-hidden="true" className="w-7 h-7 rounded-full bg-surface-hover border border-line-strong flex items-center justify-center leading-none">⋯</span>
        </button>
      )}
      {/* Show summary (#2358): the visible path to the read-only peek that
          Shift+click opens. Revealed like the selection checkbox (hover, focus);
          on touch it shows with ⋯ More actions (selected or focused card) as a
          44px target beside it. Presses stop here so they neither open the
          detail panel nor start a drag (#1287). */}
      {menuEnabled && onClick && (
        <button
          type="button"
          aria-label="Show summary"
          title="Show summary (Shift+click)"
          data-testid="card-show-summary"
          onClick={(e) => { e.stopPropagation(); onClick({ peek: true }); }}
          onKeyDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          className={`absolute top-[7px] right-6 z-10 w-6 h-6 [@media(pointer:coarse)]:top-0 [@media(pointer:coarse)]:right-16 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:h-11 items-center justify-center rounded-full text-fg-secondary hidden ${
            selected ? "[@media(pointer:coarse)]:flex [@media(hover:hover)]:group-hover:flex group-focus-within:flex" : "[@media(hover:hover)]:group-hover:flex group-focus-within:flex"
          } focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
        >
          <span aria-hidden="true" className="w-6 h-6 [@media(pointer:coarse)]:w-7 [@media(pointer:coarse)]:h-7 rounded-full bg-surface-hover border border-line-strong flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1.5 8s2.3-4.5 6.5-4.5S14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>
          </span>
        </button>
      )}
      <div className={`relative px-2.5 ${compact ? "pt-[7px] pb-1.5" : "py-2"}${bodyOpacityClass ? ` ${bodyOpacityClass}` : ""}`}>
        {/* The title keeps clear of the card-face overlay controls. Show summary reserves pr-14 at fine pointers permanently, so hover never re-wraps the title; ⋯ reserves its width at coarse pointers only while shown. */}
        <RowWrap {...(denseRow ? { className: `flex items-center gap-2${boardFace ? " [@media(pointer:fine)]:pr-12" : ""}`, "data-testid": "card-dense-row" } : {})}>
        <p title={!compact && density !== "comfortable" ? card.title : undefined} className={`leading-snug ${denseRow ? "flex-1 min-w-0 " : ""}${compact ? "text-xs text-fg line-clamp-1" : `text-sm font-semibold text-fg ${density === "comfortable" ? "line-clamp-2" : "line-clamp-1"}`}${
          menuEnabled ? (selected ? " [@media(pointer:coarse)]:pr-28" : " [@media(pointer:coarse)]:group-focus-within:pr-28") : ""
        }${boardFace && !denseRow ? " [@media(pointer:fine)]:pr-14" : ""}`}>
          {!staleBadgeShown && <AgingCue stage={aging.stage} idleDays={aging.idleDays} />}
          {/* The compact layout has no status line, so the overdue border would be
              the only signal; a flag and words keep it from resting on color alone (#2272). */}
          {isOverdueCard && compact && (
            <>
              <UrgencyGlyph kind="overdue" className="inline-block w-3 h-3 mr-1 align-[-0.125em] text-danger" />
              <span className="sr-only">Overdue, </span>
            </>
          )}
          {!compact ? (splitTitle ? splitTitle.head : card.title) : card.title}
        </p>

        {/* #2272: the text after " -- " is the subtitle (Comfortable only; Standard and Dense keep the title to one line). */}
        {showSubtitle && splitTitle && (
          <p data-testid="card-subtitle" className="mt-0.5 text-xs leading-snug text-fg-secondary line-clamp-2">{splitTitle.rest}</p>
        )}

        {/* #1920 spec § Cards row 2: track chips, only in a column that has tracks; #1102 gate progress when sub-columns are hidden. */}
        {gateProgress && <GateProgress index={gateProgress.index} names={gateProgress.names} />}
        {trackStates && trackStates.length > 0 && <TrackChips tracks={trackStates} spelledOut={trackStatesSpelledOut} />}

        {/* Description exists — indicator only; full content shown in card detail */}

        {hasMetadataRow && (
          <AvatarWrap {...(avatarInRow ? { className: `flex items-center gap-1 ${denseRow ? "shrink-0 max-w-[60%]" : "mt-1.5"}` } : {})}>
          {/* metaClass (#1844): on a tinted card, `card-aging-meta` rescopes every
          // metadata text token in this row to its on-tint value, so the row
          // clears 4.5:1 on every aging stage. Empty on an untinted card, where
          // the row's quietest text is fg-tertiary (#1862): fg-muted and fg-faint
          are below 4.5:1 on bg-surface in dark mode, so they are not used here. */}
          <div
            data-testid="card-metadata-row"
            className={`flex items-center gap-1 ${avatarInRow || denseRow ? "min-w-0" : "mt-1.5"}${avatarInRow ? " flex-1" : ""} ${expanded ? "flex-wrap overflow-visible" : "overflow-hidden"} ${card.assignee && !avatarInRow ? "min-h-5 pr-7" : ""}${metaClass ? ` ${metaClass}` : ""}`}
            // Keyboard path to the expansion: focus on a chip's quick-edit
            // button or the MR/PR link inside the row (React's onFocus/onBlur
            // bubble). Blur to another element inside the row keeps it open.
            onFocus={() => setRowFocused(true)}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRowFocused(false); }}
          >
            {/* Blocked indicator (#449) — FIRST in the row, and deliberately
                outside the `!compact` branch and every density gate.

                Position: the row clips right-to-left (`overflow-hidden` with no
                wrap at rest), so anything after a variable-width neighbour can
                be cut off on a narrow column. Leading position also puts every
                blocked card's marker in the same x-gutter, which is what makes
                a top-to-bottom column scan work.

                No density gate: it shows at every density, the one-row Dense face
                included, because blocked-ness is more actionable than checklist progress.
                `comfortable` is the default for boards created since 1.1, so
                gating it out there would mean the board-scan signal — the whole
                point of the feature — is missing on most boards.

                Inline SVG rather than an emoji: ⛔/🚫 render in their own fixed
                color and would ignore `text-danger`, so the badge would stop
                tracking the theme. The neutral 📎/✓ badges get away with it; a
                danger signal cannot.

                Icon always, numeral only above 1 — at 1 the numeral repeats
                what the icon already says, and the exact count is always in the
                accessible name. `role="img"` + `aria-label` is required: at a
                count of 1 there is no text node, so without it the element has
                no accessible name at all. */}
            {/* Manual block (#1149) joins this same indicator rather than
                adding a second badge (§ System signals, departure 3): the
                glyph, then the elapsed time ("⊘ 3d") when a manual block is
                open. The time is the signal's second half, not a tooltip
                extra, so it renders at every density, compact included. A
                relation-only block keeps the icon-only form above, with its
                numeral from 2 up; when both apply the duration wins the
                visible slot and the relation count stays in the name. */}
            {isCardBlocked(card) && (
              <span
                role="img"
                aria-label={blockedLabel}
                title={blockedLabel}
                data-testid="card-blocked-indicator"
                className="inline-flex items-center gap-0.5 text-xs font-semibold text-danger shrink-0"
              >
                <svg className="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 000 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
                </svg>
                {card.blocked_at != null
                  ? formatBlockedDuration(blockedElapsedMs(card.blocked_at), 1)
                  : card.blocker_count > 1 && card.blocker_count}
              </span>
            )}

            {/* The non-compact (per-user layout) branch shows the full density-driven
                metadata row. compact (single-line layout) keeps only the universal
                bits — blocked glyph, recently-moved dot, priority badge, assignee —
                regardless of density; it has no urgency badge, so its age cue is
                the AgingCue glyph in the title (#1843). */}
            {!compact && (
              <>
                {/* MR/PR link badge (#352) — first in the non-compact row so the
                    right-to-left clip never hides it. A real <a> nested in the
                    clickable card, because one-click to the PR is the point of
                    the feature: click/pointer-down/key-down stop propagation so
                    it never opens the card or starts a drag (no preventDefault,
                    so cmd/middle-click still work). The href is re-checked with
                    isHttpUrl() even though the server validates it — an href is
                    an XSS sink. */}
                {!denseRow && externalRef && (() => {
                  const label = PROVIDER_LABELS[externalRef.provider] ?? externalRef.provider;
                  const content = (
                    <>
                      {/* Glyph-only at comfortable density makes it the sole
                          visible indicator and click target, so it steps up
                          from the decorative w-3 size (frontend/CLAUDE.md). */}
                      <ExternalRefGlyph className={showExternalRefText ? "w-3 h-3 shrink-0" : "w-3.5 h-3.5 shrink-0"} />
                      {showExternalRefText && <span className="truncate font-mono min-w-0">{externalRef.ref}</span>}
                    </>
                  );
                  return isHttpUrl(externalRef.url) ? (
                    <a
                      href={externalRef.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${externalRef.ref}, ${label}, opens in new tab`}
                      // The real host is in the tooltip because provider/ref are
                      // free text an editor chooses — "GitHub acme/api#42" could
                      // point anywhere, and the tooltip is where a reader checks.
                      title={`${label} ${externalRef.ref} — ${new URL(externalRef.url).host} (opens in new tab)`}
                      onClick={(e) => e.stopPropagation()}
                      // Mouse/touch too: the card's drag sensors start on those (#1287).
                      onPointerDown={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      // shrink-0 is intentional and unlike the custom-field chips
                      // (#1411): this badge is deliberately first in the row (see
                      // the comment above) so it's never hidden by the row's
                      // right-to-left clip — overflow-hidden + the inner span's
                      // min-w-0 (above) just stop its own text bleeding past its
                      // own max-w-[10rem] edge, the same fix applied there.
                      className="inline-flex items-center gap-1 text-xs text-info hover:underline shrink-0 max-w-[10rem] min-w-0 overflow-hidden rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      {content}
                    </a>
                  ) : (
                    <span
                      role="img"
                      aria-label={`${externalRef.ref}, ${label}`}
                      title={`${label} ${externalRef.ref}`}
                      // Same shrink-0-is-intentional note as the <a> branch above.
                      className="inline-flex items-center gap-1 text-xs text-fg-tertiary shrink-0 max-w-[10rem] min-w-0 overflow-hidden"
                    >
                      {content}
                    </span>
                  );
                })()}

                {/* The status line (#2272) carries overdue, due soon and stale;
                    the one badge left is the calm "Just moved" cue (#961, #2393). */}
                {statusInline && statusNode}
                {justMovedBadge && (
                  <span className={`text-xs font-semibold shrink-0 ${justMovedToneClass}`} title={justMovedBadge.label}>
                    {justMovedBadge.label}
                  </span>
                )}

                {/* Label pills — density-capped: comfortable=1, standard=2; the dense row has none (words only).
                    Exception to the "filled pill" rule: labels use user-assigned colors
                    that may be light or low-contrast against white text. Tint + colored
                    border keeps the label readable across any hue. See frontend/CLAUDE.md. */}
                {!denseRow && card.labels.slice(0, labelLimit).map((label) => {
                  const display = label.name.length > 8 ? label.name.slice(0, 7) + "…" : label.name;
                  return (
                    <span
                      key={label.id}
                      className="cf-choice-badge border text-xs font-semibold px-1 py-0.5 rounded leading-none shrink-0"
                      style={colorChipStyle(label.color, aging.stage)}
                      title={label.name}
                    >
                      {display}
                    </span>
                  );
                })}
                {!denseRow && card.labels.length > labelLimit && (
                  <span className="text-xs text-fg-tertiary shrink-0">+{card.labels.length - labelLimit}</span>
                )}

                {/* Pinned custom fields (#371, Direction A) — bordered chip,
                    same tier as labels (high priority to see). Rendered
                    inline here rather than through `CustomFieldValueDisplay`
                    because the populated case needs the quick-edit click
                    handler / keyboard affordance / dotted-underline marking
                    that a pure read-only renderer shouldn't know about;
                    `CustomFieldValueDisplay` stays reusable for card-detail
                    and any future read-only surface. */}
                {pinnedFields.map((def) => {
                  if (denseRow && def.id !== denseFieldId) return null;
                  const entry = card.custom_field_values.find((v) => v.field_definition === def.id);
                  const populated = entry && entry.value !== "";
                  const interactive = isQuickEditable(def);

                  if (!populated) {
                    // Empty-value handling (`showsPinnedChip`, #2193): dense
                    // shows a dashed ghost for every type; comfortable and
                    // standard show one only where quick edit can set the
                    // value, since a text/number/date ghost there would be
                    // inert clutter with no card-face path to act on.
                    // Checkbox/dropdown ghosts open the same toggle/popover
                    // as a set chip. The server pin cap (PIN_CAP) bounds how
                    // many ghosts a card can add. From an unset state the
                    // checkbox label names the outcome ("set it to Yes"),
                    // not a vague "toggle".
                    if (!showsPinnedChip(def)) return null;
                    return (
                      <span
                        key={def.id}
                        role={interactive ? "button" : undefined}
                        tabIndex={interactive ? 0 : undefined}
                        onClick={interactive ? (e) => {
                          e.stopPropagation();
                          if (def.field_type === "checkbox") { void commitCustomFieldValue(def.id, "true"); return; }
                          setQuickEditFieldId(def.id);
                          setQuickEditAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
                        } : undefined}
                        onKeyDown={interactive ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            if (def.field_type === "checkbox") { void commitCustomFieldValue(def.id, "true"); return; }
                            setQuickEditFieldId(def.id);
                            setQuickEditAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
                          }
                        } : undefined}
                        aria-label={interactive ? `${def.name}: not set. Press Enter to ${def.field_type === "checkbox" ? "set it to Yes" : "edit"}.` : undefined}
                        className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border border-dashed border-line overflow-hidden min-w-[3.5rem] max-w-[10rem] text-fg-tertiary ${interactive ? "cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-emphasis" : ""}`}
                        title={`${def.name}: not set`}
                      >
                        <span className="truncate min-w-0">{def.name}</span>
                        <span className={interactive ? "border-b border-dotted border-fg-tertiary shrink-0" : "shrink-0"}>—</span>
                      </span>
                    );
                  }

                  const value = entry!.value;
                  const valid = isValidForType(def, value);
                  const displayText = valid ? formatCustomFieldValue(def, value, userDateFormat) : value;
                  // #2387: a number reads in compact form on the face ($33k); the
                  // title keeps the full value ($33,000). The value never yields
                  // width, so the name truncates first and the number stays whole.
                  const isNumber = valid && def.field_type === "number";
                  const faceText = isNumber
                    ? formatNumberCompact(value, { prefix: def.number_prefix, suffix: def.number_suffix, decimals: def.number_decimals })
                    : displayText;
                  const multiEntries = valid && def.field_type === "multi_select" ? parseMultiSelect(value) : null;
                  // #1391: explicit choice color → tinted badge (no dot);
                  // otherwise the automatic hash dot, exactly as before.
                  const colorKey = valid && def.field_type === "dropdown" ? explicitChoiceColor(def, value) : null;
                  const dot = valid && def.field_type === "dropdown" && !colorKey ? <ChoiceDot choice={value} /> : null;
                  // #1122: threshold mark — shape and weight only, never a
                  // hue (red/amber mean urgency on the card face). The words
                  // ride in `title` and an sr-only suffix; the chevron is
                  // aria-hidden.
                  const level = thresholdLevel(def, value, new Date(), userTimezone);
                  const phrase = thresholdPhrase(def, level);

                  return (
                    <span
                      key={def.id}
                      role={interactive ? "button" : undefined}
                      tabIndex={interactive ? 0 : undefined}
                      onClick={interactive ? (e) => {
                        e.stopPropagation();
                        if (def.field_type === "checkbox") { void commitCustomFieldValue(def.id, value === "true" ? "false" : "true"); return; }
                        setQuickEditFieldId(def.id);
                        setQuickEditAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
                      } : undefined}
                      onKeyDown={interactive ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          if (def.field_type === "checkbox") { void commitCustomFieldValue(def.id, value === "true" ? "false" : "true"); return; }
                          setQuickEditFieldId(def.id);
                          setQuickEditAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
                        }
                      } : undefined}
                      // An aria-label replaces the subtree's text, so the
                      // sr-only threshold phrase below would not be read on
                      // an editable chip; carry it in the label too (#1122).
                      // Today only checkbox/dropdown are editable and only
                      // number/date carry thresholds, so `phrase` is empty
                      // here; this keeps the words if number/date ever gain
                      // quick edit.
                      aria-label={interactive ? `${def.name}: ${displayText}${phrase ? `, ${phrase}` : ""}. Press Enter to ${def.field_type === "checkbox" ? "toggle" : "edit"}.` : undefined}
                      data-threshold-level={level === "none" ? undefined : level}
                      className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border border-line overflow-hidden ${multiEntries ? "max-w-[14rem] min-w-[4rem]" : "max-w-[10rem] min-w-[3.5rem]"} ${interactive ? "cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-emphasis" : ""}`}
                      title={phrase ? `${def.name}: ${displayText} (${phrase})` : `${def.name}: ${displayText}`}
                    >
                      {dot}
                      {/* #1391: on a multi-select chip the name yields width before the value chips do. */}
                      <span className="text-fg-tertiary truncate min-w-0 shrink-[3]">{def.name}:</span>
                      {/* Firm VoC requirement — the editable-badge affordance
                          (dotted underline) stays visible at rest, never
                          hover-reveal-only, so an occasional user can
                          discover it without training. */}
                      {def.field_type === "url" ? (
                        // #1390: hostname-only link. `url` is never a
                        // quick-edit type, so the chip itself is inert and
                        // the link stops propagation so it neither opens the
                        // card nor starts a dnd-kit drag.
                        <CustomFieldLink value={value} variant="host" maxHostChars={16} stopPropagation />
                      ) : multiEntries ? (
                        // #1391: read-only here (no quick edit, no dotted
                        // underline) — a multi-select is edited in card detail.
                        <MultiSelectChips entries={multiEntries} definition={def} max={2} />
                      ) : colorKey ? (
                        // The quick-edit hint stays on a tinted badge, as a
                        // dotted text underline in the badge's own fg
                        // (currentColor) — a border would grow the badge and
                        // a fixed gray would vanish on some tints.
                        <ChoiceBadge colorKey={colorKey}>
                          {interactive ? (
                            <span className="underline decoration-dotted underline-offset-2" data-quick-edit-hint>
                              {chipValueText(def, displayText, 16)}
                            </span>
                          ) : chipValueText(def, displayText, 16)}
                        </ChoiceBadge>
                      ) : (
                        <>
                          <ThresholdMark level={level} direction={def.threshold_direction ?? ""} />
                          <span
                            className={`${isNumber ? "shrink-0 whitespace-nowrap" : "truncate min-w-0"} ${level === "none" ? "text-fg-secondary" : "font-semibold text-fg"} ${interactive ? "border-b border-dotted border-fg-tertiary" : ""}`}
                            data-testid={isNumber ? "card-field-number" : undefined}
                            // A compacted number ($33k) is spoken in full ($33,000) by
                            // the sr-only twin below; `title` alone never reaches
                            // keyboard, touch or most screen readers (#2387).
                            aria-hidden={faceText !== displayText ? true : undefined}
                          >
                            {chipValueText(def, faceText, 16)}
                          </span>
                          {faceText !== displayText && <span className="sr-only" data-testid="card-field-number-sr">{displayText}</span>}
                        </>
                      )}
                      {phrase && <span className="sr-only">, {phrase}</span>}
                    </span>
                  );
                })}

                {/* Checklist — comfortable and standard (dense carries it as words); a quick progress signal */}
                {!denseRow && card.checklist_total > 0 && (
                  <span
                    className={`text-xs font-medium shrink-0 ${
                      card.checklist_done === card.checklist_total ? "text-success" : "text-fg-tertiary"
                    }`}
                    title={`${card.checklist_done}/${card.checklist_total} checklist items`}
                  >
                    <span aria-hidden="true">✓{card.checklist_done}/{card.checklist_total}</span>
                    <span className="sr-only">Checklist {card.checklist_done} of {card.checklist_total}</span>
                  </span>
                )}
                {/* #445: at most one suffix, overdue item first, else items
                    assigned to the viewer. Never feeds the urgency badge or
                    border (A-Q9); the word or glyph carries it, not color alone. */}
                {!denseRow && card.checklist_total > 0 && checklistSuffix && (
                  checklistSuffix.kind === "overdue" ? (
                    <span
                      className="text-xs font-medium shrink-0 text-danger"
                      title={`${checklistSuffix.count} overdue checklist item${checklistSuffix.count === 1 ? "" : "s"}`}
                      data-testid="checklist-suffix"
                    >
                      <span aria-hidden="true">· <UrgencyGlyph kind="overdue" className="inline-block w-3 h-3 align-[-0.125em]" /> {checklistSuffix.count}</span>
                      <span className="sr-only">{checklistSuffix.count} overdue checklist item{checklistSuffix.count === 1 ? "" : "s"}</span>
                    </span>
                  ) : (
                    <span
                      className="text-xs shrink-0 text-fg-tertiary"
                      title={`${checklistSuffix.count} checklist item${checklistSuffix.count === 1 ? "" : "s"} assigned to you`}
                      data-testid="checklist-suffix"
                    >
                      <span aria-hidden="true">· mine {checklistSuffix.count}</span>
                      <span className="sr-only">{checklistSuffix.count} checklist item{checklistSuffix.count === 1 ? "" : "s"} assigned to you</span>
                    </span>
                  )
                )}

                {/* Attachments — standard only (the dense row carries them as words); comfortable folds into peek */}
                {!denseRow && showAttachments && card.attachment_count > 0 && (
                  <span className="text-xs text-fg-tertiary shrink-0" title={`${card.attachment_count} attachment(s)`}>
                    <span aria-hidden="true">📎{card.attachment_count}</span>
                    <span className="sr-only">{card.attachment_count} attachment{card.attachment_count === 1 ? "" : "s"}</span>
                  </span>
                )}

                {/* Due date — Standard only, and only when the status line does
                    not already carry it. At Comfortable the face draws no
                    on-track date (sr-only text below carries it, #2399). */}
                {!denseRow && showDueDatePill && dueInfo && !dueAlreadyInUrgency && (
                  <span className="text-xs font-medium shrink-0 text-fg-tertiary" title={`Due ${card.due_date}`}>
                    {dueInfo.label}
                  </span>
                )}

                {/* Weight — standard, only when > 1 (dense carries it as words) */}
                {!denseRow && showWeight && card.weight > 1 && (
                  <span className="text-xs text-fg-secondary font-medium shrink-0" title={`Weight: ${card.weight}`}>
                    {card.weight}
                  </span>
                )}
              </>
            )}

            {/* Recently moved dot — compact layout at dense only (the dense row never
                draws it); other faces use the urgency badge's "Just moved" tone. */}
            {!denseRow && showRecentlyMovedDot && isRecent && !recentAlreadyInUrgency && (
              <span className="w-2 h-2 rounded-full bg-primary-emphasis shrink-0" title="Recently moved" />
            )}

            {/* Priority badge — compact layout at dense only. Every other face says
                priority in the accessible name and the peek, never as a badge. */}
            {!denseRow && showPriorityBadge && card.priority !== "low" && (
              <span
                className="text-xs font-semibold shrink-0 capitalize px-1 py-0.5 rounded leading-none"
                style={{ backgroundColor: priorityColor, color: "#fff" }}
                title={`Priority: ${card.priority}`}
              >
                {card.priority}
              </span>
            )}
          </div>
          {avatarInRow && card.assignee && <Avatar user={card.assignee} size="xs" className="shrink-0" />}
          </AvatarWrap>
        )}
        </RowWrap>

        {statusRow && (
          <div
            data-testid="card-status-row"
            className={`mt-1.5 flex items-center ${card.assignee && !avatarInRow ? "pr-7" : ""}${metaClass ? ` ${metaClass}` : ""}`}
          >
            {statusNode}
          </div>
        )}

        {/* Assignee avatar — positioned against the content wrapper
            (`relative`, above), not a flex child of the metadata row. The row
            is `overflow-hidden` with no wrap at rest, so an avatar rendered as
            its last flex child was the first thing silently clipped when the
            row overflowed — backwards, since it's the one metadata element
            with no density gate (#1411). */}
        {card.assignee && !avatarInRow && (
          <Avatar user={card.assignee} size="xs" className="absolute bottom-1.5 right-1.5 z-10" />
        )}
        {/* Dense face omissions: words for what the one-row face does not draw, so the
            card's accessible name stays whole (frontend/CLAUDE.md § Cards, calm-face
            omission rule). */}
        {denseSrText && <span className="sr-only" data-testid="card-dense-sr">{denseSrText}</span>}
        {comfortableDueSrText && <span className="sr-only" data-testid="card-due-sr">{comfortableDueSrText}</span>}
        {/* The priority suffix closes the card's accessible content (#2279). */}
        {prioritySuffix && <span className="sr-only" data-testid="card-priority-sr">{prioritySuffix}</span>}
      </div>
    </div>
    </div>
    {peekVisible && anchorRect && !isDragging && !peekSuppressed && createPortal(
      <CardPeekPopover
        card={card}
        anchorRect={anchorRect}
        onMouseEnter={() => setPeekVisible(true)}
        onMouseLeave={() => setPeekVisible(false)}
        customFieldDefinitions={customFieldDefinitions}
        userDateFormat={userDateFormat}
        userTimezone={userTimezone}
      />,
      document.body,
    )}
    {quickEditFieldId !== null && quickEditAnchor && (() => {
      const def = pinnedFields.find((d) => d.id === quickEditFieldId);
      if (!def || def.field_type !== "dropdown") return null;
      const entry = card.custom_field_values.find((v) => v.field_definition === def.id);
      return createPortal(
        <CustomFieldQuickEditPopover
          anchorRect={quickEditAnchor}
          choices={def.choices}
          selected={entry?.value ?? ""}
          onSelect={(v) => void commitCustomFieldValue(def.id, v)}
          onDismiss={() => setQuickEditFieldId(null)}
        />,
        document.body,
      );
    })()}
    </>
  );
}, arePropsEqual);

export default CardItem;
