import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import type { AdminUser } from "../../types";
import Avatar from "../Common/Avatar";
import { Button, InlineConfirm } from "../Page";

/** One row action in the phone sheet. The caller keeps each action's gating; the sheet only lists what it is given. */
export interface SheetAction {
  id: string;
  label: string;
  /** Second line under the label (the transfer item's "Choose a new owner…"). */
  description?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** A confirm opened from the sheet: it replaces the action list inside the sheet. */
export interface SheetConfirm {
  message: string;
  actionLabel: string;
  onConfirm: () => void;
}

interface UserActionsSheetProps {
  user: AdminUser;
  /** Make / Demote admin and Deactivate / Reactivate (on the row on wider screens, #1291). */
  primary: SheetAction[];
  /** The support actions that sit behind ⋯ on wider screens. */
  support: SheetAction[];
  /** Plain-text reason shown under the header (the superuser-only row note, #1644). */
  note?: string;
  confirm: SheetConfirm | null;
  onCancelConfirm: () => void;
  onClose: () => void;
  /** The row's ⋯ trigger: focus returns there when the sheet closes. */
  restoreFocusTo: () => HTMLElement | null;
}

const ITEM =
  "w-full min-h-11 px-4 py-2 flex flex-col items-start justify-center text-left text-sm rounded transition " +
  "hover:bg-surface-hover focus:outline-none focus:ring-2 disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Phone row actions for Site admin → Users (#2476, "Phone row actions" artboard). On a phone every
 * row action, including Deactivate and Make admin, lives here instead of on the row. The sheet
 * dims the page, so it is modal (frontend/CLAUDE.md § bottom sheets): `aria-modal`, Tab trapped,
 * Escape closes, focus returns to the row's ⋯. A confirm replaces the list in place, and its
 * Cancel (or Escape) returns to the list with focus on the action that opened it.
 */
export default function UserActionsSheet({
  user, primary, support, note, confirm, onCancelConfirm, onClose, restoreFocusTo,
}: UserActionsSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const lastActionRef = useRef<string | null>(null);
  const hadConfirmRef = useRef(false);

  useFocusTrap(panelRef, true, restoreFocusTo);

  // Above the Users section's inline-confirm handler (40): inside the sheet, Escape first leaves
  // the confirm, then closes the sheet.
  useEscapeStack(() => {
    if (confirm) { onCancelConfirm(); return; }
    onClose();
  }, 41);

  // Open on the first action; after a confirm is canceled, back on the action that opened it.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (confirm) { hadConfirmRef.current = true; return; }
    const back = hadConfirmRef.current && lastActionRef.current
      ? panel.querySelector<HTMLElement>(`[data-action-id="${lastActionRef.current}"]`)
      : null;
    hadConfirmRef.current = false;
    (back ?? panel.querySelector<HTMLElement>("[data-action-id]:not([disabled])") ?? panel.querySelector<HTMLElement>("button"))?.focus();
  }, [confirm]);

  const name = user.display_name || user.username;

  const renderGroup = (label: string, actions: SheetAction[]) =>
    actions.length > 0 && (
      <ul role="list" aria-label={label} className="flex flex-col gap-0.5">
        {actions.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              data-action-id={a.id}
              disabled={a.disabled}
              className={`${ITEM} ${a.danger ? "text-danger focus:ring-danger-emphasis" : "text-fg focus:ring-primary-emphasis"}`}
              onClick={() => {
                if (a.disabled) return;
                lastActionRef.current = a.id;
                a.onSelect();
              }}
            >
              <span>{a.label}</span>
              {a.description && <span className="text-xs text-fg-secondary">{a.description}</span>}
            </button>
          </li>
        ))}
      </ul>
    );

  return createPortal(
    <>
      <div className="fixed inset-0 z-40 bg-backdrop/60" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-variant="sheet"
        className="fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] overflow-y-auto rounded-t-xl border border-line-strong bg-surface shadow-xl pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-line">
          <Avatar user={user} size="sm" />
          <div className="min-w-0">
            <h2 id={headingId} className="text-sm font-semibold text-fg truncate">{name}</h2>
            <p className="text-xs text-fg-secondary truncate">@{user.username}</p>
          </div>
        </div>
        <div className="p-2 flex flex-col gap-2">
          {confirm ? (
            <div className="p-2">
              <InlineConfirm
                message={confirm.message}
                actionLabel={confirm.actionLabel}
                onConfirm={confirm.onConfirm}
                onCancel={onCancelConfirm}
              />
            </div>
          ) : (
            <>
              {note && <p className="px-4 py-2 text-xs text-fg-secondary">{note}</p>}
              {renderGroup("Account", primary)}
              {primary.length > 0 && support.length > 0 && <hr className="border-line mx-2" />}
              {renderGroup("Support", support)}
              <Button variant="quiet" fullWidth className="min-h-11" onClick={onClose}>Cancel</Button>
            </>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
