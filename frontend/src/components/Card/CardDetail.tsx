import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { BOARD_SCROLL_SELECTOR, classifyTransition, findBoardCardElement, isBoardTreePointerEvent, useCardSheetPlacement } from "../../hooks/useCardSheetPlacement";
import type { SheetPlacement } from "../../hooks/useCardSheetPlacement";
import { useCardSheetDockedPref } from "../../hooks/useCardSheetDockedPref";
import { claimDeparture, departSheet, dropOwnDeparture, playTransition, prefersReducedMotion } from "./cardSheetMotion";
import CardKeyFacts from "./CardKeyFacts";
import { buildKeyFacts } from "../../utils/cardKeyFacts";
import type { KeyFactTarget } from "../../utils/cardKeyFacts";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
import { useMoveToSeenPref } from "../../hooks/useMoveToSeenPref";
import { useAutosaveStatus } from "../../hooks/useAutosaveStatus";
import AutosaveIndicator from "../Common/AutosaveIndicator";
import { isHardLimit, limitBlockedMessage, limitCounts, limitRefusal } from "../Board/moveBlockedMessages";
import type { LimitRefusal } from "../Board/moveBlockedMessages";
import type { BoardFull, Card, CardAttachment, CardChecklistItem, CardComment, Label, Priority, User } from "../../types";
import { userDisplayName } from "../../types";
import SelectDropdown from "../Common/SelectDropdown";
import { deleteCard, archiveCard, getCardTimeline, getCardComments, addCardComment, deleteComment, updateCard, getCardAttachments, uploadCardAttachment, deleteCardAttachment, getChecklist, addChecklistItem, updateChecklistItem, deleteChecklistItem } from "../../api/cards";
import type { CardPatch, TimelineCounts, TimelinePage } from "../../api/cards";
import { createLabel } from "../../api/boards";
import { PALETTE_COLORS, PRIORITY_COLORS } from "../../constants/colors";
import ColorSwatchPicker from "../Common/ColorSwatchPicker";
import { focusEnclosingDialog } from "../../utils/focusEnclosingDialog";
import { hasOpenDismissLayer } from "../../utils/dismissLayer";
import ActivityTabPanel from "./ActivityTabPanel";
import { CARD_DETAIL_TABS, HISTORY_PAGE_LIMIT, getRememberedCardDetailTab, rememberCardDetailTab, type CardDetailTab } from "./cardDetailTabMemory";
import { lastActivitySummary } from "../../utils/cardTimelineLabels";
import { dropUnknownLabels } from "../../utils/cardLabels";
import { isStaleCard } from "../../utils/cardVersion";
import { formatDateStr, formatDueDate, formatDateTimeUser, formatRelativeTime } from "../../utils/date";
import type { UserDatePrefs } from "../../utils/date";
import MentionTextarea from "./MentionTextarea";
import RichTextEditor from "./RichTextEditor";
import Avatar from "../Common/Avatar";
import ModalWrapper from "../shared/ModalWrapper";
import CustomFieldEditRow from "./CustomFieldEditRow";
import CardRelationsSection from "./CardRelationsSection";
import CardExternalRefSection from "./CardExternalRefSection";
import CardBlockSection, { type BlockFormMode } from "./CardBlockSection";
import { failureReason, isLimitFailure } from "../../utils/moveFailure";
import type { MoveOutcome } from "../../hooks/useBoard";
import { withCustomFieldValue } from "../../utils/customFieldValue";
import { importedNote } from "../../utils/importedHistory";
import { DEMO_COMMENT_REASON, DEMO_UPLOAD_REASON, DEMO_DELETE_COMMENT_REASON, DEMO_DELETE_ATTACHMENT_REASON, DEMO_CARD_DETAIL_NOTE, DEMO_EXTERNAL_REF_REASON, DEMO_CARD_FOOTER_NOTE } from "../../constants/demoCopy";
import { useInstanceFlags } from "../../contexts/InstanceFlagsContext";
import { colorChipStyle } from "../../utils/colorContrast";
import { isImeComposing } from "../../utils/imeComposition";
import { isAssignableMember } from "../../utils/assignableMembers";
import ActiveUnderline from "../Common/ActiveUnderline";

interface Props {
  card: Card;
  board: BoardFull;
  onClose: () => void;
  onDeleted: (id: number) => void;
  onUpdated: (card: Card) => void;
  onArchived: (cardId: number) => void;
  onMoveCard?: (cardId: number, columnId: number, swimlaneId: number, position: number) => Promise<MoveOutcome | void>;
  // Admin override for a limit-refused move, with the popover's own target
  // (useBoard.forceMoveCardTo). The Move-blocked toast's override is outside
  // this panel's focus trap (#1732), so keyboard users cannot reach it while
  // the panel is open; the popover offers it itself (#1772). Omitted: no
  // override is shown.
  onForceMoveCard?: (cardId: number, columnId: number, swimlaneId: number, position: number) => Promise<MoveOutcome>;
  userDateFormat?: string;
  userTimeFormat?: string;
  userTimezone?: string;
  currentUser?: User | null;
  closeEditorOnEnter?: boolean;
  // Bumped by BoardView whenever a `card.updated` WebSocket event arrives for
  // this card (e.g. another user added a comment, toggled a checklist item,
  // or uploaded an attachment). The card's own fields (title, description,
  // etc.) are intentionally NOT live-synced here — see the `key`-based
  // remount note in BoardView — but comments/checklist/attachments are
  // fetched collections with no in-progress-edit risk, so they refetch.
  refreshSignal?: number;
  /**
   * Opens the block (or unblock) form with its field focused, as requested by
   * the card context menu or the ⌘K palette (#2059). `seq` changes per
   * request, so asking again for the card already open re-opens the form.
   * Ignored when this user cannot block the card or the card is already in
   * the requested state.
   */
  /** A deep link asking an open card to switch tab; `n` changes on every request (#967). */
  tabRequest?: { tab: CardDetailTab; n: number };
  blockFormRequest?: { mode: "block" | "unblock"; seq: number } | null;
}

/**
 * Opens the browser's native date picker for the transparent overlay input.
 * Safari ignores clicks on opacity-0 inputs, so showPicker() / focus() is the
 * fallback; the handler lives on the input itself (not a wrapper div) so the
 * focusable element owns both pointer and keyboard activation (#1376).
 */
function openNativeDatePicker(el: HTMLInputElement | null) {
  if (!el) return;
  // showPicker() is supported in Chrome 99+, Firefox 101+, Safari 16+
  if (typeof (el as HTMLInputElement & { showPicker?: () => void }).showPicker === "function") {
    try { (el as HTMLInputElement & { showPicker: () => void }).showPicker(); return; } catch { /* ignore */ }
  }
  // Focus opens the picker on older Safari and acts as a no-op elsewhere
  el.focus();
}

// eslint-disable-next-line react-refresh/only-export-components -- intentional utility export, used by tests and co-located with the component for cohesion
export function formatCommentTime(iso: string, user?: UserDatePrefs | null): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  // For dates older than 24 hours use the user's preferred format so the
  // timestamp matches the format they see everywhere else in the app.
  return formatDateTimeUser(iso, user);
}


const PRIORITY_OPTIONS: { value: Priority; label: string; color: string }[] = [
  { value: "low",    label: "Low",    color: PRIORITY_COLORS.low },
  { value: "medium", label: "Medium", color: PRIORITY_COLORS.medium },
  { value: "high",   label: "High",   color: PRIORITY_COLORS.high },
  { value: "urgent", label: "Urgent", color: PRIORITY_COLORS.urgent },
];

/** Controls whose click still works when it also dismisses the card detail sheet (#1914). */
const OUTSIDE_CONTROL_SELECTOR = 'button, a[href], input, select, textarea, label, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"]';

/**
 * Loading placeholder rows for one of the fetched card-detail sections
 * (#1914, frame 6), sized like that section's rows. Decorative: the body's
 * aria-busy and the one-time status line announce the load. The pulse stops
 * under reduced motion.
 */
function SectionSkeleton({ rows, testId }: { rows: number; testId: string }) {
  return (
    <div aria-hidden="true" data-testid={testId} className="flex flex-col gap-1.5 mb-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-7 rounded bg-surface-hover animate-pulse motion-reduce:animate-none" style={{ width: `${90 - i * 20}%` }} />
      ))}
    </div>
  );
}

const TAB_LABELS: Record<CardDetailTab, string> = { details: "Details", comments: "Comments", history: "History" };

export default function CardDetail({ card, board, onClose, onDeleted, onUpdated, onArchived, onMoveCard, onForceMoveCard, userDateFormat = "MM/DD/YYYY", userTimeFormat: _userTimeFormat = "12h", userTimezone = "", currentUser = null, closeEditorOnEnter = false, refreshSignal = 0, blockFormRequest = null, tabRequest }: Props) {
  const [localCard, setLocalCard] = useState<Card>(card);
  const [comments, setComments] = useState<CardComment[]>([]);
  const [confirmDeleteCommentId, setConfirmDeleteCommentId] = useState<number | null>(null);
  const deleteCommentTriggerRef = useConfirmFocusReturn(confirmDeleteCommentId);
  // Manual block form (#1149): the header's Block… and the banner's Unblock
  // open it; focus returns to whichever opened it on Cancel or Escape.
  const [blockFormMode, setBlockFormMode] = useState<BlockFormMode>(null);
  const blockTriggerRef = useConfirmFocusReturn(blockFormMode);
  // A successful unblock removes the banner's Unblock button, which
  // useConfirmFocusReturn would return focus to; the header's Block…
  // replaces it, so focus goes there instead of dropping to <body>.
  const blockButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusBlockButtonNext = useRef(false);
  // In-flight + error state for the inline comment-delete confirm (#1421).
  const [deletingCommentId, setDeletingCommentId] = useState<number | null>(null);
  const [commentDeleteError, setCommentDeleteError] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");
  // Opens on the tab chosen last this session, or a deep link's (#967).
  const [tab, setTab] = useState<CardDetailTab>(getRememberedCardDetailTab);
  const selectTab = (t: CardDetailTab) => {
    if (t !== tab && bodyScrollRef.current) bodyScrollRef.current.scrollTop = 0;
    setTab(t);
    rememberCardDetailTab(t);
  };
  // The mount already honors the request (the remembered tab was set with it), so only later ones switch.
  const handledTabRequest = useRef(tabRequest?.n);
  useEffect(() => {
    if (!tabRequest || handledTabRequest.current === tabRequest.n) return;
    handledTabRequest.current = tabRequest.n;
    setTab(tabRequest.tab);
  }, [tabRequest]);
  const tabRefs = useRef<Partial<Record<CardDetailTab, HTMLButtonElement | null>>>({});
  // First unfiltered History page, fetched on open (#967, architect R1): it
  // gives the History tab its count and the Details tab its Last activity
  // line without opening History, and the tab then shows it with no wait.
  const [historyPage, setHistoryPage] = useState<TimelinePage | null>(null);
  const [historyCounts, setHistoryCounts] = useState<TimelineCounts | null>(null);
  const [historyReload, setHistoryReload] = useState(0);
  const [focusFirstHistoryEntry, setFocusFirstHistoryEntry] = useState(false);
  const clearHistoryFocusRequest = useCallback(() => setFocusFirstHistoryEntry(false), []);
  const [addingLabel, setAddingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState(PALETTE_COLORS[0]);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<CardAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const { status: descStatus, fadingOut: descFadingOut, runSave: descRunSave } = useAutosaveStatus();
  const { status: weightStatus, fadingOut: weightFadingOut, runSave: weightRunSave } = useAutosaveStatus();
  // Reason for a weight save refused by the column's weight limit (#1428).
  // After a limit refusal the AutosaveIndicator is held at idle until the next
  // save starts, so the refusal is announced once — by the reason line — and
  // not also as "Couldn't save", even after the reason is cleared by the next
  // +/- click during the debounce.
  const [weightLimitReason, setWeightLimitReason] = useState<string | null>(null);
  const [weightLimitRefused, setWeightLimitRefused] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"delete" | "archive" | null>(null);
  // In-flight + error state for the card delete/archive confirm modal (#1437).
  const [cardActionBusy, setCardActionBusy] = useState(false);
  const [cardActionError, setCardActionError] = useState<string | null>(null);
  // Synchronous re-entry guards (#1437): refs flip immediately, so a double-fire
  // before React re-renders still sends only one request.
  const cardActionInFlight = useRef(false);
  const attachDeleteInFlight = useRef(false);
  const checklistDeleteInFlight = useRef(false);
  const commentInFlight = useRef(false);
  const uploadInFlight = useRef(false);
  const checklistToggleInFlight = useRef(false);
  const checklistAddInFlight = useRef(false);
  const labelCreateInFlight = useRef(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dueDateRef = useRef<HTMLInputElement>(null);
  const dueDateEmptyRef = useRef<HTMLInputElement>(null);
  const [checklist, setChecklist] = useState<CardChecklistItem[]>([]);
  const [newItemText, setNewItemText] = useState("");
  const [showBulkAdd, setShowBulkAdd] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [checklistOpen, setChecklistOpen] = useState(true);
  const [attachmentsOpen, setAttachmentsOpen] = useState(true);
  // The Attachments count is unknown, not 0, until a fetch has succeeded (#1916).
  const [attachmentsLoaded, setAttachmentsLoaded] = useState(false);
  // Surfaces a failure in the comments/checklist/attachments load effects
  // below — previously silent (#1375): the panel just stayed on whatever it
  // had before (empty on first mount), with nothing telling the user a
  // section failed to load.
  const [loadError, setLoadError] = useState(false);
  // Checklist-only error slot for handleAddChecklistItem / handleBulkAdd.
  const [checklistError, setChecklistError] = useState<string | null>(null);
  // #371 — expanded by default only when the card already has ≥1 populated
  // custom-field value; a board with fields defined but none filled in on
  // this card starts collapsed so an empty structure doesn't dominate the
  // panel, while still surfacing populated data without an extra click.
  const [customFieldsOpen, setCustomFieldsOpen] = useState(
    () => card.custom_field_values.some((v) => v.value !== "")
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Placement (#1914): anchored beside the card's column at >= 1280px, docked
  // to the right edge below that (or when there is no room or no card element
  // to anchor to), full-screen at <= 640px. Re-placed when the card moves.
  // "Dock to edge" (#1915) pins the sheet to the right edge at any width above 640px.
  const [dockedPref, setDockedPref] = useCardSheetDockedPref();
  const sheet = useCardSheetPlacement(card.id, `${card.column}:${card.swimlane}`, dockedPref);
  const { placement } = sheet;

  // Focus moves to the close button on open (#1914); the dialog is announced
  // through it. Passive effect: placement has already run, before paint.
  useEffect(() => {
    (closeButtonRef.current ?? panelRef.current)?.focus();
  }, []);
  // #1732 — aria-modal panel must keep Tab inside and restore focus on close.
  // Focus returns to the opener (the card that was clicked), else to the
  // card's board element (opened from the command palette or a relation
  // link, whose opener is gone), else to the board region: never to the top
  // of the page (#1914).
  // Resolved when the sheet closes, not at render: archiving or deleting the
  // card removes its face in the same commit that closes the sheet.
  useFocusTrap(panelRef, true, () =>
    findBoardCardElement(card.id) ?? document.querySelector<HTMLElement>(BOARD_SCROLL_SELECTOR));

  // Click-catcher (#1914): no overlay. A primary click outside the sheet
  // closes it; a click on a board card is left to the card's own onClick,
  // which swaps the open card (panels replace, never stack). "Inside" is the
  // React tree, not the DOM, so a portaled dropdown or tooltip rendered from
  // this component counts as inside: the sheet's onPointerDownCapture marks
  // the native event, and React dispatches at its root before this
  // document-level bubble listener runs. Classified at pointerdown, acted on
  // at the following click, so a touch swipe, a scrollbar drag or a text
  // selection that started in the sheet never closes it, and the dismissing
  // click is consumed instead of also activating what was under it. Keyboard
  // and screen-reader users close with Escape, then pick a card.
  const insidePointerEvents = useRef(new WeakSet<Event>());
  const markPointerInside = (e: React.PointerEvent) => { insidePointerEvents.current.add(e.nativeEvent); };
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    // `consume`: the dismissing click is swallowed and the press keeps focus
    // where it is. True for board space (an empty cell's "+ Add card" must not
    // also fire) and for anything that is not a control. A control elsewhere
    // in the app (toolbar, sidebar, navbar) closes the sheet AND works, in one
    // click, and takes focus as it normally would.
    // `closes`: false while the custom color popover is open in the sheet: this press
    // dismisses it alone, as Escape would, and still behaves as a press outside otherwise.
    // Only that popover opts in so far; see utils/dismissLayer.ts.
    let pending: { x: number; y: number; consume: boolean; closes: boolean } | null = null;
    // A press on the open card's own face: its click re-selects the same card,
    // so keep focus in the sheet instead of letting the press move it there.
    let keepFocus = false;
    const onPointerDown = (e: PointerEvent) => {
      pending = null;
      keepFocus = false;
      if (insidePointerEvents.current.has(e)) return;
      if (e.button !== 0) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest(`[data-card-id="${card.id}"]`)) { keepFocus = true; return; }
      // A popover a card face portaled to document.body (custom-field quick
      // edit, its dropdowns, the hover peek): part of the board, not outside.
      if (isBoardTreePointerEvent(e) && !t.closest(BOARD_SCROLL_SELECTOR)) return;
      // A card swaps through its own onClick; a toast stays usable; another
      // dialog opened over the sheet (the command palette, the shortcuts
      // overlay) handles its own clicks.
      if (t.closest('[data-card-id], [data-keeps-card-sheet-open], [data-card-sheet-ghost], [aria-modal="true"], [role="dialog"]')) return;
      // A press on a scrollbar targets the scroll container itself.
      if (t instanceof HTMLElement && t.clientWidth > 0 && (e.offsetX > t.clientWidth || e.offsetY > t.clientHeight)) return;
      const control = t.closest(OUTSIDE_CONTROL_SELECTOR);
      pending = {
        x: e.clientX,
        y: e.clientY,
        consume: !control || !!t.closest(BOARD_SCROLL_SELECTOR),
        closes: !hasOpenDismissLayer(panelRef.current),
      };
    };
    const onClick = (e: MouseEvent) => {
      const p = pending;
      pending = null;
      if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) return;
      if (p.consume) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (!p.closes) return;
      // The press kept focus in the sheet, so a save-on-blur field (the title)
      // has not blurred, and React runs no onBlur on a node it unmounts: blur
      // it now so its edit is saved before the sheet closes.
      const active = document.activeElement;
      if (active instanceof HTMLElement && panelRef.current?.contains(active)) active.blur();
      onCloseRef.current();
    };
    const onCancel = () => { pending = null; };
    // A press that may dismiss must not move focus first (mousedown's default
    // action), or focus would not return to the card on close.
    const onMouseDown = (e: MouseEvent) => { if (pending?.consume || keepFocus) e.preventDefault(); };
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
    // card.id is fixed for this instance (`key={selectedCard.id}`).
  }, [card.id]);

  // Transitions (#1914, cardSheetMotion.ts). Visual only: nothing here delays
  // a close or a swap. The first measured placement is an open, or the
  // second half of a swap when a different card's sheet just departed.
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
  // Leaves a ghost of the sheet for the close (or swap) transition. Dropping
  // our own pending departure on setup undoes React StrictMode's simulated
  // unmount in development.
  useLayoutEffect(() => {
    dropOwnDeparture(card.id);
    const panel = panelRef.current;
    return () => {
      if (panel) departSheet(card.id, placementRef.current, panel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- card.id is fixed for this instance (`key={selectedCard.id}`)
  }, []);
  const bulkAddRef = useRef<HTMLDivElement>(null);
  useFocusTrap(bulkAddRef, showBulkAdd);
  // Debounce weight saves: rapid +/- clicks coalesce into one PATCH so the
  // activity feed shows a single net change (e.g. "Weight: 3 → 8") rather
  // than an entry per click.
  const weightSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // #1305 — cancel (not flush) a pending weight-save debounce on unmount.
  // This matches the established precedent for this exact 600ms debounce
  // class: CustomFieldValueInput's own comment says its text/number debounce
  // "mirrors CardDetail's Weight field", and that component's unmount effect
  // also cancels outright rather than flushing (see
  // frontend/src/components/Card/CustomFieldValueInput.tsx). #1140 already
  // established that a surface needing a *guaranteed* capture opts into
  // `debounceMs={0}` (immediate commit) rather than relying on a
  // flush-on-unmount safety net. Weight only changes via +/-1 button clicks,
  // so a cancelled debounce loses at most a single increment the user can
  // immediately redo — not a typed edit — so cancelling is the right choice
  // here, unlike (say) a free-text field.
  useEffect(() => {
    return () => {
      if (weightSaveTimer.current) clearTimeout(weightSaveTimer.current);
    };
  }, []);
  const moveButtonRef = useRef<HTMLButtonElement>(null);
  const movePopoverRef = useRef<HTMLDivElement>(null);
  const [showMovePopover, setShowMovePopover] = useState(false);
  const [movePopoverAnchor, setMovePopoverAnchor] = useState<{ top: number; left: number } | null>(null);
  const [moveTargetColumn, setMoveTargetColumn] = useState<number | null>(null);
  const [moveTargetSwimlane, setMoveTargetSwimlane] = useState<number | null>(null);
  const [moveSubmitting, setMoveSubmitting] = useState(false);
  const [movePopoverError, setMovePopoverError] = useState<string | null>(null);
  // The limit body behind movePopoverError, when it is a column-limit refusal:
  // drives the numbers line and the admin override (#1772). Set and cleared
  // together with movePopoverError.
  const [moveRefusal, setMoveRefusal] = useState<LimitRefusal | null>(null);
  // In-flight state for the popover's admin override; the ref is the
  // synchronous re-entry guard (a double-fire before re-render sends one request).
  const [moveForcing, setMoveForcing] = useState(false);
  const moveForcingRef = useRef(false);
  const moveSubmitRef = useRef<HTMLButtonElement>(null);
  // Set when a failed override leaves no override link: the popover's Move
  // button takes focus once moveForcing clears and it is enabled again.
  const focusMoveSubmitRef = useRef(false);
  // Cancelling the inline new-label input (Escape or the x button) returns focus to the "+ New
  // label" trigger it replaced (#2036); a successful create does not steal focus.
  const newLabelTriggerRef = useRef<HTMLButtonElement>(null);
  const focusNewLabelTriggerRef = useRef(false);
  const moveErrorId = useId();
  // Shown in the panel header (always-mounted status line) when a refresh
  // replaced the card out from under a failed move, because the popover that
  // showed the failure closes with it (#1773).
  const [moveNotice, setMoveNotice] = useState("");
  const [moveToSeen, setMoveToSeen] = useMoveToSeenPref();
  // Loading (#1914, design frame 6): the sheet opens at once with the title,
  // breadcrumb and tabs from the board card; the three fetched sections show
  // skeletons until they settle (success or failure), the body is
  // aria-busy, and Archive waits until everything has loaded.
  const [pendingSections, setPendingSections] = useState({ comments: true, attachments: true, checklist: true });
  const loading = pendingSections.comments || pendingSections.attachments || pendingSections.checklist;
  // "Loading card details" is announced once: set after mount, so it lands in
  // an already-mounted live region, and cleared for good when loading ends.
  const [loadingAnnouncement, setLoadingAnnouncement] = useState("");
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const [bodyShadows, setBodyShadows] = useState({ above: false, below: false });
  const updateBodyShadows = () => {
    const el = bodyScrollRef.current;
    if (!el) return;
    const above = el.scrollTop > 0;
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setBodyShadows((p) => (p.above === above && p.below === below ? p : { above, below }));
  };
  // Content height changes (a section loads, the History tab fills in)
  // without a scroll event; observe it rather than measuring every render.
  useLayoutEffect(() => {
    updateBodyShadows();
    const scroller = bodyScrollRef.current;
    const content = scroller?.firstElementChild;
    if (!scroller || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => updateBodyShadows());
    ro.observe(scroller);
    ro.observe(content);
    return () => ro.disconnect();
  }, [tab]);
  useEffect(() => {
    setLoadingAnnouncement(loading ? "Loading card details" : "");
  }, [loading]);

  useEffect(() => {
    // Each fetch keeps its own .catch() rather than a single Promise.all/try-
    // catch wrapper, so a slow section's failure doesn't block the other two
    // from populating as soon as they resolve (unchanged success-path timing).
    const settle = (section: keyof typeof pendingSections) => () =>
      setPendingSections((p) => (p[section] ? { ...p, [section]: false } : p));
    getCardComments(board.id, card.id).then(setComments).catch(() => setLoadError(true)).finally(settle("comments"));
    getCardAttachments(board.id, card.id).then((data) => {
      setAttachments(data);
      setAttachmentsLoaded(true);
      setAttachmentsOpen(data.length > 0);
    }).catch(() => setLoadError(true)).finally(settle("attachments"));
    getChecklist(board.id, card.id).then((data) => {
      setChecklist(data);
      setChecklistOpen(data.length > 0);
    }).catch(() => setLoadError(true)).finally(settle("checklist"));
  }, [board.id, card.id]);

  // Refetch comments/checklist/attachments when another session mutates this
  // card while the panel is open (#1310 — none of these live-update without a
  // manual refresh otherwise). Keyed on whether the signal CHANGED (not a
  // "skip first run" flag, which StrictMode's ref-preserving remount defeats and
  // turns into an extra mount fetch, #1479); the effect above covers the mount
  // load. Deliberately does not touch the *Open collapse
  // state, so a background refresh never snaps a collapsed section back open.
  const lastSignalRef = useRef(refreshSignal);
  useEffect(() => {
    if (lastSignalRef.current === refreshSignal) return;
    lastSignalRef.current = refreshSignal;
    getCardComments(board.id, card.id).then(setComments).catch(() => setLoadError(true));
    getCardAttachments(board.id, card.id).then((data) => { setAttachments(data); setAttachmentsLoaded(true); }).catch(() => setLoadError(true));
    getChecklist(board.id, card.id).then(setChecklist).catch(() => setLoadError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-fetches only in response to refreshSignal; board.id/card.id are stable for this instance's lifetime (BoardView remounts CardDetail via `key={selectedCard.id}` on card change)
  }, [refreshSignal]);
  // Refetched on another session's change, on any saved edit (card.version),
  // and after this session posts a comment, so the count and line stay true.
  // A failure leaves the count unknown (no number, never 0); the History tab
  // reports its own load error.
  // Aborted on cleanup, so arrowing past cards or a burst of updates does
  // not leave the server working on pages nobody will see.
  useEffect(() => {
    const controller = new AbortController();
    getCardTimeline(board.id, card.id, { limit: HISTORY_PAGE_LIMIT, offset: 0, include_counts: true }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setHistoryPage(page);
        if (page.counts) setHistoryCounts(page.counts);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [board.id, card.id, card.version, refreshSignal, historyReload]);

  // Dismiss confirm overlay before closing the panel so Escape has two stages:
  // first press dismisses the confirm, second press closes the panel.
  // The inline comment-delete prompt shares this priority: Escape cancels it
  // instead of closing the panel (#1365).
  useEscapeStack(() => {
    // Only consume Escape when the prompt is actually visible: a refetch can remove
    // the comment while its prompt is open, and a stale id must not swallow the key.
    if (confirmDeleteCommentId !== null && comments.some((c) => c.id === confirmDeleteCommentId)) {
      setConfirmDeleteCommentId(null);
      return;
    }
    if (!confirmAction) return false;
    // Swallow Escape while the request is in flight: dismissing would hide its outcome.
    if (cardActionInFlight.current) return;
    setConfirmAction(null);
    setCardActionError(null);
  }, 35);
  // Resolve the Move popover when a REMOTE change replaces the card underneath
  // it (#1773): another session's edit or move, or a version-conflict reload.
  // The popover's own admin override (#1772) is not remote: it is guarded like
  // a plain Move through moveSubmittingRef below. BoardView hands us the
  // live card from board.cards, but localCard and the popover targets are
  // seeded once, so without this the popover keeps the pre-refresh target and
  // error. Keyed on version alone: useBoard's optimistic relocation and the
  // rollback of a failed move change the location but never the version, so
  // they cannot close the popover or erase the error of our own failed move.
  // Every save bumps the version server-side and returns through onUpdated, so
  // versions this component caused itself (ownVersionsRef) are not remote. Only
  // version and location are synced into localCard: the rest can hold
  // in-progress edits a refresh must not clobber, and the version must follow
  // so the checklist/attachment onUpdated payloads do not write a stale one back.
  const lastSeenVersionRef = useRef(card.version);
  const ownVersionsRef = useRef(new Set<number>());
  const ownSavesInFlightRef = useRef(0);
  // Read through refs so the effect sees the state at the moment the version
  // changed without re-running when the popover opens or closes.
  const showMovePopoverRef = useRef(showMovePopover);
  showMovePopoverRef.current = showMovePopover;
  const moveSubmittingRef = useRef(moveSubmitting || moveForcing);
  // A forced move from the popover (#1772) is ours too: the version bump it
  // causes syncs version and location but must not reset the popover.
  moveSubmittingRef.current = moveSubmitting || moveForcing;
  const moveTargetRef = useRef({ column: moveTargetColumn, swimlane: moveTargetSwimlane });
  moveTargetRef.current = { column: moveTargetColumn, swimlane: moveTargetSwimlane };
  // Latest live card and localCard, read by async handlers AFTER their await so
  // an onUpdated payload never reflects the render the click happened in (#1777).
  const liveCardRef = useRef(card);
  liveCardRef.current = card;
  const localCardRef = useRef(localCard);
  localCardRef.current = localCard;
  // Base for every onUpdated payload that changes one field (checklist counts,
  // attachment count). Built from the live `card` prop, NOT from localCard:
  // localCard is seeded once and only follows version/location, so spreading it
  // wrote a remotely renamed title, labels, weight or assignee back into
  // board.cards (#1777). The version takes the higher of the two because an own
  // move/save may have synced it into localCard before the prop catches up.
  const liveCardBase = (): Card => ({
    ...liveCardRef.current,
    version: Math.max(liveCardRef.current.version, localCardRef.current.version),
  });
  // label.deleted strips the label from the live card without a version bump,
  // so the version-gated sync below never sees it (#1888). Drop a label from
  // localCard when it vanished from both the live card and the board, so the
  // chip goes and no later label_ids PATCH can carry the deleted id.
  const prevLiveLabelsRef = useRef(card.labels);
  useEffect(() => {
    const prevLabels = prevLiveLabelsRef.current;
    prevLiveLabelsRef.current = card.labels;
    const gone = prevLabels.filter(
      (l) => !card.labels.some((n) => n.id === l.id) && !board.labels.some((b) => b.id === l.id),
    );
    if (gone.length === 0) return;
    setLocalCard((c) => (
      c.labels.some((l) => gone.some((g) => g.id === l.id))
        ? { ...c, labels: c.labels.filter((l) => !gone.some((g) => g.id === l.id)) }
        : c
    ));
  }, [card.labels, board.labels]);
  const localLocationRef = useRef({ column: localCard.column, swimlane: localCard.swimlane });
  localLocationRef.current = { column: localCard.column, swimlane: localCard.swimlane };
  useEffect(() => {
    // Only a version that goes UP is a change. A copy older than one already
    // seen (useBoard drops those since #1969, and a failed move's rollback now
    // keeps a newer copy, but a full board reload still delivers one for a card
    // nothing wrote while it was in flight: it stays authoritative there, #2038)
    // is not a remote change and must not close the popover or erase its error.
    if (card.version <= lastSeenVersionRef.current) return;
    lastSeenVersionRef.current = card.version;
    // Our own save, or our own move: handleMoveSubmit and save() apply their
    // results themselves. Just keep the version current. A bump that lands while
    // one of our saves or moves is still in flight is treated as ours too: the
    // board's socket echo of our own PATCH can arrive before the HTTP response
    // has registered its version in ownVersionsRef. A save never changes the
    // location though, so a bump that comes with a different location is
    // remote even while a save is in flight (a move is guarded unconditionally:
    // useBoard relocates the card optimistically).
    const sameLocation = localLocationRef.current.column === card.column && localLocationRef.current.swimlane === card.swimlane;
    if (moveSubmittingRef.current) {
      // The location is synced too: it is our own target on success (a no-op next
      // to handleMoveSubmit), and the real location if a remote move or the
      // conflict reload lands before our request settles.
      setLocalCard((c) => (
        c.version === card.version && c.column === card.column && c.swimlane === card.swimlane
          ? c
          : { ...c, version: card.version, column: card.column, swimlane: card.swimlane, labels: card.labels, custom_field_values: card.custom_field_values, weight: weightSaveTimer.current ? c.weight : card.weight, blocked_at: card.blocked_at, blocked_reason: card.blocked_reason }
      ));
      return;
    }
    if (ownVersionsRef.current.delete(card.version) || (ownSavesInFlightRef.current > 0 && sameLocation)) {
      setLocalCard((c) => (c.version === card.version ? c : { ...c, version: card.version }));
      return;
    }
    // Custom field values and weight follow it as well (#1840): the custom field
    // save PATCHes the FULL values array and the weight buttons step from
    // localCard.weight, so a stale copy writes another session's edit back.
    // Labels follow the live card here too (#1840): label toggle/create build
    // their label_ids from localCard.labels, and the label buttons render their
    // active state from it, so a label another session added or removed must
    // land in localCard or the next toggle PATCHes a stale list over it.
    setLocalCard((c) => (
      c.version === card.version && c.column === card.column && c.swimlane === card.swimlane
        ? c
        : { ...c, version: card.version, column: card.column, swimlane: card.swimlane, labels: card.labels, custom_field_values: card.custom_field_values, weight: weightSaveTimer.current ? c.weight : card.weight, blocked_at: card.blocked_at, blocked_reason: card.blocked_reason }
    ));
    // An open popover closes with the user's selection or error in it. Say so
    // in the panel, unless the card landed exactly where the popover was
    // aiming (another session placed it exactly there): that is the user's
    // own outcome. A refresh with the popover closed clears any older notice
    // instead (its "current location" may be stale).
    const wasOpen = showMovePopoverRef.current;
    const target = moveTargetRef.current;
    const landedOnTarget = target.column === card.column && target.swimlane === card.swimlane;
    setMoveNotice(wasOpen && !landedOnTarget ? "This card was changed elsewhere. Its current location is shown." : "");
    setShowMovePopover(false);
    // Closing unmounts the focused control: hand focus back to the Move button,
    // but only when the popover was open and focus was inside it (or lost to
    // body). A version bump while the popover is closed must never move focus.
    if (wasOpen) {
      const active = document.activeElement;
      if (!active || active === document.body || movePopoverRef.current?.contains(active)) {
        moveButtonRef.current?.focus();
      }
    }
  }, [card.version, card.column, card.swimlane]);

  // Close move popover before panel — priority 36 sits above confirmAction (35) so
  // it fires first when both are open, and above panel close (30) in the normal case.
  useEscapeStack(() => {
    if (!showMovePopover) return false;
    // Swallow Escape while the admin override is in flight: closing would hide
    // its outcome (#1772).
    if (moveForcingRef.current) return;
    setShowMovePopover(false);
  }, 36);
  // Bulk-add overlay is a modal over the panel: Escape closes it first (priority 37, above
  // the move popover) instead of closing the whole card panel (#1376).
  useEscapeStack(() => {
    if (!showBulkAdd) return false;
    setShowBulkAdd(false);
    setChecklistError(null);
  }, 37);
  // The inline new-label input: Escape cancels it (priority 34, above the panel's 30) instead of
  // closing the whole panel and discarding other unsaved edits (#1972).
  useEscapeStack(() => {
    if (!addingLabel) return false;
    focusNewLabelTriggerRef.current = true;
    setAddingLabel(false);
    setLabelError(null);
  }, 34);
  useEffect(() => {
    if (addingLabel || !focusNewLabelTriggerRef.current) return;
    focusNewLabelTriggerRef.current = false;
    newLabelTriggerRef.current?.focus();
  }, [addingLabel]);
  // The title input: Escape reverts an in-progress edit and moves focus to the panel (priority 43, above the panel's
  // 30) instead of also closing the panel. Returns false unless the input has focus, so Escape
  // still closes the panel when no title edit is in progress (#2036, #2082).
  useEscapeStack(() => {
    const input = titleInputRef.current;
    if (!input || document.activeElement !== input) return false;
    // flushSync: the blur handler must see the reverted title, or it saves the half-typed one.
    flushSync(() => setLocalCard((c) => ({ ...c, title: titleBaselineRef.current })));
    focusEnclosingDialog(input);
  }, 43);
  useEscapeStack(onClose, 30);

  // The title the field was last in sync with: seeded from the card, then the
  // server's title after this component's own saves. The blur check compares
  // against this, not the live card prop, so another session's rename cannot
  // turn a plain focus+blur into a PATCH that writes the old title back.
  const titleBaselineRef = useRef(card.title);
  const titleInputRef = useRef<HTMLInputElement>(null);
  // Takes the server's copy after one of this component's own saves and
  // remembers its version as ours, so the reset effect does not read the bump
  // as a remote change (#1773).
  // Roll a failed save back to its snapshot, but keep the version and location
  // the reset effect may have synced from a remote change while it was in
  // flight, so later onUpdated payloads never write a stale version back.
  // A save's continuation runs in the render it started in, so read the board's
  // labels through a ref to see a label.deleted that landed meanwhile (#1888).
  const boardLabelsRef = useRef(board.labels);
  boardLabelsRef.current = board.labels;
  const rollbackTo = (prev: Card) =>
    setLocalCard((c) => ({ ...dropUnknownLabels(prev, boardLabelsRef.current), version: c.version, column: c.column, swimlane: c.swimlane }));
  // A newer version can reach localCard while the save is in flight (#1969): a
  // remote edit's frame, which the reset effect syncs as a version-only bump
  // while a save is pending, or a later save of ours that returned first. The
  // older response must not replace it. The live card is then taken instead
  // when it is at least as new, since a higher version was committed after
  // this save and so includes it, keeping localCard's location (the live card
  // can hold useBoard's optimistic one for a move still in flight); otherwise
  // localCard already holds the newer copy and is kept.
  const adoptSaved = (updated: Card) => {
    if (isStaleCard(updated, localCardRef.current)) {
      const live = liveCardRef.current;
      if (isStaleCard(live, localCardRef.current)) return;
      titleBaselineRef.current = live.title;
      setLocalCard((c) => ({ ...dropUnknownLabels(live, boardLabelsRef.current), column: c.column, swimlane: c.swimlane }));
      return;
    }
    titleBaselineRef.current = updated.title;
    ownVersionsRef.current.add(updated.version);
    // A response can carry a label deleted while the save was in flight (#1888).
    setLocalCard(dropUnknownLabels(updated, boardLabelsRef.current));
  };

  const save = async (patch: CardPatch) => {
    // Snapshot pre-save state so we can roll back if the API call fails.
    const prev = localCard;
    ownSavesInFlightRef.current += 1;
    try {
      const updated = await updateCard(board.id, localCard.id, patch);
      adoptSaved(updated);
      onUpdated(updated);
    } catch (err) {
      rollbackTo(prev);
      throw err;
    } finally {
      ownSavesInFlightRef.current -= 1;
    }
  };

  const saveWeight = async (weight: number) => {
    setWeightLimitRefused(false);
    try {
      await save({ weight });
      setWeightLimitReason(null);
    } catch (err) {
      // save() has already rolled the weight back. Only a limit refusal gets
      // a reason; any other failure keeps the indicator's "Couldn't save".
      const reason = limitBlockedMessage(err);
      setWeightLimitReason(reason);
      setWeightLimitRefused(reason !== null);
      throw err;
    }
  };

  // Names the column for limit refusals (the 409 body carries column_name);
  // the shared failureReason stays generic for the bulk toolbar.
  const moveFailureMessage = (err: unknown): string => {
    const reason = failureReason(err);
    const body = (err as { response?: { data?: { column_name?: unknown; swimlane_name?: unknown } } } | null)?.response?.data;
    // A swimlane limit (#1150) is named as the swimlane: the column it also
    // carries is only the target cell's.
    if (isLimitFailure(err) && typeof body?.swimlane_name === "string") {
      return `Card could not be moved — swimlane "${body.swimlane_name}" has reached its limit.`;
    }
    if (isLimitFailure(err) && typeof body?.column_name === "string") {
      return `Card could not be moved — "${body.column_name}" has reached its limit.`;
    }
    return `Card could not be moved — ${reason}.`;
  };

  const handleMoveSubmit = async () => {
    if (!onMoveCard || moveTargetColumn === null || moveTargetSwimlane === null) return;
    // No-op if the card is already in this location.
    if (moveTargetColumn === localCard.column && moveTargetSwimlane === localCard.swimlane) {
      setShowMovePopover(false);
      return;
    }
    setMoveSubmitting(true);
    setMovePopoverError(null);
    setMoveRefusal(null);
    try {
      // position 9999 appends the card to the end of the target cell.
      // useBoard.moveCard never rejects; it reports failure in its result. Only
      // commit the new location to localCard on success, and name the real cause
      // (limit wording only for limit codes, #1761).
      const result = await onMoveCard(localCard.id, moveTargetColumn, moveTargetSwimlane, 9999);
      if (result && result.ok === false) {
        setMovePopoverError(moveFailureMessage(result.error));
        setMoveRefusal(limitRefusal(result.error));
        return;
      }
      setLocalCard((c) => ({ ...c, column: moveTargetColumn, swimlane: moveTargetSwimlane }));
      setShowMovePopover(false);
    } catch (err) {
      setMovePopoverError(moveFailureMessage(err));
      setMoveRefusal(limitRefusal(err));
    } finally {
      setMoveSubmitting(false);
    }
  };

  // Changing the target invalidates the last failure's message and override.
  const clearMoveFailure = () => {
    setMovePopoverError(null);
    setMoveRefusal(null);
  };

  // Admin override from the popover (#1772): force the popover's own target,
  // never the toast's shared pendingMove. Success closes the popover silently
  // (the outcome is visible in the breadcrumb) and hands focus to the Move
  // trigger; failure names its cause inline like a plain Move.
  const handleForceMove = async () => {
    if (!onForceMoveCard || moveForcingRef.current || moveTargetColumn === null || moveTargetSwimlane === null) return;
    const columnId = moveTargetColumn;
    const swimlaneId = moveTargetSwimlane;
    moveForcingRef.current = true;
    setMoveForcing(true);
    try {
      const result = await onForceMoveCard(localCard.id, columnId, swimlaneId, 9999);
      if (result.ok === false) {
        const refusal = limitRefusal(result.error);
        setMovePopoverError(moveFailureMessage(result.error));
        setMoveRefusal(refusal);
        // The link the user activated is gone unless the new failure is again
        // an overridable limit: move focus to the popover's Move button rather
        // than letting it drop to the panel.
        if (refusal === null || isHardLimit(refusal.code)) focusMoveSubmitRef.current = true;
        return;
      }
      setLocalCard((c) => ({ ...c, column: columnId, swimlane: swimlaneId }));
      setMovePopoverError(null);
      setMoveRefusal(null);
      setShowMovePopover(false);
      // The panel may have closed while the request was in flight.
      moveButtonRef.current?.focus();
    } catch (err) {
      // Defensive: useBoard.forceMoveCardTo never rejects (it reports failure in
      // its result), but the prop is a plain Promise, so a rejecting caller still
      // gets its cause shown instead of an unhandled rejection.
      setMovePopoverError(moveFailureMessage(err));
      setMoveRefusal(limitRefusal(err));
      focusMoveSubmitRef.current = true;
    } finally {
      moveForcingRef.current = false;
      setMoveForcing(false);
    }
  };

  // The popover's Move button is disabled while the override is in flight, so
  // it can only take focus after the render that re-enables it.
  useEffect(() => {
    if (moveForcing || !focusMoveSubmitRef.current) return;
    focusMoveSubmitRef.current = false;
    moveSubmitRef.current?.focus();
  }, [moveForcing]);

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !isImeComposing(e)) {
      e.preventDefault();
      (e.target as HTMLInputElement).blur(); // blur triggers save
      if (closeEditorOnEnter) onClose();
    }
    // Escape is handled by the useEscapeStack registration (priority 43), not here (#2036).
  };

  const handleTitleBlur = async () => {
    const trimmed = localCard.title.trim();
    if (!trimmed) {
      // Restore if user cleared the title entirely
      setLocalCard((c) => ({ ...c, title: titleBaselineRef.current }));
    } else if (trimmed !== titleBaselineRef.current) {
      await save({ title: trimmed }).catch(() => {});
    }
  };

  const toggleLabel = async (label: Label) => {
    const has = localCard.labels.some((l) => l.id === label.id);
    const newLabels = has
      ? localCard.labels.filter((l) => l.id !== label.id)
      : [...localCard.labels, label];
    const prev = localCard;
    setLocalCard((c) => ({ ...c, labels: newLabels }));
    ownSavesInFlightRef.current += 1;
    try {
      const updated = await updateCard(board.id, localCard.id, { label_ids: newLabels.map((l) => l.id) });
      adoptSaved(updated);
      onUpdated(updated);
    } catch {
      rollbackTo(prev);
    } finally {
      ownSavesInFlightRef.current -= 1;
    }
  };

  const handleCreateLabel = async (colorOverride?: string) => {
    if (!newLabelName.trim()) return;
    // Ref guard (#1498): Enter+click or a double click on a color swatch would
    // otherwise create the label twice.
    if (labelCreateInFlight.current) return;
    labelCreateInFlight.current = true;
    setLabelError(null);
    const color = colorOverride ?? newLabelColor;
    try {
      const label = await createLabel(board.id, { name: newLabelName.trim(), color });
      // Do not call onLabelAdded here — the WebSocket label.created broadcast is
      // the source of truth for board.labels and will add it once. Calling it here
      // too produces a duplicate label in the board's label list.
      const updatedLabelIds = [...localCard.labels.map((l) => l.id), label.id];
      const updated = await updateCard(board.id, localCard.id, { label_ids: updatedLabelIds });
      adoptSaved(updated);
      onUpdated(updated);
      setNewLabelName("");
      focusNewLabelTriggerRef.current = true;
      setAddingLabel(false);
    } catch {
      setLabelError("Failed to create label. Only board admins can create labels.");
    } finally {
      labelCreateInFlight.current = false;
    }
  };

  const handleComment = async () => {
    // Demo (#1179): never attempted, so the typed text is simply kept.
    if (demoMode) return;
    if (!commentBody.trim()) return;
    // Ref guard (#1498): a double click or Enter+click before React re-renders
    // would otherwise post the same comment twice.
    if (commentInFlight.current) return;
    commentInFlight.current = true;
    setCommentError(null);
    try {
      const c = await addCardComment(board.id, card.id, commentBody.trim());
      setComments((prev) => [...prev, c]);
      setCommentBody("");
      setHistoryReload((n) => n + 1);
      // The composer is pinned: bring the new comment, at the thread's end, into view.
      requestAnimationFrame(() => {
        const el = bodyScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } catch {
      // Typed text is kept so the user can retry without retyping.
      setCommentError("Could not post comment.");
    } finally {
      commentInFlight.current = false;
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (uploadInFlight.current) return;
    uploadInFlight.current = true;
    setUploading(true);
    setAttachError(null);
    try {
      const attachment = await uploadCardAttachment(board.id, localCard.id, file);
      setAttachments((prev) => [attachment, ...prev]);
      setLocalCard((c) => ({ ...c, attachment_count: c.attachment_count + 1 }));
      {
        const base = liveCardBase();
        onUpdated({ ...base, attachment_count: base.attachment_count + 1 });
      }
    } catch {
      setAttachError("Could not upload attachment.");
    } finally {
      uploadInFlight.current = false;
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const [attachError, setAttachError] = useState<string | null>(null);

  const handleDeleteAttachment = async (id: number) => {
    if (attachDeleteInFlight.current) return;
    attachDeleteInFlight.current = true;
    try {
      setAttachError(null);
      await deleteCardAttachment(board.id, localCard.id, id);
      setAttachments((prev) => prev.filter((a) => a.id !== id));
      setLocalCard((c) => ({ ...c, attachment_count: Math.max(0, c.attachment_count - 1) }));
      {
        const base = liveCardBase();
        onUpdated({ ...base, attachment_count: Math.max(0, base.attachment_count - 1) });
      }
    } catch {
      setAttachError("Could not delete attachment.");
    } finally {
      attachDeleteInFlight.current = false;
    }
  };

  const handleAddChecklistItem = async () => {
    if (!newItemText.trim()) return;
    // Ref guard (#1498), shared with handleBulkAdd so the two cannot overlap.
    if (checklistAddInFlight.current) return;
    checklistAddInFlight.current = true;
    setChecklistError(null);
    try {
      // Previously unhandled (#1375): a rejected add left the typed text in
      // place with the input otherwise unresponsive — nothing told the user
      // it had failed, so the keystroke looked lost.
      const item = await addChecklistItem(board.id, card.id, newItemText.trim());
      setChecklist((prev) => [...prev, item]);
      setNewItemText("");
      {
        const base = liveCardBase();
        onUpdated({ ...base, checklist_total: base.checklist_total + 1 });
      }
    } catch {
      setChecklistError("Could not add item.");
    } finally {
      checklistAddInFlight.current = false;
    }
  };

  const handleBulkAdd = async () => {
    const items = bulkText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    if (checklistAddInFlight.current) return;
    checklistAddInFlight.current = true;
    setChecklistError(null);
    const added: CardChecklistItem[] = [];
    try {
      // Previously unhandled (#1375): a mid-loop rejection left every item
      // already persisted on the server but never applied to local state —
      // they'd only reappear on the next full reload, with no error shown and
      // the "Add checklist items" dialog stuck open with no explanation.
      for (const text of items) {
        const item = await addChecklistItem(board.id, card.id, text);
        added.push(item);
      }
      setBulkText("");
      setShowBulkAdd(false);
    } catch {
      // Rewrite the textarea to only the items that didn't make it in yet —
      // the failed one plus anything after it that was never attempted — so a
      // literal retry (clicking "Add items" again without editing) resubmits
      // only the remainder instead of re-posting the ones already committed.
      const remaining = items.slice(added.length);
      setBulkText(remaining.join("\n"));
      setChecklistError(
        added.length > 0
          ? `Added ${added.length} of ${items.length} items — the rest failed.`
          : "Could not add items."
      );
    } finally {
      checklistAddInFlight.current = false;
      if (added.length > 0) {
        setChecklist((prev) => [...prev, ...added]);
        {
          const base = liveCardBase();
          onUpdated({ ...base, checklist_total: base.checklist_total + added.length });
        }
      }
    }
  };

  const handleToggleChecklistItem = async (item: CardChecklistItem) => {
    if (checklistToggleInFlight.current) return;
    checklistToggleInFlight.current = true;
    setChecklistError(null);
    try {
      const updated = await updateChecklistItem(board.id, card.id, item.id, { is_checked: !item.is_checked });
      // Derive the new list from the current closure snapshot of `checklist` rather
      // than using a stale ±1 delta against localCard.checklist_done. Delta math
      // accumulates errors when two items are toggled before a re-render occurs.
      const newChecklist = checklist.map((i) => (i.id === item.id ? updated : i));
      setChecklist(newChecklist);
      const done = newChecklist.filter((i) => i.is_checked).length;
      onUpdated({ ...liveCardBase(), checklist_done: done, checklist_total: newChecklist.length });
    } catch {
      setChecklistError("Could not update item.");
    } finally {
      checklistToggleInFlight.current = false;
    }
  };

  const handleDeleteChecklistItem = async (itemId: number) => {
    if (checklistDeleteInFlight.current) return;
    checklistDeleteInFlight.current = true;
    setChecklistError(null);
    try {
      await deleteChecklistItem(board.id, card.id, itemId);
      const newChecklist = checklist.filter((i) => i.id !== itemId);
      setChecklist(newChecklist);
      const done = newChecklist.filter((i) => i.is_checked).length;
      onUpdated({ ...liveCardBase(), checklist_total: newChecklist.length, checklist_done: done });
    } catch {
      setChecklistError("Could not delete item.");
    } finally {
      checklistDeleteInFlight.current = false;
    }
  };

  const openCardAction = (action: "delete" | "archive") => {
    setCardActionError(null);
    setConfirmAction(action);
  };
  const handleDelete = () => openCardAction("delete");
  // Archive waits for the sheet to finish loading (#1914, frame 6): it is
  // aria-disabled, not `disabled`, so it keeps its Tab stop.
  const handleArchive = () => { if (!loading) openCardAction("archive"); };

  const closeCardAction = () => {
    // Ignore dismissal while the request is in flight so the outcome is never hidden.
    if (cardActionInFlight.current) return;
    setConfirmAction(null);
    setCardActionError(null);
  };

  // Delete/archive share one flow: keep the modal open until the request succeeds so a
  // failure can be shown (and retried) in place, matching the comment-delete prompt (#1421).
  const runCardAction = async (request: () => Promise<unknown>, onSuccess: () => void, errorMessage: string) => {
    if (cardActionInFlight.current) return;
    cardActionInFlight.current = true;
    setCardActionBusy(true);
    setCardActionError(null);
    try {
      await request();
      setConfirmAction(null);
      onSuccess();
    } catch {
      setCardActionError(errorMessage);
    } finally {
      cardActionInFlight.current = false;
      setCardActionBusy(false);
    }
  };

  const executeDelete = () =>
    runCardAction(() => deleteCard(board.id, card.id), () => onDeleted(card.id), "Could not delete card.");

  const executeArchive = () =>
    runCardAction(
      () => archiveCard(board.id, card.id),
      () => { onArchived(card.id); onClose(); },
      "Could not archive card.",
    );

  const column = board.columns.find((c) => c.id === localCard.column);
  const swimlane = board.swimlanes.find((s) => s.id === localCard.swimlane);

  const role = board.current_user_role;
  const canEdit = role === "site_admin" || role === "admin" || role === "member";
  // The popover's admin override (#1772): only a soft limit can be forced, so
  // never for wip_hard_blocked, and never without a refusal body.
  const isBoardAdmin = role === "admin" || role === "site_admin";
  const canForceMove = isBoardAdmin && onForceMoveCard !== undefined && moveRefusal !== null && !isHardLimit(moveRefusal.code);
  const canManageLabels = role === "site_admin" || role === "admin";
  const canComment = canEdit || role === "collaborator";
  // Hosted demo (#1179): the server fence refuses comments and uploads, so
  // those controls are aria-disabled up front with the reason — never native
  // `disabled`, which would drop them from the tab order and hide the reason
  // from keyboard users. Copy uses the fixed demo lead (frontend/CLAUDE.md).
  const demoMode = useInstanceFlags().demo_mode;
  const uploadsBlockedReason = demoMode
    ? DEMO_UPLOAD_REASON
    : currentUser?.uploads_enabled === false
      ? "File uploads are disabled by the site administrator."
      : null;

  // Ownership gating: members can only delete/archive cards they created,
  // unless they have admin, site_admin, or is_moderator entitlement.
  const isModerator = board.members.some(
    (m) => currentUser != null && m.user.id === currentUser.id && m.is_moderator,
  );
  const canModifyOthersContent =
    role === "admin" || role === "site_admin" || isModerator;
  const isCardOwner =
    currentUser != null && localCard.created_by?.id === currentUser.id;
  // Hosted demo (#1179): the server lets the published visitor (a plain
  // MEMBER) archive, unarchive and reassign cards others created, via a
  // DEMO_MODE-gated carve-out in boards.permissions. Mirror that here as a
  // display heuristic only (`demoMode && member`) — the server stays the
  // authority, and the frontend never replicates its username check. Widened
  // ONLY for writes the demo fence allows. Since #1914 the sheet itself
  // offers no Archive in the demo (its footer note replaces it), so here
  // the widening only affects reassigning.
  const canModifyOthersContentInDemo =
    (demoMode && role === "member") || canModifyOthersContent;
  // Shared demo (#1914, design frame 7): the footer note replaces Archive.
  // A UI restriction only: the demo fence would allow the archive itself.
  const canArchive = !demoMode && canEdit && (isCardOwner || canModifyOthersContentInDemo);
  const canAssign = canEdit && (isCardOwner || canModifyOthersContentInDemo);
  // Delete is NOT widened, and is hidden outright in demo mode: card DELETE is
  // not on DEMO_ALLOWED_WRITES, so the fence refuses it even for the visitor's
  // own cards — showing it would only produce a refusal.
  const canDelete = !demoMode && canEdit && (isCardOwner || canModifyOthersContent);
  // Block / unblock (#1149): the edit rule (member+, own card unless a
  // moderator or admin), as the server enforces it. Not offered in the shared
  // demo, whose write fence does not allow it.
  const canBlock = !demoMode && canEdit && (isCardOwner || canModifyOthersContent);
  // The block state shown is the newer of the live card (another session's
  // block arrives there) and localCard (our own response, before the board
  // store has it).
  const blockSource = localCard.version > card.version ? localCard : card;
  const manuallyBlocked = blockSource.blocked_at != null;
  // Declared after the open-focus effect above, so on open the form's own
  // focus (CardBlockSection, on formMode) lands last and wins over Close.
  const handledBlockRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!blockFormRequest || handledBlockRequest.current === blockFormRequest.seq) return;
    handledBlockRequest.current = blockFormRequest.seq;
    if (!canBlock || (blockFormRequest.mode === "unblock") !== manuallyBlocked) return;
    setTab("details");
    setBlockFormMode(blockFormRequest.mode);
  }, [blockFormRequest, canBlock, manuallyBlocked]);
  useEffect(() => {
    if (!manuallyBlocked && focusBlockButtonNext.current) {
      focusBlockButtonNext.current = false;
      blockButtonRef.current?.focus();
    }
  }, [manuallyBlocked]);

  const canDeleteComment = (c: CardComment): boolean =>
    (c.author !== null && currentUser !== null && c.author.id === currentUser.id) ||
    canModifyOthersContent;

  const canDeleteAttachment = (a: CardAttachment): boolean =>
    (a.uploaded_by !== null && currentUser !== null && a.uploaded_by.id === currentUser.id) ||
    canModifyOthersContent;

  // Mirrors the server's checklist ownership gate (#692, #1943): PATCH/DELETE
  // on an item is allowed for its creator or a moderator/admin. A null creator
  // (legacy row or deleted account) is moderator-only, so a plain member sees
  // the controls disabled instead of a failed request.
  const canModifyChecklistItem = (item: CardChecklistItem): boolean =>
    (item.created_by !== null && item.created_by !== undefined && currentUser !== null &&
      item.created_by.id === currentUser.id) ||
    // The hosted-demo visitor (a plain member) may tick/remove any checklist
    // item server-side (demo-data.md), so mirror it like card reassignment.
    canModifyOthersContentInDemo;

  const handleDeleteComment = async (commentId: number) => {
    // Re-entry guard: the disabled Confirm covers clicks, this covers a
    // double-fire before React re-renders, so only one DELETE is ever sent.
    if (deletingCommentId !== null) return;
    setDeletingCommentId(commentId);
    setCommentDeleteError(null);
    try {
      await deleteComment(board.id, card.id, commentId);
      setComments((prev) => prev.filter((x) => x.id !== commentId));
      setConfirmDeleteCommentId(null);
    } catch {
      // Keep the prompt open so the user can retry or Cancel; never leave it stuck.
      setCommentDeleteError("Failed to delete comment. Please try again.");
    } finally {
      setDeletingCommentId(null);
    }
  };

  const cancelCommentDelete = () => {
    setConfirmDeleteCommentId(null);
    setCommentDeleteError(null);
  };

  const allLabels = [...board.labels];
  localCard.labels.forEach((l) => {
    if (!allLabels.find((bl) => bl.id === l.id)) allLabels.push(l);
  });

  // Shared by the Move button and the Column key fact (#1916), so both open
  // the same popover the same way.
  const toggleMovePopover = () => {
    // Inert while the popover's admin override is in flight: toggling
    // would close the popover and hide the pending outcome (#1772).
    if (moveForcingRef.current) return;
    setMoveToSeen(true);
    // Calculate fixed position from the button's viewport rect so the
    // popover isn't clipped by the panel's overflow-hidden container.
    const rect = moveButtonRef.current?.getBoundingClientRect();
    if (rect) {
      // Right-align to button, clamped so the popover never clips the left edge.
      const popoverWidth = 256; // w-64
      const left = Math.max(8, window.innerWidth - (window.innerWidth - rect.right) - popoverWidth);
      setMovePopoverAnchor({ top: rect.bottom + 4, left });
    }
    setMoveTargetColumn(localCard.column);
    setMoveTargetSwimlane(localCard.swimlane);
    setMovePopoverError(null);
    setMoveRefusal(null);
    setMoveNotice("");
    setShowMovePopover((v) => !v);
  };

  // Key-facts jump (#1916): switch to Details if needed, open a collapsed
  // section, then (after the render that makes the target exist) scroll it to
  // the top of the body, under the fixed header, and focus its first control.
  const [pendingJump, setPendingJump] = useState<{ target: KeyFactTarget; n: number } | null>(null);
  const focusMovePopoverNext = useRef(false);
  const jumpTo = (target: KeyFactTarget) => {
    if (target === "move") {
      if (!canEdit || !onMoveCard) return;
      focusMovePopoverNext.current = !showMovePopover;
      toggleMovePopover();
      return;
    }
    if (target.startsWith("field:")) setCustomFieldsOpen(true);
    if (tab !== "details") selectTab("details");
    setPendingJump((j) => ({ target, n: (j?.n ?? 0) + 1 }));
  };
  useEffect(() => {
    if (!pendingJump || tab !== "details") return;
    const section = bodyScrollRef.current?.querySelector<HTMLElement>(`[data-fact-section="${pendingJump.target}"]`);
    setPendingJump(null);
    if (!section) return;
    if (typeof section.scrollIntoView === "function") {
      // Instant under reduced motion; the body's scroll-padding keeps the
      // target clear of the top fade.
      section.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
    section.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")?.focus({ preventScroll: true });
  }, [pendingJump, tab]);
  useEffect(() => {
    if (!showMovePopover || !focusMovePopoverNext.current) return;
    focusMovePopoverNext.current = false;
    movePopoverRef.current?.querySelector<HTMLElement>("button, [tabindex]")?.focus();
  }, [showMovePopover]);

  const keyFacts = buildKeyFacts({ card: localCard, board, userTimezone, userDateFormat });

  const anchored = placement.mode === "anchored";
  const fullscreen = placement.mode === "fullscreen";
  const commentCount = pendingSections.comments ? undefined : comments.length;
  const historyCount = historyCounts ? Object.values(historyCounts).reduce((a, b) => a + b, 0) : undefined;
  const lastHistoryEntry = historyPage?.results[0] ?? null;
  const goToLatestHistory = () => {
    selectTab("history");
    setFocusFirstHistoryEntry(true);
  };
  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const i = CARD_DETAIL_TABS.indexOf(tab);
    const last = CARD_DETAIL_TABS.length - 1;
    const next =
      e.key === "ArrowRight" ? CARD_DETAIL_TABS[i === last ? 0 : i + 1]
      : e.key === "ArrowLeft" ? CARD_DETAIL_TABS[i === 0 ? last : i - 1]
      : e.key === "Home" ? CARD_DETAIL_TABS[0]
      : e.key === "End" ? CARD_DETAIL_TABS[last]
      : null;
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    tabRefs.current[next]?.focus();
  };
  // Geometry per mode (#1914). Anchored: 540px beside the column, below the
  // board toolbar, rounded and elevated. Docked: full height at the right
  // edge, square with a left border. Full-screen: the whole viewport.
  const panelModeClass = anchored
    ? "rounded-lg border border-primary-emphasis shadow-2xl"
    : fullscreen
      ? "inset-0"
      : "top-0 bottom-0 right-0 w-[540px] border-l border-line shadow-2xl";
  const panelStyle: React.CSSProperties | undefined = anchored
    ? { left: placement.left ?? undefined, top: placement.top, bottom: placement.bottom, width: 540 }
    : undefined;
  const notch = anchored ? placement.notch : null;

  return (
    // `contents`: no box of its own, so each layer below positions itself;
    // the wrapper only marks pointer events from this React tree as inside.
    <div className="contents" onPointerDownCapture={markPointerInside}>
      {/* Docked only: a light dimming layer that is visual, not a click
          target, so the cards behind stay clickable to swap (#1914). Anchored
          and full-screen sheets have none. */}
      {placement.mode === "docked" && (
        <div className="fixed inset-0 z-50 bg-backdrop/20 pointer-events-none" aria-hidden="true" data-testid="card-detail-backdrop" />
      )}

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-detail-title"
        tabIndex={-1}
        data-sheet-mode={placement.mode}
        data-sheet-side={anchored ? placement.side ?? undefined : undefined}
        style={panelStyle}
        className={`fixed z-50 bg-surface outline-none ${panelModeClass}`}
      >
        {/* Notch (#1946): a speech-bubble tail on the sheet's outer edge. A
            child of the root, which is overflow-visible so the tail can sit
            outside it; the clip moves to the wrapper below. Tracking: an
            isosceles triangle. Clamped: a right-triangle wedge whose apex
            points toward the card, so shape alone shows direction.
            Decorative: the card's 2px border and aria-current carry the link. */}
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
        {/* Clip wrapper: rounds the content to the border's inner radius when
            anchored only (a docked or full-screen panel is flush and square). */}
        <div className={`flex h-full flex-col overflow-hidden ${anchored ? "rounded-[7px]" : ""}`}>
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-line">
          {fullscreen && (
            // Full-screen (<= 640px, frame 4): a 44px "Board" back control.
            // It closes the sheet like Close and Escape do.
            <button
              type="button"
              onClick={onClose}
              // Distinct from the toolbar's "Board" view tab; still contains the visible text (label-in-name).
              aria-label="Back to board"
              className="h-11 -my-2 -ml-2 px-2 flex items-center gap-1 rounded text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              <span aria-hidden="true">‹</span> Board
            </button>
          )}
          <div className="flex-1 min-w-0">
            <input
              id="card-detail-title"
              ref={titleInputRef}
              value={localCard.title}
              onChange={(e) => setLocalCard((c) => ({ ...c, title: e.target.value }))}
              onKeyDown={handleTitleKeyDown}
              onBlur={handleTitleBlur}
              className="text-base font-semibold text-fg w-full outline-none rounded px-1 -ml-1 border border-transparent focus:border-primary-soft focus:bg-primary-emphasis/20 bg-transparent transition"
            />
            {/* Breadcrumb row — swimlane and column names close the panel so the user
                lands back on the board at that location. The move icon sits immediately
                after the column name so it reads as part of the same affordance. */}
            <div className="flex items-center gap-0.5 mt-1 px-1 min-w-0">
              <button
                onClick={onClose}
                className="text-xs text-fg-muted hover:text-fg-secondary transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded truncate max-w-[10rem]"
                title={swimlane?.name}
              >
                {swimlane?.name}
              </button>
              <span className="text-xs text-fg-faint mx-1 shrink-0" aria-hidden="true">›</span>
              <button
                onClick={onClose}
                className="text-xs text-fg-muted hover:text-fg-secondary transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded truncate max-w-[10rem]"
                title={column?.name}
              >
                {column?.name}
              </button>
              {canEdit && onMoveCard && (
                <div className="relative shrink-0 group/move ml-1">
                  {!moveToSeen && (
                    // First-encounter dot: disappears after the user clicks Move for the first time.
                    // bg-primary-emphasis is the notification indicator token — distinct from bg-primary-soft
                    // (active filter/selection state). pointer-events-none prevents the dot from
                    // intercepting clicks intended for the button.
                    <span className="absolute top-0 right-0 w-2 h-2 rounded-full bg-primary-emphasis pointer-events-none" aria-hidden="true" />
                  )}
                  <button
                    ref={moveButtonRef}
                    onClick={toggleMovePopover}
                    // On coarse pointers (touch) this is the non-drag way to move a card,
                    // but a 20px icon is too small to tap and its hover tooltip never
                    // shows (#1287). Grow it to 32px and show the "Move" label inline.
                    className="w-5 h-5 [@media(pointer:coarse)]:w-auto [@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:px-2 [@media(pointer:coarse)]:gap-1 flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    aria-label="Move card to different column or swimlane"
                  >
                    {/* Two-headed arrows = transfer/move-to-another-location metaphor */}
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path d="M8 5a1 1 0 100 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8zM12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z" />
                    </svg>
                    <span className="hidden [@media(pointer:coarse)]:inline text-xs" aria-hidden="true">Move</span>
                  </button>
                  {/* Styled tooltip — 300ms delay on show, immediate hide */}
                  <div className="pointer-events-none absolute bottom-full right-0 mb-1.5 whitespace-nowrap bg-sunken text-fg text-xs rounded px-2 py-1 shadow-lg opacity-0 group-hover/move:opacity-100 transition-opacity delay-300 group-hover/move:delay-300">
                    Move card
                  </div>
                </div>
              )}
            </div>
            {/* Always mounted, takes no space while empty; text swapped inside so it is announced (#1773). */}
            <div role="status" aria-live="polite" aria-atomic="true" data-testid="move-notice">
              {moveNotice && <p className="text-xs text-warning mt-1 px-1">{moveNotice}</p>}
            </div>
          </div>
          {canBlock && !manuallyBlocked && (
            <button
              ref={(el) => { blockTriggerRef("block")(el); blockButtonRef.current = el; }}
              type="button"
              onClick={() => { setTab("details"); setBlockFormMode((m) => (m === "block" ? null : "block")); }}
              aria-expanded={blockFormMode === "block"}
              className="px-3 py-1.5 -my-1 text-sm rounded text-fg-secondary hover:text-fg hover:bg-surface-hover transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Block…
            </button>
          )}
          {!fullscreen && (
            // Dock toggle (#1915): DOM order equals visual order (Dock, then Close) and focus
            // opens on Close, so Shift+Tab reaches it. The pressed state is not tint alone:
            // ActiveUnderline (#2188) plus the icon swap and border as reinforcement.
            <button
              type="button"
              onClick={() => setDockedPref(!dockedPref)}
              aria-pressed={dockedPref}
              aria-label={dockedPref ? "Open next to card" : "Dock to edge"}
              title={dockedPref ? "Open next to card" : "Dock to edge"}
              data-testid="card-sheet-dock-toggle"
              className={`relative w-7 h-7 flex items-center justify-center rounded border transition shrink-0 hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                dockedPref ? "bg-surface-hover border-line-strong text-fg" : "border-transparent text-fg-tertiary"
              }`}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
                {dockedPref ? (
                  <>
                    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
                    <path d="M9.5 2.75v10.5" />
                    <path d="M9.5 8H4.5M6.5 6l-2 2 2 2" />
                  </>
                ) : (
                  <>
                    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
                    <path d="M10 2.75v10.5" />
                    <path d="M10 8h2.5M11.25 6.75L12.5 8l-1.25 1.25" />
                  </>
                )}
              </svg>
              <ActiveUnderline active={dockedPref} />
            </button>
          )}
          <button type="button"
            ref={closeButtonRef}
            onClick={onClose}
            className={`${fullscreen ? "w-11 h-11 -my-2 -mr-2" : "w-7 h-7"} flex items-center justify-center rounded text-fg-tertiary hover:text-fg hover:bg-surface-hover transition text-lg leading-none shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
            title="Close"
            aria-label="Close"
          >×</button>
        </div>

        {/* Key facts (#1916): row 3 of the header, so it stays put while the body
            scrolls. Read-only viewers keep it: navigation is reading. The Column
            fact has nothing to open for someone who cannot move the card. */}
        <CardKeyFacts facts={keyFacts} onJump={jumpTo} inertTargets={canEdit && onMoveCard ? [] : ["move"]} />

        {/* Tabs (#967): full tablist pattern with roving tabIndex. A count
            is part of the tab's name ("Comments, 4") and is left out while
            unknown, never shown as 0. */}
        <div role="tablist" aria-label="Card sections" className="flex border-b border-line text-sm">
          {CARD_DETAIL_TABS.map((t) => {
            const count = t === "comments" ? commentCount : t === "history" ? historyCount : undefined;
            return (
              <button
                key={t}
                ref={(el) => { tabRefs.current[t] = el; }}
                type="button"
                role="tab"
                id={`card-tab-${t}-${card.id}`}
                aria-selected={tab === t}
                // "Comments, 4": an explicit name, because a visually hidden
                // comma span gets padded with spaces by name computation.
                aria-label={count !== undefined ? `${TAB_LABELS[t]}, ${count}` : undefined}
                aria-controls={`card-tabpanel-${card.id}`}
                tabIndex={tab === t ? 0 : -1}
                onClick={() => selectTab(t)}
                onKeyDown={handleTabKeyDown}
                className={`${fullscreen ? "px-3" : "px-5"} py-2.5 font-medium transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis rounded-t ${
                  tab === t ? "border-b-2 border-info text-info" : "text-fg-muted hover:text-fg-secondary"
                }`}
              >
                {TAB_LABELS[t]}
                {count !== undefined && (
                  <span className="ml-1 font-normal text-fg-tertiary" data-testid={`card-tab-count-${t}`}>{count}</span>
                )}
              </button>
            );
          })}
        </div>

        {loadError && (
          <p role="alert" className="px-5 pt-2 text-xs text-danger">
            Some card details failed to load — try reopening the card.
          </p>
        )}

        {/* Always mounted, so the one-time "Loading card details" text lands in an existing live region. */}
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{loadingAnnouncement}</p>

        <div className="relative flex-1 overflow-hidden">
          <div ref={bodyScrollRef} onScroll={updateBodyShadows} aria-busy={loading} role="tabpanel" id={`card-tabpanel-${card.id}`} aria-labelledby={`card-tab-${tab}-${card.id}`} className="h-full overflow-y-auto px-5 py-4 scroll-pb-10 scroll-pt-6">
          {tab === "details" ? (
            <div className="flex flex-col gap-6">

              {demoMode && (
                // Shared demo (frame 7): one note at the top of the body; each
                // section that is off here still carries its own reason.
                <p className="text-xs text-fg-muted -mb-3">{DEMO_CARD_DETAIL_NOTE}</p>
              )}

              {/* Manual blocked state (#1149): first in the body, because a
                  blocked card's most important fact is that it is blocked. */}
              <CardBlockSection
                boardId={board.id}
                card={blockSource}
                canBlock={canBlock}
                formMode={blockFormMode}
                onFormModeChange={setBlockFormMode}
                unblockTriggerRef={blockTriggerRef("unblock")}
                onCardUpdated={(updated) => {
                  if (updated.blocked_at == null) focusBlockButtonNext.current = true;
                  adoptSaved(updated);
                  onUpdated(updated);
                }}
                userPrefs={currentUser}
                refreshSignal={refreshSignal}
              />

              {/* Description */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Description</p>
                <RichTextEditor
                  value={localCard.description ?? ""}
                  onSave={(md) => {
                    setLocalCard((c) => ({ ...c, description: md }));
                    // void: runSave awaits the passed promise in its own
                    // try/catch and drives descStatus/AutosaveIndicator to
                    // "error" on failure — it never rejects itself.
                    void descRunSave(save({ description: md }));
                  }}
                  readOnly={!canEdit}
                  showActions={canEdit}
                  placeholder="Add a description…"
                  minHeight="min-h-32"
                  members={board.members}
                />
                <AutosaveIndicator status={descStatus} fadingOut={descFadingOut} />
              </div>

              {/* Definition of done (#1101): the current column's policy, shown
                  for reference to every reader. Display-only — it never blocks
                  moving the card out — so bullets, not boxes that read as
                  checkboxes. Omitted when the column has no done criteria
                  (board-config-gated). An h3, unlike the sibling <p> labels,
                  so the section is named for screen readers. */}
              {column?.policy && column.policy.done.length > 0 && (
                <section aria-labelledby="card-dod-heading">
                  <h3 id="card-dod-heading" className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">
                    Definition of done · <span className="normal-case tracking-normal">{column.name}</span>
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {column.policy.done.map((text, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-fg-secondary">
                        <span aria-hidden="true" className="mt-2 w-1 h-1 rounded-full bg-fg-tertiary shrink-0" />
                        <span className="min-w-0 break-words">{text}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-fg-tertiary mt-1.5">For reference. It never blocks moving the card on.</p>
                </section>
              )}

              <div className="border-t border-line" />

              {/* Assignee + Due date */}
              <div className="grid grid-cols-2 gap-4">
                <div data-fact-section="assignee">
                  <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Assignee</p>
                  <SelectDropdown
                    value={String(localCard.assignee?.id ?? "")}
                    onChange={(v) => {
                      const id = v ? Number(v) : null;
                      save({ assignee_id: id }).catch(() => {});
                    }}
                    options={[
                      { value: "", label: "Unassigned" },
                      ...board.members
                        .filter(isAssignableMember)
                        .map((m) => ({
                          value: String(m.user.id),
                          label: userDisplayName(m.user),
                        })),
                      // The member list omits users with all-content access for
                      // readers who are not site admins (#1714); a card already
                      // assigned to one still shows that assignee by name.
                      ...(localCard.assignee && !board.members.some((m) => m.user.id === localCard.assignee?.id)
                        ? [{ value: String(localCard.assignee.id), label: userDisplayName(localCard.assignee) }]
                        : []),
                    ]}
                    disabled={!canAssign}
                    // Never shown to the demo visitor: canAssign is widened for
                    // a demo member (canModifyOthersContentInDemo), so this
                    // moderator-only reason cannot misdescribe the demo.
                    disabledReason="Assigning cards requires Moderator or Admin access"
                    className="w-full"
                  />
                </div>
                <div data-fact-section="due">
                  <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Due date</p>
                  {/* The native <input type="date"> always displays in the browser's locale
                      format (e.g. mm/dd/yyyy on en-US) regardless of user settings.
                      When a date is already set, overlay an invisible native input over a
                      styled display so the user always sees their chosen format. */}
                  {localCard.due_date ? (() => {
                    const info = formatDueDate(localCard.due_date, userTimezone, userDateFormat);
                    return (
                      <div className="flex items-center gap-1.5">
                        {/* The transparent input sits over the styled display and receives clicks
                            directly. On Chrome/Firefox the opacity-0 input is enough; on Safari,
                            opacity:0 inputs don't trigger the native calendar, so the container
                            onClick explicitly calls showPicker() / focus() as a fallback. */}
                        <div className="relative flex-1 cursor-pointer rounded-lg focus-within:ring-2 focus-within:ring-primary-emphasis">
                          <div className={`text-sm border rounded-lg px-2.5 py-1.5 w-full select-none flex items-center justify-between pointer-events-none ${info.overdue ? "bg-danger/10 border-danger/40 text-danger-on-tint" : "bg-surface-hover border-line-strong text-fg"}`}>
                            <span>{formatDateStr(localCard.due_date, userDateFormat)}</span>
                            <svg className="w-4 h-4 opacity-70 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="2.5" width="13" height="12" rx="1.5"/><path d="M5 1v3M11 1v3M1.5 6h13"/></svg>
                          </div>
                          <input
                            ref={dueDateRef}
                            type="date"
                            aria-label="Due date"
                            value={localCard.due_date}
                            onChange={(e) => {
                              const v = e.target.value || null;
                              setLocalCard((c) => ({ ...c, due_date: v }));
                              save({ due_date: v }).catch(() => {});
                            }}
                            onClick={() => openNativeDatePicker(dueDateRef.current)}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                          />
                        </div>
                        <button type="button"
                          onClick={() => { setLocalCard((c) => ({ ...c, due_date: null })); save({ due_date: null }).catch(() => {}); }}
                          className="text-fg-faint hover:text-danger transition text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
                          title="Clear due date"
                          aria-label="Clear due date"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })() : (
                    <div className="relative cursor-pointer rounded-lg focus-within:ring-2 focus-within:ring-primary-emphasis">
                      <div className="text-sm bg-surface-hover border border-line-strong rounded-lg px-2.5 py-1.5 text-fg-muted select-none flex items-center justify-between pointer-events-none">
                        <span>{userDateFormat.toLowerCase()}</span>
                        <svg className="w-4 h-4 opacity-50 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="2.5" width="13" height="12" rx="1.5"/><path d="M5 1v3M11 1v3M1.5 6h13"/></svg>
                      </div>
                      <input
                        ref={dueDateEmptyRef}
                        type="date"
                        aria-label="Due date"
                        value=""
                        min={new Date().toISOString().slice(0, 10)}
                        onChange={(e) => {
                          const v = e.target.value || null;
                          setLocalCard((c) => ({ ...c, due_date: v }));
                          save({ due_date: v }).catch(() => {});
                        }}
                        onClick={() => openNativeDatePicker(dueDateEmptyRef.current)}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Priority */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Priority</p>
                <div className="flex gap-1.5">
                  {PRIORITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => { setLocalCard((c) => ({ ...c, priority: opt.value })); save({ priority: opt.value }).catch(() => {}); }}
                      className={`text-xs px-3 py-1 rounded-full border font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                        localCard.priority === opt.value
                          ? "text-on-primary border-transparent shadow-sm"
                          : "text-fg-tertiary border-line-strong hover:border-line-emphasis bg-transparent"
                      }`}
                      style={localCard.priority === opt.value ? { backgroundColor: opt.color, borderColor: opt.color } : {}}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Labels */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Labels</p>
                <div className="flex flex-wrap gap-1.5">
                  {allLabels.map((label) => {
                    const active = localCard.labels.some((l) => l.id === label.id);
                    return (
                      <button
                        key={label.id}
                        onClick={() => toggleLabel(label)}
                        aria-pressed={active}
                        // Active is a check mark plus a heavier weight and inset ring, not
                        // a color change alone (#2094): the tint is the same either way.
                        className={`cf-choice-badge inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                          active ? "font-semibold shadow-[inset_0_0_0_1px_currentColor]" : ""
                        }`}
                        style={colorChipStyle(label.color)}
                      >
                        {/* Always rendered so the check reserves its space (weight can still widen the chip slightly); hidden when idle. */}
                        <span aria-hidden="true" className={active ? "" : "invisible"}>✓</span>
                        {label.name}
                      </button>
                    );
                  })}

                  {addingLabel ? (
                    <div className="flex flex-col gap-1 mt-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <input
                          autoFocus
                          value={newLabelName}
                          onChange={(e) => { setNewLabelName(e.target.value); setLabelError(null); }}
                          // void: handleCreateLabel already catches its own rejection and surfaces it via labelError.
                          onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e)) void handleCreateLabel(); }}
                          aria-label="New label name"
                          placeholder="Label name"
                          className="text-xs bg-sunken border border-info rounded-full px-2.5 py-1 outline-none w-28 text-fg"
                        />
                        <ColorSwatchPicker
                          colors={PALETTE_COLORS}
                          value={newLabelColor}
                          size="sm"
                          className="flex gap-2"
                          groupLabel="Label color"
                          allowCustom
                          applyLabel={newLabelName.trim() ? "Create label" : undefined}
                          // void: handleCreateLabel already catches its own rejection and surfaces it via labelError.
                          onChange={(c) => { setNewLabelColor(c); if (newLabelName.trim()) void handleCreateLabel(c); }}
                          getAriaLabel={(_c, name) => newLabelName.trim() ? `Create "${newLabelName.trim()}" with color ${name}` : `Select color ${name}`}
                        />
                        {!newLabelName.trim() && (
                          <span className="text-xs text-fg-muted">type a name first</span>
                        )}
                        <button
                          type="button"
                          aria-label="Cancel new label"
                          onClick={() => { focusNewLabelTriggerRef.current = true; setAddingLabel(false); setLabelError(null); }}
                          className="text-xs text-fg-muted hover:text-fg-secondary transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                        >✕</button>
                      </div>
                      <p role="status" aria-live="polite" aria-atomic="true" className="text-xs min-h-4 mt-0.5">
                        {labelError && <span className="text-danger">{labelError}</span>}
                      </p>
                    </div>
                  ) : canManageLabels ? (
                    <button
                      ref={newLabelTriggerRef}
                      onClick={() => setAddingLabel(true)}
                      className="text-xs text-fg-muted hover:text-fg-secondary border border-dashed border-line-strong hover:border-line-emphasis rounded-full px-2.5 py-1 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      + New label
                    </button>
                  ) : null}
                </div>
              </div>

              {/* Custom fields (#371) — the whole section, dividers included, is
                  omitted when the board has none defined. This is a context-gate,
                  not a permission-gate (frontend/CLAUDE.md's Conditional
                  admin-only elements rule covers both the same way): the feature
                  is valid for this user, just meaningless on a board with no
                  fields, so there's nothing to render rather than an empty
                  placeholder section. No `is_required` indicator anywhere here —
                  the field is API-exposed but server-unenforced in v1, so a
                  required-field asterisk would promise validation that doesn't
                  exist. */}
              {board.custom_field_definitions.length > 0 && (
                <>
                  <div className="border-t border-line" />
                  <div>
                    <button
                      className="flex items-center justify-between w-full mb-2 group/cf focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
                      onClick={() => setCustomFieldsOpen((o) => !o)}
                    >
                      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                        Custom fields
                        <span className="ml-1.5 normal-case font-normal text-fg-muted">({board.custom_field_definitions.length})</span>
                      </p>
                      <svg className={`w-3.5 h-3.5 text-fg-faint group-hover/cf:text-fg-tertiary transition-transform ${customFieldsOpen ? "" : "-rotate-90"}`} viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    </button>
                    {customFieldsOpen && (
                      <div className="flex flex-col gap-4">
                        {[...board.custom_field_definitions]
                          .sort((a, b) => a.position - b.position)
                          .map((definition) => {
                            const existing = localCard.custom_field_values.find((v) => v.field_definition === definition.id);
                            return (
                              <div key={definition.id} data-fact-section={`field:${definition.id}`}>
                                <CustomFieldEditRow
                                  definition={definition}
                                  value={existing?.value}
                                  disabled={!canEdit}
                                  userDateFormat={userDateFormat}
                                  onSave={(v) => save({
                                    custom_field_values: withCustomFieldValue(localCard.custom_field_values, definition.id, v),
                                  })}
                                />
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Weight */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Weight</p>
                <div className="flex items-center gap-2">
                  <button type="button"
                    onClick={() => {
                      const w = Math.max(1, localCard.weight - 1);
                      setLocalCard((c) => ({ ...c, weight: w }));
                      setWeightLimitReason(null);
                      if (weightSaveTimer.current) clearTimeout(weightSaveTimer.current);
                      weightSaveTimer.current = setTimeout(() => { weightSaveTimer.current = null; void weightRunSave(saveWeight(w)); }, 600);
                    }}
                    aria-label="Decrease weight"
                    className="w-7 h-7 rounded-full border border-line-strong text-fg-tertiary hover:bg-surface-hover transition text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >−</button>
                  <span className="text-sm font-semibold text-fg w-6 text-center">{localCard.weight}</span>
                  <button type="button"
                    onClick={() => {
                      const w = localCard.weight + 1;
                      setLocalCard((c) => ({ ...c, weight: w }));
                      setWeightLimitReason(null);
                      if (weightSaveTimer.current) clearTimeout(weightSaveTimer.current);
                      weightSaveTimer.current = setTimeout(() => { weightSaveTimer.current = null; void weightRunSave(saveWeight(w)); }, 600);
                    }}
                    aria-label="Increase weight"
                    className="w-7 h-7 rounded-full border border-line-strong text-fg-tertiary hover:bg-surface-hover transition text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >+</button>
                </div>
                <AutosaveIndicator
                  status={weightLimitRefused ? "idle" : weightStatus}
                  fadingOut={weightFadingOut}
                />
                <p className="text-xs min-h-4" role="status" aria-live="polite" aria-atomic="true">
                  <span className="text-danger">{weightLimitReason}</span>
                </p>
              </div>

              <div className="border-t border-line" />

              {/* Relations (#449) — the last thing that is *about* the card
                  rather than *inside* it, so it closes the classification arc
                  (priority/labels/custom fields/weight) before the contents arc
                  (checklist/attachments) opens. The section renders its own
                  trailing divider, and renders nothing at all for a reader with
                  no relations to read. */}
              <CardRelationsSection
                board={board}
                card={localCard}
                canEdit={canEdit}
                demoMode={demoMode}
                // Panel-local only — deliberately does NOT push up to
                // `onUpdated`. The board store is updated by the authoritative
                // `card.updated` frame the server broadcasts for both ends of
                // the relation. Pushing `localCard` instead would write a stale
                // card: only its version and location are re-synced after
                // mount (#1773), so any other field changed by someone else
                // while the panel was open (a retitle, say) would be silently
                // reverted by adding a relation. The count is taken from the updater's argument
                // rather than the render closure so two rapid clicks cannot
                // both read the same pre-click value.
                onBlockerCountChange={(delta) =>
                  setLocalCard((c) => ({
                    ...c,
                    blocker_count: Math.max(0, c.blocker_count + delta),
                  }))
                }
                refreshSignal={refreshSignal}
              />

              {/* MR/PR link (#352) — right after relations: both are "what this
                  card connects to". Renders its own trailing divider, and
                  nothing at all for a read-only reader when no link is set.
                  `save` rolls back and rethrows, so the section can show the
                  server's validation error inline. */}
              <CardExternalRefSection
                externalRef={localCard.external_ref}
                canEdit={canEdit}
                demoReason={demoMode ? DEMO_EXTERNAL_REF_REASON : undefined}
                onSave={(next) => save({ external_ref: next })}
              />

              {/* Checklist */}
              <div>
                <button type="button"
                  className="flex items-center justify-between w-full mb-2 group/cl rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  onClick={() => setChecklistOpen((o) => !o)}
                >
                  <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                    Checklist
                    {checklist.length > 0 && (
                      <span className="ml-1.5 normal-case font-normal text-fg-muted">{checklist.filter((i) => i.is_checked).length}/{checklist.length}</span>
                    )}
                  </p>
                  <svg className={`w-3.5 h-3.5 text-fg-faint group-hover/cl:text-fg-tertiary transition-transform ${checklistOpen ? "" : "-rotate-90"}`} viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
                {pendingSections.checklist && <SectionSkeleton rows={2} testId="checklist-skeleton" />}
                {checklistOpen && checklist.length > 0 && ( // items and progress only when expanded
                  <>
                    <div className="h-1 bg-surface-hover rounded-full mb-3 overflow-hidden">
                      <div
                        className="h-full bg-success-emphasis rounded-full transition-all"
                        style={{ width: `${Math.round((checklist.filter((i) => i.is_checked).length / checklist.length) * 100)}%` }}
                      />
                    </div>
                    <div className="flex flex-col gap-1 mb-3">
                      {checklist.map((item) => (
                        <div key={item.id} className="flex items-center gap-2 group px-1 py-0.5 rounded hover:bg-surface-hover">
                          <input
                            type="checkbox"
                            checked={item.is_checked}
                            onChange={canComment && canModifyChecklistItem(item) ? () => handleToggleChecklistItem(item) : undefined}
                            disabled={!canComment || !canModifyChecklistItem(item)}
                            title={
                              !canComment
                                ? "Viewers cannot modify checklist items"
                                : !canModifyChecklistItem(item)
                                  ? "Only the creator or a moderator can modify this item"
                                  : undefined
                            }
                            // A disabled input is not focusable, so the title never
                            // reaches keyboard or screen-reader users; fold the
                            // reason into the accessible name (sub-pattern B).
                            aria-label={
                              canComment && !canModifyChecklistItem(item)
                                ? `${item.text}. Only the creator or a moderator can modify this item`
                                : undefined
                            }
                            className={`w-3.5 h-3.5 rounded accent-primary shrink-0 ${canComment && canModifyChecklistItem(item) ? "cursor-pointer" : "cursor-default"}`}
                          />
                          <span className={`text-sm flex-1 ${item.is_checked ? "line-through text-fg-faint" : "text-fg-secondary"}`}>
                            {item.text}
                          </span>
                          {(canEdit || role === "collaborator") && canModifyChecklistItem(item) && (
                            <button type="button"
                              onClick={() => handleDeleteChecklistItem(item.id)}
                              className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-fg-faint hover:text-danger transition text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
                              title="Remove item"
                              aria-label="Remove item"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {canComment && (
                  <div className="flex gap-2">
                    <input
                      value={newItemText}
                      onChange={(e) => setNewItemText(e.target.value)}
                      // void: handleAddChecklistItem now catches its own rejection and surfaces it via checklistError.
                      onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e)) void handleAddChecklistItem(); }}
                      placeholder="Add item (Enter)…"
                      className="flex-1 text-sm bg-surface border border-line rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent text-fg-secondary placeholder-fg-muted"
                    />
                    <button
                      onClick={() => { setBulkText(""); setChecklistError(null); setShowBulkAdd(true); }}
                      className="text-sm text-info hover:text-info font-medium px-2 whitespace-nowrap transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
                    >
                      Bulk
                    </button>
                  </div>
                )}
                {canComment && !showBulkAdd && (
                  <p role="status" aria-live="polite" aria-atomic="true" className="text-xs h-4 mt-1">
                    {checklistError && <span className="text-danger">{checklistError}</span>}
                  </p>
                )}

                {showBulkAdd && (
                  <div className="fixed inset-0 z-[60] flex items-center justify-center">
                    <div className="absolute inset-0 bg-backdrop/40" aria-hidden="true" onClick={() => { setShowBulkAdd(false); setChecklistError(null); }} />
                    <div
                      ref={bulkAddRef}
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="bulk-add-title"
                      tabIndex={-1}
                      className="relative bg-surface border border-line rounded-lg shadow-xl w-80 p-5 flex flex-col gap-4 outline-none"
                    >
                      <h3 id="bulk-add-title" className="text-sm font-semibold text-fg">Add checklist items</h3>
                      <p className="text-xs text-fg-muted -mt-2">One item per line</p>
                      <textarea
                        autoFocus
                        value={bulkText}
                        onChange={(e) => setBulkText(e.target.value)}
                        // void: handleBulkAdd now catches its own rejection and surfaces it via checklistError.
                        // Escape is handled by the useEscapeStack registration (priority 37), not here (#1891).
                        onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e) && (e.metaKey || e.ctrlKey)) void handleBulkAdd(); }}
                        placeholder={"Buy milk\nCall client\nReview PR"}
                        rows={6}
                        className="w-full text-sm bg-surface border border-line rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent resize-none text-fg-secondary placeholder-fg-muted"
                      />
                      {checklistError && (
                        <p role="alert" className="text-xs text-danger -mt-2">{checklistError}</p>
                      )}
                      <div className="flex justify-end gap-3">
                        <button onClick={() => { setShowBulkAdd(false); setChecklistError(null); }} className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded">Cancel</button>
                        <button onClick={() => void handleBulkAdd()} className="text-sm bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover transition font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Add items</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-line" />

              {/* Attachments */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <button type="button"
                    className="flex items-center gap-1.5 group/att rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    onClick={() => setAttachmentsOpen((o) => !o)}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                      Attachments{attachmentsLoaded && <span className="ml-1.5 normal-case font-normal text-fg-muted" data-testid="card-section-count-attachments">{attachments.length}</span>}
                    </p>
                    <svg className={`w-3.5 h-3.5 text-fg-faint group-hover/att:text-fg-tertiary transition-transform ${attachmentsOpen ? "" : "-rotate-90"}`} viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                  {attachmentsOpen && canComment && (
                    <>
                      {uploadsBlockedReason ? (
                        // A real, focusable button (not the old title-only span)
                        // so keyboard and screen-reader users reach the reason.
                        <button
                          type="button"
                          aria-disabled="true"
                          aria-describedby="card-upload-blocked-reason"
                          onClick={(e) => e.preventDefault()}
                          className="text-xs text-fg-faint font-medium cursor-not-allowed rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                        >
                          + Upload
                        </button>
                      ) : (
                        <>
                          <button type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                            className="text-xs text-info hover:text-info font-medium disabled:opacity-40 transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                          >
                            {uploading ? "Uploading…" : "+ Upload"}
                          </button>
                          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />
                        </>
                      )}
                    </>
                  )}
                </div>
                {attachmentsOpen && canComment && uploadsBlockedReason && (
                  <p id="card-upload-blocked-reason" className="text-xs text-fg-muted mb-2">
                    {uploadsBlockedReason}
                  </p>
                )}
                {attachmentsOpen && (pendingSections.attachments ? (
                  <SectionSkeleton rows={1} testId="attachments-skeleton" />
                ) : attachments.length === 0 ? (
                  <p className="text-xs text-fg-faint italic">No attachments.</p>
                ) : (<>
                  <div className="flex flex-col gap-1.5">
                    {attachments.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 bg-surface-hover rounded-lg px-3 py-2 group">
                        <span className="text-fg-muted text-sm shrink-0">📎</span>
                        <div className="flex-1 min-w-0">
                          {/* The download attribute tells the browser to always save the file
                              rather than attempting to render it inline. This is defense-in-depth
                              alongside the server-side Content-Disposition: attachment header. */}
                          <a href={a.url} download={a.filename} target="_blank" rel="noreferrer" className="text-sm text-info hover:underline truncate block">
                            {a.filename}
                          </a>
                          <p className="text-xs text-fg-muted">{(a.size / 1024).toFixed(1)} KB · {formatDateStr(a.uploaded_at.slice(0, 10), userDateFormat)}</p>
                        </div>
                        {canDeleteAttachment(a) && (
                          // #1193: attachment DELETE is not on DEMO_ALLOWED_WRITES,
                          // so this refusal is up-front and aria-disabled, matching
                          // the upload button above, rather than falling through to
                          // DemoWriteBlockedToast. Sub-pattern (B) — the row has no
                          // room for a visible reason line — so the reason folds
                          // into title/aria-label instead of an aria-describedby.
                          demoMode ? (
                            <button
                              type="button"
                              aria-disabled="true"
                              onClick={(e) => e.preventDefault()}
                              title={`Delete. ${DEMO_DELETE_ATTACHMENT_REASON}`}
                              aria-label={`Delete attachment ${a.filename}. ${DEMO_DELETE_ATTACHMENT_REASON}`}
                              className="opacity-40 cursor-not-allowed text-fg-faint transition text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
                            >✕</button>
                          ) : (
                            <button type="button"
                              onClick={() => handleDeleteAttachment(a.id)}
                              className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-fg-faint hover:text-danger transition text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
                              title="Delete"
                              aria-label={`Delete attachment ${a.filename}`}
                            >✕</button>
                          )
                        )}
                      </div>
                    ))}
                  </div>
                  <p role="status" aria-live="polite" aria-atomic="true" className="text-xs h-4">{attachError && <span className="text-danger">{attachError}</span>}</p>
                </>))}
              </div>

              {/* Last activity (#967): one line, newest entry of any type. */}
              {lastHistoryEntry && (
                <button
                  type="button"
                  onClick={goToLatestHistory}
                  data-testid="card-last-activity"
                  className="self-start max-w-full py-1 text-left text-xs text-fg-tertiary hover:text-fg underline decoration-dotted underline-offset-2 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  Last activity: {lastActivitySummary(lastHistoryEntry, userDateFormat)} ·{" "}
                  <time dateTime={lastHistoryEntry.ts} title={formatDateTimeUser(lastHistoryEntry.ts, currentUser)}>
                    {formatRelativeTime(lastHistoryEntry.ts)}
                  </time>
                  <span className="sr-only">. Go to History</span>
                </button>
              )}

            </div>
          ) : tab === "comments" ? (
            <div>
                {pendingSections.comments && <SectionSkeleton rows={2} testId="comments-skeleton" />}
                {!pendingSections.comments && comments.length === 0 && (
                  <p className="text-sm text-fg-tertiary mb-3">No comments yet</p>
                )}
                <div className="flex flex-col gap-3 mb-3">
                  {comments.map((c) => {
                    const authorName = c.author ? userDisplayName(c.author) : "Unknown";
                    // An imported comment (#1702) is the importer's; the source's
                    // author name is metadata text, never a user (frontend/CLAUDE.md).
                    const imported = importedNote(c.imported_from_username);
                    return (
                      <div key={c.id} className="flex gap-2.5 group">
                        <Avatar user={c.author} size="sm" className="mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-semibold text-fg-secondary min-w-0 truncate" title={authorName}>{authorName}</span>
                            <span className="text-xs text-fg-muted shrink-0 whitespace-nowrap" title={formatDateTimeUser(c.created_at, currentUser)}>{formatCommentTime(c.created_at, currentUser)}</span>
                            {imported && (
                              <span className="text-xs text-fg-muted min-w-0 truncate" title={imported}>{imported}</span>
                            )}
                            {canDeleteComment(c) && (
                              // #1193: comment DELETE is not on DEMO_ALLOWED_WRITES.
                              // Refuse up front with the fixed lead, never open the
                              // Confirm/Cancel prompt for a delete that cannot succeed —
                              // sub-pattern (B), same as the attachment delete above.
                              demoMode ? (
                                <button
                                  type="button"
                                  aria-disabled="true"
                                  onClick={(e) => e.preventDefault()}
                                  title={`Delete comment. ${DEMO_DELETE_COMMENT_REASON}`}
                                  aria-label={`Delete comment. ${DEMO_DELETE_COMMENT_REASON}`}
                                  className="ml-auto opacity-40 cursor-not-allowed p-0.5 rounded text-fg-muted focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                                    <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                                  </svg>
                                </button>
                              ) : confirmDeleteCommentId === c.id ? (
                                <div role="status" aria-live="polite" aria-atomic="true" className="ml-auto flex flex-col items-end text-xs">
                                  <div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
                                  <span className="text-fg-tertiary">Delete this comment?</span>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteComment(c.id)}
                                    disabled={deletingCommentId !== null}
                                    className="text-danger hover:text-danger font-medium transition disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                                  >
                                    Confirm
                                  </button>
                                  <button
                                    type="button"
                                    onClick={cancelCommentDelete}
                                    disabled={deletingCommentId !== null}
                                    className="text-fg-tertiary hover:text-fg transition disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                                  >
                                    Cancel
                                  </button>
                                  </div>
                                  {commentDeleteError && <p className="text-xs text-danger mt-1">{commentDeleteError}</p>}
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  ref={deleteCommentTriggerRef(c.id)}
                                  title="Delete comment"
                                  onClick={() => { setCommentDeleteError(null); setConfirmDeleteCommentId(c.id); }}
                                  className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity duration-150 p-0.5 rounded text-fg-muted hover:text-danger hover:bg-surface-active focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                                  aria-label="Delete comment"
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                                    <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                                  </svg>
                                </button>
                              )
                            )}
                          </div>
                          <div className="bg-surface-hover rounded-lg px-3 py-2 text-sm text-fg-secondary leading-relaxed">
                            {c.body.split(/(@[\w.+-]+)/g).map((part, i) => // nosemgrep: nodejs_scan.javascript-dos-rule-regex_dos
                              /^@[\w.+-]+$/.test(part) // nosemgrep: nodejs_scan.javascript-dos-rule-regex_dos
                                ? <span key={i} className="font-semibold text-info">{part}</span>
                                : part
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {canComment && (
                  // Pinned to the bottom of the Comments tab (#967 design § 1.4),
                  // so a note can be written without scrolling the thread.
                  <div className="sticky -bottom-4 -mb-4 pb-4 max-[640px]:pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2 bg-surface border-t border-line flex flex-col gap-2">
                    <MentionTextarea
                      value={commentBody}
                      onChange={setCommentBody}
                      onSubmit={handleComment}
                      members={board.members}
                      placeholder="Add a comment… (Enter to submit, @ to mention)"
                      ariaLabel="Add a comment"
                      rows={2}
                      className="w-full text-sm bg-surface border border-line rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent resize-none text-fg-secondary placeholder-fg-muted"
                    />
                    {demoMode && (
                      <p id="card-comment-demo-reason" className="text-xs text-fg-muted">
                        {DEMO_COMMENT_REASON}
                      </p>
                    )}
                    <p role="status" aria-live="polite" aria-atomic="true" className="text-xs min-h-4">
                      {commentError && <span className="text-danger">{commentError}</span>}
                    </p>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleComment}
                        aria-disabled={demoMode ? true : undefined}
                        aria-describedby={demoMode ? "card-comment-demo-reason" : undefined}
                        className={`text-sm bg-button-primary text-on-primary px-4 py-1.5 rounded transition font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                          demoMode ? "opacity-40 cursor-not-allowed" : "hover:bg-button-primary-hover"
                        }`}
                      >
                        Comment
                      </button>
                    </div>
                  </div>
                )}
              </div>
          ) : (
            <ActivityTabPanel
              boardId={board.id}
              cardId={card.id}
              userDateFormat={userDateFormat}
              user={currentUser}
              initialPage={historyPage}
              refreshSignal={refreshSignal}
              onFirstPage={(page) => { if (page.counts) setHistoryCounts(page.counts); }}
              focusFirstEntry={focusFirstHistoryEntry}
              onFirstEntryFocused={clearHistoryFocusRequest}
            />
          )}
          </div>
          {/* Scroll shadows (frame 5): the header and footer stay put while
              the body scrolls; each fade shows only while there is more
              content on its side. */}
          {bodyShadows.above && (
            <div className="absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-surface to-transparent pointer-events-none" aria-hidden="true" data-testid="card-body-shadow-top" />
          )}
          {/* Not on Comments: the pinned composer sits at the bottom edge and the fade would cover it. */}
          {bodyShadows.below && !(tab === "comments" && canComment) && (
            <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-surface to-transparent pointer-events-none" aria-hidden="true" data-testid="card-body-shadow-bottom" />
          )}
        </div>

        {/* Footer */}
        {demoMode ? (
          // Shared demo (frame 7): no destructive or removing action here.
          <div className="px-5 py-3 border-t border-line">
            <p className="text-xs text-fg-muted" data-testid="card-demo-footer">{DEMO_CARD_FOOTER_NOTE}</p>
          </div>
        ) : (canArchive || canDelete) && (
          <div className="px-5 py-3 border-t border-line flex items-center justify-between">
            {canArchive ? (
              <button
                onClick={handleArchive}
                aria-disabled={loading || undefined}
                title={loading ? "Available once the card has loaded" : undefined}
                className={`text-xs text-fg-muted transition focus:outline-none focus:ring-2 focus:ring-warning-emphasis rounded ${loading ? "opacity-40 cursor-not-allowed" : "hover:text-warning"}`}
              >
                Archive card
              </button>
            ) : <span />}
            {canDelete && (
              <button
                onClick={handleDelete}
                className="text-xs text-fg-faint hover:text-danger transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
              >
                Delete card
              </button>
            )}
          </div>
        )}

        {/* Move popover — position:fixed so the body's overflow-hidden scroll region doesn't clip it; inside panelRef so the focus trap includes it (#1732) */}
        {showMovePopover && movePopoverAnchor && (
          <div
            ref={movePopoverRef}
            // Owns the inline role="alert" for a refused move, so the shared
            // toast mirrors it silently (MoveBlockedToast, frontend/CLAUDE.md § Toasts).
            data-move-popover=""
            className="fixed w-64 bg-surface border border-line rounded-lg shadow-xl p-4 z-[60] flex flex-col gap-3"
            style={{ top: movePopoverAnchor.top, left: movePopoverAnchor.left }}
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-tertiary">Move to</p>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-fg-muted">Swimlane</label>
              <SelectDropdown
                options={board.swimlanes.map((s) => ({ value: String(s.id), label: s.name }))}
                value={moveTargetSwimlane !== null ? String(moveTargetSwimlane) : ""}
                onChange={(v) => { setMoveTargetSwimlane(Number(v)); clearMoveFailure(); }}
                disabled={moveForcing}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-fg-muted">Column</label>
              <SelectDropdown
                options={board.columns.map((c) => ({ value: String(c.id), label: c.name }))}
                value={moveTargetColumn !== null ? String(moveTargetColumn) : ""}
                onChange={(v) => { setMoveTargetColumn(Number(v)); clearMoveFailure(); }}
                disabled={moveForcing}
              />
            </div>
            <div className="flex flex-col items-start gap-1">
              <p id={moveErrorId} role="alert" className="text-xs min-h-4 self-stretch">
                {movePopoverError && <span className="text-danger">{movePopoverError}</span>}
                {movePopoverError && moveRefusal && (
                  <span className="block mt-0.5 text-fg-tertiary">{limitCounts(moveRefusal)}</span>
                )}
              </p>
              {/* Outside the live region: the link is an action, not part of the announcement (#1772). */}
              {canForceMove && (
                <button
                  type="button"
                  onClick={handleForceMove}
                  aria-disabled={moveForcing}
                  aria-describedby={moveErrorId}
                  className="text-xs text-warning hover:text-warning underline transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
                >{moveForcing ? "Moving anyway…" : "Move anyway (admin override)"}</button>
              )}
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowMovePopover(false)}
                disabled={moveForcing}
                className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded disabled:opacity-40"
              >Cancel</button>
              <button
                ref={moveSubmitRef}
                onClick={handleMoveSubmit}
                disabled={moveForcing || moveSubmitting || moveTargetColumn === null || moveTargetSwimlane === null || (moveTargetColumn === localCard.column && moveTargetSwimlane === localCard.swimlane)}
                className="text-sm font-medium bg-button-primary hover:bg-button-primary-hover text-on-primary px-3 py-1.5 rounded transition disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >{moveSubmitting ? "Moving…" : "Move"}</button>
            </div>
          </div>
        )}
        </div>
      </div>

      {/* Delete / Archive confirmation overlay */}
      <ModalWrapper
        open={confirmAction !== null}
        onClose={closeCardAction}
        title={confirmAction === "delete" ? "Delete this card?" : "Archive this card?"}
        maxWidth="max-w-sm"
      >
        {confirmAction === "delete" ? (
          <>
            <p className="text-fg-tertiary text-sm mb-5">This cannot be undone.</p>
            <div role="status" aria-live="polite" aria-atomic="true">
              {cardActionError && <p className="text-xs text-danger mb-3">{cardActionError}</p>}
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={closeCardAction} disabled={cardActionBusy} className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded disabled:opacity-40">Cancel</button>
              <button onClick={executeDelete} aria-disabled={cardActionBusy} className="aria-disabled:opacity-40 aria-disabled:cursor-not-allowed bg-danger-bg hover:bg-danger-bg-hover text-on-danger text-sm px-4 py-1.5 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis">{cardActionBusy ? "Deleting…" : "Delete"}</button>
            </div>
          </>
        ) : confirmAction === "archive" ? (
          <>
            <p className="text-fg-tertiary text-sm mb-5">It will be hidden from the board but can be unarchived from the Archived panel.</p>
            <div role="status" aria-live="polite" aria-atomic="true">
              {cardActionError && <p className="text-xs text-danger mb-3">{cardActionError}</p>}
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={closeCardAction} disabled={cardActionBusy} className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded disabled:opacity-40">Cancel</button>
              <button onClick={executeArchive} aria-disabled={cardActionBusy} className="aria-disabled:opacity-40 aria-disabled:cursor-not-allowed bg-warning-bg hover:bg-warning-bg-hover text-fg text-sm px-4 py-1.5 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-warning-emphasis">{cardActionBusy ? "Archiving…" : "Archive"}</button>
            </div>
          </>
        ) : null}
      </ModalWrapper>
    </div>
  );
}
