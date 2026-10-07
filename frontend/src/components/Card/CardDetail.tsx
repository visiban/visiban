import { useEffect, useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
import { useMoveToSeenPref } from "../../hooks/useMoveToSeenPref";
import { useAutosaveStatus } from "../../hooks/useAutosaveStatus";
import AutosaveIndicator from "../Common/AutosaveIndicator";
import { limitBlockedMessage } from "../Board/moveBlockedMessages";
import type { BoardFull, Card, CardAttachment, CardChecklistItem, CardComment, Label, Priority, User } from "../../types";
import { userDisplayName } from "../../types";
import SelectDropdown from "../Common/SelectDropdown";
import { deleteCard, archiveCard, getCardComments, addCardComment, deleteComment, updateCard, getCardAttachments, uploadCardAttachment, deleteCardAttachment, getChecklist, addChecklistItem, updateChecklistItem, deleteChecklistItem } from "../../api/cards";
import type { CardPatch } from "../../api/cards";
import { createLabel } from "../../api/boards";
import { PALETTE_COLORS, PRIORITY_COLORS } from "../../constants/colors";
import ActivityTabPanel from "./ActivityTabPanel";
import { formatDateStr, formatDueDate, formatDateTimeUser } from "../../utils/date";
import type { UserDatePrefs } from "../../utils/date";
import MentionTextarea from "./MentionTextarea";
import RichTextEditor from "./RichTextEditor";
import Avatar from "../Common/Avatar";
import ModalWrapper from "../shared/ModalWrapper";
import CustomFieldEditRow from "./CustomFieldEditRow";
import CardRelationsSection from "./CardRelationsSection";
import CardExternalRefSection from "./CardExternalRefSection";
import { withCustomFieldValue } from "../../utils/customFieldValue";
import { DEMO_COMMENT_REASON, DEMO_UPLOAD_REASON, DEMO_DELETE_COMMENT_REASON, DEMO_DELETE_ATTACHMENT_REASON } from "../../constants/demoCopy";

interface Props {
  card: Card;
  board: BoardFull;
  onClose: () => void;
  onDeleted: (id: number) => void;
  onUpdated: (card: Card) => void;
  onArchived: (cardId: number) => void;
  onMoveCard?: (cardId: number, columnId: number, swimlaneId: number, position: number) => Promise<void>;
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

export default function CardDetail({ card, board, onClose, onDeleted, onUpdated, onArchived, onMoveCard, userDateFormat = "MM/DD/YYYY", userTimeFormat: _userTimeFormat = "12h", userTimezone = "", currentUser = null, closeEditorOnEnter = false, refreshSignal = 0 }: Props) {
  const [localCard, setLocalCard] = useState<Card>(card);
  const [comments, setComments] = useState<CardComment[]>([]);
  const [confirmDeleteCommentId, setConfirmDeleteCommentId] = useState<number | null>(null);
  const deleteCommentTriggerRef = useConfirmFocusReturn(confirmDeleteCommentId);
  // In-flight + error state for the inline comment-delete confirm (#1421).
  const [deletingCommentId, setDeletingCommentId] = useState<number | null>(null);
  const [commentDeleteError, setCommentDeleteError] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [tab, setTab] = useState<"details" | "activity">("details");
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dueDateRef = useRef<HTMLInputElement>(null);
  const dueDateEmptyRef = useRef<HTMLInputElement>(null);
  const [checklist, setChecklist] = useState<CardChecklistItem[]>([]);
  const [newItemText, setNewItemText] = useState("");
  const [showBulkAdd, setShowBulkAdd] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [checklistOpen, setChecklistOpen] = useState(true);
  const [attachmentsOpen, setAttachmentsOpen] = useState(true);
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

  // Focus the panel on open so screen readers announce it as a dialog.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
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
  const [showMovePopover, setShowMovePopover] = useState(false);
  const [movePopoverAnchor, setMovePopoverAnchor] = useState<{ top: number; left: number } | null>(null);
  const [moveTargetColumn, setMoveTargetColumn] = useState<number | null>(null);
  const [moveTargetSwimlane, setMoveTargetSwimlane] = useState<number | null>(null);
  const [moveSubmitting, setMoveSubmitting] = useState(false);
  const [movePopoverError, setMovePopoverError] = useState<string | null>(null);
  const [moveToSeen, setMoveToSeen] = useMoveToSeenPref();

  useEffect(() => {
    // Each fetch keeps its own .catch() rather than a single Promise.all/try-
    // catch wrapper, so a slow section's failure doesn't block the other two
    // from populating as soon as they resolve (unchanged success-path timing).
    getCardComments(board.id, card.id).then(setComments).catch(() => setLoadError(true));
    getCardAttachments(board.id, card.id).then((data) => {
      setAttachments(data);
      setAttachmentsOpen(data.length > 0);
    }).catch(() => setLoadError(true));
    getChecklist(board.id, card.id).then((data) => {
      setChecklist(data);
      setChecklistOpen(data.length > 0);
    }).catch(() => setLoadError(true));
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
    getCardAttachments(board.id, card.id).then(setAttachments).catch(() => setLoadError(true));
    getChecklist(board.id, card.id).then(setChecklist).catch(() => setLoadError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-fetches only in response to refreshSignal; board.id/card.id are stable for this instance's lifetime (BoardView remounts CardDetail via `key={selectedCard.id}` on card change)
  }, [refreshSignal]);

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
  // Close move popover before panel — priority 36 sits above confirmAction (35) so
  // it fires first when both are open, and above panel close (30) in the normal case.
  useEscapeStack(() => {
    if (!showMovePopover) return false;
    setShowMovePopover(false);
  }, 36);
  // Bulk-add overlay is a modal over the panel: Escape closes it first (priority 37, above
  // the move popover) instead of closing the whole card panel (#1376).
  useEscapeStack(() => {
    if (!showBulkAdd) return false;
    setShowBulkAdd(false);
    setChecklistError(null);
  }, 37);
  useEscapeStack(onClose, 30);

  const save = async (patch: CardPatch) => {
    // Snapshot pre-save state so we can roll back if the API call fails.
    const prev = localCard;
    try {
      const updated = await updateCard(board.id, localCard.id, patch);
      setLocalCard(updated);
      onUpdated(updated);
    } catch (err) {
      setLocalCard(prev);
      throw err;
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

  const handleMoveSubmit = async () => {
    if (!onMoveCard || moveTargetColumn === null || moveTargetSwimlane === null) return;
    // No-op if the card is already in this location.
    if (moveTargetColumn === localCard.column && moveTargetSwimlane === localCard.swimlane) {
      setShowMovePopover(false);
      return;
    }
    setMoveSubmitting(true);
    setMovePopoverError(null);
    try {
      // position 9999 appends the card to the end of the target cell.
      await onMoveCard(localCard.id, moveTargetColumn, moveTargetSwimlane, 9999);
      setLocalCard((c) => ({ ...c, column: moveTargetColumn, swimlane: moveTargetSwimlane }));
      setShowMovePopover(false);
    } catch {
      setMovePopoverError("Move blocked — check WIP or weight limits.");
    } finally {
      setMoveSubmitting(false);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur(); // blur triggers save
      if (closeEditorOnEnter) onClose();
    } else if (e.key === "Escape") {
      setLocalCard((c) => ({ ...c, title: card.title }));
      (e.target as HTMLInputElement).blur();
    }
  };

  const handleTitleBlur = async () => {
    const trimmed = localCard.title.trim();
    if (!trimmed) {
      // Restore if user cleared the title entirely
      setLocalCard((c) => ({ ...c, title: card.title }));
    } else if (trimmed !== card.title) {
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
    try {
      const updated = await updateCard(board.id, localCard.id, { label_ids: newLabels.map((l) => l.id) });
      setLocalCard(updated);
      onUpdated(updated);
    } catch {
      setLocalCard(prev);
    }
  };

  const handleCreateLabel = async (colorOverride?: string) => {
    if (!newLabelName.trim()) return;
    setLabelError(null);
    const color = colorOverride ?? newLabelColor;
    try {
      const label = await createLabel(board.id, { name: newLabelName.trim(), color });
      // Do not call onLabelAdded here — the WebSocket label.created broadcast is
      // the source of truth for board.labels and will add it once. Calling it here
      // too produces a duplicate label in the board's label list.
      const updatedLabelIds = [...localCard.labels.map((l) => l.id), label.id];
      const updated = await updateCard(board.id, localCard.id, { label_ids: updatedLabelIds });
      setLocalCard(updated);
      onUpdated(updated);
      setNewLabelName("");
      setAddingLabel(false);
    } catch {
      setLabelError("Failed to create label. Only board admins can create labels.");
    }
  };

  const handleComment = async () => {
    // Demo (#1179): never attempted, so the typed text is simply kept.
    if (demoMode) return;
    if (!commentBody.trim()) return;
    const c = await addCardComment(board.id, card.id, commentBody.trim());
    setComments((prev) => [...prev, c]);
    setCommentBody("");
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const attachment = await uploadCardAttachment(board.id, localCard.id, file);
      setAttachments((prev) => [attachment, ...prev]);
      setLocalCard((c) => ({ ...c, attachment_count: c.attachment_count + 1 }));
      onUpdated({ ...localCard, attachment_count: localCard.attachment_count + 1 });
    } finally {
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
      onUpdated({ ...localCard, attachment_count: Math.max(0, localCard.attachment_count - 1) });
    } catch {
      setAttachError("Could not delete attachment.");
    } finally {
      attachDeleteInFlight.current = false;
    }
  };

  const handleAddChecklistItem = async () => {
    if (!newItemText.trim()) return;
    setChecklistError(null);
    try {
      // Previously unhandled (#1375): a rejected add left the typed text in
      // place with the input otherwise unresponsive — nothing told the user
      // it had failed, so the keystroke looked lost.
      const item = await addChecklistItem(board.id, card.id, newItemText.trim());
      setChecklist((prev) => [...prev, item]);
      setNewItemText("");
      onUpdated({ ...localCard, checklist_total: localCard.checklist_total + 1 });
    } catch {
      setChecklistError("Could not add item.");
    }
  };

  const handleBulkAdd = async () => {
    const items = bulkText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
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
      if (added.length > 0) {
        setChecklist((prev) => [...prev, ...added]);
        onUpdated({ ...localCard, checklist_total: localCard.checklist_total + added.length });
      }
    }
  };

  const handleToggleChecklistItem = async (item: CardChecklistItem) => {
    const updated = await updateChecklistItem(board.id, card.id, item.id, { is_checked: !item.is_checked });
    // Derive the new list from the current closure snapshot of `checklist` rather
    // than using a stale ±1 delta against localCard.checklist_done. Delta math
    // accumulates errors when two items are toggled before a re-render occurs.
    const newChecklist = checklist.map((i) => (i.id === item.id ? updated : i));
    setChecklist(newChecklist);
    const done = newChecklist.filter((i) => i.is_checked).length;
    onUpdated({ ...localCard, checklist_done: done, checklist_total: newChecklist.length });
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
      onUpdated({ ...localCard, checklist_total: newChecklist.length, checklist_done: done });
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
  const handleArchive = () => openCardAction("archive");

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
  const canManageLabels = role === "site_admin" || role === "admin";
  const canComment = canEdit || role === "collaborator";
  // Hosted demo (#1179): the server fence refuses comments and uploads, so
  // those controls are aria-disabled up front with the reason — never native
  // `disabled`, which would drop them from the tab order and hide the reason
  // from keyboard users. Copy uses the fixed demo lead (frontend/CLAUDE.md).
  const demoMode = currentUser?.demo_mode === true;
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
  // ONLY for writes the demo fence allows.
  const canModifyOthersContentInDemo =
    (demoMode && role === "member") || canModifyOthersContent;
  const canArchive = canEdit && (isCardOwner || canModifyOthersContentInDemo);
  const canAssign = canEdit && (isCardOwner || canModifyOthersContentInDemo);
  // Delete is NOT widened, and is hidden outright in demo mode: card DELETE is
  // not on DEMO_ALLOWED_WRITES, so the fence refuses it even for the visitor's
  // own cards — showing it would only produce a refusal.
  const canDelete = !demoMode && canEdit && (isCardOwner || canModifyOthersContent);

  const canDeleteComment = (c: CardComment): boolean =>
    (c.author !== null && currentUser !== null && c.author.id === currentUser.id) ||
    canModifyOthersContent;

  const canDeleteAttachment = (a: CardAttachment): boolean =>
    (a.uploaded_by !== null && currentUser !== null && a.uploaded_by.id === currentUser.id) ||
    canModifyOthersContent;

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
      setCommentDeleteError("Could not delete comment.");
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

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-backdrop/40" aria-hidden="true" onClick={onClose} />

      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="card-detail-title" tabIndex={-1} className="w-full sm:w-[540px] bg-surface shadow-2xl flex flex-col overflow-hidden outline-none">
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-line">
          <div className="flex-1 min-w-0">
            <input
              id="card-detail-title"
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
              <span className="text-xs text-fg-faint mx-1 shrink-0">›</span>
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
                    onClick={() => {
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
                      setShowMovePopover((v) => !v);
                    }}
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
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-fg-tertiary hover:text-fg hover:bg-surface-hover transition text-lg leading-none shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            title="Close"
            aria-label="Close"
          >×</button>
        </div>

        {/* Tabs */}
        <div role="tablist" className="flex border-b border-line text-sm">
          {(["details", "activity"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`px-5 py-2.5 font-medium capitalize transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded ${
                tab === t ? "border-b-2 border-info text-info" : "text-fg-muted hover:text-fg-secondary"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {loadError && (
          <p role="alert" className="px-5 pt-2 text-xs text-danger">
            Some card details failed to load — try reopening the card.
          </p>
        )}

        <div className="relative flex-1 overflow-hidden">
          <div className="h-full overflow-y-auto px-5 py-4">
          {tab === "details" ? (
            <div className="flex flex-col gap-6">

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

              <div className="border-t border-line" />

              {/* Assignee + Due date */}
              <div className="grid grid-cols-2 gap-4">
                <div>
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
                        .filter((m) => m.role !== "viewer")
                        .map((m) => ({
                          value: String(m.user.id),
                          label: userDisplayName(m.user),
                        })),
                    ]}
                    disabled={!canAssign}
                    // Never shown to the demo visitor: canAssign is widened for
                    // a demo member (canModifyOthersContentInDemo), so this
                    // moderator-only reason cannot misdescribe the demo.
                    disabledReason="Assigning cards requires Moderator or Admin access"
                    className="w-full"
                  />
                </div>
                <div>
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
                          <div className={`text-sm border rounded-lg px-2.5 py-1.5 w-full select-none flex items-center justify-between pointer-events-none ${info.overdue ? "bg-danger/10 border-danger/40 text-danger" : "bg-surface-hover border-line-strong text-fg"}`}>
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
                        <button
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
                      className={`text-xs px-3 py-1 rounded-full border font-medium transition ${
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
                        className={`text-xs px-2.5 py-1 rounded-full border font-medium transition ${
                          active ? "text-on-primary border-transparent shadow-sm" : "bg-transparent border-line-strong hover:border-line-emphasis"
                        }`}
                        style={active
                          ? { backgroundColor: label.color, borderColor: label.color }
                          : { color: label.color }}
                      >
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
                          onKeyDown={(e) => { if (e.key === "Enter") void handleCreateLabel(); if (e.key === "Escape") { setAddingLabel(false); setLabelError(null); } }}
                          placeholder="Label name"
                          className="text-xs bg-sunken border border-info rounded-full px-2.5 py-1 outline-none w-28 text-fg"
                        />
                        <div className="flex gap-1">
                          {PALETTE_COLORS.map((c) => (
                            <button
                              key={c}
                              // void: handleCreateLabel already catches its own rejection and surfaces it via labelError.
                              onClick={() => { setNewLabelColor(c); if (newLabelName.trim()) void handleCreateLabel(c); }}
                              aria-label={newLabelName.trim() ? `Create "${newLabelName.trim()}" with color ${c}` : `Select color ${c}`}
                              aria-pressed={newLabelColor === c}
                              className={`w-5 h-5 rounded-full border-2 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${newLabelColor === c ? "border-white scale-110" : "border-transparent"}`}
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                        {!newLabelName.trim() && (
                          <span className="text-xs text-fg-muted">type a name first</span>
                        )}
                        <button onClick={() => { setAddingLabel(false); setLabelError(null); }} className="text-xs text-fg-muted hover:text-fg-secondary transition">✕</button>
                      </div>
                      {labelError && (
                        <p className="text-xs text-danger mt-0.5">{labelError}</p>
                      )}
                    </div>
                  ) : canManageLabels ? (
                    <button
                      onClick={() => setAddingLabel(true)}
                      className="text-xs text-fg-muted hover:text-fg-secondary border border-dashed border-line-strong hover:border-line-emphasis rounded-full px-2.5 py-1 transition"
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
                              <CustomFieldEditRow
                                key={definition.id}
                                definition={definition}
                                value={existing?.value}
                                disabled={!canEdit}
                                userDateFormat={userDateFormat}
                                onSave={(v) => save({
                                  custom_field_values: withCustomFieldValue(localCard.custom_field_values, definition.id, v),
                                })}
                              />
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
                  <button
                    onClick={() => {
                      const w = Math.max(1, localCard.weight - 1);
                      setLocalCard((c) => ({ ...c, weight: w }));
                      setWeightLimitReason(null);
                      if (weightSaveTimer.current) clearTimeout(weightSaveTimer.current);
                      weightSaveTimer.current = setTimeout(() => weightRunSave(saveWeight(w)), 600);
                    }}
                    className="w-7 h-7 rounded-full border border-line-strong text-fg-tertiary hover:bg-surface-hover transition text-sm font-medium"
                  >−</button>
                  <span className="text-sm font-semibold text-fg w-6 text-center">{localCard.weight}</span>
                  <button
                    onClick={() => {
                      const w = localCard.weight + 1;
                      setLocalCard((c) => ({ ...c, weight: w }));
                      setWeightLimitReason(null);
                      if (weightSaveTimer.current) clearTimeout(weightSaveTimer.current);
                      weightSaveTimer.current = setTimeout(() => weightRunSave(saveWeight(w)), 600);
                    }}
                    className="w-7 h-7 rounded-full border border-line-strong text-fg-tertiary hover:bg-surface-hover transition text-sm font-medium"
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
                // card: it is seeded at mount and never re-synced, so any
                // field changed by someone else while the panel was open (a
                // move, a retitle) would be silently reverted by adding a
                // relation. The count is taken from the updater's argument
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
                onSave={(next) => save({ external_ref: next })}
              />

              {/* Checklist */}
              <div>
                <button
                  className="flex items-center justify-between w-full mb-2 group/cl"
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
                            onChange={canComment ? () => handleToggleChecklistItem(item) : undefined}
                            disabled={!canComment}
                            title={!canComment ? "Viewers cannot modify checklist items" : undefined}
                            className={`w-3.5 h-3.5 rounded accent-green-500 shrink-0 ${canComment ? "cursor-pointer" : "cursor-default"}`}
                          />
                          <span className={`text-sm flex-1 ${item.is_checked ? "line-through text-fg-faint" : "text-fg-secondary"}`}>
                            {item.text}
                          </span>
                          {(canEdit || (role === "collaborator" && currentUser != null && item.created_by?.id === currentUser.id)) && (
                            <button
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
                      onKeyDown={(e) => { if (e.key === "Enter") void handleAddChecklistItem(); }}
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
                    <div className="absolute inset-0 bg-backdrop/40" aria-hidden="true" onClick={() => setShowBulkAdd(false)} />
                    <div className="relative bg-surface border border-line rounded-lg shadow-xl w-80 p-5 flex flex-col gap-4">
                      <h3 className="text-sm font-semibold text-fg">Add checklist items</h3>
                      <p className="text-xs text-fg-muted -mt-2">One item per line</p>
                      <textarea
                        autoFocus
                        value={bulkText}
                        onChange={(e) => setBulkText(e.target.value)}
                        // void: handleBulkAdd now catches its own rejection and surfaces it via checklistError.
                        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleBulkAdd(); if (e.key === "Escape") setShowBulkAdd(false); }}
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
                  <button
                    className="flex items-center gap-1.5 group/att"
                    onClick={() => setAttachmentsOpen((o) => !o)}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                      Attachments{attachments.length > 0 && <span className="ml-1.5 normal-case font-normal text-fg-muted">({attachments.length})</span>}
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
                          <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                            className="text-xs text-info hover:text-info font-medium disabled:opacity-40 transition"
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
                {attachmentsOpen && (attachments.length === 0 ? (
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
                            <button
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

              <div className="border-t border-line" />

              {/* Comments */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-3">
                  Comments {comments.length > 0 && <span className="normal-case font-normal text-fg-muted">({comments.length})</span>}
                </p>
                <div className="flex flex-col gap-3 mb-3">
                  {comments.map((c) => {
                    const authorName = c.author ? userDisplayName(c.author) : "Unknown";
                    return (
                      <div key={c.id} className="flex gap-2.5 group">
                        <Avatar user={c.author} size="sm" className="mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-semibold text-fg-secondary min-w-0 truncate" title={authorName}>{authorName}</span>
                            <span className="text-xs text-fg-muted" title={formatDateTimeUser(c.created_at, currentUser)}>{formatCommentTime(c.created_at, currentUser)}</span>
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
                                    onClick={() => handleDeleteComment(c.id)}
                                    disabled={deletingCommentId !== null}
                                    className="text-danger hover:text-danger font-medium transition disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                                  >
                                    Confirm
                                  </button>
                                  <button
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
                  <div className="flex flex-col gap-2">
                    <MentionTextarea
                      value={commentBody}
                      onChange={setCommentBody}
                      onSubmit={handleComment}
                      members={board.members}
                      placeholder="Add a comment… (Enter to submit, @ to mention)"
                      rows={2}
                      className="w-full text-sm bg-surface border border-line rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent resize-none text-fg-secondary placeholder-fg-muted"
                    />
                    {demoMode && (
                      <p id="card-comment-demo-reason" className="text-xs text-fg-muted">
                        {DEMO_COMMENT_REASON}
                      </p>
                    )}
                    <div className="flex justify-end">
                      <button
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

            </div>
          ) : (
            <ActivityTabPanel boardId={board.id} cardId={card.id} userDateFormat={userDateFormat} user={currentUser} />
          )}
          </div>
          {/* Scroll affordance — fade gradient at bottom signals more content below */}
          <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-surface to-transparent pointer-events-none" />
        </div>

        {/* Footer */}
        {(canArchive || canDelete) && (
          <div className="px-5 py-3 border-t border-line flex items-center justify-between">
            {canArchive ? (
              <button
                onClick={handleArchive}
                className="text-xs text-fg-muted hover:text-warning transition focus:outline-none focus:ring-2 focus:ring-warning-emphasis rounded"
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
      </div>

      {/* Move popover — rendered fixed so the panel's overflow-hidden doesn't clip it */}
      {showMovePopover && movePopoverAnchor && (
        <div
          className="fixed w-64 bg-surface border border-line rounded-lg shadow-xl p-4 z-[60] flex flex-col gap-3"
          style={{ top: movePopoverAnchor.top, left: movePopoverAnchor.left }}
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-tertiary">Move to</p>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-fg-muted">Swimlane</label>
            <SelectDropdown
              options={board.swimlanes.map((s) => ({ value: String(s.id), label: s.name }))}
              value={moveTargetSwimlane !== null ? String(moveTargetSwimlane) : ""}
              onChange={(v) => setMoveTargetSwimlane(Number(v))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-fg-muted">Column</label>
            <SelectDropdown
              options={board.columns.map((c) => ({ value: String(c.id), label: c.name }))}
              value={moveTargetColumn !== null ? String(moveTargetColumn) : ""}
              onChange={(v) => setMoveTargetColumn(Number(v))}
            />
          </div>
          <p className="text-xs h-4">
            {movePopoverError && <span className="text-danger">{movePopoverError}</span>}
          </p>
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => setShowMovePopover(false)}
              className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
            >Cancel</button>
            <button
              onClick={handleMoveSubmit}
              disabled={moveSubmitting || moveTargetColumn === null || moveTargetSwimlane === null || (moveTargetColumn === localCard.column && moveTargetSwimlane === localCard.swimlane)}
              className="text-sm font-medium bg-button-primary hover:bg-button-primary-hover text-on-primary px-3 py-1.5 rounded transition disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >{moveSubmitting ? "Moving…" : "Move"}</button>
          </div>
        </div>
      )}

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
              <button onClick={closeCardAction} disabled={cardActionBusy} className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded disabled:opacity-50">Cancel</button>
              <button onClick={executeDelete} aria-disabled={cardActionBusy} className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed bg-danger-bg hover:bg-danger-bg-hover text-on-danger text-sm px-4 py-1.5 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis">{cardActionBusy ? "Deleting…" : "Delete"}</button>
            </div>
          </>
        ) : confirmAction === "archive" ? (
          <>
            <p className="text-fg-tertiary text-sm mb-5">It will be hidden from the board but can be unarchived from the Archived panel.</p>
            <div role="status" aria-live="polite" aria-atomic="true">
              {cardActionError && <p className="text-xs text-danger mb-3">{cardActionError}</p>}
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={closeCardAction} disabled={cardActionBusy} className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded disabled:opacity-50">Cancel</button>
              <button onClick={executeArchive} aria-disabled={cardActionBusy} className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed bg-warning-bg hover:bg-warning-bg-hover text-fg text-sm px-4 py-1.5 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-warning-emphasis">{cardActionBusy ? "Archiving…" : "Archive"}</button>
            </div>
          </>
        ) : null}
      </ModalWrapper>
    </div>
  );
}
