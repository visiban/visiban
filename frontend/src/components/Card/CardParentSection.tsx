import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useInRouterContext } from "react-router-dom";
import { getCardParent, getParentBoards, unlinkCardParent } from "../../api/cards";
import type { BoardFull, Card, CardParent, ParentBoardOption } from "../../types";
import LockGlyph from "./LockGlyph";
import ParentCardPicker from "./ParentCardPicker";
import { parentSingular } from "../../utils/parentItemNames";
import { LINKED_CARD_HIDDEN, LINKED_CARD_HIDDEN_DETAIL, requestCardParentRefetch } from "./cardParent";

interface Props {
  board: BoardFull;
  /** The live card from the board store: `parent` is refreshed there on `card.parent_changed`. */
  card: Card;
  /** Member and above: the link and unlink writes need `member` on this board. */
  canEdit: boolean;
  /** Hosted demo (#1193): the link writes are not on DEMO_ALLOWED_WRITES. */
  demoMode?: boolean;
}


const UNLINK_CLASS =
  "shrink-0 min-h-11 px-2 py-1 text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40";

/**
 * The child side of a cross-board parent link, first in the card detail body
 * (#1104, canvas "The child's side").
 *
 * Shown only on a board that is not a parent board (two tiers: a parent
 * board's cards show Children, never Parent, #2209). When the card has no
 * parent, the row is offered only to a member+ viewer with at least one
 * parent board to pick from; otherwise nothing renders.
 *
 * Unlink asks nothing: it changes no column, history or WIP of this card, and
 * the link can be restored from the picker. It edits only this card, so it is
 * offered for a parent the viewer can't open too.
 */
export default function CardParentSection({ board, card, canEdit, demoMode = false }: Props) {
  const inRouter = useInRouterContext();
  // A leftover parent on a board whose switch was turned off (#2446) is a parent, not a child: the
  // server offers it no parent board (a card is never both), so it gets no Parent row.
  const childBoard = !board.cards_can_have_children && card.children_rollup === undefined;
  const canWrite = canEdit && !demoMode && childBoard;
  const [parentBoards, setParentBoards] = useState<ParentBoardOption[]>([]);
  // What this panel just wrote, until the store's re-read replaces `card.parent`.
  const [override, setOverride] = useState<{ value: CardParent | null; base: CardParent | null | undefined } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linkButtonRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterUnlink = useRef(false);
  const focusAfterLink = useRef(false);
  // The card panel, captured before an unlink that may unmount this whole
  // section (no parent board to offer): focus lands there, never on <body>.
  const focusFallback = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!canWrite) return;
    let live = true;
    // Started inside a then, so a synchronous throw lands in the catch too.
    Promise.resolve()
      .then(() => getParentBoards(board.id))
      .then((rows) => { if (live) setParentBoards(rows); })
      // Quiet on failure: the row is optional, and an empty list hides it.
      .catch(() => { if (live) setParentBoards([]); });
    return () => { live = false; };
  }, [board.id, canWrite]);

  // A store refresh (the re-read after a write, or another session's change)
  // supersedes the local override.
  const storeParent = card.parent;
  // Only some card surfaces carry `parent`; `undefined` means never read, not
  // "no parent", so it is read once here and nothing renders until it lands
  // (a false "Not linked" would offer to link a card that already has one).
  const [readParent, setReadParent] = useState<CardParent | null | undefined>(undefined);
  useEffect(() => {
    if (storeParent !== undefined || board.cards_can_have_children) return;
    let live = true;
    getCardParent(board.id, card.id).then((p) => { if (live) setReadParent(p); }).catch(() => {});
    return () => { live = false; };
  }, [storeParent, board.id, board.cards_can_have_children, card.id]);
  const parent: CardParent | null | undefined =
    override && override.base === storeParent ? override.value : (storeParent === undefined ? readParent : storeParent);

  // A layout effect, not a passive one or a frame later (#2608): the commit that swaps the row
  // removes the focused control (Unlink, or the picker's Link), so focus is on <body> until this
  // runs. A passive effect or a requestAnimationFrame left that window open past paint, long
  // enough on a slow machine for a screen reader (or a test) to land on <body>.
  useLayoutEffect(() => {
    if (focusAfterUnlink.current && parent === null) {
      focusAfterUnlink.current = false;
      (linkButtonRef.current ?? headingRef.current ?? focusFallback.current)?.focus();
    } else if (focusAfterLink.current && !pickerOpen && parent) {
      // The Link button unmounts with the empty row; land on the heading. Keyed on the picker
      // closing too: a store re-read can show the new parent before the link's response, and
      // then `parent` does not change in the commit that removes the picker.
      focusAfterLink.current = false;
      headingRef.current?.focus();
    }
  }, [parent, pickerOpen]);

  if (!childBoard || parent === undefined) return null;
  const offerLink = parent === null && canWrite && parentBoards.length > 0;
  if (parent === null && !offerLink) return null;

  const unlink = async () => {
    if (unlinking) return;
    setUnlinking(true);
    setError(null);
    focusFallback.current = headingRef.current?.closest<HTMLElement>('[role="dialog"][tabindex]') ?? null;
    try {
      await unlinkCardParent(board.id, card.id);
      focusAfterUnlink.current = true;
      setOverride({ value: null, base: storeParent });
      requestCardParentRefetch([card.id]);
    } catch (err) {
      // 404: there was no parent any more (unlinked elsewhere); show that.
      if ((err as { response?: { status?: number } })?.response?.status === 404) {
        focusAfterUnlink.current = true;
        setOverride({ value: null, base: storeParent });
        requestCardParentRefetch([card.id]);
      } else {
        setError("Failed to unlink the parent. Please try again.");
      }
    } finally {
      setUnlinking(false);
    }
  };

  const headingId = `card-parent-heading-${card.id}`;
  return (
    <section aria-labelledby={headingId} data-testid="card-parent-section" className="flex flex-col gap-1.5">
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className="text-xs font-semibold uppercase tracking-wide text-fg-muted focus:outline-none">
        {parentSingular(parent && !parent.hidden ? parent.board_parent_name_singular : "")}
      </h3>

      {parent === null ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg-muted flex-1">Not linked</span>
          <button
            ref={linkButtonRef}
            type="button"
            onClick={() => { setError(null); setPickerOpen(true); }}
            className="min-h-11 px-3 py-1.5 text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Link a parent
          </button>
        </div>
      ) : parent.hidden ? (
        <div className="flex items-center gap-2 border border-dashed border-fg-tertiary rounded px-3 py-2" data-testid="card-parent-hidden">
          <LockGlyph className="w-4 h-4 shrink-0 text-fg-muted" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-fg-secondary">{LINKED_CARD_HIDDEN}</span>
            <span className="block text-xs text-fg-muted">{LINKED_CARD_HIDDEN_DETAIL}</span>
          </span>
          {canWrite && (
            <button type="button" onClick={() => void unlink()} disabled={unlinking} aria-label="Unlink the linked card you can't open" className={UNLINK_CLASS}>
              Unlink
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="flex-1 min-w-0">
            {/* Opens the parent on its own board; its column never changes this card's. Router
                navigation, no full page load; a bare render with no router (a unit test) keeps an anchor. */}
            {(() => {
              const to = `/boards/${parent.board_id}?card=${parent.id}`;
              const cls = `block text-sm text-info hover:underline truncate rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${parent.archived ? "line-through" : ""}`;
              return inRouter
                ? <Link to={to} title={parent.title} className={cls}>{parent.title}</Link>
                : <a href={to} title={parent.title} className={cls}>{parent.title}</a>;
            })()}
            <span className="block text-xs text-fg-muted truncate">
              {parent.board_name} › {parent.column_name}{parent.archived ? " · Archived" : ""}
            </span>
            {/* Canvas "2 of 5 siblings done" (#2443): counted by the server for this viewer, over
                this board only. Not shown for an only child, or by a server that sends no count. */}
            {typeof parent.siblings_total === "number" && parent.siblings_total > 1 && (
              <span className="block text-xs text-fg-muted" data-testid="card-parent-siblings">
                {parent.siblings_done ?? 0} of {parent.siblings_total} siblings done
              </span>
            )}
          </span>
          {canWrite && (
            <button type="button" onClick={() => void unlink()} disabled={unlinking} aria-label={`Unlink parent ${parent.title}`} className={UNLINK_CLASS}>
              Unlink
            </button>
          )}
        </div>
      )}

      {/* Always mounted, so a failure is announced (#1421). */}
      <p role="status" aria-live="polite" aria-atomic="true" className={error ? "text-xs text-danger" : "sr-only"}>{error ?? ""}</p>

      {pickerOpen && parentBoards.length > 0 && (
        <ParentCardPicker
          boardId={board.id}
          cardId={card.id}
          parentBoards={parentBoards}
          onClose={() => {
            setPickerOpen(false);
            linkButtonRef.current?.focus();
          }}
          onLinked={(linked) => {
            setPickerOpen(false);
            focusAfterLink.current = true;
            setOverride({ value: linked, base: storeParent });
            requestCardParentRefetch([card.id]);
          }}
        />
      )}
    </section>
  );
}
