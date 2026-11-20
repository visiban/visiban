import { useCallback, useEffect, useRef, useState } from "react";
import Spinner from "../Common/Spinner";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { relativeTime } from "../../utils/relativeTime";
import {
  createWebhook,
  deleteWebhook,
  disableWebhook,
  getWebhookStatus,
  listWebhooks,
  reenableWebhook,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
} from "../../api/webhooks";
import type { WebhookChangedPayload, WebhookStatus, WebhookSubscription } from "../../types";
import type { SocketStatus } from "../../hooks/useBoardSocket";
import {
  CHANGED_ELSEWHERE_MS,
  SECRET_LEFT_COPY,
  SECRET_PENDING_BOUND_MS,
  SECRET_STUCK_COPY,
  webhookPosition,
} from "../../constants/webhooks";
import WebhookList from "./webhooks/WebhookList";
import WebhookCreateForm from "./webhooks/WebhookCreateForm";
import { axiosResponse, outcomeUnknown } from "./webhooks/webhookFormUtils";
import WebhookDetail, { type WebhookConfirm } from "./webhooks/WebhookDetail";
import WebhookSecretReveal, { type WebhookSecretRevealHandle } from "./webhooks/WebhookSecretReveal";
import { DispatcherStaleNotice, WebhooksOffNotice } from "./webhooks/WebhookServiceNotice";

/**
 * Escape priorities inside Board Settings (ModalWrapper 40; frontend/CLAUDE.md
 * modal list). One per confirm, highest first: the secret-reveal guard.
 */
export const WEBHOOK_ESCAPE = {
  deleteConfirm: 52,
  disableConfirm: 53,
  reenableConfirm: 54,
  rotateConfirm: 55,
  secretGuard: 56,
} as const;

/** Said when a way out of the tab is refused because a one-time secret is on its way. */
const SECRET_PENDING_COPY = "Wait for the new secret. It can only be shown once, so you can't leave until it arrives.";
/** Said (through the notice slot) and shown when the open webhook was deleted elsewhere (#2057). */
const DELETED_ELSEWHERE_COPY = "This webhook was deleted elsewhere.";

const CLOCK_TICK_MS = 30_000;
const HIGHLIGHT_MS = 1500;
/** Frames and focus events within this window share one list read (#2057). */
const REFETCH_COALESCE_MS = 300;
/** Announcements of changes made elsewhere coalesce within this window (1.3 UI spec Part 9). */
const ANNOUNCE_COALESCE_MS = 2000;

const PAUSED_LIVE_COPY = "Live updates paused.";

const awayCopy = (n: number) => `${n} ${n === 1 ? "webhook" : "webhooks"} changed while you were away`;

/**
 * "by <name>" for a frame's `changed_by` id (#2403). The frame carries the id
 * only, so the name comes from the board's member list. An id nobody can be
 * matched to reads "by another admin", never the raw id; null (the dispatcher
 * turning a webhook off) names no one.
 */
function byLabel(changedBy: number | null, members: ReadonlyArray<{ user: { id: number; display_name: string } }>): string | null {
  if (changedBy === null) return null;
  const name = members.find((m) => m.user.id === changedBy)?.user.display_name?.trim();
  return name ? `by ${name}` : "by another admin";
}

const STATUS_WORD: Record<WebhookChangedPayload["status"], string> = {
  active: "on",
  failing: "failing",
  disabled: "turned off",
  deleted: "deleted",
};

function detailChangeCopy(status: WebhookChangedPayload["status"], by: string | null): string {
  return `This webhook was changed elsewhere${by ? ` ${by}` : ""}. It is now ${STATUS_WORD[status]}.`;
}

/**
 * The announcement for one change made elsewhere (Part 8 copy, no host):
 * "Webhook 2 of 3 is failing: 3 deliveries in a row." Names the new status;
 * falls back to the generic sentence when the row is not in the list.
 */
function changeAnnouncement(change: WebhookChangedPayload, subs: readonly WebhookSubscription[] | null): string {
  if (change.status === "deleted") return "A webhook was deleted elsewhere.";
  if (!subs || !subs.some((s) => s.id === change.id)) return "A webhook was changed elsewhere.";
  const where = webhookPosition(subs, change.id);
  if (change.status === "failing") {
    const n = change.consecutive_failures;
    return n > 0 ? `${where} is failing: ${n} ${n === 1 ? "delivery" : "deliveries"} in a row.` : `${where} is failing.`;
  }
  return `${where} is ${change.status === "active" ? "on" : "turned off"}.`;
}

/** Rows added, removed or whose state moved between two reads. */
function countChanged(prev: readonly WebhookSubscription[] | null, next: readonly WebhookSubscription[]): number {
  if (!prev) return 0;
  const sig = (s: WebhookSubscription) => `${s.enabled}|${s.consecutive_failures}|${s.disabled_reason}|${s.url_display}|${s.event_types.join(",")}|${s.secret_rotated_at}`;
  const before = new Map(prev.map((s) => [s.id, sig(s)]));
  let n = 0;
  for (const s of next) if (before.get(s.id) !== sig(s)) n += 1;
  const ids = new Set(next.map((s) => s.id));
  for (const id of before.keys()) if (!ids.has(id)) n += 1;
  return n;
}

type SecretOrigin = "create" | "rotate";
interface LeftPending {
  origin: SecretOrigin;
  at: number;
}

// A create or rotate the user stopped waiting for (#2127). Kept in
// sessionStorage, so the warning survives closing Board settings and a reload
// in this browser tab; it holds no secret, only that one may have been issued.
const leftPendingKey = (boardId: number) => `visiban.webhooks.leftPending.${boardId}`;

function readLeftPending(boardId: number): LeftPending | null {
  try {
    const raw = window.sessionStorage.getItem(leftPendingKey(boardId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LeftPending> | null;
    if (v && (v.origin === "create" || v.origin === "rotate") && typeof v.at === "number") return { origin: v.origin, at: v.at };
  } catch {
    // Blocked or malformed storage: nothing to restore.
  }
  return null;
}

function writeLeftPending(boardId: number, value: LeftPending | null) {
  try {
    if (value) window.sessionStorage.setItem(leftPendingKey(boardId), JSON.stringify(value));
    else window.sessionStorage.removeItem(leftPendingKey(boardId));
  } catch {
    // Blocked storage: the notice still shows until this tab unmounts.
  }
}

/** The tab's answer to "may Board settings close / switch tabs now?". */
export type WebhookCloseGuard = (proceed: () => void) => boolean;

interface Props {
  boardId: number;
  /** Opened from the `webhook_disabled` notification deep link. One-shot. */
  focusFirstStopped?: boolean;
  /** False for an SSO-only account: take-over then uses a recent provider sign-in. */
  currentUserHasPassword?: boolean;
  /** Board settings registers this so Close, the backdrop and tab switches ask first. */
  registerCloseGuard?: (guard: WebhookCloseGuard | null) => void;
  /** Close Board settings (the modal's own onClose). */
  onRequestClose?: () => void;
  /** #2057 — the latest `webhook.changed` frame for this board; each new one refetches the list. */
  remoteChange?: (WebhookChangedPayload & { seq: number }) | null;
  /** Frames this user caused still refetch, but are not tagged as changed elsewhere. */
  currentUserId?: number | null;
  /**
   * #2057 — bumped by BoardView on each board-socket reconnect: frames sent
   * while the socket was down are lost, so each new value re-reads the list.
   */
  reconnectSignal?: number;
  /**
   * #2403 — the board socket's state. While it is down, live updates are
   * paused and the tab says so, with a Refresh. Omitted = no banner.
   */
  socketStatus?: SocketStatus;
  /**
   * #2403 — the board's members, only to turn a frame's `changed_by` id into a
   * display name. No new request: the frame carries the id and nothing else.
   */
  members?: ReadonlyArray<{ user: { id: number; display_name: string } }>;
}

type View = { kind: "list" } | { kind: "create" } | { kind: "detail"; id: number };

interface Reveal {
  subId: number;
  host: string;
  secret: string;
  origin: "create" | "rotate";
  acknowledged: boolean;
  guardOpen: boolean;
}

/** Board Settings → Webhooks (#863, 1.3 UI spec Part 8). Board admins only. */
export default function BoardSettingsWebhooksTab({
  boardId,
  focusFirstStopped = false,
  currentUserHasPassword = true,
  registerCloseGuard,
  onRequestClose,
  remoteChange = null,
  currentUserId = null,
  reconnectSignal = 0,
  socketStatus,
  members = [],
}: Props) {
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [featureOff, setFeatureOff] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [subs, setSubs] = useState<WebhookSubscription[] | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [confirm, setConfirm] = useState<WebhookConfirm | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [live, setLive] = useState("");
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reloadKey, setReloadKey] = useState(0);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  // How many ways out were refused during this request; 0 hides the banner. It
  // keys the banner, so each refusal is a new alert and is announced again. The
  // key is prefixed: its siblings include WebhookDetail, keyed by a bare webhook id.
  const [refusals, setRefusals] = useState(0);
  // #2127 — the create or rotate whose bound has passed: offer "Leave anyway".
  const [stuck, setStuck] = useState<SecretOrigin | null>(null);
  const [leftPending, setLeftPending] = useState<LeftPending | null>(() => readLeftPending(boardId));
  // #2057 — rows another admin or the dispatcher changed in the last 30 s.
  // The value is the "by <name>" suffix (#2403); null when nobody is to be named.
  const [changedIds, setChangedIds] = useState<ReadonlyMap<number, string | null>>(() => new Map());
  // #2403 — when the list was last read, for "Updated N min ago" while paused.
  const [updatedAt, setUpdatedAt] = useState(() => Date.now());
  // #2403 — rows that changed while the socket was down, shown after a reconnect.
  const [awayCount, setAwayCount] = useState(0);
  // #2403 — a non-delete change to the webhook whose detail is open.
  const [detailChange, setDetailChange] = useState<{ id: number; text: string } | null>(null);
  // Announces the paused / away / detail-changed banners: always mounted (#1421).
  const [stateLive, setStateLive] = useState("");
  const stateLiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [remoteLive, setRemoteLive] = useState("");
  // A "may have taken effect" notice or a banner that replaces a vanished
  // subject is announced here, always mounted: a status region that mounts
  // with its text is not reliably read (#1421, #1435).
  const [noticeLive, setNoticeLive] = useState("");

  const rootRef = useRef<HTMLDivElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const goneRef = useRef<HTMLParagraphElement>(null);
  const leaveButtonRef = useRef<HTMLButtonElement>(null);
  const refusalRef = useRef<HTMLParagraphElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const revealRef = useRef<WebhookSecretRevealHandle>(null);
  // A create or rotate is running: its response is the only copy of a secret.
  const secretPendingRef = useRef(false);
  // A confirm's request is running: closing it would read as a cancel and hide a failure.
  const confirmRunningRef = useRef(false);
  const manageRefs = useRef(new Map<number, HTMLButtonElement>());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deepLinkDoneRef = useRef(false);
  const guardProceedRef = useRef<(() => void) | null>(null);
  const revealRefState = useRef<Reveal | null>(null);
  // Each create/rotate gets a number; one the user left is "abandoned", and
  // its late answer neither unlocks a newer request nor moves the view.
  const pendingTokenRef = useRef(0);
  const abandonedRef = useRef(new Set<number>());
  // The way out the user last tried while a secret was on its way.
  const refusedProceedRef = useRef<(() => void) | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchDeferredRef = useRef(false);
  const changedTimersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announceIdsRef = useRef(new Map<number, WebhookChangedPayload>());
  const subsRef = useRef<WebhookSubscription[] | null>(null);
  subsRef.current = subs;
  const membersRef = useRef(members);
  membersRef.current = members;
  // A reconnect asked for this read: diff it against the list on screen.
  const awayReadRef = useRef(false);
  // A frame that arrived before this tab mounted is already in the first load.
  const mountSeqRef = useRef(remoteChange?.seq ?? 0);
  // Likewise a reconnect from before this tab mounted.
  const mountReconnectRef = useRef(reconnectSignal);
  // The guard protects the reveal only while it is on screen: a create reveal
  // above the list, a rotate reveal in its own webhook's detail. Any path that
  // takes it off screen disarms the guard (frontend/CLAUDE.md, close guards).
  const revealShown =
    reveal !== null &&
    !featureOff &&
    ((reveal.origin === "create" && view.kind === "list") ||
      // Not once the webhook is gone (deleted elsewhere, #2057): its detail,
      // and so the reveal, no longer renders, and the guard must not ask about it.
      (reveal.origin === "rotate" && view.kind === "detail" && view.id === reveal.subId &&
        subs !== null && subs.some((s) => s.id === reveal.subId)));
  revealRefState.current = revealShown ? reveal : null;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => {
    if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current);
    if (refetchTimerRef.current !== null) clearTimeout(refetchTimerRef.current);
    if (announceTimerRef.current !== null) clearTimeout(announceTimerRef.current);
    if (stateLiveTimerRef.current !== null) clearTimeout(stateLiveTimerRef.current);
    changedTimersRef.current.forEach((t) => clearTimeout(t));
  }, []);

  // ── Live updates (#2057, 1.3 UI spec Part 9) ─────────────────────────────────
  // A refetch only replaces the list: an open create form, confirm or secret
  // reveal is separate state and is never disturbed by one.
  // Clear, then write on the next tick, so an identical sentence is a change
  // to the region and is read again (the announcer rule, #2057).
  const announceState = useCallback((text: string) => {
    if (stateLiveTimerRef.current !== null) clearTimeout(stateLiveTimerRef.current);
    setStateLive("");
    stateLiveTimerRef.current = setTimeout(() => {
      stateLiveTimerRef.current = null;
      setStateLive(text);
    }, 50);
  }, []);

  const refetchList = useCallback(() => {
    if (refetchTimerRef.current !== null) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      // A create's answer is about to add its row; read after it instead.
      if (secretPendingRef.current) {
        refetchDeferredRef.current = true;
        return;
      }
      const diffAway = awayReadRef.current;
      awayReadRef.current = false;
      listWebhooks(boardId).then((next) => {
        if (diffAway) {
          const n = countChanged(subsRef.current, next);
          if (n > 0) {
            setAwayCount(n);
            announceState(awayCopy(n));
          }
        }
        setSubs(next);
        setUpdatedAt(Date.now());
      }).catch(() => undefined);
    }, REFETCH_COALESCE_MS);
  }, [boardId, announceState]);

  useEffect(() => {
    if (!remoteChange || remoteChange.seq <= mountSeqRef.current) return;
    mountSeqRef.current = remoteChange.seq;
    refetchList();
    // This user's own change (this tab or another of theirs): no "elsewhere" tag.
    if (remoteChange.changed_by !== null && remoteChange.changed_by === currentUserId) return;
    const id = remoteChange.id;
    const by = byLabel(remoteChange.changed_by, membersRef.current);
    // The detail banner already says this change through the state slot; the
    // coalesced announcement below would read it a second time (#2403).
    let announcedInDetail = false;
    setChangedIds((prev) => new Map(prev).set(id, by));
    if (viewRef.current.kind === "detail" && viewRef.current.id === id && remoteChange.status !== "deleted") {
      const text = detailChangeCopy(remoteChange.status, by);
      setDetailChange({ id, text });
      announceState(text);
      announcedInDetail = true;
    }
    const timers = changedTimersRef.current;
    const previous = timers.get(id);
    if (previous !== undefined) clearTimeout(previous);
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      setChangedIds((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }, CHANGED_ELSEWHERE_MS));
    if (announcedInDetail) return;
    announceIdsRef.current.set(id, remoteChange);
    if (announceTimerRef.current === null) {
      // Cleared at the start of each batch, so a batch with the same count as
      // the last one is still a change to the region and is announced.
      setRemoteLive("");
      announceTimerRef.current = setTimeout(() => {
        announceTimerRef.current = null;
        const batch = [...announceIdsRef.current.values()];
        announceIdsRef.current.clear();
        setRemoteLive(
          batch.length === 1
            ? changeAnnouncement(batch[0], subsRef.current)
            : `${batch.length} webhooks were changed elsewhere.`,
        );
      }, ANNOUNCE_COALESCE_MS);
    }
  }, [remoteChange, currentUserId, refetchList, announceState]);

  useEffect(() => {
    if (subs !== null) setUpdatedAt(Date.now());
  }, [subs]);

  // #2403 — live updates are paused while the socket is down. The banner is
  // announced once, through the always-mounted slot; coming back clears it.
  const paused = socketStatus === "reconnecting" || socketStatus === "failed";
  useEffect(() => {
    // The latest state wins: a pending away or detail announcement must not
    // land after, and overwrite, the paused copy.
    if (paused) {
      if (stateLiveTimerRef.current !== null) {
        clearTimeout(stateLiveTimerRef.current);
        stateLiveTimerRef.current = null;
      }
      setStateLive(PAUSED_LIVE_COPY);
    }
    else setStateLive((prev) => (prev === PAUSED_LIVE_COPY ? "" : prev));
  }, [paused]);

  // A detail banner belongs to the webhook it was raised for.
  useEffect(() => {
    if (detailChange && !(view.kind === "detail" && view.id === detailChange.id)) setDetailChange(null);
  }, [view, detailChange]);

  // Frames sent while the socket was down never arrive: re-read on reconnect.
  useEffect(() => {
    if (reconnectSignal <= mountReconnectRef.current) return;
    mountReconnectRef.current = reconnectSignal;
    awayReadRef.current = true;
    refetchList();
  }, [reconnectSignal, refetchList]);

  // Anything sent while this window was in the background, or while the
  // socket was down, is picked up when it is focused again.
  useEffect(() => {
    const onFocus = () => refetchList();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetchList]);

  // Load: status first; the list only when the feature is on.
  useEffect(() => {
    let canceled = false;
    setLoadError(false);
    getWebhookStatus(boardId)
      .then(async (s) => {
        if (canceled) return;
        setStatus(s);
        setNow(Date.now());
        if (!s.enabled) {
          setFeatureOff(true);
          return;
        }
        const list = await listWebhooks(boardId);
        if (!canceled) setSubs(list);
      })
      .catch((err: unknown) => {
        if (canceled) return;
        if (axiosResponse(err)?.data?.code === "webhooks_disabled") setFeatureOff(true);
        else setLoadError(true);
      });
    return () => { canceled = true; };
  }, [boardId, reloadKey]);

  // The tab may be scrolled well past its top by the time something is refused.
  // `stuck` too: the bound passing swaps the banner for one with a way out.
  useEffect(() => {
    if (refusals > 0 || stuck !== null) refusalRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [refusals, stuck]);

  // The open webhook vanished (deleted elsewhere, #2057): its detail, with any
  // confirm or reveal in it, is gone, so the banner that replaces it takes
  // focus. Only focus that was in this tab or already lost moves; the user
  // may be working elsewhere in Board settings.
  const detailGone = view.kind === "detail" && subs !== null && !subs.some((s) => s.id === view.id);
  useEffect(() => {
    if (!detailGone) {
      // Cleared on the way out, so the next deletion is a change and is read.
      setNoticeLive((prev) => (prev === DELETED_ELSEWHERE_COPY ? "" : prev));
      return;
    }
    setNoticeLive(DELETED_ELSEWHERE_COPY);
    const active = document.activeElement;
    if (active === null || active === document.body || rootRef.current?.contains(active)) goneRef.current?.focus();
  }, [detailGone]);

  // Focus targets resolve after the render that mounts them.
  useEffect(() => {
    if (pendingFocus === null) return;
    const target = pendingFocus;
    setPendingFocus(null);
    if (target === "list-heading") listHeadingRef.current?.focus();
    else if (target === "add") (addButtonRef.current ?? listHeadingRef.current)?.focus();
    else if (target === "detail-heading") document.querySelector<HTMLElement>("[data-webhook-status-heading]")?.focus();
    else if (target === "landmark" || target === "landmark-if-lost") {
      // The heading of whatever view is showing. "-if-lost" only when focus
      // fell to the page, so it never takes focus from a control that claimed it.
      const active = document.activeElement;
      if (target === "landmark-if-lost" && active !== null && active !== document.body) return;
      (rootRef.current?.querySelector<HTMLElement>("[data-webhook-status-heading]")
        ?? listHeadingRef.current
        ?? rootRef.current?.querySelector<HTMLElement>("h3[tabindex='-1']"))?.focus();
    }
    else if (target.startsWith("manage:")) manageRefs.current.get(Number(target.slice(7)))?.focus();
  }, [pendingFocus]);

  // Deep link: the first webhook that was turned off automatically, once.
  useEffect(() => {
    if (!focusFirstStopped || deepLinkDoneRef.current || subs === null) return;
    deepLinkDoneRef.current = true;
    const stopped = subs.find((s) => !s.enabled && s.disabled_reason !== "manual");
    if (!stopped) {
      listHeadingRef.current?.focus();
      return;
    }
    const btn = manageRefs.current.get(stopped.id);
    btn?.scrollIntoView?.({ block: "nearest" });
    btn?.focus();
    setHighlightId(stopped.id);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightId(null);
      highlightTimerRef.current = null;
    }, HIGHLIGHT_MS);
  }, [focusFirstStopped, subs]);

  // ── The secret guard (Escape 56, Close, backdrop, tab switch) ────────────────
  const guard = useCallback<WebhookCloseGuard>((proceed) => {
    // Nothing is on screen yet to ask about, so this refuses rather than prompts:
    // leaving now would drop the response, and the server has already replaced
    // the secret, with nothing to tell anyone the new one was never seen.
    if (secretPendingRef.current) {
      refusedProceedRef.current = proceed;
      setRefusals((n) => n + 1);
      return true;
    }
    const r = revealRefState.current;
    if (!r || r.acknowledged) return false;
    guardProceedRef.current = proceed;
    setReveal({ ...r, guardOpen: true });
    return true;
  }, []);

  useEffect(() => {
    registerCloseGuard?.(guard);
    return () => registerCloseGuard?.(null);
  }, [registerCloseGuard, guard]);

  useEscapeStack(() => {
    const r = revealRefState.current;
    if (!r || r.acknowledged) return false;
    if (r.guardOpen) {
      setReveal({ ...r, guardOpen: false });
      revealRef.current?.focusCopy();
    } else {
      guard(() => onRequestClose?.());
    }
  }, WEBHOOK_ESCAPE.secretGuard);
  // Each confirm's Escape: swallowed, not closed, while its request runs.
  const escapeConfirm = (kind: WebhookConfirm) => () => {
    if (confirm !== kind) return false;
    if (!confirmRunningRef.current) setConfirm(null);
  };
  useEscapeStack(escapeConfirm("rotate"), WEBHOOK_ESCAPE.rotateConfirm);
  useEscapeStack(escapeConfirm("reenable"), WEBHOOK_ESCAPE.reenableConfirm);
  useEscapeStack(escapeConfirm("disable"), WEBHOOK_ESCAPE.disableConfirm);
  useEscapeStack(escapeConfirm("delete"), WEBHOOK_ESCAPE.deleteConfirm);

  const replaceSub = (updated: WebhookSubscription) =>
    setSubs((prev) => (prev ? prev.map((s) => (s.id === updated.id ? updated : s)) : prev));

  /** A 403 webhooks_disabled from any call swaps the whole tab to the off note. */
  const guarded = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (axiosResponse(err)?.data?.code === "webhooks_disabled") {
        setReveal(null);
        setFeatureOff(true);
      }
      throw err;
    }
  };

  /**
   * Run a create or rotate: its answer is the only copy of a secret, so every
   * way out is refused while it runs. After SECRET_PENDING_BOUND_MS the tab
   * offers "Leave anyway" (#2127). The request is never canceled: the server
   * may still commit it, so a late answer is still used where it can be.
   */
  const issuingSecret = async <T,>(origin: SecretOrigin, fn: () => Promise<T>): Promise<{ value: T; abandoned: boolean }> => {
    const requestNo = ++pendingTokenRef.current;
    secretPendingRef.current = true;
    refusedProceedRef.current = null;
    const bound = setTimeout(() => {
      if (pendingTokenRef.current === requestNo && secretPendingRef.current) setStuck(origin);
    }, SECRET_PENDING_BOUND_MS);
    try {
      const value = await guarded(fn);
      return { value, abandoned: abandonedRef.current.has(requestNo) };
    } finally {
      clearTimeout(bound);
      abandonedRef.current.delete(requestNo);
      // A request left behind must not unlock a newer one when it settles.
      if (pendingTokenRef.current === requestNo) {
        // "Leave anyway" unmounts now: if it had focus, a heading takes it,
        // unless what the answer mounts (a reveal) claims focus first.
        if (leaveButtonRef.current !== null && document.activeElement === leaveButtonRef.current) {
          setPendingFocus("landmark-if-lost");
        }
        secretPendingRef.current = false;
        refusedProceedRef.current = null;
        setRefusals(0);
        setStuck(null);
      }
      if (refetchDeferredRef.current && !secretPendingRef.current) {
        refetchDeferredRef.current = false;
        refetchList();
      }
    }
  };

  const clearLeftPending = () => {
    setLeftPending(null);
    writeLeftPending(boardId, null);
    // So a later "Leave anyway" with the same sentence is read again.
    setNoticeLive((prev) => (prev === DELETED_ELSEWHERE_COPY ? prev : ""));
  };

  /** Dismiss on the left-pending notice: the notice unmounts, so focus goes to the view's heading. */
  const dismissLeftPending = () => {
    clearLeftPending();
    setPendingFocus("landmark");
  };

  /** "Leave anyway": unlock the tab, say a secret may have been issued, re-read the server. */
  const leaveAnyway = () => {
    const origin = stuck;
    if (origin === null) return;
    abandonedRef.current.add(pendingTokenRef.current);
    secretPendingRef.current = false;
    confirmRunningRef.current = false;
    setStuck(null);
    setRefusals(0);
    setConfirm(null);
    const left = { origin, at: Date.now() };
    setLeftPending(left);
    writeLeftPending(boardId, left);
    setNoticeLive(SECRET_LEFT_COPY[origin]);
    // So the "until" line and the list show what the server has now; a late
    // answer re-reads again.
    listWebhooks(boardId).then(setSubs).catch(() => undefined);
    const proceed = refusedProceedRef.current;
    refusedProceedRef.current = null;
    if (proceed) proceed();
    else if (origin === "create") openList("add");
    // The button unmounts with the banner; the rotate confirm closed above,
    // so focus goes to the webhook's status heading.
    else setPendingFocus("detail-heading");
  };

  const whileConfirmRuns = async (fn: () => Promise<void>) => {
    confirmRunningRef.current = true;
    try {
      await fn();
    } finally {
      confirmRunningRef.current = false;
    }
  };

  const openList = (focus: string) => {
    setView({ kind: "list" });
    setConfirm(null);
    setPendingFocus(focus);
  };

  const finishReveal = () => {
    const r = revealRefState.current;
    if (!r) return;
    setReveal(null);
    guardProceedRef.current = null;
    setLive("Secret hidden. It can't be shown again.");
    setPendingFocus(r.origin === "create" ? "add" : "detail-heading");
  };

  const forceCloseReveal = () => {
    const proceed = guardProceedRef.current;
    guardProceedRef.current = null;
    setReveal(null);
    setLive("Secret hidden without confirmation. Rotate it if you didn't store it.");
    proceed?.();
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  if (featureOff) return <WebhooksOffNotice />;
  if (loadError) {
    return (
      <div className="flex items-center gap-3">
        <p role="alert" className="text-xs text-danger">Failed to load webhooks.</p>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Retry
        </button>
      </div>
    );
  }
  if (status === null || subs === null) {
    return (
      <div className="flex justify-center py-6">
        <Spinner size="sm" label="Loading webhooks" />
      </div>
    );
  }

  const dismissAway = () => {
    setAwayCount(0);
    setStateLive((prev) => (prev === awayCopy(awayCount) ? "" : prev));
    // The focused button unmounts: a heading takes focus.
    setPendingFocus("landmark");
  };
  const dismissDetailChange = () => {
    setStateLive((prev) => (prev === detailChange?.text ? "" : prev));
    setDetailChange(null);
    setPendingFocus("landmark");
  };
  const updatedMinutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);

  const lastRun = status.dispatcher_last_run_at ? Date.parse(status.dispatcher_last_run_at) : NaN;
  const lastRunLabel = Number.isNaN(lastRun) ? null : relativeTime(lastRun, now);

  const revealPanel = reveal && (
    <WebhookSecretReveal
      ref={revealRef}
      host={reveal.host}
      secret={reveal.secret}
      acknowledged={reveal.acknowledged}
      onAcknowledge={(acknowledged) => setReveal({ ...reveal, acknowledged, guardOpen: false })}
      onDone={finishReveal}
      guardOpen={reveal.guardOpen}
      onGuardConfirm={forceCloseReveal}
      onGuardCancel={() => { setReveal({ ...reveal, guardOpen: false }); revealRef.current?.focusCopy(); }}
    />
  );

  let body;
  if (view.kind === "create") {
    body = (
      <WebhookCreateForm
        eventOptions={status.subscribable_event_types}
        onCancel={() => {
          const go = () => openList("add");
          if (!guard(go)) go();
        }}
        onSubmit={async (req) => {
          let created;
          let abandoned;
          try {
            ({ value: created, abandoned } = await issuingSecret("create", () => createWebhook(boardId, req)));
          } catch (err) {
            // A lost response then a retry would leave a second enabled webhook
            // with a secret nobody saw. A refused create added nothing.
            if (outcomeUnknown(err)) await listWebhooks(boardId).then(setSubs).catch(() => undefined);
            throw err;
          }
          const { url: _url, secret, ...sub } = created;
          void _url;
          // A refetch may already hold the row (#2057).
          setSubs((prev) => [sub, ...(prev ?? []).filter((s) => s.id !== sub.id)]);
          if (abandoned) {
            // Left while waiting (#2127): show the secret only where it belongs,
            // without moving the user, and then the warning is no longer needed.
            if (viewRef.current.kind === "detail") return;
            clearLeftPending();
          }
          setView({ kind: "list" });
          setReveal({ subId: sub.id, host: sub.url_host, secret, origin: "create", acknowledged: false, guardOpen: false });
          // The new row is first in the list.
          setLive(`Webhook 1 of ${(subs?.length ?? 0) + 1} created. Copy its signing secret now.`);
        }}
      />
    );
  } else if (view.kind === "detail") {
    const sub = subs.find((s) => s.id === view.id);
    if (!sub) {
      // Deleted by another admin while open (#2057, webhook-deleted-elsewhere).
      body = (
        // Announced through the always-mounted notice slot; the sentence takes
        // focus when the webhook vanishes (the effect on detailGone).
        <div className="flex flex-col items-start gap-2 rounded-lg border border-line bg-raised px-3 py-3">
          <p ref={goneRef} tabIndex={-1} className="text-sm text-fg focus:outline-none">{DELETED_ELSEWHERE_COPY}</p>
          <button
            type="button"
            onClick={() => openList("list-heading")}
            className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded border border-line-strong transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Back to all webhooks
          </button>
        </div>
      );
    } else {
      body = (
        <>
        {detailChange?.id === sub.id && (
          // Announced through the always-mounted state slot; no live role of its own (#1421, #2403).
          <div data-testid="webhook-changed-detail" className="flex items-start gap-3 rounded-lg border border-line bg-raised px-3 py-2 text-xs text-fg">
            <p className="flex-1">{detailChange.text}</p>
            <button
              type="button"
              onClick={dismissDetailChange}
              className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}
        <WebhookDetail
          key={sub.id}
          sub={sub}
          status={status}
          now={now}
          confirm={confirm}
          onConfirmChange={(next) => {
            // Another confirm opening would unmount the one whose request runs.
            if (!confirmRunningRef.current) setConfirm(next);
          }}
          currentUserHasPassword={currentUserHasPassword}
          reveal={reveal?.origin === "rotate" && reveal.subId === sub.id ? revealPanel : undefined}
          revealOpen={revealShown}
          onBack={() => {
            const go = () => openList(`manage:${sub.id}`);
            if (!guard(go)) go();
          }}
          onTest={() => guarded(() => testWebhook(boardId, sub.id))}
          onDisable={() => whileConfirmRuns(async () => {
            replaceSub(await guarded(() => disableWebhook(boardId, sub.id)));
            setConfirm(null);
            setLive(`${webhookPosition(subs, sub.id)} turned off.`);
          })}
          onReenable={(resumeFrom, password) => whileConfirmRuns(async () => {
            replaceSub(await guarded(() => reenableWebhook(boardId, sub.id, resumeFrom, password)));
            setConfirm(null);
            setLive(`${webhookPosition(subs, sub.id)} is on.`);
            setPendingFocus("detail-heading");
          })}
          onRotate={(overlapSeconds) => whileConfirmRuns(async () => {
            let rotated;
            let abandoned;
            try {
              ({ value: rotated, abandoned } = await issuingSecret("rotate", () => rotateWebhookSecret(boardId, sub.id, overlapSeconds)));
            } catch (err) {
              // The response may be all that was lost. Show what the server has,
              // so the "until" line is true before anyone retries: a retry retires
              // whatever that lost rotation left as the current secret.
              if (axiosResponse(err)?.data?.code !== "webhooks_disabled") {
                const list = await listWebhooks(boardId).catch(() => null);
                if (list) {
                  setSubs(list);
                  // Deleted elsewhere: the detail view would render nothing.
                  if (!list.some((s) => s.id === sub.id)) {
                    setLive("This webhook no longer exists.");
                    openList("list-heading");
                  }
                }
              }
              throw err;
            }
            const { secret, ...updated } = rotated;
            replaceSub(updated);
            if (abandoned) {
              // Left while waiting (#2127): reveal only if the user is still
              // on this webhook; never pull them back to it.
              const v = viewRef.current;
              if (v.kind !== "detail" || v.id !== sub.id) return;
              clearLeftPending();
            }
            setConfirm(null);
            // Its own webhook's detail is the one place this reveal renders.
            setView({ kind: "detail", id: sub.id });
            setReveal({ subId: sub.id, host: sub.url_host, secret, origin: "rotate", acknowledged: false, guardOpen: false });
          })}
          onDelete={() => whileConfirmRuns(async () => {
            await guarded(() => deleteWebhook(boardId, sub.id));
            // Read before the row leaves the list.
            const position = webhookPosition(subs, sub.id);
            setSubs((prev) => (prev ? prev.filter((s) => s.id !== sub.id) : prev));
            // Deleting destroys the secret too: nothing left to protect.
            if (reveal?.subId === sub.id) {
              setReveal(null);
              guardProceedRef.current = null;
            }
            setLive(`${position} deleted.`);
            openList("list-heading");
          })}
          onChangeAddress={async (url) => {
            replaceSub(await guarded(() => updateWebhook(boardId, sub.id, { url })));
            setLive("Address changed. You're now this webhook's owner.");
          }}
        />
        </>
      );
    }
  } else {
    const intro = (
      <p className="text-xs text-fg-tertiary leading-relaxed">
        Each webhook gets a signed POST for every change on this board. Delivery is best effort: Visiban retries a failed send, then turns the webhook off if it keeps failing. It doesn't keep a delivery history.
      </p>
    );
    body = (
      <section aria-labelledby="webhooks-heading" className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h3
            id="webhooks-heading"
            ref={listHeadingRef}
            tabIndex={-1}
            className="flex-1 text-xs font-semibold text-fg-tertiary uppercase tracking-wide focus:outline-none"
          >
            Webhooks
          </h3>
          {subs.length > 0 && !revealShown && (
            <button
              ref={addButtonRef}
              type="button"
              onClick={() => { setLive(""); setView({ kind: "create" }); }}
              className="text-xs bg-button-primary text-on-primary px-3 py-1.5 rounded hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
            >
              Add webhook
            </button>
          )}
        </div>
        {subs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 text-center py-10 px-6 border border-dashed border-line rounded-lg">
            <p className="text-base font-semibold text-fg">No webhooks yet</p>
            <p className="text-sm text-fg-secondary">Send this board's changes to Zapier, n8n, a Slack bridge or your own script.</p>
            <button
              ref={addButtonRef}
              type="button"
              onClick={() => { setLive(""); setView({ kind: "create" }); }}
              className="mt-1 text-xs bg-button-primary text-on-primary px-3 py-1.5 rounded hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
            >
              Add webhook
            </button>
          </div>
        ) : (
          <>
            {intro}
            {reveal?.origin === "create" && revealPanel}
            <WebhookList
              subs={subs}
              now={now}
              highlightId={highlightId}
              changedIds={changedIds}
              onManage={(id) => {
                // An unacknowledged secret owns the tab: leaving asks first.
                const go = () => { setConfirm(null); setLive(""); setView({ kind: "detail", id }); };
                if (!guard(go)) go();
              }}
              manageRef={(id) => (el) => {
                if (el) manageRefs.current.set(id, el);
                else manageRefs.current.delete(id);
              }}
            />
          </>
        )}
        {subs.length === 0 && intro}
      </section>
    );
  }

  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      {stuck !== null ? (
        // Past the bound (#2127): the same alert slot, now with a way out. The
        // alert is the message only, keyed so each refusal is announced again;
        // the button sits beside it (#1772) and is not remounted by a refusal.
        <div className="scroll-mt-5 flex flex-col items-start gap-2 rounded-lg border border-warning/60 bg-warning/15 px-3 py-2 text-xs text-warning-on-tint">
          <p key={`stuck-${refusals}`} id="webhook-secret-stuck" ref={refusalRef} role="alert">{SECRET_STUCK_COPY[stuck]}</p>
          <button
            ref={leaveButtonRef}
            type="button"
            onClick={leaveAnyway}
            aria-describedby="webhook-secret-stuck"
            className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded border border-line-strong bg-surface transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Leave anyway
          </button>
        </div>
      ) : refusals > 0 && (
        <p key={`refusal-${refusals}`} ref={refusalRef} role="alert" className="scroll-mt-5 rounded-lg border border-warning/60 bg-warning/15 px-3 py-2 text-xs text-warning-on-tint">
          {SECRET_PENDING_COPY}
        </p>
      )}
      {leftPending !== null && (
        // Announced through the always-mounted notice slot below (#1421).
        <div data-testid="webhook-left-pending" className="flex items-start gap-3 rounded-lg border border-warning/60 bg-warning/15 px-3 py-2 text-xs text-warning-on-tint">
          <p className="flex-1">{SECRET_LEFT_COPY[leftPending.origin]}</p>
          <button
            type="button"
            onClick={dismissLeftPending}
            className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}
      {paused && (
        // Announced through the always-mounted state slot below (#2403).
        <div data-testid="webhooks-paused" className="flex items-center gap-3 rounded-lg border border-warning/60 bg-warning/15 px-3 py-2 text-xs text-warning-on-tint">
          <p className="flex-1">
            Live updates paused · Updated {updatedMinutes < 1 ? "just now" : `${updatedMinutes} min ago`}
          </p>
          <button
            type="button"
            onClick={() => refetchList()}
            className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded border border-line-strong bg-surface transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis shrink-0"
          >
            Refresh
          </button>
        </div>
      )}
      {awayCount > 0 && !paused && (
        <div data-testid="webhooks-away" className="flex items-center gap-3 rounded-lg border border-line bg-raised px-3 py-2 text-xs text-fg">
          <p className="flex-1">{awayCopy(awayCount)}</p>
          <button
            type="button"
            onClick={dismissAway}
            className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}
      {status.dispatcher_stale && <DispatcherStaleNotice lastRunLabel={lastRunLabel} />}
      {body}
      {/* The list status slot: created, deleted, turned off, turned on. */}
      <p className="text-xs text-fg-tertiary min-h-4" role="status" aria-live="polite" aria-atomic="true">{live}</p>
      {/* Changes made elsewhere (#2057), coalesced; kept apart so they never overwrite the slot above. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{remoteLive}</p>
      {/* "May have taken effect" and "deleted elsewhere" (#2127, #2057): the visible banners carry no live role. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="webhook-notice-live">{noticeLive}</p>
      {/* Live updates paused, changed while away, and a change to the open webhook (#2403). */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="webhook-state-live">{stateLive}</p>
    </div>
  );
}
