import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { WebhookResumeFrom } from "../../../api/webhooks";
import type { WebhookStatus, WebhookSubscription, WebhookTestResult } from "../../../types";
import { useConfirmFocusReturn } from "../../../hooks/useConfirmFocusReturn";
import { relativeTime } from "../../../utils/relativeTime";
import {
  SAMPLE_PAYLOAD,
  SESSION_REQUIRED_COPY,
  URL_ERROR_COPY,
  URL_HELPER_COPY,
  VERIFY_STEPS,
  disabledReasonCopy,
  lastErrorLabel,
  reenableConfirmCopy,
  testResultCopy,
  urlErrorFromResponse,
  urlShapeError,
} from "../../../constants/webhooks";
import WebhookStatusPill from "./WebhookStatusPill";
import { axiosResponse, urlInputClass } from "./webhookFormUtils";

export type WebhookConfirm = "delete" | "disable" | "reenable" | "rotate";

interface Props {
  sub: WebhookSubscription;
  status: WebhookStatus;
  now: number;
  /** The open inline confirm; owned by the tab so Escape (52-55) can close it. */
  confirm: WebhookConfirm | null;
  onConfirmChange: (next: WebhookConfirm | null) => void;
  /** The rotate reveal, when a rotation just happened. */
  reveal?: ReactNode;
  /** A one-time secret is on screen: rotating again would overwrite it unseen. */
  revealOpen?: boolean;
  currentUserHasPassword: boolean;
  onBack: () => void;
  onTest: () => Promise<WebhookTestResult>;
  onDisable: () => Promise<void>;
  onReenable: (resumeFrom: WebhookResumeFrom, password?: string) => Promise<void>;
  onRotate: () => Promise<void>;
  onDelete: () => Promise<void>;
  onChangeAddress: (url: string) => Promise<void>;
}

const SECONDARY_BTN =
  "text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded border border-line-strong transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40";
const PRIMARY_BTN =
  "text-xs bg-button-primary text-on-primary px-3 py-1.5 rounded hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium disabled:opacity-40";
const CONFIRM_BTN = "min-h-6 px-1 text-danger hover:text-danger font-medium transition rounded disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-danger-emphasis";
const CANCEL_BTN = "min-h-6 px-1 text-fg-tertiary hover:text-fg transition rounded disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

function when(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : relativeTime(t, now);
}

function dateLabel(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : t.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function lastErrorLine(sub: WebhookSubscription, now: number): string | null {
  const label = lastErrorLabel(sub);
  if (!label) return null;
  const ago = when(sub.last_attempt_at, now);
  return `${label}${ago ? ` · ${ago}` : ""}`;
}

function person(user: WebhookSubscription["created_by"]): string {
  return user ? user.display_name || user.username : "a former member";
}

/** One webhook's detail view (1.3 UI spec Part 8 § webhook-detail). */
export default function WebhookDetail(props: Props) {
  const { sub, status, now, confirm, onConfirmChange, reveal, revealOpen = false, currentUserHasPassword } = props;
  const uid = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const turnOnRef = useRef<HTMLButtonElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const turnOnConfirmRef = useRef<HTMLButtonElement>(null);
  const changeAddressRef = useRef<HTMLButtonElement>(null);
  const [focusChangeAddress, setFocusChangeAddress] = useState(false);
  const triggerRef = useConfirmFocusReturn<WebhookConfirm>(confirm);
  const [inFlight, setInFlight] = useState<WebhookConfirm | "test" | "address" | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [expiredOnServer, setExpiredOnServer] = useState(false);
  const [testResult, setTestResult] = useState<ReturnType<typeof testResultCopy> | null>(null);
  const [editingAddress, setEditingAddress] = useState(false);
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [focusTurnOn, setFocusTurnOn] = useState(false);

  // Manage → focus the detail heading.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    // The confirm replaced its trigger: move focus into it (the password
    // field when there is one, else the confirm's own button).
    if (confirm === "reenable") (passwordRef.current ?? turnOnConfirmRef.current)?.focus();
    setConfirmError(null);
    setPasswordError(null);
    if (confirm !== "reenable") {
      setPassword("");
      setExpiredOnServer(false);
    }
  }, [confirm]);

  useEffect(() => {
    if (editingAddress) addressRef.current?.focus();
  }, [editingAddress]);
  // The address form unmounts on Save and on Cancel: return to its trigger.
  useEffect(() => {
    if (focusChangeAddress && !editingAddress) {
      changeAddressRef.current?.focus();
      setFocusChangeAddress(false);
    }
  }, [focusChangeAddress, editingAddress]);

  // Turn off success focuses Turn on again (spec Part 8 § Turn off · delete).
  useEffect(() => {
    if (focusTurnOn && !sub.enabled) {
      turnOnRef.current?.focus();
      setFocusTurnOn(false);
    }
  }, [focusTurnOn, sub.enabled]);

  const reason = disabledReasonCopy(sub, status.disable_after_failures);
  const takeOver = sub.disabled_reason === "creator_lost_access";
  const expired = sub.disabled_reason === "cursor_expired" || expiredOnServer;

  const handle = async (kind: WebhookConfirm | "test" | "address", fn: () => Promise<void>, fail: (err: unknown) => void) => {
    setInFlight(kind);
    try {
      await fn();
    } catch (err) {
      const code = axiosResponse(err)?.data?.code;
      if (code === "session_required") {
        if (kind === "address") setAddressError(SESSION_REQUIRED_COPY);
        else if (kind === "test") setTestResult({ tone: "err", headline: SESSION_REQUIRED_COPY, remedy: "" });
        else setConfirmError(SESSION_REQUIRED_COPY);
      } else fail(err);
    } finally {
      setInFlight(null);
    }
  };

  const runTest = () => {
    if (inFlight === "test") return; // aria-disabled needs its own guard
    // Clear the old result so an identical new one is announced again.
    setTestResult(null);
    void handle(
      "test",
      async () => setTestResult(testResultCopy(await props.onTest(), status.test_timeout_seconds)),
      (err) => setTestResult(axiosResponse(err)?.status === 429
        ? testResultCopy("rate_limited")
        : { tone: "err", headline: "Couldn't send the test event.", remedy: "Try again." }),
    );
  };

  const confirmReenable = () => {
    if (takeOver && currentUserHasPassword && !password) {
      setPasswordError("Enter your current password.");
      passwordRef.current?.focus();
      return;
    }
    void handle(
      "reenable",
      async () => {
        await props.onReenable(expired ? "latest" : "cursor", takeOver && currentUserHasPassword ? password : undefined);
        setPassword("");
      },
      (err) => {
        const code = axiosResponse(err)?.data?.code;
        setPassword("");
        if (code === "password_incorrect" || code === "password_required") {
          setPasswordError(code === "password_incorrect" ? "That password isn't right." : "Enter your current password.");
          passwordRef.current?.focus();
        } else if (code === "recent_login_required") {
          setConfirmError("You haven't signed in with your provider recently. Sign out, sign in again with it, then take the webhook over within a few minutes.");
        } else if (code === "cursor_expired") {
          setExpiredOnServer(true);
          setConfirmError("The events it missed are gone, so it can only resume with new events.");
        } else if (axiosResponse(err)?.status === 429) {
          setConfirmError("Too many attempts. Try again in a few minutes.");
        } else {
          setConfirmError("Couldn't turn the webhook on. Try again.");
        }
      },
    );
  };

  const saveAddress = (e: React.FormEvent) => {
    e.preventDefault();
    const shape = urlShapeError(address);
    if (shape) {
      setAddressError(URL_ERROR_COPY[shape]);
      addressRef.current?.focus();
      return;
    }
    void handle(
      "address",
      async () => {
        await props.onChangeAddress(address.trim());
        setEditingAddress(false);
        setAddress("");
        setAddressError(null);
        setFocusChangeAddress(true);
      },
      (err) => {
        setAddressError(urlErrorFromResponse(axiosResponse(err)?.data) ?? "Couldn't change the address. Try again.");
        addressRef.current?.focus();
      },
    );
  };

  const inlineConfirm = (kind: WebhookConfirm, text: string, run: () => void) => (
    <div role="status" aria-live="polite" aria-atomic="true" className="flex flex-wrap items-center gap-2 text-xs text-fg py-1">
      <span>{text}</span>
      <button type="button" onClick={run} disabled={inFlight === kind} aria-label={`Confirm: ${text}`} className={CONFIRM_BTN}>
        Confirm
      </button>
      <button type="button" onClick={() => onConfirmChange(null)} disabled={inFlight === kind} className={CANCEL_BTN}>
        Cancel
      </button>
      {confirmError && <p role="alert" className="basis-full text-danger">{confirmError}</p>}
    </div>
  );

  const errLine = lastErrorLine(sub, now);

  return (
    <section aria-labelledby={`${uid}-heading`} className="flex flex-col gap-3.5">
      <div>
        <button
          type="button"
          onClick={props.onBack}
          className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-1.5 py-0.5 min-h-6 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          ← All webhooks
        </button>
      </div>
      <div className="flex items-center gap-2.5 min-w-0">
        <h3
          id={`${uid}-heading`}
          ref={headingRef}
          tabIndex={-1}
          data-webhook-status-heading
          className="flex-1 min-w-0 truncate font-mono text-sm font-semibold text-fg focus:outline-none"
          title={sub.url_display}
        >
          {sub.url_display}
        </h3>
        <WebhookStatusPill sub={sub} />
      </div>

      {!sub.enabled && (
        <div
          role="note"
          className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-fg ${reason ? "bg-warning/15 border-warning/60" : "bg-sunken border-line"}`}
        >
          <p className={`text-sm font-semibold ${reason ? "text-warning-on-tint" : "text-fg"}`}>
            {reason ? reason.headline : `Turned off by a board admin${sub.disabled_at ? ` on ${dateLabel(sub.disabled_at)}` : ""}`}
          </p>
          {reason && <p className="text-xs leading-relaxed">{reason.body}</p>}
          {reason && <p className="text-xs text-fg-tertiary font-mono">Reason code: {sub.disabled_reason}</p>}
          {sub.disabled_reason !== "secret_unavailable" && (confirm === "reenable" ? (
            <div role="group" aria-labelledby={`${uid}-reenable`} className="flex flex-col gap-2 border-t border-warning/40 pt-2.5 mt-1">
              <p id={`${uid}-reenable`} role="status" aria-live="polite" aria-atomic="true" className="text-xs text-fg">
                {expired && !takeOver ? reenableConfirmCopy({ ...sub, disabled_reason: "cursor_expired" }) : reenableConfirmCopy(sub)}
              </p>
              {takeOver && currentUserHasPassword && (
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${uid}-pw`} className="text-xs text-fg-tertiary">Current password</label>
                  <input
                    id={`${uid}-pw`}
                    ref={passwordRef}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setPasswordError(null); }}
                    aria-invalid={passwordError ? true : undefined}
                    aria-describedby={`${uid}-pw-help`}
                    className={`max-w-[280px] bg-surface border rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 ${passwordError ? "border-danger focus:ring-danger-emphasis" : "border-line focus:ring-primary-emphasis focus:border-transparent"}`}
                  />
                  <p id={`${uid}-pw-help`} role="status" aria-live="polite" aria-atomic="true" className={`text-xs min-h-4 ${passwordError ? "text-danger" : "text-fg-tertiary"}`}>
                    {passwordError ?? "Confirms it's you before you take over."}
                  </p>
                </div>
              )}
              {takeOver && !currentUserHasPassword && (
                <p className="text-xs text-fg-tertiary">Your account signs in with SSO, so instead of a password Visiban checks that you signed in with your provider in the last few minutes.</p>
              )}
              {confirmError && <p role="alert" className="text-xs text-danger">{confirmError}</p>}
              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => onConfirmChange(null)} disabled={inFlight === "reenable"} className={SECONDARY_BTN}>
                  Cancel
                </button>
                <button ref={turnOnConfirmRef} type="button" onClick={confirmReenable} disabled={inFlight === "reenable"} className={PRIMARY_BTN}>
                  {takeOver ? "Take over and turn on" : expired ? "Turn on from now" : "Turn on"}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <button
                ref={(el) => { triggerRef("reenable")(el); turnOnRef.current = el; }}
                type="button"
                onClick={() => onConfirmChange("reenable")}
                className={PRIMARY_BTN}
              >
                {reason?.action || "Turn on again"}
              </button>
            </div>
          ))}
        </div>
      )}

      {reveal}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-fg-tertiary">Endpoint</dt>
        <dd className="min-w-0">
          {editingAddress ? (
            <form onSubmit={saveAddress} noValidate className="flex flex-col gap-1">
              <label htmlFor={`${uid}-addr`} className="sr-only">New endpoint URL</label>
              <input
                id={`${uid}-addr`}
                ref={addressRef}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://hooks.example.com/visiban"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                aria-invalid={addressError ? true : undefined}
                aria-describedby={`${uid}-addr-help`}
                className={urlInputClass(Boolean(addressError))}
              />
              <p id={`${uid}-addr-help`} role="status" aria-live="polite" aria-atomic="true" className={`text-xs min-h-4 ${addressError ? "text-danger" : "text-fg-tertiary"}`}>
                {addressError ?? `${URL_HELPER_COPY} Changing it makes you this webhook's owner; the secret stays the same.`}
              </p>
              <div className="flex gap-2">
                <button type="submit" disabled={inFlight === "address"} className={PRIMARY_BTN}>Save address</button>
                <button type="button" onClick={() => { setEditingAddress(false); setAddress(""); setAddressError(null); setFocusChangeAddress(true); }} className={SECONDARY_BTN}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <span className="flex flex-wrap items-center gap-2 min-w-0">
              <span className="font-mono text-fg truncate min-w-0" title={sub.url_display}>{sub.url_display}</span>
              <button ref={changeAddressRef} type="button" onClick={() => setEditingAddress(true)} className="min-h-6 px-1 text-fg-secondary underline hover:text-fg rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
                Change address…
              </button>
            </span>
          )}
        </dd>
        <dt className="text-fg-tertiary">Events</dt>
        <dd className="text-fg">
          {sub.event_types.length ? sub.event_types.map((e, i) => (
            <span key={e}>{i > 0 && ", "}<span className="font-mono">{e}</span></span>
          )) : "All events"}
        </dd>
        <dt className="text-fg-tertiary">Failures in a row</dt>
        <dd className="font-mono text-fg">{sub.consecutive_failures}</dd>
        <dt className="text-fg-tertiary">Last error</dt>
        <dd className="min-w-0">
          {errLine ? <span className="block font-mono text-fg truncate" title={errLine}>{errLine}</span> : <span className="text-fg-tertiary">None</span>}
        </dd>
        <dt className="text-fg-tertiary">Created by</dt>
        <dd className="text-fg">
          {person(sub.created_by)}{sub.created_at ? ` · ${dateLabel(sub.created_at)}` : ""}
          {sub.configured_by?.id !== sub.created_by?.id && (
            <span className="block text-fg-tertiary">Owner now: {person(sub.configured_by)}.</span>
          )}
          <span className="block text-fg-tertiary">You can manage it like any other webhook. Its notices go to this board's admins.</span>
        </dd>
        <dt className="text-fg-tertiary">ID</dt>
        <dd className="font-mono text-fg">{sub.id}</dd>
      </dl>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-fg-tertiary">Signing secret</span>
        <p className="text-xs text-fg-secondary">Set. It can't be shown again.</p>
        <div className="ml-6 border-l-2 border-line pl-4 flex flex-col gap-2">
          <p id={`${uid}-rotate-help`} className="text-xs text-fg-tertiary">
            Rotating issues a new secret, shown once. The current one stops working right away.
          </p>
          {confirm === "rotate"
            ? inlineConfirm("rotate", "Rotate the secret? Update your receiver right after, or its signature checks will fail.", () =>
                void handle("rotate", props.onRotate, () => setConfirmError("Couldn't rotate the secret. Try again.")))
            : sub.disabled_reason !== "secret_unavailable" && !revealOpen && (
              <div>
                <button ref={triggerRef("rotate")} type="button" onClick={() => onConfirmChange("rotate")} aria-describedby={`${uid}-rotate-help`} className={SECONDARY_BTN}>
                  Rotate secret…
                </button>
              </div>
            )}
        </div>
      </div>

      <details className="rounded border border-line px-3 py-2">
        <summary className="text-xs font-medium text-fg-secondary cursor-pointer rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Payload sample · read-only</summary>
        <p className="text-xs text-fg-tertiary mt-2 mb-1.5">
          The body is the board change-feed event, exactly. Redacted to what a board member can see: admin-only swimlane field values and admin-only rows are left out. Values here are placeholders.
        </p>
        <pre role="region" tabIndex={0} aria-label="Sample payload" className="focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-mono text-xs bg-sunken border border-line rounded p-2 overflow-x-auto text-fg-secondary">{SAMPLE_PAYLOAD}</pre>
      </details>
      <details className="rounded border border-line px-3 py-2">
        <summary className="text-xs font-medium text-fg-secondary cursor-pointer rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Verify the signature</summary>
        <p className="text-xs text-fg-tertiary mt-2 mb-1.5">
          Each POST carries <span className="font-mono">X-Visiban-Signature</span> (HMAC-SHA256) and <span className="font-mono">X-Visiban-Timestamp</span>. Compute over the raw body, before any JSON parsing.
        </p>
        <pre role="region" tabIndex={0} aria-label="Verification steps" className="font-mono text-xs bg-sunken border border-line rounded p-2 overflow-x-auto text-fg-secondary select-all focus:outline-none focus:ring-2 focus:ring-primary-emphasis">{VERIFY_STEPS}</pre>
      </details>

      <div className="pt-3 border-t border-line flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={runTest} aria-disabled={inFlight === "test" || undefined} className={SECONDARY_BTN}>
            {inFlight === "test" ? "Sending…" : "Send test event"}
          </button>
          <span className="text-xs text-fg-tertiary">Sends one <span className="font-mono">webhook.test</span> event to the saved address.</span>
        </div>
        <div role="status" aria-live="polite" aria-atomic="true" className="flex flex-col gap-0.5 min-h-9">
          {testResult && (
            <>
              <p className={`text-xs font-medium ${testResult.tone === "ok" ? "text-success-on-tint" : testResult.tone === "warn" ? "text-warning-on-tint" : "text-danger"}`}>
                <span aria-hidden="true">{testResult.tone === "ok" ? "✓ " : testResult.tone === "err" ? "✕ " : ""}</span>
                {testResult.headline}
              </p>
              <p className="text-xs text-fg-tertiary">{testResult.remedy}</p>
            </>
          )}
        </div>
      </div>

      <div className="pt-3 border-t border-line flex flex-col gap-1">
        {sub.enabled && (confirm === "disable"
          ? inlineConfirm("disable", "Turn off this webhook? Visiban stops sending to this address until an admin turns it back on.", () =>
              void handle("disable", async () => { await props.onDisable(); setFocusTurnOn(true); }, () => setConfirmError("Couldn't turn the webhook off. Try again.")))
          : (
            <div>
              <button ref={triggerRef("disable")} type="button" onClick={() => onConfirmChange("disable")} className="min-h-6 px-1 text-sm text-fg-secondary hover:text-fg rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
                Turn off
              </button>
            </div>
          ))}
        {confirm === "delete"
          ? inlineConfirm("delete", "Delete this webhook? Visiban stops sending to this address, and its secret is destroyed. This can't be undone.", () =>
              void handle("delete", props.onDelete, () => setConfirmError("Couldn't delete the webhook. Try again.")))
          : (
            <div>
              <button ref={triggerRef("delete")} type="button" onClick={() => onConfirmChange("delete")} className="min-h-6 px-1 text-sm text-danger hover:text-danger rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis">
                Delete webhook
              </button>
            </div>
          )}
      </div>
    </section>
  );
}
