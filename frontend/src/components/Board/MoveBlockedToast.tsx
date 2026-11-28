import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MoveBlockedError } from "../../hooks/useBoard";
import { useToast } from "../../contexts/useToast";
import type { ToastInput } from "../../utils/toastQueue";
import { failureReason } from "../../utils/moveFailure";
import { canOverride, overrideHint, overrideLabel, type OverrideEligibility } from "../../utils/forceOverride";
import ModalWrapper from "../shared/ModalWrapper";
import OverrideReasonForm from "./OverrideReasonForm";
import { entryRequirementCount, hardLimitContainer, isHardLimit, toastBody, toastTitle, type UnmetFields } from "./moveBlockedMessages";

interface Props {
  error: MoveBlockedError;
  /** Who may force this refusal (utils/forceOverride). */
  eligibility: OverrideEligibility;
  /** The refused card, focused after the reason dialog's move succeeds. */
  cardId?: number | null;
  /** `reason` is set on the assignee basis, which the server requires it for. A
   *  resolved `{ ok: false }` keeps the dialog open. */
  onForce: (reason?: string) => void | Promise<unknown>;
  onDismiss: () => void;
  /** The board's field definitions, so an entry bound reads in its field's format (#2718). */
  fields?: UnmetFields;
}

/** Coalescing key: a later move replaces a stale refusal in place. */
export const MOVE_TOAST_KEY = "move";

/**
 * The move refusal as a `blocked` toast (frontend/CLAUDE.md § Move-blocked
 * toast for the content, § Toasts for placement and timing). Persists until
 * dismissed or replaced, announced assertively.
 */
function moveBlockedToast(error: MoveBlockedError, eligibility: OverrideEligibility, onForce: () => void | Promise<unknown>, fields?: UnmetFields): ToastInput {
  const entryHard = error.code === "entry_requirements_unmet" && error.mode === "hard";
  const hardBlocked = isHardLimit(error.code) || error.code === "permission_denied" || entryHard;
  // maintenance_mode has no override for anyone — a site admin never sees this
  // toast at all, since their own writes succeed — but it keeps the ⚠ glyph
  // (matching MaintenanceBanner's amber tone, not permission_denied's ⛔):
  // per frontend/CLAUDE.md, ⛔ marks the hard WIP blocks (column and, since
  // #1150, swimlane) and a Hard entry-requirements column (#1923), so the
  // no-override condition and the severity glyph are tracked separately.
  const noOverride = hardBlocked || error.code === "maintenance_mode" || error.code === "move_failed";
  const versionConflict = error.code === "version_conflict";
  const hardContainer = hardLimitContainer(error);
  // Other limits the same move tripped (#1150): the server names only the
  // strictest, so the second line names the rest from board state.
  const also = "also" in error ? error.also ?? [] : [];
  const alsoLine = also.length > 0 ? `Also: ${also.join(" ")}` : null;
  // A hard WIP block shows a resolution hint naming the column or swimlane it
  // is on; permission_denied has no actionable hint beyond the body text.
  const hint = entryHard
    ? "No one can override this column's requirements."
    : !versionConflict && noOverride && hardContainer !== null
      ? `To unblock, move a card out of ${hardContainer}, or ask an admin to raise the WIP limit.`
      : null;
  const overridable = !versionConflict && !noOverride;
  const actionLabel = overridable && canOverride(eligibility) ? overrideLabel(eligibility) : null;
  const overrideNote = overridable ? overrideHint(eligibility) : null;
  const title = toastTitle(error);
  const body = toastBody(error, fields);
  return {
    key: MOVE_TOAST_KEY,
    variant: "blocked",
    hardGlyph: hardBlocked,
    title,
    message: body,
    details: (alsoLine || hint || overrideNote) ? (
      <>
        {alsoLine && <p className="mt-1 text-xs text-fg-tertiary">{alsoLine}</p>}
        {hint && <p className="mt-1.5 text-xs text-fg-tertiary">{hint}</p>}
        {overrideNote && <p className="mt-1.5 text-xs text-fg-tertiary">{overrideNote}</p>}
      </>
    ) : undefined,
    action: actionLabel
      ? { label: actionLabel, pendingLabel: "Moving anyway…", onAction: onForce }
      : undefined,
    // Everything the old role="alert" toast read out, as one sentence group.
    // An entry refusal's body is a "Needs: ..." list, which a screen reader would read as one long run: announce
    // the count and leave the list to the visible body (ux-design: the announcement carries no list).
    announceText: [
      error.code === "entry_requirements_unmet" ? `${title}. ${entryRequirementCount(error.unmet.length)} unmet.` : `${title}. ${body}`,
      alsoLine,
      hint,
      overrideNote,
      actionLabel ? `${actionLabel} available.` : null,
    ].filter(Boolean).join(" "),
    testId: "move-blocked-toast",
  };
}

/**
 * A move refused while the card detail sheet's Move popover is open came from
 * that popover, which reports it inline in its own `role="alert"` first (it
 * stays open on failure). Its toast is then the visible mirror only: one live
 * announcement per action. Named explicitly: any other open `aria-modal`
 * surface has no inline alert for a move, so the toast must announce.
 */
function reportedByMovePopover(): boolean {
  return document.querySelector("[data-move-popover]") !== null;
}

/** An assignee override, and any override past entry requirements (owner Q2, #1923), needs a reason first. */
function needsReason(kind: OverrideEligibility["kind"], error: MoveBlockedError): boolean {
  return kind === "assignee" || error.code === "entry_requirements_unmet";
}

const notMoved = (err: unknown) => `Card could not be moved: ${failureReason(err)}.`;

/** Takes focus for the moved card only if it would otherwise be lost to `body`. True once the card is in the DOM. */
function focusMovedCard(cardId: number): boolean {
  const el = document.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
  if (!el) return false;
  if (document.activeElement === document.body || !document.activeElement) el.focus();
  return true;
}

/**
 * Bridges the board's `moveError` into the shared toast region. Renders only
 * the assignee's reason dialog (a toast cannot hold a form); mount it while
 * there is an error, and it raises, replaces and finally removes the `move`
 * toast.
 */
export default function MoveBlockedToast({ error, eligibility, cardId, onForce, onDismiss, fields }: Props) {
  const { notify, dismiss } = useToast();
  // Read when a refusal arrives, never a reason to re-raise it: board updates
  // hand down a fresh array, and re-notifying would re-announce the toast.
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const forceRef = useRef(onForce);
  forceRef.current = onForce;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  // The refusal the reason dialog was opened for, so a newer refusal closes it.
  const [reasonFor, setReasonFor] = useState<MoveBlockedError | null>(null);
  const [busy, setBusy] = useState(false);
  // The card a forced move with a reason just moved. Focus goes back to it in a layout effect (focus rule 3,
  // #2608), in the commit that closes the dialog, while this toast stays mounted. A success usually clears the
  // error, so the host unmounts this component in the same batch and that state update is dropped (#2631): the
  // ref is set before it, outside render, so the unmount cleanup still knows which card to focus.
  const [restoreFor, setRestoreFor] = useState<number | null>(null);
  const restoreRef = useRef<number | null>(null);
  // Whether the unmount cleanup has already run: a host can drop this component while the force is in flight.
  const mountedRef = useRef(true);
  const [failure, setFailure] = useState("");
  const openReason = (e: MoveBlockedError) => { setFailure(""); setReasonFor(e); };
  const closeReason = () => { setFailure(""); setReasonFor(null); };
  const submitReason = async (reason: string) => {
    // Read now: both can change, and this component can unmount, while it runs.
    const movedId = cardId;
    setBusy(true);
    setFailure("");
    try {
      const outcome = (await forceRef.current(reason)) as { ok: boolean; error?: unknown } | undefined;
      if (outcome?.ok === false) {
        setFailure(notMoved(outcome.error));
        return;
      }
      setReasonFor(null);
      if (movedId != null) {
        restoreRef.current = movedId;
        setRestoreFor(movedId);
        // Already unmounted, so no cleanup is left to run: make the attempt here.
        if (!mountedRef.current) queueMicrotask(() => focusMovedCard(movedId));
      }
    } catch (err) {
      setFailure(notMoved(err));
    } finally {
      setBusy(false);
    }
  };
  // Eligibility is a fresh object on every host render; key the toast on its content.
  const kind = eligibility.kind;
  const assigneeName = eligibility.kind === "other_member" ? eligibility.assigneeName : "";

  useEffect(() => {
    const e = (kind === "other_member" ? { kind, assigneeName } : { kind }) as OverrideEligibility;
    notify({
      ...moveBlockedToast(error, e, () => (needsReason(kind, error) ? openReason(error) : forceRef.current()), fieldsRef.current),
      announce: !reportedByMovePopover(),
      onDismiss: () => dismissRef.current(),
    });
  }, [error, kind, assigneeName, notify]);

  useEffect(() => () => dismiss(MOVE_TOAST_KEY), [dismiss]);

  // The moved card can mount after the dialog closes (the board re-renders from the move's response), so when it is
  // not in the DOM yet, watch for it instead of polling per frame (focus rule 3). Disconnected on cleanup.
  useLayoutEffect(() => {
    if (restoreFor === null) return;
    const done = () => { restoreRef.current = null; setRestoreFor(null); };
    if (focusMovedCard(restoreFor)) { done(); return; }
    const observer = new MutationObserver(() => {
      if (focusMovedCard(restoreFor)) { observer.disconnect(); done(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [restoreFor]);
  // On unmount the closing dialog still holds focus, so wait a microtask for it to leave the DOM (focus falls to
  // body) before taking it for the moved card. Not requestAnimationFrame (focus rule 3).
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const id = restoreRef.current;
      if (id !== null) queueMicrotask(() => focusMovedCard(id));
    };
  }, []);

  const column = "column_name" in error ? error.column_name : null;
  return (
    <ModalWrapper
      open={reasonFor === error && needsReason(kind, error)}
      onClose={closeReason}
      dismissable={!busy}
      title={column ? `Move to ${column} anyway?` : "Move anyway?"}
      maxWidth="max-w-md"
    >
      <p role="alert" className={failure ? "text-xs text-danger mb-2" : "sr-only"}>{failure}</p>
      <OverrideReasonForm busy={busy} onCancel={closeReason} onSubmit={(reason) => void submitReason(reason)} />
    </ModalWrapper>
  );
}
