import { useEffect, useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { BoardFull, Card, CardAttachment, CardChecklistItem, CardComment, Label, Priority, User } from "../../types";
import { userDisplayName } from "../../types";
import SelectDropdown from "../Common/SelectDropdown";
import { deleteCard, archiveCard, getCardComments, addCardComment, deleteComment, updateCard, getCardAttachments, uploadCardAttachment, deleteCardAttachment, getChecklist, addChecklistItem, updateChecklistItem, deleteChecklistItem } from "../../api/cards";
import type { CardPatch } from "../../api/cards";
import { createLabel } from "../../api/boards";
import { PALETTE_COLORS, PRIORITY_COLORS } from "../../constants/colors";
import CardMovementTimeline from "./CardMovementTimeline";
import { formatDateStr, formatDueDate } from "../../utils/date";
import MentionTextarea from "./MentionTextarea";
import RichTextEditor from "./RichTextEditor";

interface Props {
  card: Card;
  board: BoardFull;
  onClose: () => void;
  onDeleted: (id: number) => void;
  onUpdated: (card: Card) => void;
  onArchived: (cardId: number) => void;
  userDateFormat?: string;
  userTimeFormat?: string;
  userTimezone?: string;
  currentUser?: User | null;
  closeEditorOnEnter?: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components -- intentional utility export, used by tests and co-located with the component for cohesion
export function formatCommentTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Deterministic avatar color per user — cycles through a fixed palette so each
// person's initials always appear in the same color regardless of where they show up.
const AVATAR_PALETTE = [
  { bg: "bg-teal-700",    text: "text-teal-100"    },
  { bg: "bg-amber-700",   text: "text-amber-100"   },
  { bg: "bg-violet-700",  text: "text-violet-100"  },
  { bg: "bg-rose-700",    text: "text-rose-100"    },
  { bg: "bg-blue-700",    text: "text-blue-100"    },
  { bg: "bg-emerald-700", text: "text-emerald-100" },
  { bg: "bg-orange-700",  text: "text-orange-100"  },
  { bg: "bg-pink-700",    text: "text-pink-100"    },
];
function avatarColor(userId: number) {
  return AVATAR_PALETTE[userId % AVATAR_PALETTE.length];
}

const PRIORITY_OPTIONS: { value: Priority; label: string; color: string }[] = [
  { value: "low",    label: "Low",    color: PRIORITY_COLORS.low },
  { value: "medium", label: "Medium", color: PRIORITY_COLORS.medium },
  { value: "high",   label: "High",   color: PRIORITY_COLORS.high },
  { value: "urgent", label: "Urgent", color: PRIORITY_COLORS.urgent },
];

export default function CardDetail({ card, board, onClose, onDeleted, onUpdated, onArchived, userDateFormat = "MM/DD/YYYY", userTimeFormat = "12h", userTimezone = "", currentUser = null, closeEditorOnEnter = false }: Props) {
  const [localCard, setLocalCard] = useState<Card>(card);
  const [comments, setComments] = useState<CardComment[]>([]);
  const [confirmDeleteCommentId, setConfirmDeleteCommentId] = useState<number | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [tab, setTab] = useState<"details" | "history">("details");
  const [addingLabel, setAddingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState(PALETTE_COLORS[0]);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<CardAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
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
  // Debounce weight saves: rapid +/- clicks coalesce into one PATCH so the
  // activity feed shows a single net change (e.g. "Weight: 3 → 8") rather
  // than an entry per click.
  const weightSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  useEscapeStack(onClose, 30);

  const save = async (patch: CardPatch) => {
    // Snapshot pre-save state so we can roll back if the API call fails.
    const prev = localCard;
    setSaveError(null);
    try {
      const updated = await updateCard(board.id, localCard.id, patch);
      setLocalCard(updated);
      onUpdated(updated);
    } catch {
      setLocalCard(prev);
      setSaveError("Failed to save — please try again.");
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
      await save({ title: trimmed });
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

  const handleDeleteAttachment = async (id: number) => {
    await deleteCardAttachment(board.id, localCard.id, id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setLocalCard((c) => ({ ...c, attachment_count: Math.max(0, c.attachment_count - 1) }));
    onUpdated({ ...localCard, attachment_count: Math.max(0, localCard.attachment_count - 1) });
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
    setChecklist((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    const doneDelta = updated.is_checked ? 1 : -1;
    onUpdated({ ...localCard, checklist_done: localCard.checklist_done + doneDelta });
  };

  const handleDeleteChecklistItem = async (itemId: number) => {
    const item = checklist.find((i) => i.id === itemId);
    await deleteChecklistItem(board.id, card.id, itemId);
    setChecklist((prev) => prev.filter((i) => i.id !== itemId));
    const doneDelta = item?.is_checked ? -1 : 0;
    onUpdated({ ...localCard, checklist_total: localCard.checklist_total - 1, checklist_done: localCard.checklist_done + doneDelta });
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
  // A comment may be deleted by its author, board admins, or site admins.
  // Admins can delete any comment for moderation purposes.
  const canDeleteComment = (c: CardComment): boolean =>
    (c.author !== null && currentUser !== null && c.author.id === currentUser.id) ||
    role === "admin" ||
    role === "site_admin";

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
      <div className="flex-1 bg-black/40" onClick={onClose} />

      <div ref={panelRef} className="w-[540px] bg-slate-800 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-slate-700">
          <div className="flex-1 min-w-0">
            <input
              value={localCard.title}
              onChange={(e) => setLocalCard((c) => ({ ...c, title: e.target.value }))}
              onKeyDown={handleTitleKeyDown}
              onBlur={handleTitleBlur}
              className="text-base font-semibold text-white w-full outline-none rounded px-1 -ml-1 border border-transparent focus:border-blue-400 focus:bg-blue-900/20 bg-transparent transition"
            />
            <p className="text-[11px] text-slate-500 mt-1 px-1">
              {swimlane?.name} <span className="mx-1 text-slate-600">›</span> {column?.name}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-white hover:bg-slate-700 transition text-lg leading-none shrink-0"
            title="Close"
          >×</button>
        </div>

        {/* Save error — reserved space so layout never shifts */}
        <p className="text-xs h-4 px-5 pt-1">
          {saveError && <span className="text-red-400">{saveError}</span>}
        </p>

        {/* Tabs */}
        <div className="flex border-b border-slate-700 text-sm">
          {(["details", "history"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-2.5 font-medium capitalize transition ${
                tab === t ? "border-b-2 border-blue-400 text-blue-400" : "text-slate-500 hover:text-slate-300"
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
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Description</p>
                <RichTextEditor
                  value={localCard.description ?? ""}
                  onSave={(md) => {
                    setLocalCard((c) => ({ ...c, description: md }));
                    save({ description: md });
                  }}
                  readOnly={!canEdit}
                  showActions={canEdit}
                  placeholder="Add a description…"
                  minHeight="min-h-32"
                  members={board.members}
                />
              </div>

              <div className="border-t border-slate-700" />

              {/* Assignee + Due date */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Assignee</p>
                  <SelectDropdown
                    value={String(localCard.assignee?.id ?? "")}
                    onChange={(v) => {
                      const id = v ? Number(v) : null;
                      save({ assignee_id: id });
                    }}
                    options={[
                      { value: "", label: "Unassigned" },
                      ...board.members.map((m) => ({
                        value: String(m.user.id),
                        label: userDisplayName(m.user),
                      })),
                    ]}
                    className="w-full"
                  />
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Due date</p>
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
                          <div className={`text-sm border rounded-lg px-2.5 py-1.5 w-full select-none flex items-center justify-between pointer-events-none ${info.overdue ? "bg-red-950/40 border-red-700/60 text-red-300" : "bg-slate-700 border-slate-500 text-slate-100"}`}>
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
                              save({ due_date: v });
                            }}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                          />
                        </div>
                        <button
                          onClick={() => { setLocalCard((c) => ({ ...c, due_date: null })); save({ due_date: null }); }}
                          className="text-slate-600 hover:text-red-400 transition text-xs shrink-0"
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
                      <div className="text-sm bg-slate-700 border border-slate-500 rounded-lg px-2.5 py-1.5 text-slate-500 select-none flex items-center justify-between pointer-events-none">
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
                          save({ due_date: v });
                        }}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Priority */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Priority</p>
                <div className="flex gap-1.5">
                  {PRIORITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => { setLocalCard((c) => ({ ...c, priority: opt.value })); save({ priority: opt.value }); }}
                      className={`text-xs px-3 py-1 rounded-full border font-medium transition ${
                        localCard.priority === opt.value
                          ? "text-white border-transparent shadow-sm"
                          : "text-slate-400 border-slate-600 hover:border-slate-400 bg-transparent"
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
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Labels</p>
                <div className="flex flex-wrap gap-1.5">
                  {allLabels.map((label) => {
                    const active = localCard.labels.some((l) => l.id === label.id);
                    return (
                      <button
                        key={label.id}
                        onClick={() => toggleLabel(label)}
                        className={`text-xs px-2.5 py-1 rounded-full border font-medium transition ${
                          active ? "text-white border-transparent shadow-sm" : "bg-transparent border-slate-600 hover:border-slate-400"
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
                          className="text-xs bg-slate-900 border border-blue-400 rounded-full px-2.5 py-1 outline-none w-28 text-slate-200"
                        />
                        <div className="flex gap-1">
                          {PALETTE_COLORS.map((c) => (
                            <button
                              key={c}
                              onClick={() => { setNewLabelColor(c); if (newLabelName.trim()) handleCreateLabel(c); }}
                              className={`w-5 h-5 rounded-full border-2 transition ${newLabelColor === c ? "border-white scale-110" : "border-transparent"}`}
                              style={{ backgroundColor: c }}
                              title={newLabelName.trim() ? `Create "${newLabelName.trim()}" with this color` : "Pick color"}
                            />
                          ))}
                        </div>
                        {!newLabelName.trim() && (
                          <span className="text-[10px] text-slate-500">type a name first</span>
                        )}
                        <button onClick={() => { setAddingLabel(false); setLabelError(null); }} className="text-xs text-slate-500 hover:text-slate-300 transition">✕</button>
                      </div>
                      {labelError && (
                        <p className="text-[10px] text-red-400 mt-0.5">{labelError}</p>
                      )}
                    </div>
                  ) : canManageLabels ? (
                    <button
                      onClick={() => setAddingLabel(true)}
                      className="text-xs text-slate-500 hover:text-slate-300 border border-dashed border-slate-600 hover:border-slate-400 rounded-full px-2.5 py-1 transition"
                    >
                      + New label
                    </button>
                  ) : null}
                </div>
              </div>

              {/* Weight */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Weight</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const w = Math.max(1, localCard.weight - 1);
                      setLocalCard((c) => ({ ...c, weight: w }));
                      if (weightSaveTimer.current) clearTimeout(weightSaveTimer.current);
                      weightSaveTimer.current = setTimeout(() => save({ weight: w }), 600);
                    }}
                    className="w-7 h-7 rounded-full border border-slate-600 text-slate-400 hover:bg-slate-700 transition text-sm font-medium"
                  >−</button>
                  <span className="text-sm font-semibold text-slate-200 w-6 text-center">{localCard.weight}</span>
                  <button
                    onClick={() => {
                      const w = localCard.weight + 1;
                      setLocalCard((c) => ({ ...c, weight: w }));
                      if (weightSaveTimer.current) clearTimeout(weightSaveTimer.current);
                      weightSaveTimer.current = setTimeout(() => save({ weight: w }), 600);
                    }}
                    className="w-7 h-7 rounded-full border border-slate-600 text-slate-400 hover:bg-slate-700 transition text-sm font-medium"
                  >+</button>
                </div>
              </div>

              <div className="border-t border-slate-700" />

              {/* Checklist */}
              <div>
                <button
                  className="flex items-center justify-between w-full mb-2 group/cl"
                  onClick={() => setChecklistOpen((o) => !o)}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Checklist
                    {checklist.length > 0 && (
                      <span className="ml-1.5 normal-case font-normal text-slate-500">{checklist.filter((i) => i.is_checked).length}/{checklist.length}</span>
                    )}
                  </p>
                  <svg className={`w-3.5 h-3.5 text-slate-600 group-hover/cl:text-slate-400 transition-transform ${checklistOpen ? "" : "-rotate-90"}`} viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
                {checklistOpen && checklist.length > 0 && ( // items and progress only when expanded
                  <>
                    <div className="h-1 bg-slate-700 rounded-full mb-3 overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full transition-all"
                        style={{ width: `${Math.round((checklist.filter((i) => i.is_checked).length / checklist.length) * 100)}%` }}
                      />
                    </div>
                    <div className="flex flex-col gap-1 mb-3">
                      {checklist.map((item) => (
                        <div key={item.id} className="flex items-center gap-2 group px-1 py-0.5 rounded hover:bg-slate-700">
                          <input
                            type="checkbox"
                            checked={item.is_checked}
                            onChange={() => handleToggleChecklistItem(item)}
                            className="w-3.5 h-3.5 rounded accent-green-500 shrink-0 cursor-pointer"
                          />
                          <span className={`text-sm flex-1 ${item.is_checked ? "line-through text-slate-600" : "text-slate-300"}`}>
                            {item.text}
                          </span>
                          <button
                            onClick={() => handleDeleteChecklistItem(item.id)}
                            className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition text-xs shrink-0"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <div className="flex gap-2">
                  <input
                    value={newItemText}
                    onChange={(e) => setNewItemText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddChecklistItem(); }}
                    placeholder="Add item (Enter)…"
                    className="flex-1 text-sm bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 text-slate-200 placeholder-slate-600"
                  />
                  <button
                    onClick={() => { setBulkText(""); setShowBulkAdd(true); }}
                    className="text-sm text-blue-400 hover:text-blue-300 font-medium px-2 whitespace-nowrap transition"
                  >
                    Bulk
                  </button>
                </div>

                {showBulkAdd && (
                  <div className="fixed inset-0 z-[60] flex items-center justify-center">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setShowBulkAdd(false)} />
                    <div className="relative bg-slate-800 rounded-xl shadow-2xl w-80 p-5 flex flex-col gap-4">
                      <h3 className="text-sm font-semibold text-white">Add checklist items</h3>
                      <p className="text-xs text-slate-500 -mt-2">One item per line</p>
                      <textarea
                        autoFocus
                        value={bulkText}
                        onChange={(e) => setBulkText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleBulkAdd(); if (e.key === "Escape") setShowBulkAdd(false); }}
                        placeholder={"Buy milk\nCall client\nReview PR"}
                        rows={6}
                        className="w-full text-sm bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 outline-none focus:border-blue-400 resize-none text-slate-200 placeholder-slate-600"
                      />
                      <div className="flex justify-end gap-2">
                        <button onClick={() => setShowBulkAdd(false)} className="text-sm text-slate-400 hover:text-white px-3 py-1.5 transition">Cancel</button>
                        <button onClick={handleBulkAdd} className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 transition">Add items</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-slate-700" />

              {/* Attachments */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <button
                    className="flex items-center gap-1.5 group/att"
                    onClick={() => setAttachmentsOpen((o) => !o)}
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Attachments{attachments.length > 0 && <span className="ml-1.5 normal-case font-normal text-slate-500">({attachments.length})</span>}
                    </p>
                    <svg className={`w-3.5 h-3.5 text-slate-600 group-hover/att:text-slate-400 transition-transform ${attachmentsOpen ? "" : "-rotate-90"}`} viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                  {attachmentsOpen && (
                    <>
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="text-xs text-blue-400 hover:text-blue-300 font-medium disabled:opacity-50 transition"
                      >
                        {uploading ? "Uploading…" : "+ Upload"}
                      </button>
                      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />
                    </>
                  )}
                </div>
                {attachmentsOpen && (attachments.length === 0 ? (
                  <p className="text-xs text-slate-600 italic">No attachments.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {attachments.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 bg-slate-700 rounded-lg px-3 py-2 group">
                        <span className="text-slate-500 text-sm shrink-0">📎</span>
                        <div className="flex-1 min-w-0">
                          {/* The download attribute tells the browser to always save the file
                              rather than attempting to render it inline. This is defense-in-depth
                              alongside the server-side Content-Disposition: attachment header. */}
                          <a href={a.url} download={a.filename} target="_blank" rel="noreferrer" className="text-sm text-blue-400 hover:underline truncate block">
                            {a.filename}
                          </a>
                          <p className="text-xs text-slate-500">{(a.size / 1024).toFixed(1)} KB · {formatDateStr(a.uploaded_at.slice(0, 10), userDateFormat)}</p>
                        </div>
                        <button
                          onClick={() => handleDeleteAttachment(a.id)}
                          className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition text-xs shrink-0"
                          title="Delete"
                        >✕</button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <div className="border-t border-slate-700" />

              {/* Comments */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-3">
                  Comments {comments.length > 0 && <span className="normal-case font-normal text-slate-500">({comments.length})</span>}
                </p>
                <div className="flex flex-col gap-3 mb-3">
                  {comments.map((c) => {
                    const authorName = c.author ? userDisplayName(c.author) : "Unknown";
                    const authorInitials = authorName.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
                    const avatarCls = avatarColor(c.author?.id ?? 0);
                    return (
                      <div key={c.id} className="flex gap-2.5 group">
                        <span className={`w-7 h-7 rounded-full ${avatarCls.bg} ${avatarCls.text} text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5`}>
                          {authorInitials}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-semibold text-slate-300">{authorName}</span>
                            <span className="text-[10px] text-slate-500" title={new Date(c.created_at).toLocaleString()}>{formatCommentTime(c.created_at)}</span>
                            {canDeleteComment(c) && (
                              confirmDeleteCommentId === c.id ? (
                                <div className="ml-auto flex items-center gap-1">
                                  <span className="text-[10px] text-red-400">Delete?</span>
                                  <button
                                    onClick={() => handleDeleteComment(c.id)}
                                    className="text-[10px] text-red-400 hover:text-red-300 font-medium focus:outline-none focus:ring-1 focus:ring-red-500 rounded px-1"
                                  >
                                    Yes
                                  </button>
                                  <button
                                    onClick={() => setConfirmDeleteCommentId(null)}
                                    className="text-[10px] text-slate-500 hover:text-slate-300 focus:outline-none focus:ring-1 focus:ring-slate-500 rounded px-1"
                                  >
                                    No
                                  </button>
                                </div>
                              ) : (
                                <button
                                  title="Delete comment"
                                  onClick={() => setConfirmDeleteCommentId(c.id)}
                                  className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity duration-150 p-0.5 rounded text-slate-500 hover:text-red-400 hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500"
                                  aria-label="Delete comment"
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                                    <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                                  </svg>
                                </button>
                              )
                            )}
                          </div>
                          <div className="bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 leading-relaxed">
                            {c.body.split(/(@[\w.+-]+)/g).map((part, i) => // nosemgrep: nodejs_scan.javascript-dos-rule-regex_dos
                              /^@[\w.+-]+$/.test(part) // nosemgrep: nodejs_scan.javascript-dos-rule-regex_dos
                                ? <span key={i} className="font-semibold text-blue-400">{part}</span>
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
                      className="w-full text-sm bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 outline-none focus:border-blue-400 resize-none text-slate-200 placeholder-slate-600"
                    />
                    <div className="flex justify-end">
                      <button
                        onClick={handleComment}
                        className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 transition font-medium"
                      >
                        Comment
                      </button>
                    </div>
                  </div>
                )}
              </div>

            </div>
          ) : (
            <CardMovementTimeline boardId={board.id} cardId={card.id} columnIds={new Set(board.columns.map((c) => c.id))} userDateFormat={userDateFormat} userTimeFormat={userTimeFormat} />
          )}
          </div>
          {/* Scroll affordance — fade gradient at bottom signals more content below */}
          <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-slate-800 to-transparent pointer-events-none" />
        </div>

        {/* Footer */}
        {canEdit && (
          <div className="px-5 py-3 border-t border-slate-700 flex items-center justify-between">
            <button onClick={handleArchive} className="text-xs text-slate-500 hover:text-amber-400 transition">
              Archive card
            </button>
            <button onClick={handleDelete} className="text-xs text-slate-600 hover:text-red-400 transition">
              Delete card
            </button>
          </div>
        )}
      </div>

      {/* Delete / Archive confirmation overlay */}
      {confirmAction && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]">
          <div className="bg-slate-800 rounded-xl p-6 w-full max-w-sm shadow-xl border border-slate-700">
            {confirmAction === "delete" ? (
              <>
                <h3 className="text-white font-semibold text-base mb-2">Delete this card?</h3>
                <p className="text-slate-400 text-sm mb-5">This cannot be undone.</p>
                <div className="flex gap-3 justify-end">
                  <button onClick={() => setConfirmAction(null)} className="text-slate-400 text-sm hover:text-white px-3 py-1.5 transition">Cancel</button>
                  <button onClick={executeDelete} className="bg-red-600 hover:bg-red-700 text-white text-sm px-4 py-1.5 rounded-lg transition">Delete</button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-white font-semibold text-base mb-2">Archive this card?</h3>
                <p className="text-slate-400 text-sm mb-5">It will be hidden from the board but can be restored from the Archived panel.</p>
                <div className="flex gap-3 justify-end">
                  <button onClick={() => setConfirmAction(null)} className="text-slate-400 text-sm hover:text-white px-3 py-1.5 transition">Cancel</button>
                  <button onClick={executeArchive} className="bg-amber-600 hover:bg-amber-700 text-white text-sm px-4 py-1.5 rounded-lg transition">Archive</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
