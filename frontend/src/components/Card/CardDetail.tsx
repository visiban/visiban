import { useEffect, useRef, useState } from "react";
import type { BoardFull, Card, CardAttachment, CardComment, Label, Priority } from "../../types";
import { userDisplayName } from "../../types";
import { deleteCard, getCardComments, addCardComment, updateCard, getCardAttachments, uploadCardAttachment, deleteCardAttachment } from "../../api/cards";
import type { CardPatch } from "../../api/cards";
import { createLabel } from "../../api/boards";
import CardMovementTimeline from "./CardMovementTimeline";

interface Props {
  card: Card;
  board: BoardFull;
  onClose: () => void;
  onDeleted: (id: number) => void;
  onUpdated: (card: Card) => void;
  onLabelAdded: (label: Label) => void;
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
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getCardComments(board.id, card.id).then(setComments);
    getCardAttachments(board.id, card.id).then(setAttachments);
  }, [board.id, card.id]);

  const save = async (patch: CardPatch) => {
    const updated = await updateCard(board.id, localCard.id, patch);
    setLocalCard(updated);
    onUpdated(updated);
  };

  const handleTitleBlur = () => {
    if (localCard.title.trim()) save({ title: localCard.title.trim() });
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

  const handleCreateLabel = async () => {
    if (!newLabelName.trim()) return;
    const label = await createLabel(board.id, { name: newLabelName.trim(), color: newLabelColor });
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

  const handleDelete = async () => {
    if (!confirm("Delete this card?")) return;
    await deleteCard(board.id, card.id);
    onDeleted(card.id);
  };

  const column = board.columns.find((c) => c.id === localCard.column);
  const swimlane = board.swimlanes.find((s) => s.id === localCard.swimlane);

  // Merge board labels with any on the card not yet in board list
  const allLabels = [...board.labels];
  localCard.labels.forEach((l) => {
    if (!allLabels.find((bl) => bl.id === l.id)) allLabels.push(l);
  });

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />

      <div ref={panelRef} className="w-[480px] bg-white shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <div className="flex-1 min-w-0">
            <input
              value={localCard.title}
              onChange={(e) => setLocalCard((c) => ({ ...c, title: e.target.value }))}
              onBlur={handleTitleBlur}
              className="text-lg font-semibold text-gray-900 w-full outline-none border-b border-transparent focus:border-blue-400 bg-transparent"
            />
            <p className="text-xs text-gray-400 mt-0.5">
              {swimlane?.name} · {column?.name}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
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

              {/* Priority */}
              <div>
                <p className="text-xs text-gray-400 mb-2">Priority</p>
                <div className="flex gap-1.5">
                  {PRIORITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => { setLocalCard((c) => ({ ...c, priority: opt.value })); save({ priority: opt.value }); }}
                      className={`text-xs px-3 py-1 rounded-full border-2 font-medium transition ${
                        localCard.priority === opt.value
                          ? "text-white border-transparent"
                          : "text-gray-500 border-gray-200 hover:border-gray-300 bg-white"
                      }`}
                      style={localCard.priority === opt.value ? { backgroundColor: opt.color, borderColor: opt.color } : {}}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Weight */}
              <div>
                <p className="text-xs text-gray-400 mb-1">Weight</p>
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

              {/* Due date */}
              <div>
                <p className="text-xs text-gray-400 mb-1">Due date</p>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={localCard.due_date ?? ""}
                    onChange={(e) => {
                      const v = e.target.value || null;
                      setLocalCard((c) => ({ ...c, due_date: v }));
                      save({ due_date: v });
                    }}
                    className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400"
                  />
                  {localCard.due_date && (
                    <button
                      onClick={() => { setLocalCard((c) => ({ ...c, due_date: null })); save({ due_date: null }); }}
                      className="text-xs text-gray-400 hover:text-red-500 transition"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Assignee */}
              <div>
                <p className="text-xs text-gray-400 mb-1">Assignee</p>
                <select
                  value={localCard.assignee?.id ?? ""}
                  onChange={(e) => {
                    const id = e.target.value ? Number(e.target.value) : null;
                    save({ assignee_id: id });
                  }}
                  className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 w-full"
                >
                  <option value="">Unassigned</option>
                  {board.members.map((m) => (
                    <option key={m.user.id} value={m.user.id}>
                      {userDisplayName(m.user)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Labels */}
              <div>
                <p className="text-xs text-gray-400 mb-2">Labels</p>
                <div className="flex flex-wrap gap-1.5">
                  {allLabels.map((label) => {
                    const active = localCard.labels.some((l) => l.id === label.id);
                    return (
                      <button
                        key={label.id}
                        onClick={() => toggleLabel(label)}
                        className={`text-xs px-2.5 py-1 rounded-full border-2 font-medium transition ${
                          active ? "text-white border-transparent" : "bg-white border-gray-200 hover:border-gray-300"
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
                            onClick={() => setNewLabelColor(c)}
                            className={`w-5 h-5 rounded-full border-2 transition ${newLabelColor === c ? "border-gray-800 scale-110" : "border-transparent"}`}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                      <button onClick={handleCreateLabel} className="text-xs text-blue-600 hover:text-blue-700 font-medium">Add</button>
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

              {/* Description */}
              <div>
                <p className="text-xs text-gray-400 mb-1">Description</p>
                <textarea
                  value={localCard.description ?? ""}
                  onChange={(e) => setLocalCard((c) => ({ ...c, description: e.target.value }))}
                  onBlur={handleDescriptionBlur}
                  placeholder="Add a description…"
                  rows={3}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-400 resize-none"
                />
              </div>

              {/* Attachments */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-gray-400">Attachments</p>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium disabled:opacity-50"
                  >
                    {uploading ? "Uploading…" : "+ Upload"}
                  </button>
                  <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />
                </div>
                {attachments.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">No attachments yet.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {attachments.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                        <span className="text-gray-400 text-sm">📎</span>
                        <div className="flex-1 min-w-0">
                          <a
                            href={a.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm text-blue-600 hover:underline truncate block"
                          >
                            {a.filename}
                          </a>
                          <p className="text-xs text-gray-400">
                            {(a.size / 1024).toFixed(1)} KB · {new Date(a.uploaded_at).toLocaleDateString()}
                          </p>
                        </div>
                        <button
                          onClick={() => handleDeleteAttachment(a.id)}
                          className="text-gray-300 hover:text-red-500 transition text-xs shrink-0"
                          title="Delete attachment"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Comments */}
              <div>
                <p className="text-xs text-gray-400 mb-2">Comments</p>
                <div className="flex flex-col gap-2 mb-3">
                  {comments.map((c) => (
                    <div key={c.id} className="bg-gray-50 rounded-lg px-3 py-2">
                      <p className="text-xs text-gray-400 mb-0.5">
                        {c.author ? userDisplayName(c.author) : null} · {new Date(c.created_at).toLocaleDateString()}
                      </p>
                      <p className="text-sm text-gray-700">{c.body}</p>
                    </div>
                  ))}
                </div>
                <textarea
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                  placeholder="Add a comment…"
                  rows={2}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-400 resize-none"
                />
                <button
                  onClick={handleComment}
                  className="mt-1.5 text-sm bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition"
                >
                  Comment
                </button>
              </div>

            </div>
          ) : (
            <CardMovementTimeline boardId={board.id} cardId={card.id} />
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100">
          <button onClick={handleDelete} className="text-sm text-red-500 hover:text-red-700 transition">
            Delete card
          </button>
        </div>
      </div>
    </div>
  );
}
