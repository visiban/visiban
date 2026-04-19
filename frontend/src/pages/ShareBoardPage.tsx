import { Fragment, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getPublicBoard } from "../api/boards";
import type { BoardPublic, PublicCard, Column, Swimlane, Label } from "../types";
import { PRIORITY_COLORS } from "../constants/colors";
import ShareBoardHeader from "../components/Board/ShareBoardHeader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function priorityColor(priority: string): string {
  return PRIORITY_COLORS[priority as keyof typeof PRIORITY_COLORS] ?? "#6B7280";
}

// ---------------------------------------------------------------------------
// StaticCardItem — read-only card tile (no DnD, no onClick)
// ---------------------------------------------------------------------------

interface StaticCardItemProps {
  card: PublicCard;
  labels: Label[];
}

function StaticCardItem({ card, labels }: StaticCardItemProps) {
  const cardLabels = labels.filter((l) => card.labels.some((cl) => cl.id === l.id));
  const color = priorityColor(card.priority);

  return (
    <div
      className="bg-surface rounded-md border relative cursor-default select-none"
      style={{
        borderColor: color,
        boxShadow: "0 2px 0 rgba(0,0,0,0.45), 0 1px 6px rgba(0,0,0,0.25)",
      }}
      data-testid="share-card"
    >
      <div className="px-2.5 py-2">
        <p className="text-sm text-fg leading-snug line-clamp-2">{card.title}</p>
        {/* Metadata row */}
        {(cardLabels.length > 0 || card.due_date || card.assignee || card.checklist_total > 0 || card.weight > 1) && (
          <div className="flex items-center gap-1 mt-1.5 overflow-hidden flex-wrap">
            {cardLabels.slice(0, 3).map((label) => {
              const display = label.name.length > 8 ? label.name.slice(0, 7) + "…" : label.name;
              return (
                <span
                  key={label.id}
                  className="text-[9px] font-semibold px-1 py-0.5 rounded leading-none shrink-0"
                  style={{ backgroundColor: label.color + "22", color: label.color, border: `1px solid ${label.color}44` }}
                  title={label.name}
                >
                  {display}
                </span>
              );
            })}
            {card.checklist_total > 0 && (
              <span
                className={`text-[10px] font-medium shrink-0 ${
                  card.checklist_done === card.checklist_total ? "text-success" : "text-fg-tertiary"
                }`}
              >
                ✓{card.checklist_done}/{card.checklist_total}
              </span>
            )}
            {card.due_date && (
              <span className="text-[10px] text-fg-tertiary shrink-0">
                {card.due_date}
              </span>
            )}
            {card.weight > 1 && (
              <span className="text-[10px] text-fg-secondary font-medium shrink-0" title={`Weight: ${card.weight}`}>
                {card.weight}
              </span>
            )}
            {card.assignee && (
              <span className="text-[10px] text-fg-tertiary shrink-0 truncate max-w-[5rem]" title={card.assignee.display_name}>
                {card.assignee.display_name}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Static swimlane label panel
// ---------------------------------------------------------------------------

function StaticSwimlaneSidebar({ swimlane }: { swimlane: Swimlane }) {
  return (
    <div
      className="bg-surface flex items-center px-3 py-2 min-w-0"
      style={{ borderLeft: `4px solid ${swimlane.color}` }}
    >
      <span className="text-sm text-fg-secondary truncate" title={swimlane.name}>{swimlane.name}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Static column header
// ---------------------------------------------------------------------------

function StaticColumnHeader({ column, cardCount }: { column: Column; cardCount: number }) {
  return (
    <div className="bg-surface px-2 py-2 flex items-center gap-1.5 min-w-0">
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: column.color }} />
      <span className="text-sm font-medium text-fg truncate flex-1" title={column.name}>{column.name}</span>
      <span className="text-xs text-fg-muted shrink-0">{cardCount}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Static board grid — no DndContext needed
// ---------------------------------------------------------------------------

function StaticBoardGrid({ board }: { board: BoardPublic }) {
  const columns = [...board.columns].sort((a, b) => a.position - b.position);
  const swimlanes = [...board.swimlanes].sort((a, b) => a.position - b.position);

  const cardsAt = (colId: number, laneId: number): PublicCard[] =>
    board.cards
      .filter((c) => c.column === colId && c.swimlane === laneId)
      .sort((a, b) => a.position - b.position);

  const colCardCount = (colId: number) => board.cards.filter((c) => c.column === colId).length;

  const colW = 220;
  const labelW = 160;

  return (
    <div className="overflow-auto flex-1">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `${labelW}px repeat(${columns.length}, ${colW}px)`,
          gridTemplateRows: `auto repeat(${swimlanes.length}, auto)`,
        }}
      >
        {/* Top-left corner */}
        <div className="bg-surface border-b border-r border-line-subtle px-2 py-1 text-xs text-fg-muted">
          {swimlanes.length} lane{swimlanes.length !== 1 ? "s" : ""} · {board.cards.length} card{board.cards.length !== 1 ? "s" : ""}
        </div>

        {/* Column headers */}
        {columns.map((col) => (
          <div key={col.id} className="border-b border-r border-line-subtle">
            <StaticColumnHeader column={col} cardCount={colCardCount(col.id)} />
          </div>
        ))}

        {/* Swimlane rows */}
        {swimlanes.map((lane) => (
          <Fragment key={lane.id}>
            {/* Swimlane label */}
            <div className="border-b border-r border-line-subtle">
              <StaticSwimlaneSidebar swimlane={lane} />
            </div>

            {/* Cells */}
            {columns.map((col) => {
              const cellCards = cardsAt(col.id, lane.id);
              return (
                <div
                  key={`cell-${col.id}-${lane.id}`}
                  className="bg-canvas border-b border-r border-line-subtle p-1.5 flex flex-col gap-1.5 min-h-[80px]"
                >
                  {cellCards.map((card) => (
                    <StaticCardItem key={card.uid} card={card} labels={board.labels} />
                  ))}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShareBoardPage
// ---------------------------------------------------------------------------

/**
 * Public read-only board view served at /share/:token.
 * No authentication required. Uses getPublicBoard() which hits GET /api/share/<token>/.
 */
export default function ShareBoardPage() {
  const { token } = useParams<{ token: string }>();
  const [board, setBoard] = useState<BoardPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (!token) return;
    getPublicBoard(token)
      .then(setBoard)
      .catch(() => setExpired(true))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <span className="w-8 h-8 border-2 border-primary-emphasis border-t-transparent rounded-full animate-spin" aria-label="Loading" />
      </div>
    );
  }

  if (expired || !board) {
    return <ShareExpiredPage />;
  }

  return (
    <div className="flex flex-col min-h-screen bg-canvas" data-testid="share-board-page">
      <ShareBoardHeader boardName={board.name} />
      <StaticBoardGrid board={board} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShareExpiredPage — inline (can be split to its own file later)
// ---------------------------------------------------------------------------

/**
 * Shown when the share token is revoked, missing, or the board is deleted.
 * Follows the JoinPage invalid-state layout: centered message, primary CTA.
 */
function ShareExpiredPage() {
  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center" data-testid="share-expired-page">
      <div className="flex flex-col items-center gap-4 max-w-sm text-center px-4">
        <svg className="w-12 h-12 text-fg-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h16.5a.75.75 0 00.75-.75V10.5a.75.75 0 00-.75-.75H3.75a.75.75 0 00-.75.75v10.5c0 .414.336.75.75.75z" />
        </svg>
        <h1 className="text-xl font-semibold text-fg">This board is no longer shared</h1>
        <p className="text-sm text-fg-tertiary">
          The share link has been revoked or the board has been deleted.
        </p>
        <a
          href="/"
          className="bg-primary hover:bg-primary-hover text-on-primary px-4 py-2 rounded text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Sign in to Visiban
        </a>
      </div>
    </div>
  );
}

export { ShareExpiredPage };
