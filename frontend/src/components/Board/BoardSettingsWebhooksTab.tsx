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
import type { WebhookStatus, WebhookSubscription } from "../../types";
import { webhookPosition } from "../../constants/webhooks";
import WebhookList from "./webhooks/WebhookList";
import WebhookCreateForm from "./webhooks/WebhookCreateForm";
import { axiosResponse } from "./webhooks/webhookFormUtils";
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

const CLOCK_TICK_MS = 30_000;
const HIGHLIGHT_MS = 1500;

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

  const listHeadingRef = useRef<HTMLHeadingElement>(null);
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
  // The guard protects the reveal only while it is on screen: a create reveal
  // above the list, a rotate reveal in its own webhook's detail. Any path that
  // takes it off screen disarms the guard (frontend/CLAUDE.md, close guards).
  const revealShown =
    reveal !== null &&
    !featureOff &&
    ((reveal.origin === "create" && view.kind === "list") ||
      (reveal.origin === "rotate" && view.kind === "detail" && view.id === reveal.subId));
  revealRefState.current = revealShown ? reveal : null;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => {
    if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current);
  }, []);

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
  useEffect(() => {
    if (refusals > 0) refusalRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [refusals]);

  // Focus targets resolve after the render that mounts them.
  useEffect(() => {
    if (pendingFocus === null) return;
    const target = pendingFocus;
    setPendingFocus(null);
    if (target === "list-heading") listHeadingRef.current?.focus();
    else if (target === "add") (addButtonRef.current ?? listHeadingRef.current)?.focus();
    else if (target === "detail-heading") document.querySelector<HTMLElement>("[data-webhook-status-heading]")?.focus();
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

  const issuingSecret = async <T,>(fn: () => Promise<T>): Promise<T> => {
    secretPendingRef.current = true;
    try {
      return await guarded(fn);
    } finally {
      secretPendingRef.current = false;
      setRefusals(0);
    }
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
          const created = await issuingSecret(() => createWebhook(boardId, req));
          const { url: _url, secret, ...sub } = created;
          void _url;
          setSubs((prev) => [sub, ...(prev ?? [])]);
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
      body = null;
    } else {
      body = (
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
            try {
              rotated = await issuingSecret(() => rotateWebhookSecret(boardId, sub.id, overlapSeconds));
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
    <div className="flex flex-col gap-3">
      {refusals > 0 && (
        <p key={`refusal-${refusals}`} ref={refusalRef} role="alert" className="rounded-lg border border-warning/60 bg-warning/15 px-3 py-2 text-xs text-warning-on-tint">
          {SECRET_PENDING_COPY}
        </p>
      )}
      {status.dispatcher_stale && <DispatcherStaleNotice lastRunLabel={lastRunLabel} />}
      {body}
      {/* The list status slot: created, deleted, turned off, turned on. */}
      <p className="text-xs text-fg-tertiary min-h-4" role="status" aria-live="polite" aria-atomic="true">{live}</p>
    </div>
  );
}
