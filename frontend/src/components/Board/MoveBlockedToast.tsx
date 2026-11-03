import { useEffect, useRef } from "react";
import type { MoveBlockedError } from "../../hooks/useBoard";
import { useToast } from "../../contexts/useToast";
import type { ToastInput } from "../../utils/toastQueue";
import { hardLimitContainer, isHardLimit, toastBody, toastTitle } from "./moveBlockedMessages";

interface Props {
  error: MoveBlockedError;
  isAdmin: boolean;
  onForce: () => void | Promise<unknown>;
  onDismiss: () => void;
}

/** Coalescing key: a later move replaces a stale refusal in place. */
export const MOVE_TOAST_KEY = "move";

/**
 * The move refusal as a `blocked` toast (frontend/CLAUDE.md § Move-blocked
 * toast for the content, § Toasts for placement and timing). Persists until
 * dismissed or replaced, announced assertively.
 */
function moveBlockedToast(error: MoveBlockedError, isAdmin: boolean, onForce: () => void | Promise<unknown>): ToastInput {
  const hardBlocked = isHardLimit(error.code) || error.code === "permission_denied";
  // maintenance_mode has no override for anyone — a site admin never sees this
  // toast at all, since their own writes succeed — but it keeps the ⚠ glyph
  // (matching MaintenanceBanner's amber tone, not permission_denied's ⛔):
  // per frontend/CLAUDE.md, ⛔ is reserved for the hard WIP blocks (column
  // and, since #1150, swimlane), so the no-override condition and the
  // severity glyph are tracked separately.
  const noOverride = hardBlocked || error.code === "maintenance_mode" || error.code === "move_failed";
  const versionConflict = error.code === "version_conflict";
  const hardContainer = hardLimitContainer(error);
  // Other limits the same move tripped (#1150): the server names only the
  // strictest, so the second line names the rest from board state.
  const also = "also" in error ? error.also ?? [] : [];
  const alsoLine = also.length > 0 ? `Also: ${also.join(" ")}` : null;
  // A hard WIP block shows a resolution hint naming the column or swimlane it
  // is on; permission_denied has no actionable hint beyond the body text.
  const hint = !versionConflict && noOverride && hardContainer !== null
    ? `To unblock, move a card out of ${hardContainer}, or ask an admin to raise the WIP limit.`
    : null;
  const canOverride = !versionConflict && !noOverride && isAdmin;
  const title = toastTitle(error);
  const body = toastBody(error);
  return {
    key: MOVE_TOAST_KEY,
    variant: "blocked",
    hardGlyph: hardBlocked,
    title,
    message: body,
    details: (alsoLine || hint) ? (
      <>
        {alsoLine && <p className="mt-1 text-xs text-fg-tertiary">{alsoLine}</p>}
        {hint && <p className="mt-1.5 text-xs text-fg-tertiary">{hint}</p>}
      </>
    ) : undefined,
    action: canOverride
      ? { label: "Move anyway (admin override)", pendingLabel: "Moving anyway…", onAction: onForce }
      : undefined,
    // Everything the old role="alert" toast read out, as one sentence group.
    announceText: [
      `${title}. ${body}`,
      alsoLine,
      hint,
      canOverride ? "Move anyway (admin override) available." : null,
    ].filter(Boolean).join(" "),
    testId: "move-blocked-toast",
  };
}

/**
 * A move refused while an `aria-modal` surface is open came from the card
 * detail sheet's Move popover (drag-and-drop is suspended while the sheet is
 * open), which reports it inline in its own `role="alert"` first. Its toast is
 * the visible mirror only: one live announcement per action.
 */
function raisedInsideModal(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/**
 * Bridges the board's `moveError` into the shared toast region. Renders
 * nothing; mount it while there is an error, and it raises, replaces and
 * finally removes the `move` toast.
 */
export default function MoveBlockedToast({ error, isAdmin, onForce, onDismiss }: Props) {
  const { notify, dismiss } = useToast();
  const forceRef = useRef(onForce);
  forceRef.current = onForce;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    notify({
      ...moveBlockedToast(error, isAdmin, () => forceRef.current()),
      announce: !raisedInsideModal(),
      onDismiss: () => dismissRef.current(),
    });
  }, [error, isAdmin, notify]);

  useEffect(() => () => dismiss(MOVE_TOAST_KEY), [dismiss]);

  return null;
}
