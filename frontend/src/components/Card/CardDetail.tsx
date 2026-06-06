import { useEffect, useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useMoveToSeenPref } from "../../hooks/useMoveToSeenPref";
import { useAutosaveStatus } from "../../hooks/useAutosaveStatus";
import AutosaveIndicator from "../Common/AutosaveIndicator";
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

export default function CardDetail({ card, board, onClose, onDeleted, onUpdated, onArchived, onMoveCard, userDateFormat = "MM/DD/YYYY", userTimeFormat: _userTimeFormat = "12h", userTimezone = "", currentUser = null, closeEditorOnEnter = false }: Props) {
  const [localCard, setLocalCard] = useState<Card>(card);
  const [comments, setComments] = useState<CardComment[]>([]);
  const [confirmDeleteCommentId, setConfirmDeleteCommentId] = useState<number | null>(null);
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
  const [confirmAction, setConfirmAction] = useState<"delete" | "archive" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dueDateRef = useRef<HTMLInputElement>(null);
  const dueDateEmptyRef = useRef<HTMLInputElement>(null);
  const [checklist, setChecklist] = useState<CardChecklistItem[]>([]);
  const [newItemText, setNewItemText] = useState("");
  const [showBulkAdd, setShowBulkAdd] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [checklistOpen, setChecklistOpen] = useState(true);
  const [attachmentsOpen, setAttachmentsOpen] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus the panel on open so screen readers announce it as a dialog.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  // Debounce weight saves: rapid +/- clicks coalesce into one PATCH so the
  // activity feed shows a single net change (e.g. "Weight: 3 → 8") rather
  // than an entry per click.
  const weightSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moveButtonRef = useRef<HTMLButtonElement>(null);
  const [showMovePopover, setShowMovePopover] = useState(false);
  const [movePopoverAnchor, setMovePopoverAnchor] = useState<{ top: number; left: number } | null>(null);
  const [moveTargetColumn, setMoveTargetColumn] = useState<number | null>(null);
  const [moveTargetSwimlane, setMoveTargetSwimlane] = useState<number | null>(null);
  const [moveSubmitting, setMoveSubmitting] = useState(false);
  const [movePopoverError, setMovePopoverError] = useState<string | null>(null);
  const [moveToSeen, setMoveToSeen] = useMoveToSeenPref();

  useEffect(() => {
    getCardComments(board.id, card.id).then(setComments);
    getCardAttachments(board.id, card.id).then((data) => {
      setAttachments(data);
      setAttachmentsOpen(data.length > 0);
    });
    getChecklist(board.id, card.id).then((data) => {
      setChecklist(data);
      setChecklistOpen(data.length > 0);
    });
  }, [board.id, card.id]);

  // Dismiss confirm overlay before closing the panel so Escape has two stages:
  // first press dismisses the confirm, second press closes the panel.
  useEscapeStack(() => {
    if (!confirmAction) return false;
    setConfirmAction(null);
  }, 35);
  // Close move popover before panel — priority 36 sits above confirmAction (35) so
  // it fires first when both are open, and above panel close (30) in the normal case.
  useEscapeStack(() => {
    if (!showMovePopover) return false;
    setShowMovePopover(false);
  }, 36);
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
    try {
      setAttachError(null);
      await deleteCardAttachment(board.id, localCard.id, id);
      setAttachments((prev) => prev.filter((a) => a.id !== id));
      setLocalCard((c) => ({ ...c, attachment_count: Math.max(0, c.attachment_count - 1) }));
      onUpdated({ ...localCard, attachment_count: Math.max(0, localCard.attachment_count - 1) });
    } catch {
      setAttachError("Could not delete attachment.");
    }
  };

  const handleAddChecklistItem = async () => {
    if (!newItemText.trim()) return;
    const item = await addChecklistItem(board.id, card.id, newItemText.trim());
    setChecklist((prev) => [...prev, item]);
    setNewItemText("");
    onUpdated({ ...localCard, checklist_total: localCard.checklist_total + 1 });
  };

  const handleBulkAdd = async () => {
    const items = bulkText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    const added: CardChecklistItem[] = [];
    for (const text of items) {
      const item = await addChecklistItem(board.id, card.id, text);
      added.push(item);
    }
    setChecklist((prev) => [...prev, ...added]);
    onUpdated({ ...localCard, checklist_total: localCard.checklist_total + added.length });
    setBulkText("");
    setShowBulkAdd(false);
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
    await deleteChecklistItem(board.id, card.id, itemId);
    const newChecklist = checklist.filter((i) => i.id !== itemId);
    setChecklist(newChecklist);
    const done = newChecklist.filter((i) => i.is_checked).length;
    onUpdated({ ...localCard, checklist_total: newChecklist.length, checklist_done: done });
  };

  const handleDelete = () => setConfirmAction("delete");
  const handleArchive = () => setConfirmAction("archive");

  const executeDelete = async () => {
    setConfirmAction(null);
    await deleteCard(board.id, card.id);
    onDeleted(card.id);
  };

  const executeArchive = async () => {
    setConfirmAction(null);
    await archiveCard(board.id, card.id);
    onArchived(card.id);
    onClose();
  };

  const column = board.columns.find((c) => c.id === localCard.column);
  const swimlane = board.swimlanes.find((s) => s.id === localCard.swimlane);

  const role = board.current_user_role;
  const canEdit = role === "site_admin" || role === "admin" || role === "member";
  const canManageLabels = role === "site_admin" || role === "admin";
  const canComment = canEdit || role === "collaborator";

  // Ownership gating: members can only delete/archive cards they created,
  // unless they have admin, site_admin, or is_moderator entitlement.
  const isModerator = board.members.some(
    (m) => currentUser != null && m.user.id === currentUser.id && m.is_moderator,
  );
  const canModifyOthersContent =
    role === "admin" || role === "site_admin" || isModerator;
  const isCardOwner =
    currentUser != null && localCard.created_by?.id === currentUser.id;
  const canDeleteOrArchive = canEdit && (isCardOwner || canModifyOthersContent);
  const canAssign = canEdit && (isCardOwner || canModifyOthersContent);

  const canDeleteComment = (c: CardComment): boolean =>
    (c.author !== null && currentUser !== null && c.author.id === currentUser.id) ||
    canModifyOthersContent;

  const canDeleteAttachment = (a: CardAttachment): boolean =>
    (a.uploaded_by !== null && currentUser !== null && a.uploaded_by.id === currentUser.id) ||
    canModifyOthersContent;

  const handleDeleteComment = async (commentId: number) => {
    await deleteComment(board.id, card.id, commentId);
    setComments((prev) => prev.filter((x) => x.id !== commentId));
    setConfirmDeleteCommentId(null);
  };

  const allLabels = [...board.labels];
  localCard.labels.forEach((l) => {
    if (!allLabels.find((bl) => bl.id === l.id)) allLabels.push(l);
  });

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-backdrop/40" onClick={onClose} />

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
                    className="w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    aria-label="Move card to different column or swimlane"
                  >
                    {/* Two-headed arrows = transfer/move-to-another-location metaphor */}
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M8 5a1 1 0 100 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8zM12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z" />
                    </svg>
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
                    descRunSave(save({ description: md }));
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
                        <div
                          className="relative flex-1 cursor-pointer"
                          onClick={() => {
                            const el = dueDateRef.current;
                            if (!el) return;
                            // showPicker() is supported in Chrome 99+, Firefox 101+, Safari 16+
                            if (typeof (el as HTMLInputElement & { showPicker?: () => void }).showPicker === 'function') {
                              try { (el as HTMLInputElement & { showPicker: () => void }).showPicker(); return; } catch { /* ignore */ }
                            }
                            // Focus opens the picker on older Safari and acts as a no-op elsewhere
                            el.focus();
                          }}
                        >
                          <div className={`text-sm border rounded-lg px-2.5 py-1.5 w-full select-none flex items-center justify-between pointer-events-none ${info.overdue ? "bg-danger/10 border-danger/40 text-danger" : "bg-surface-hover border-line-strong text-fg"}`}>
                            <span>{formatDateStr(localCard.due_date, userDateFormat)}</span>
                            <svg className="w-4 h-4 opacity-70 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="2.5" width="13" height="12" rx="1.5"/><path d="M5 1v3M11 1v3M1.5 6h13"/></svg>
                          </div>
                          <input
                            ref={dueDateRef}
                            type="date"
                            value={localCard.due_date}
                            onChange={(e) => {
                              const v = e.target.value || null;
                              setLocalCard((c) => ({ ...c, due_date: v }));
                              save({ due_date: v }).catch(() => {});
                            }}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                          />
                        </div>
                        <button
                          onClick={() => { setLocalCard((c) => ({ ...c, due_date: null })); save({ due_date: null }).catch(() => {}); }}
                          className="text-fg-faint hover:text-danger transition text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
                          title="Clear due date"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })() : (
                    <div
                      className="relative cursor-pointer"
                      onClick={() => {
                        const el = dueDateEmptyRef.current;
                        if (!el) return;
                        if (typeof (el as HTMLInputElement & { showPicker?: () => void }).showPicker === 'function') {
                          try { (el as HTMLInputElement & { showPicker: () => void }).showPicker(); return; } catch { /* ignore */ }
                        }
                        el.focus();
                      }}
                    >
                      <div className="text-sm bg-surface-hover border border-line-strong rounded-lg px-2.5 py-1.5 text-fg-muted select-none flex items-center justify-between pointer-events-none">
                        <span>{userDateFormat.toLowerCase()}</span>
                        <svg className="w-4 h-4 opacity-50 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="2.5" width="13" height="12" rx="1.5"/><path d="M5 1v3M11 1v3M1.5 6h13"/></svg>
                      </div>
                      <input
                        ref={dueDateEmptyRef}
                        type="date"
                        value=""
                        min={new Date().toISOString().slice(0, 10)}
                        onChange={(e) => {
                          const v = e.target.value || null;
                          setLocalCard((c) => ({ ...c, due_date: v }));
                          save({ due_date: v }).catch(() => {});
                        }}
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
                          onKeyDown={(e) => { if (e.key === "Enter") handleCreateLabel(); if (e.key === "Escape") { setAddingLabel(false); setLabelError(null); } }}
                          placeholder="Label name"
                          className="text-xs bg-sunken border border-info rounded-full px-2.5 py-1 outline-none w-28 text-fg"
                        />
                        <div className="flex gap-1">
                          {PALETTE_COLORS.map((c) => (
                            <button
                              key={c}
                              onClick={() => { setNewLabelColor(c); if (newLabelName.trim()) handleCreateLabel(c); }}
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

              {/* Weight */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Weight</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const w = Math.max(1, localCard.weight - 1);
                      setLocalCard((c) => ({ ...c, weight: w }));
                      if (weightSaveTimer.current) clearTimeout(weightSaveTimer.current);
                      weightSaveTimer.current = setTimeout(() => weightRunSave(save({ weight: w })), 600);
                    }}
                    className="w-7 h-7 rounded-full border border-line-strong text-fg-tertiary hover:bg-surface-hover transition text-sm font-medium"
                  >−</button>
                  <span className="text-sm font-semibold text-fg w-6 text-center">{localCard.weight}</span>
                  <button
                    onClick={() => {
                      const w = localCard.weight + 1;
                      setLocalCard((c) => ({ ...c, weight: w }));
                      if (weightSaveTimer.current) clearTimeout(weightSaveTimer.current);
                      weightSaveTimer.current = setTimeout(() => weightRunSave(save({ weight: w })), 600);
                    }}
                    className="w-7 h-7 rounded-full border border-line-strong text-fg-tertiary hover:bg-surface-hover transition text-sm font-medium"
                  >+</button>
                </div>
                <AutosaveIndicator status={weightStatus} fadingOut={weightFadingOut} />
              </div>

              <div className="border-t border-line" />

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
                      onKeyDown={(e) => { if (e.key === "Enter") handleAddChecklistItem(); }}
                      placeholder="Add item (Enter)…"
                      className="flex-1 text-sm bg-surface border border-line rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent text-fg-secondary placeholder-fg-muted"
                    />
                    <button
                      onClick={() => { setBulkText(""); setShowBulkAdd(true); }}
                      className="text-sm text-info hover:text-info font-medium px-2 whitespace-nowrap transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
                    >
                      Bulk
                    </button>
                  </div>
                )}

                {showBulkAdd && (
                  <div className="fixed inset-0 z-[60] flex items-center justify-center">
                    <div className="absolute inset-0 bg-backdrop/40" onClick={() => setShowBulkAdd(false)} />
                    <div className="relative bg-surface border border-line rounded-lg shadow-xl w-80 p-5 flex flex-col gap-4">
                      <h3 className="text-sm font-semibold text-fg">Add checklist items</h3>
                      <p className="text-xs text-fg-muted -mt-2">One item per line</p>
                      <textarea
                        autoFocus
                        value={bulkText}
                        onChange={(e) => setBulkText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleBulkAdd(); if (e.key === "Escape") setShowBulkAdd(false); }}
                        placeholder={"Buy milk\nCall client\nReview PR"}
                        rows={6}
                        className="w-full text-sm bg-surface border border-line rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent resize-none text-fg-secondary placeholder-fg-muted"
                      />
                      <div className="flex justify-end gap-3">
                        <button onClick={() => setShowBulkAdd(false)} className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded">Cancel</button>
                        <button onClick={handleBulkAdd} className="text-sm bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover transition font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Add items</button>
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
                      {currentUser?.uploads_enabled === false ? (
                        <span
                          title="File uploads are disabled by the site administrator."
                          className="text-xs text-fg-faint font-medium cursor-not-allowed"
                        >
                          + Upload
                        </span>
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
                          <button
                            onClick={() => handleDeleteAttachment(a.id)}
                            className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-fg-faint hover:text-danger transition text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
                            title="Delete"
                          >✕</button>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-xs h-4">{attachError && <span className="text-danger">{attachError}</span>}</p>
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
                            <span className="text-xs font-semibold text-fg-secondary">{authorName}</span>
                            <span className="text-xs text-fg-muted" title={formatDateTimeUser(c.created_at, currentUser)}>{formatCommentTime(c.created_at, currentUser)}</span>
                            {canDeleteComment(c) && (
                              confirmDeleteCommentId === c.id ? (
                                <div className="ml-auto flex items-center gap-1">
                                  <span className="text-xs text-danger">Delete?</span>
                                  <button
                                    onClick={() => handleDeleteComment(c.id)}
                                    className="text-xs text-danger hover:text-danger font-medium focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded px-1"
                                  >
                                    Yes
                                  </button>
                                  <button
                                    onClick={() => setConfirmDeleteCommentId(null)}
                                    className="text-xs text-fg-muted hover:text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded px-1"
                                  >
                                    No
                                  </button>
                                </div>
                              ) : (
                                <button
                                  title="Delete comment"
                                  onClick={() => setConfirmDeleteCommentId(c.id)}
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
                    <div className="flex justify-end">
                      <button
                        onClick={handleComment}
                        className="text-sm bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover transition font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
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
        {canDeleteOrArchive && (
          <div className="px-5 py-3 border-t border-line flex items-center justify-between">
            <button onClick={handleArchive} className="text-xs text-fg-muted hover:text-warning transition">
              Archive card
            </button>
            <button onClick={handleDelete} className="text-xs text-fg-faint hover:text-danger transition">
              Delete card
            </button>
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
        onClose={() => setConfirmAction(null)}
        title={confirmAction === "delete" ? "Delete this card?" : "Archive this card?"}
        maxWidth="max-w-sm"
      >
        {confirmAction === "delete" ? (
          <>
            <p className="text-fg-tertiary text-sm mb-5">This cannot be undone.</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmAction(null)} className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded">Cancel</button>
              <button onClick={executeDelete} className="bg-danger-bg hover:bg-danger-bg-hover text-on-danger text-sm px-4 py-1.5 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis">Delete</button>
            </div>
          </>
        ) : confirmAction === "archive" ? (
          <>
            <p className="text-fg-tertiary text-sm mb-5">It will be hidden from the board but can be unarchived from the Archived panel.</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmAction(null)} className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded">Cancel</button>
              <button onClick={executeArchive} className="bg-warning-bg hover:bg-warning-bg-hover text-fg text-sm px-4 py-1.5 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-warning-emphasis">Archive</button>
            </div>
          </>
        ) : null}
      </ModalWrapper>
    </div>
  );
}
