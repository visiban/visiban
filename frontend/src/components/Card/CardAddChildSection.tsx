import { useRef, useState } from "react";
import type { BoardFull } from "../../types";
import AddChildDialog from "./AddChildDialog";

interface Props {
  board: Pick<BoardFull, "id" | "name" | "cards_can_have_children" | "current_user_role">;
  cardId: number;
}

/**
 * The "Add child" entry on a card of a parent-tier board (#2208). Renders nothing for a board whose cards
 * cannot have children and for roles below member; the server enforces the same two rules. The Children tab
 * and rollup are #2209/#2210.
 */
export default function CardAddChildSection({ board, cardId }: Props) {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const role = board.current_user_role;
  const canAdd = role === "site_admin" || role === "admin" || role === "member";
  if (!board.cards_can_have_children || !canAdd) return null;

  return (
    <>
      <div className="flex flex-col gap-1">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => { setAdded(null); setOpen(true); }}
          className="self-start min-h-11 sm:min-h-0 px-3 py-1.5 text-sm text-info border border-line rounded hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Add child
        </button>
        <p role="status" aria-live="polite" className={added ? "text-xs text-fg-muted" : "sr-only"}>{added}</p>
      </div>
      {open && (
        <AddChildDialog
          boardId={board.id}
          boardName={board.name}
          cardId={cardId}
          onClose={() => { setOpen(false); queueMicrotask(() => buttonRef.current?.focus()); }}
          onAdded={({ boardName, title }) => {
            setOpen(false);
            setAdded(`Added "${title}" to ${boardName}.`);
            queueMicrotask(() => buttonRef.current?.focus());
          }}
        />
      )}
      <div className="border-t border-line" />
    </>
  );
}
