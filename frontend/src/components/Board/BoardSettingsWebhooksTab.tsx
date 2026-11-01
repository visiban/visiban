import { useCallback, useEffect, useRef, useState } from "react";
import Spinner from "../Common/Spinner";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
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
  type WebhookResumeFrom,
  type WebhookWriteBody,
} from "../../api/webhooks";
import type { WebhookStatus, WebhookSubscription } from "../../types";
import {
  CONFIG_ERROR_COPY,
  WEBHOOKS_VERIFY_URL,
  deliveryErrorCopy,
  webhookRowStatus,
} from "../../constants/webhooks";
import WebhookRow, { type WebhookRowAction, type WebhookRowMessage } from "./webhooks/WebhookRow";
import WebhookForm, { type WebhookFormHandle } from "./webhooks/WebhookForm";
import WebhookSecretReveal from "./webhooks/WebhookSecretReveal";
import WebhookReenablePrompt from "./webhooks/WebhookReenablePrompt";
import { DispatcherStaleNotice, WebhooksOffNotice } from "./webhooks/WebhookServiceNotice";

/**
 * Escape priorities inside Board Settings (frontend/CLAUDE.md, modal list):
 * all above ModalWrapper's 40 and the Members tab's 49-51.
 */
export const WEBHOOK_INLINE_ESCAPE_PRIORITY = 52;
export const WEBHOOK_FORM_ESCAPE_PRIORITY = 53;
export const WEBHOOK_REVEAL_ESCAPE_PRIORITY = 54;

const REVEAL_GUARD_MESSAGE = "Copy the secret, then choose Done.";
const HIGHLIGHT_MS = 1500;
const CLOCK_TICK_MS = 30_000;

interface Props {
  boardId: number;
  /** Opened from the `webhook_disabled` notification deep link (#863). */
  focusFirstStopped?: boolean;
}

type InlineKind = "rotate" | "delete" | "reenable";
type ActivePanel =
  | { rowId: "new"; kind: "form" }
  | { rowId: number; kind: "edit" }
  | { rowId: number; kind: InlineKind }
  | { rowId: number; kind: "reveal"; url?: string; secret: string; origin: "create" | "rotate" };

function errorCode(err: unknown): { status?: number; code?: string } {
  const response = (err as { response?: { status?: number; data?: { code?: unknown } } })?.response;
  const code = response?.data?.code;
  return { status: response?.status, code: typeof code === "string" ? code : undefined };
}

function displayName(sub: WebhookSubscription) {
  return sub.name || sub.url_host;
}

/** Board Settings → Webhooks (#863; UX spec on the issue). Board admins only. */
export default function BoardSettingsWebhooksTab({ boardId, focusFirstStopped = false }: Props) {
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [featureOff, setFeatureOff] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [subs, setSubs] = useState<WebhookSubscription[] | null>(null);
  const [panel, setPanel] = useState<ActivePanel | null>(null);
  const [inlineInFlight, setInlineInFlight] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [reenableExpired, setReenableExpired] = useState(false);
  const [revealGuard, setRevealGuard] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<number, WebhookRowMessage>>({});
  const [testing, setTesting] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [tabStatus, setTabStatus] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reloadKey, setReloadKey] = useState(0);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<WebhookFormHandle>(null);
  const rowRefs = useRef(new Map<number, HTMLLIElement>());
  const firstActionRefs = useRef(new Map<number, HTMLButtonElement>());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deepLinkDoneRef = useRef(false);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);

  const inlineKey =
    panel && (panel.kind === "rotate" || panel.kind === "delete" || panel.kind === "reenable")
      ? `${panel.rowId}:${panel.kind}`
      : null;
  const triggerRef = useConfirmFocusReturn<string>(inlineKey);
  const triggerEls = useRef(new Map<string, HTMLElement>());
  const registerTrigger = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      triggerRef(key)(el);
      if (el) triggerEls.current.set(key, el);
      else triggerEls.current.delete(key);
    },
    [triggerRef],
  );

  // Relative times stay roughly current while the tab is open.
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
        setFeatureOff(false);
        const list = await listWebhooks(boardId);
        if (!canceled) setSubs(list);
      })
      .catch((err: unknown) => {
        if (canceled) return;
        if (errorCode(err).code === "webhooks_disabled") setFeatureOff(true);
        else setLoadError(true);
      });
    return () => { canceled = true; };
  }, [boardId, reloadKey]);

  // Pending focus targets are resolved after the render that mounts them.
  useEffect(() => {
    if (pendingFocus === null) return;
    const target = pendingFocus;
    setPendingFocus(null);
    if (target === "heading") headingRef.current?.focus();
    else if (target === "new") newButtonRef.current?.focus();
    else triggerEls.current.get(target)?.focus();
  }, [pendingFocus]);

  // Deep link from the notification: focus the first Stopped row, once.
  useEffect(() => {
    if (!focusFirstStopped || deepLinkDoneRef.current || subs === null) return;
    deepLinkDoneRef.current = true;
    const stopped = subs.find((s) => webhookRowStatus(s) === "stopped");
    if (!stopped) {
      headingRef.current?.focus();
      return;
    }
    rowRefs.current.get(stopped.id)?.scrollIntoView?.({ block: "nearest" });
    firstActionRefs.current.get(stopped.id)?.focus();
    setHighlightId(stopped.id);
    if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightId(null);
      highlightTimerRef.current = null;
    }, HIGHLIGHT_MS);
  }, [focusFirstStopped, subs]);

  const closeInline = useCallback(() => {
    setPanel(null);
    setInlineError(null);
    setReenableExpired(false);
  }, []);

  // ── Escape (52 inline · 53 form · 54 reveal guard) ──────────────────────────
  useEscapeStack(() => {
    if (panel?.kind !== "reveal") return false;
    setRevealGuard(REVEAL_GUARD_MESSAGE);
  }, WEBHOOK_REVEAL_ESCAPE_PRIORITY);
  useEscapeStack(() => {
    if (panel?.kind !== "form" && panel?.kind !== "edit") return false;
    formRef.current?.cancel();
  }, WEBHOOK_FORM_ESCAPE_PRIORITY);
  useEscapeStack(() => {
    if (inlineKey === null) return false;
    if (!inlineInFlight) closeInline();
  }, WEBHOOK_INLINE_ESCAPE_PRIORITY);

  const setMessage = (id: number, message: WebhookRowMessage | null) =>
    setMessages((prev) => {
      const next = { ...prev };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });

  const replaceSub = (updated: WebhookSubscription) =>
    setSubs((prev) => (prev ? prev.map((s) => (s.id === updated.id ? updated : s)) : prev));

  const withBusy = async (id: number, fn: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(id));
    try {
      await fn();
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  /** Shared failure handling: feature off swaps the tab; otherwise a row message. */
  const failRow = (id: number, err: unknown, what: string) => {
    const { status: httpStatus, code } = errorCode(err);
    if (code === "webhooks_disabled") {
      setFeatureOff(true);
      return;
    }
    if (httpStatus === 429) {
      setMessage(id, { tone: "warning", text: what === "test" ? "Too many tests. Try again later." : "Too many webhook changes in a short time. Try again in a few minutes." });
      return;
    }
    if (code === "session_required") {
      setMessage(id, { tone: "danger", text: CONFIG_ERROR_COPY.session_required.text });
      return;
    }
    setMessage(id, { tone: "danger", text: `Couldn't ${what} the webhook. Try again.` });
  };

  // ── Actions ─────────────────────────────────────────────────────────────────
  const handleCreate = async (body: WebhookWriteBody) => {
    try {
      const created = await createWebhook(boardId, body as WebhookWriteBody & { url: string });
      const { url, secret, ...sub } = created;
      setSubs((prev) => [...(prev ?? []), sub]);
      setRevealGuard(null);
      setPanel({ rowId: created.id, kind: "reveal", url, secret, origin: "create" });
    } catch (err) {
      if (errorCode(err).code === "webhooks_disabled") setFeatureOff(true);
      throw err;
    }
  };

  const handleEdit = async (sub: WebhookSubscription, body: WebhookWriteBody) => {
    try {
      const updated = await updateWebhook(boardId, sub.id, body);
      replaceSub(updated);
      setPanel(null);
      setMessage(sub.id, { tone: "neutral", text: "Webhook updated." });
      setPendingFocus(`${sub.id}:edit`);
    } catch (err) {
      if (errorCode(err).code === "webhooks_disabled") setFeatureOff(true);
      throw err;
    }
  };

  const handleTest = (sub: WebhookSubscription) => {
    setMessage(sub.id, null);
    setTesting((prev) => new Set(prev).add(sub.id));
    void withBusy(sub.id, async () => {
      try {
        const result = await testWebhook(boardId, sub.id);
        if (result.ok) {
          setMessage(sub.id, { tone: "success", text: `Test event delivered (HTTP ${result.status_code}).` });
        } else {
          setMessage(sub.id, {
            tone: "danger",
            text: `${deliveryErrorCopy(result.code, result.status_code)}.`,
            remedy: "Check that the receiver is reachable and returns a 2xx.",
          });
        }
      } catch (err) {
        failRow(sub.id, err, "test");
      } finally {
        setTesting((prev) => {
          const next = new Set(prev);
          next.delete(sub.id);
          return next;
        });
      }
    });
  };

  const handleDisable = (sub: WebhookSubscription) => {
    setMessage(sub.id, null);
    void withBusy(sub.id, async () => {
      try {
        replaceSub(await disableWebhook(boardId, sub.id));
        setMessage(sub.id, { tone: "neutral", text: "Webhook disabled." });
        setPendingFocus(`${sub.id}:reenable`);
      } catch (err) {
        failRow(sub.id, err, "disable");
      }
    });
  };

  const runInline = async (fn: () => Promise<void>) => {
    setInlineInFlight(true);
    setInlineError(null);
    try {
      await fn();
    } finally {
      setInlineInFlight(false);
    }
  };

  const handleReenable = (sub: WebhookSubscription, resumeFrom: WebhookResumeFrom) =>
    void runInline(async () => {
      try {
        replaceSub(await reenableWebhook(boardId, sub.id, resumeFrom));
        setPanel(null);
        setReenableExpired(false);
        setMessage(sub.id, { tone: "neutral", text: "Webhook re-enabled." });
        setPendingFocus(`${sub.id}:test`);
      } catch (err) {
        const { code } = errorCode(err);
        if (code === "cursor_expired") setReenableExpired(true);
        else if (code === "webhooks_disabled") setFeatureOff(true);
        else if (code === "session_required") setInlineError(CONFIG_ERROR_COPY.session_required.text);
        else if (code === "secret_unavailable") setInlineError("This webhook's stored URL or secret can no longer be read. Delete it and create a new one.");
        else setInlineError("Couldn't re-enable the webhook. Try again.");
      }
    });

  const handleRotate = (sub: WebhookSubscription) =>
    void runInline(async () => {
      try {
        const { secret, ...updated } = await rotateWebhookSecret(boardId, sub.id);
        replaceSub(updated);
        setRevealGuard(null);
        setPanel({ rowId: sub.id, kind: "reveal", secret, origin: "rotate" });
      } catch (err) {
        const { code, status: httpStatus } = errorCode(err);
        if (code === "webhooks_disabled") setFeatureOff(true);
        else if (code === "session_required") setInlineError(CONFIG_ERROR_COPY.session_required.text);
        else if (httpStatus === 429) setInlineError("Too many webhook changes in a short time. Try again in a few minutes.");
        else setInlineError("Couldn't rotate the secret. Try again.");
      }
    });

  const handleDelete = (sub: WebhookSubscription) =>
    void runInline(async () => {
      try {
        await deleteWebhook(boardId, sub.id);
        setPanel(null);
        setSubs((prev) => (prev ? prev.filter((s) => s.id !== sub.id) : prev));
        setMessage(sub.id, null);
        setTabStatus("Webhook deleted.");
        setPendingFocus("heading");
      } catch (err) {
        if (errorCode(err).code === "webhooks_disabled") setFeatureOff(true);
        else setInlineError("Couldn't delete the webhook. Try again.");
      }
    });

  const onRowAction = (sub: WebhookSubscription, action: WebhookRowAction) => {
    setTabStatus(null);
    if (action === "test") return handleTest(sub);
    if (action === "disable") return handleDisable(sub);
    setInlineError(null);
    setReenableExpired(false);
    if (action === "edit") {
      setMessage(sub.id, null);
      setPanel({ rowId: sub.id, kind: "edit" });
      return;
    }
    setPanel({ rowId: sub.id, kind: action });
  };

  const handleRevealDone = () => {
    if (panel?.kind !== "reveal") return;
    const { rowId, origin } = panel;
    setPanel(null);
    setRevealGuard(null);
    setPendingFocus(origin === "create" ? `${rowId}:test` : `${rowId}:rotate`);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  if (featureOff) {
    return <WebhooksOffNotice />;
  }
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
  const formOpen = panel?.kind === "form";
  const topReveal = panel?.kind === "reveal" && panel.origin === "create" ? panel : null;

  const inlinePanelFor = (sub: WebhookSubscription) => {
    if (!panel || panel.rowId !== sub.id) return null;
    const name = displayName(sub);
    if (panel.kind === "reenable") {
      return (
        <WebhookReenablePrompt
          name={name}
          cursorExpired={reenableExpired || sub.disabled_reason === "cursor_expired"}
          inFlight={inlineInFlight}
          error={inlineError}
          onConfirm={(resumeFrom) => handleReenable(sub, resumeFrom)}
          onCancel={() => { if (!inlineInFlight) closeInline(); }}
        />
      );
    }
    if (panel.kind === "rotate" || panel.kind === "delete") {
      const isDelete = panel.kind === "delete";
      return (
        <div role="group" aria-label={isDelete ? `Delete ${name}` : `Rotate secret for ${name}`} className="basis-full flex flex-wrap items-center gap-2 text-xs">
          <span className="text-fg-tertiary">
            {isDelete
              ? `Delete ${name}? Visiban stops sending events to this URL. This can't be undone.`
              : `Rotate the signing secret for ${name}? The current secret stops working immediately, so deliveries fail signature checks until you update your receiver.`}
          </span>
          <button
            type="button"
            onClick={() => (isDelete ? handleDelete(sub) : handleRotate(sub))}
            disabled={inlineInFlight}
            aria-label={isDelete ? `Confirm: delete ${name}` : `Confirm: rotate secret for ${name}`}
            className="text-danger hover:text-danger font-medium transition rounded disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={() => { if (!inlineInFlight) closeInline(); }}
            disabled={inlineInFlight}
            aria-label={isDelete ? `Cancel deleting ${name}` : `Cancel rotating the secret for ${name}`}
            className="text-fg-tertiary hover:text-fg transition rounded disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Cancel
          </button>
          {inlineError && <p className="basis-full text-danger">{inlineError}</p>}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-3">
      {status.dispatcher_stale && <DispatcherStaleNotice lastRunLabel={lastRunLabel} />}

      <div>
        <div className="flex items-center justify-between gap-3">
          <h3
            id="webhooks-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide focus:outline-none"
          >
            Webhooks
          </h3>
          {!formOpen && !topReveal && (
            <button
              ref={newButtonRef}
              type="button"
              onClick={() => { setTabStatus(null); setInlineError(null); setPanel({ rowId: "new", kind: "form" }); }}
              className="text-xs bg-button-primary text-on-primary px-3 py-1.5 rounded hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
            >
              New webhook
            </button>
          )}
        </div>
        {!status.dispatcher_stale && lastRunLabel && (
          <p className="text-xs text-fg-tertiary mt-1">Dispatcher last ran {lastRunLabel}.</p>
        )}
        <p className="text-xs text-fg-tertiary mt-1">
          Visiban sends a signed POST to each URL when this board changes. Members' private activity is never sent.{" "}
          <a
            href={WEBHOOKS_VERIFY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
          >
            How to verify signatures
          </a>
        </p>
      </div>

      {formOpen && (
        <WebhookForm
          ref={formRef}
          mode="create"
          eventOptions={status.subscribable_event_types}
          onSubmit={handleCreate}
          onCancel={() => { setPanel(null); setPendingFocus("new"); }}
        />
      )}
      {topReveal && (
        <WebhookSecretReveal
          url={topReveal.url}
          secret={topReveal.secret}
          onDone={handleRevealDone}
          guardMessage={revealGuard}
        />
      )}

      {subs.length === 0 && !formOpen && !topReveal && (
        <p className="text-xs text-fg-muted">No webhooks yet.</p>
      )}

      {subs.length > 0 && (
        <ul aria-labelledby="webhooks-heading" className="flex flex-col gap-2">
          {subs.map((sub) => {
            const editing = panel?.kind === "edit" && panel.rowId === sub.id;
            const rotateReveal = panel?.kind === "reveal" && panel.origin === "rotate" && panel.rowId === sub.id ? panel : null;
            return (
              <WebhookRow
                key={sub.id}
                sub={sub}
                now={now}
                highlighted={highlightId === sub.id}
                testing={testing.has(sub.id)}
                busy={busy.has(sub.id) || (inlineInFlight && panel?.rowId === sub.id)}
                message={messages[sub.id] ?? null}
                onAction={(action) => onRowAction(sub, action)}
                triggerRef={registerTrigger}
                rowRef={(el) => {
                  if (el) rowRefs.current.set(sub.id, el);
                  else rowRefs.current.delete(sub.id);
                }}
                firstActionRef={(el) => {
                  if (el) firstActionRefs.current.set(sub.id, el);
                  else firstActionRefs.current.delete(sub.id);
                }}
                inlinePanel={inlinePanelFor(sub)}
                reveal={rotateReveal ? (
                  <WebhookSecretReveal
                    secret={rotateReveal.secret}
                    onDone={handleRevealDone}
                    guardMessage={revealGuard}
                  />
                ) : undefined}
                editForm={editing ? (
                  <WebhookForm
                    ref={formRef}
                    mode="edit"
                    initial={sub}
                    eventOptions={status.subscribable_event_types}
                    onSubmit={(body) => handleEdit(sub, body)}
                    onCancel={() => { setPanel(null); setPendingFocus(`${sub.id}:edit`); }}
                  />
                ) : undefined}
              />
            );
          })}
        </ul>
      )}

      <p className="text-xs min-h-4" role="status" aria-live="polite" aria-atomic="true">
        {tabStatus && <span className="text-fg-secondary">{tabStatus}</span>}
      </p>
    </div>
  );
}
