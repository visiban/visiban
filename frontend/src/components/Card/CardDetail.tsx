import { useEffect, useRef, useState } from "react";
import type { BoardFull, Card, CardAttachment, CardChecklistItem, CardComment, Label, Priority } from "../../types";
import { userDisplayName } from "../../types";
import { deleteCard, getCardComments, addCardComment, updateCard, getCardAttachments, uploadCardAttachment, deleteCardAttachment, getChecklist, addChecklistItem, updateChecklistItem, deleteChecklistItem } from "../../api/cards";
import type { CardPatch } from "../../api/cards";
import { createLabel } from "../../api/boards";
import CardMovementTimeline from "./CardMovementTimeline";
import MentionTextarea from "./MentionTextarea";

interface Props {
  card: Card;
  board: BoardFull;
  onClose: () => void;
  onDeleted: (id: number) => void;
  onUpdated: (card: Card) => void;
  onLabelAdded: (label: Label) => void;
}

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

const PRIORITY_OPTIONS: { value: Priority; label: string; color: string }[] = [
  { value: "low",    label: "Low",    color: "#6B7280" },
  { value: "medium", label: "Medium", color: "#3B82F6" },
  { value: "high",   label: "High",   color: "#F59E0B" },
  { value: "urgent", label: "Urgent", color: "#EF4444" },
];

const LABEL_COLORS = ["#6B7280", "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6"];

export default function CardDetail({ card, board, onClose, onDeleted, onUpdated, onLabelAdded }: Props) {
  const [localCard, setLocalCard] = useState<Card>(card);
  const [comments, setComments] = useState<CardComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [tab, setTab] = useState<"details" | "history">("details");
  const [addingLabel, setAddingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState(LABEL_COLORS[0]);
  const [attachments, setAttachments] = useState<CardAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [checklist, setChecklist] = useState<CardChecklistItem[]>([]);
  const [newItemText, setNewItemText] = useState("");
  const [showBulkAdd, setShowBulkAdd] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getCardComments(board.id, card.id).then(setComments);
    getCardAttachments(board.id, card.id).then(setAttachments);
    getChecklist(board.id, card.id).then(setChecklist);
  }, [board.id, card.id]);

  // Escape closes the panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const save = async (patch: CardPatch) => {
    const updated = await updateCard(board.id, localCard.id, patch);
    setLocalCard(updated);
    onUpdated(updated);
  };

  const handleTitleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = localCard.title.trim();
      if (trimmed) {
        await save({ title: trimmed });
        onClose();
      }
    } else if (e.key === "Escape") {
      setLocalCard((c) => ({ ...c, title: card.title }));
      (e.target as HTMLInputElement).blur();
    }
  };

  const handleDescriptionBlur = () => {
    save({ description: localCard.description });
  };

  const toggleLabel = async (label: Label) => {
    const has = localCard.labels.some((l) => l.id === label.id);
    const newLabels = has
      ? localCard.labels.filter((l) => l.id !== label.id)
      : [...localCard.labels, label];
    setLocalCard((c) => ({ ...c, labels: newLabels }));
    const updated = await updateCard(board.id, localCard.id, { label_ids: newLabels.map((l) => l.id) });
    setLocalCard(updated);
    onUpdated(updated);
  };

  const handleCreateLabel = async (colorOverride?: string) => {
    if (!newLabelName.trim()) return;
    const color = colorOverride ?? newLabelColor;
    const label = await createLabel(board.id, { name: newLabelName.trim(), color });
    onLabelAdded(label);
    const updatedLabelIds = [...localCard.labels.map((l) => l.id), label.id];
    const updated = await updateCard(board.id, localCard.id, { label_ids: updatedLabelIds });
    setLocalCard(updated);
    onUpdated(updated);
    setNewLabelName("");
    setAddingLabel(false);
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

  const handleDelete = async () => {
    if (!confirm("Delete this card?")) return;
    await deleteCard(board.id, card.id);
    onDeleted(card.id);
  };

  const column = board.columns.find((c) => c.id === localCard.column);
  const swimlane = board.swimlanes.find((s) => s.id === localCard.swimlane);

  const role = board.current_user_role;
  const canEdit = role === "site_admin" || role === "admin" || role === "member";
  const canComment = canEdit || role === "collaborator";

  // Merge board labels with any on the card not yet in board list
  const allLabels = [...board.labels];
  localCard.labels.forEach((l) => {
    if (!allLabels.find((bl) => bl.id === l.id)) allLabels.push(l);
  });

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />

      <div ref={panelRef} className="w-[540px] bg-white shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-gray-100">
          <div className="flex-1 min-w-0">
            <input
              value={localCard.title}
              onChange={(e) => setLocalCard((c) => ({ ...c, title: e.target.value }))}
              onKeyDown={handleTitleKeyDown}
              className="text-base font-semibold text-gray-900 w-full outline-none rounded px-1 -ml-1 border border-transparent focus:border-blue-400 focus:bg-blue-50/30 bg-transparent transition"
            />
            <p className="text-[11px] text-gray-400 mt-1 px-1">
              {swimlane?.name} <span className="mx-1 text-gray-300">›</span> {column?.name}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition text-lg leading-none shrink-0"
            title="Close"
          >×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 text-sm">
          {(["details", "history"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-2.5 font-medium capitalize ${
                tab === t ? "border-b-2 border-blue-500 text-blue-600" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === "details" ? (
            <div className="flex flex-col gap-5">

              {/* Description */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Description</p>
                <textarea
                  value={localCard.description ?? ""}
                  onChange={(e) => setLocalCard((c) => ({ ...c, description: e.target.value }))}
                  onBlur={handleDescriptionBlur}
                  placeholder="Add a description…"
                  rows={3}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-400 resize-none text-gray-700 placeholder-gray-300"
                />
              </div>

              <div className="border-t border-gray-100" />

              {/* Assignee + Due date (side by side) */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Assignee</p>
                  <select
                    value={localCard.assignee?.id ?? ""}
                    onChange={(e) => {
                      const id = e.target.value ? Number(e.target.value) : null;
                      save({ assignee_id: id });
                    }}
                    className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 w-full text-gray-700 bg-white"
                  >
                    <option value="">Unassigned</option>
                    {board.members.map((m) => (
                      <option key={m.user.id} value={m.user.id}>
                        {userDisplayName(m.user)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Due date</p>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="date"
                      value={localCard.due_date ?? ""}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => {
                        const v = e.target.value || null;
                        setLocalCard((c) => ({ ...c, due_date: v }));
                        save({ due_date: v });
                      }}
                      className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 w-full text-gray-700"
                    />
                    {localCard.due_date && (
                      <button
                        onClick={() => { setLocalCard((c) => ({ ...c, due_date: null })); save({ due_date: null }); }}
                        className="text-gray-300 hover:text-red-400 transition text-xs shrink-0"
                        title="Clear due date"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Priority */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Priority</p>
                <div className="flex gap-1.5">
                  {PRIORITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => { setLocalCard((c) => ({ ...c, priority: opt.value })); save({ priority: opt.value }); }}
                      className={`text-xs px-3 py-1 rounded-full border font-medium transition ${
                        localCard.priority === opt.value
                          ? "text-white border-transparent shadow-sm"
                          : "text-gray-500 border-gray-200 hover:border-gray-300 bg-white"
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
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Labels</p>
                <div className="flex flex-wrap gap-1.5">
                  {allLabels.map((label) => {
                    const active = localCard.labels.some((l) => l.id === label.id);
                    return (
                      <button
                        key={label.id}
                        onClick={() => toggleLabel(label)}
                        className={`text-xs px-2.5 py-1 rounded-full border font-medium transition ${
                          active ? "text-white border-transparent shadow-sm" : "bg-white border-gray-200 hover:border-gray-300"
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
                    <div className="flex items-center gap-1.5 flex-wrap mt-1">
                      <input
                        autoFocus
                        value={newLabelName}
                        onChange={(e) => setNewLabelName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleCreateLabel(); if (e.key === "Escape") setAddingLabel(false); }}
                        placeholder="Label name"
                        className="text-xs border border-blue-400 rounded-full px-2.5 py-1 outline-none w-28"
                      />
                      <div className="flex gap-1">
                        {LABEL_COLORS.map((c) => (
                          <button
                            key={c}
                            onClick={() => { setNewLabelColor(c); if (newLabelName.trim()) handleCreateLabel(c); }}
                            className={`w-5 h-5 rounded-full border-2 transition ${newLabelColor === c ? "border-gray-800 scale-110" : "border-transparent"}`}
                            style={{ backgroundColor: c }}
                            title={newLabelName.trim() ? `Create "${newLabelName.trim()}" with this color` : "Pick color"}
                          />
                        ))}
                      </div>
                      {!newLabelName.trim() && (
                        <span className="text-[10px] text-gray-400">type a name first</span>
                      )}
                      <button onClick={() => setAddingLabel(false)} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setAddingLabel(true)}
                      className="text-xs text-gray-400 hover:text-gray-600 border border-dashed border-gray-300 rounded-full px-2.5 py-1 transition"
                    >
                      + New label
                    </button>
                  )}
                </div>
              </div>

              {/* Weight */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Weight</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { const w = Math.max(1, localCard.weight - 1); setLocalCard((c) => ({ ...c, weight: w })); save({ weight: w }); }}
                    className="w-7 h-7 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-100 transition text-sm font-medium"
                  >−</button>
                  <span className="text-sm font-semibold text-gray-700 w-6 text-center">{localCard.weight}</span>
                  <button
                    onClick={() => { const w = localCard.weight + 1; setLocalCard((c) => ({ ...c, weight: w })); save({ weight: w }); }}
                    className="w-7 h-7 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-100 transition text-sm font-medium"
                  >+</button>
                </div>
              </div>

              <div className="border-t border-gray-100" />

              {/* Checklist */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    Checklist
                    {checklist.length > 0 && (
                      <span className="ml-1.5 normal-case font-normal text-gray-500">{checklist.filter((i) => i.is_checked).length}/{checklist.length}</span>
                    )}
                  </p>
                </div>
                {checklist.length > 0 && (
                  <>
                    <div className="h-1 bg-gray-100 rounded-full mb-3 overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full transition-all"
                        style={{ width: `${Math.round((checklist.filter((i) => i.is_checked).length / checklist.length) * 100)}%` }}
                      />
                    </div>
                    <div className="flex flex-col gap-1 mb-3">
                      {checklist.map((item) => (
                        <div key={item.id} className="flex items-center gap-2 group px-1 py-0.5 rounded hover:bg-gray-50">
                          <input
                            type="checkbox"
                            checked={item.is_checked}
                            onChange={() => handleToggleChecklistItem(item)}
                            className="w-3.5 h-3.5 rounded accent-green-500 shrink-0 cursor-pointer"
                          />
                          <span className={`text-sm flex-1 ${item.is_checked ? "line-through text-gray-300" : "text-gray-700"}`}>
                            {item.text}
                          </span>
                          <button
                            onClick={() => handleDeleteChecklistItem(item.id)}
                            className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition text-xs shrink-0"
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
                    className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 text-gray-700 placeholder-gray-300"
                  />
                  <button
                    onClick={() => { setBulkText(""); setShowBulkAdd(true); }}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium px-2 whitespace-nowrap"
                  >
                    Bulk
                  </button>
                </div>

                {showBulkAdd && (
                  <div className="fixed inset-0 z-[60] flex items-center justify-center">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setShowBulkAdd(false)} />
                    <div className="relative bg-white rounded-xl shadow-2xl w-80 p-5 flex flex-col gap-4">
                      <h3 className="text-sm font-semibold text-gray-800">Add checklist items</h3>
                      <p className="text-xs text-gray-400 -mt-2">One item per line</p>
                      <textarea
                        autoFocus
                        value={bulkText}
                        onChange={(e) => setBulkText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleBulkAdd(); if (e.key === "Escape") setShowBulkAdd(false); }}
                        placeholder={"Buy milk\nCall client\nReview PR"}
                        rows={6}
                        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-400 resize-none"
                      />
                      <div className="flex justify-end gap-2">
                        <button onClick={() => setShowBulkAdd(false)} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5">Cancel</button>
                        <button onClick={handleBulkAdd} className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 transition">Add items</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-gray-100" />

              {/* Attachments */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Attachments</p>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium disabled:opacity-50 transition"
                  >
                    {uploading ? "Uploading…" : "+ Upload"}
                  </button>
                  <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />
                </div>
                {attachments.length === 0 ? (
                  <p className="text-xs text-gray-300 italic">No attachments.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {attachments.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2 group">
                        <span className="text-gray-300 text-sm shrink-0">📎</span>
                        <div className="flex-1 min-w-0">
                          <a href={a.url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:underline truncate block">
                            {a.filename}
                          </a>
                          <p className="text-xs text-gray-400">{(a.size / 1024).toFixed(1)} KB · {new Date(a.uploaded_at).toLocaleDateString()}</p>
                        </div>
                        <button
                          onClick={() => handleDeleteAttachment(a.id)}
                          className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition text-xs shrink-0"
                          title="Delete"
                        >✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-gray-100" />

              {/* Comments */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-3">
                  Comments {comments.length > 0 && <span className="normal-case font-normal text-gray-400">({comments.length})</span>}
                </p>
                <div className="flex flex-col gap-3 mb-3">
                  {comments.map((c) => {
                    const authorName = c.author ? userDisplayName(c.author) : "Unknown";
                    const authorInitials = authorName.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
                    return (
                      <div key={c.id} className="flex gap-2.5">
                        <span className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-600 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                          {authorInitials}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2 mb-1">
                            <span className="text-xs font-semibold text-gray-700">{authorName}</span>
                            <span className="text-[10px] text-gray-400" title={new Date(c.created_at).toLocaleString()}>{formatCommentTime(c.created_at)}</span>
                          </div>
                          <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-700 leading-relaxed">
                            {c.body.split(/(@[\w.+-]+)/g).map((part, i) => // nosemgrep: regex_dos — hyphen is last in class (literal, not range); no nested quantifiers; false positive
                              /^@[\w.+-]+$/.test(part) // nosemgrep: regex_dos
                                ? <span key={i} className="font-semibold text-blue-600">{part}</span>
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
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-400 resize-none text-gray-700 placeholder-gray-300"
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
            <CardMovementTimeline boardId={board.id} cardId={card.id} />
          )}
        </div>

        {/* Footer */}
        {canEdit && (
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end">
            <button onClick={handleDelete} className="text-xs text-gray-300 hover:text-red-400 transition">
              Delete card
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
