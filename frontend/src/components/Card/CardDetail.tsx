import { useEffect, useRef, useState } from "react";
import type { BoardFull, Card, CardComment } from "../../types";
import { deleteCard, getCardComments, addCardComment, updateCard } from "../../api/cards";
import CardMovementTimeline from "./CardMovementTimeline";

interface Props {
  card: Card;
  board: BoardFull;
  onClose: () => void;
  onDeleted: (id: number) => void;
}

const PRIORITY_LABELS = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

export default function CardDetail({ card, board, onClose, onDeleted }: Props) {
  const [comments, setComments] = useState<CardComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [tab, setTab] = useState<"details" | "history">("details");
  const [title, setTitle] = useState(card.title);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getCardComments(board.id, card.id).then(setComments);
  }, [board.id, card.id]);

  const handleTitleBlur = () => {
    if (title !== card.title && title.trim()) {
      updateCard(board.id, card.id, { title: title.trim() });
    }
  };

  const handleComment = async () => {
    if (!commentBody.trim()) return;
    const c = await addCardComment(board.id, card.id, commentBody.trim());
    setComments((prev) => [...prev, c]);
    setCommentBody("");
  };

  const handleDelete = async () => {
    if (!confirm("Delete this card?")) return;
    await deleteCard(board.id, card.id);
    onDeleted(card.id);
  };

  const column = board.columns.find((c) => c.id === card.column);
  const customer = board.customers.find((c) => c.id === card.customer);

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div ref={panelRef} className="w-[480px] bg-white shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <div className="flex-1 min-w-0">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={handleTitleBlur}
              className="text-lg font-semibold text-gray-900 w-full outline-none border-b border-transparent focus:border-blue-400 bg-transparent"
            />
            <p className="text-xs text-gray-400 mt-0.5">
              {customer?.name} · {column?.name}
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
            <div className="flex flex-col gap-4">
              {/* Meta */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-gray-400 mb-1">Priority</p>
                  <span className="font-medium text-gray-700">{PRIORITY_LABELS[card.priority]}</span>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Due date</p>
                  <span className="font-medium text-gray-700">{card.due_date ?? "—"}</span>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Assignee</p>
                  <span className="font-medium text-gray-700">
                    {card.assignee ? (card.assignee.first_name || card.assignee.username) : "—"}
                  </span>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Labels</p>
                  <div className="flex flex-wrap gap-1">
                    {card.labels.length > 0
                      ? card.labels.map((l) => (
                          <span key={l.id} className="text-xs px-1.5 py-0.5 rounded-full text-white" style={{ backgroundColor: l.color }}>
                            {l.name}
                          </span>
                        ))
                      : <span className="text-gray-700">—</span>}
                  </div>
                </div>
              </div>

              {/* Description */}
              {card.description && (
                <div>
                  <p className="text-xs text-gray-400 mb-1">Description</p>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{card.description}</p>
                </div>
              )}

              {/* Comments */}
              <div>
                <p className="text-xs text-gray-400 mb-2">Comments</p>
                <div className="flex flex-col gap-2 mb-3">
                  {comments.map((c) => (
                    <div key={c.id} className="bg-gray-50 rounded-lg px-3 py-2">
                      <p className="text-xs text-gray-400 mb-0.5">
                        {c.author?.first_name || c.author?.username} · {new Date(c.created_at).toLocaleDateString()}
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
          <button
            onClick={handleDelete}
            className="text-sm text-red-500 hover:text-red-700 transition"
          >
            Delete card
          </button>
        </div>
      </div>
    </div>
  );
}
