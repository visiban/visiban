import { useEffect, useId, useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { blockCard, getCardBlocks, unblockCard } from "../../api/cards";
import type { Card, CardBlock } from "../../types";
import { blockedElapsedMs, formatBlockedDuration } from "../../utils/blockedState";
import { formatDateTimeUser, type UserDatePrefs } from "../../utils/date";

/** Matches `CardBlock.reason` / `resolution` max_length on the server. */
export const BLOCK_TEXT_MAX = 500;

const REASON_HELPER = "Say what the card is waiting on, so blocked time can be grouped by reason.";
const REASON_REQUIRED = "Enter a reason to block this card.";
const RESOLUTION_HELPER = "Optional. How the block was resolved.";

const ERROR_COPY: Record<string, string> = {
  card_already_blocked: "This card is already blocked. Close the form to see the current block.",
  card_not_blocked: "This card is no longer blocked.",
};

/** The server's message for a failed block/unblock, or a generic fallback. */
function errorCopy(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
  if (!data) return fallback;
  if (typeof data.code === "string" && ERROR_COPY[data.code]) return ERROR_COPY[data.code];
  for (const key of ["reason", "resolution"] as const) {
    const msgs = data[key];
    if (Array.isArray(msgs) && typeof msgs[0] === "string") return msgs[0];
  }
  return typeof data.detail === "string" ? data.detail : fallback;
}

export type BlockFormMode = "block" | "unblock" | null;

interface Props {
  boardId: number;
  /** The newest copy of the card: its blocked_at / blocked_reason drive the banner. */
  card: Card;
  /** Member+ with the edit (ownership) rule; viewers and collaborators only read. */
  canBlock: boolean;
  /** Owned by CardDetail, whose header hosts the Block… trigger. */
  formMode: BlockFormMode;
  onFormModeChange: (mode: BlockFormMode) => void;
  /** `useConfirmFocusReturn` ref for the banner's Unblock trigger. */
  unblockTriggerRef: (el: HTMLElement | null) => void;
  /** The server's card after a block or unblock. */
  onCardUpdated: (card: Card) => void;
  userPrefs?: UserDatePrefs | null;
  refreshSignal?: number;
}

/**
 * Manual blocked state in the card detail panel (#1149).
 *
 * Three parts, each rendered only when it applies:
 *
 * - **Block form** (`formMode === "block"`): an inline section in the sheet,
 *   not a modal, with a required reason. Escape closes it before the sheet
 *   (priority 42, frontend/CLAUDE.md § Escape priority inside the card detail
 *   panel); focus starts in Reason and returns to the header's Block… on
 *   Cancel (CardDetail's `useConfirmFocusReturn`).
 * - **Banner** while manually blocked: elapsed time, reason, who and when,
 *   and total blocked time across every block of the card; Unblock opens an
 *   optional Resolution field.
 * - **History line** when the card is not blocked now but was before.
 *
 * Relation blocks (#449) are shown by the Relations section, not here: they
 * are cleared by the blocking card, not by Unblock.
 */
export default function CardBlockSection({
  boardId, card, canBlock, formMode, onFormModeChange, unblockTriggerRef, onCardUpdated,
  userPrefs = null, refreshSignal = 0,
}: Props) {
  const [text, setText] = useState("");
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [blocks, setBlocks] = useState<CardBlock[] | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const focusBannerNext = useRef(false);
  const fieldId = useId();
  const helperId = `${fieldId}-helper`;

  const blocked = card.blocked_at != null;

  // Block history, for the totals. Refetched when the block state changes
  // (ours or another session's) and when the panel's refresh signal fires.
  useEffect(() => {
    let cancelled = false;
    getCardBlocks(boardId, card.id)
      .then((rows) => { if (!cancelled) setBlocks(rows); })
      .catch(() => { if (!cancelled) setBlocks(null); });
    return () => { cancelled = true; };
  }, [boardId, card.id, card.blocked_at, refreshSignal]);

  // Each open starts from an empty field and no error.
  useEffect(() => {
    setText("");
    setSubmitAttempted(false);
    setError(null);
    if (formMode !== null) textareaRef.current?.focus();
  }, [formMode]);

  // After a successful block the header's Block… trigger is gone, so focus
  // lands on the banner that replaced it rather than dropping to <body>.
  useEffect(() => {
    if (focusBannerNext.current && blocked) {
      focusBannerNext.current = false;
      bannerRef.current?.focus();
    }
  }, [blocked]);

  // Priority 42 (reserved for this form): above the panel's close (30) and
  // the value menus (39/41), below modal tiers. Returns false when no form is
  // open so Escape falls through to the panel.
  useEscapeStack(() => {
    if (formMode === null) return false;
    if (inFlight.current) return;
    onFormModeChange(null);
  }, 42);

  const trimmed = text.trim();
  const reasonMissing = formMode === "block" && trimmed.length === 0;
  const showRequired = submitAttempted && reasonMissing;
  const slotText = error ?? (showRequired ? REASON_REQUIRED : formMode === "block" ? REASON_HELPER : RESOLUTION_HELPER);
  const slotIsError = error !== null || showRequired;

  const submit = async () => {
    if (inFlight.current) return;
    setSubmitAttempted(true);
    if (reasonMissing) {
      textareaRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const wasBlockedAt = card.blocked_at;
    try {
      if (formMode === "block") {
        const updated = await blockCard(boardId, card.id, trimmed);
        focusBannerNext.current = true;
        onCardUpdated(updated);
        setAnnouncement(`Blocked "${card.title}"`);
      } else {
        const updated = await unblockCard(boardId, card.id, trimmed);
        const after = wasBlockedAt ? formatBlockedDuration(blockedElapsedMs(wasBlockedAt), 2) : null;
        onCardUpdated(updated);
        setAnnouncement(after ? `Unblocked "${card.title}" after ${after}` : `Unblocked "${card.title}"`);
      }
      onFormModeChange(null);
    } catch (err) {
      setError(errorCopy(err, formMode === "block" ? "Could not block this card. Try again." : "Could not unblock this card. Try again."));
      textareaRef.current?.focus();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const openBlock = blocks?.find((b) => b.unblocked_at === null) ?? null;
  const now = Date.now();
  const totalMs = (blocks ?? []).reduce(
    (sum, b) => sum + (b.unblocked_at === null ? blockedElapsedMs(b.blocked_at, now) : b.duration_seconds * 1000),
    0,
  );
  const blockCount = blocks?.length ?? 0;
  const totalLine = blockCount > 0
    ? `Total blocked time: ${formatBlockedDuration(totalMs, 2)} across ${blockCount} ${blockCount === 1 ? "block" : "blocks"}`
    : null;
  const blockerName = openBlock
    ? openBlock.blocked_by?.display_name || openBlock.imported_from_username || "a deleted user"
    : null;

  const form = formMode !== null && (
    <section
      aria-labelledby={`${fieldId}-heading`}
      className="flex flex-col gap-2"
      data-testid={formMode === "block" ? "card-block-form" : "card-unblock-form"}
    >
      <h3 id={`${fieldId}-heading`} className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {formMode === "block" ? "Block card" : "Unblock card"}
      </h3>
      <label htmlFor={fieldId} className="text-xs font-medium text-fg-secondary">
        {formMode === "block" ? "Reason" : "Resolution"}
        {formMode === "block" && <span aria-hidden="true" className="text-danger"> *</span>}
      </label>
      <textarea
        ref={textareaRef}
        id={fieldId}
        value={text}
        onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
        maxLength={BLOCK_TEXT_MAX}
        rows={3}
        required={formMode === "block"}
        aria-required={formMode === "block"}
        aria-invalid={slotIsError}
        aria-describedby={helperId}
        className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
      />
      {/* Reserved helper/error slot (§ Inline status messages). */}
      <p id={helperId} className="text-xs min-h-4">
        <span className={slotIsError ? "text-danger" : "text-fg-muted"}>{slotText}</span>
      </p>
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => onFormModeChange(null)}
          disabled={busy}
          className="px-3 py-1.5 text-sm rounded text-fg-secondary hover:text-fg hover:bg-surface-hover transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => { void submit(); }}
          aria-disabled={busy}
          className="px-3 py-1.5 text-sm rounded font-medium bg-button-primary hover:bg-button-primary-hover text-on-primary transition aria-disabled:opacity-40 aria-disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          {formMode === "block"
            ? (busy ? "Blocking…" : "Block card")
            : (busy ? "Unblocking…" : "Unblock card")}
        </button>
      </div>
    </section>
  );

  return (
    <>
      {/* Always mounted so the outcome lands in an existing live region. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="card-block-status">
        {announcement}
      </p>
      {blocked && (
        <div
          ref={bannerRef}
          role="note"
          tabIndex={-1}
          aria-label="Blocked"
          data-testid="card-blocked-banner"
          className="bg-danger/10 border border-danger/60 text-danger-on-tint rounded px-3 py-2 flex flex-col gap-1 outline-none focus:ring-2 focus:ring-danger-emphasis"
        >
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 000 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">
                Blocked for {formatBlockedDuration(blockedElapsedMs(card.blocked_at as string, now), 2)}
              </p>
              <p className="text-sm break-words whitespace-pre-wrap">{card.blocked_reason}</p>
              <p className="text-xs">
                {blockerName ? `By ${blockerName} · ` : ""}
                {formatDateTimeUser(card.blocked_at as string, userPrefs)}
              </p>
              {totalLine && <p className="text-xs" data-testid="card-blocked-total">{totalLine}</p>}
            </div>
            {canBlock && formMode !== "unblock" && (
              <button
                ref={unblockTriggerRef}
                type="button"
                onClick={() => onFormModeChange("unblock")}
                className="px-3 py-1.5 text-sm rounded text-fg-secondary hover:text-fg hover:bg-surface-hover transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Unblock
              </button>
            )}
          </div>
        </div>
      )}
      {form}
      {!blocked && formMode === null && totalLine && (
        <p className="text-xs text-fg-tertiary -mt-3" data-testid="card-blocked-total">
          Previously blocked. {totalLine}.
        </p>
      )}
    </>
  );
}
