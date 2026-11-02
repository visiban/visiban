import type { WebhookSubscription, WebhookTestResult } from "../types";

/**
 * Board Settings → Webhooks copy and styles (#863). Source: 1.3 Release UI
 * spec Part 8 (owner decision 2026-11-01) with the overrides on #863 (one
 * neutral address error). Change wording there first.
 */

export type WebhookRowStatus = "active" | "failing" | "disabled";

/** Active / Failing / Disabled: a shape and a word, never color alone (departure 19). */
export function webhookRowStatus(sub: Pick<WebhookSubscription, "enabled" | "consecutive_failures">): WebhookRowStatus {
  if (!sub.enabled) return "disabled";
  return sub.consecutive_failures > 0 ? "failing" : "active";
}

/** `/15` tint, `/60` border, on-tint text (#1550 ratios). */
export const WEBHOOK_STATUS_STYLES: Record<WebhookRowStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-success/15 border-success/60 text-success-on-tint" },
  failing: { label: "Failing", className: "bg-warning/15 border-warning/60 text-warning-on-tint" },
  disabled: { label: "Disabled", className: "bg-fg-muted/15 border-fg-muted/60 text-muted-on-tint" },
};

/** The one message for every address-based refusal (departure 26, #863 threat model). */
export const ADDRESS_REFUSED_COPY = "Visiban can't send to this address. If it should be allowed, ask your Visiban operator.";

/** URL field errors. Only input-shape errors get their own copy. */
export const URL_ERROR_COPY: Record<"http" | "format" | "creds" | "refused", string> = {
  http: "Use an https:// address. Your Visiban operator can allow plain http for specific hosts.",
  format: "Enter a full address, like https://hooks.example.com/visiban.",
  creds: "Remove the user name and password from the address. Receivers check Visiban with the signing secret instead.",
  refused: ADDRESS_REFUSED_COPY,
};

export const URL_HELPER_COPY = "Must start with https://. Visiban shows only the host and the last characters after you save.";

/**
 * Client-side shape check: only what the server would also refuse from the
 * text alone. http:// is left to the server (an operator allowlist may admit
 * it), and so is every address rule.
 */
export function urlShapeError(raw: string): "format" | "creds" | null {
  const url = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+/i.test(url) || /\s/.test(url)) return "format";
  if (!/^https?:\/\//i.test(url)) return "format";
  if (/^[a-z]+:\/\/[^/?#]*@/i.test(url)) return "creds";
  return null;
}

/** Map a create / address-change failure to its URL-field copy, or null for a form-level one. */
export function urlErrorFromResponse(data: { code?: unknown; reason?: unknown } | undefined): string | null {
  if (data?.code === "url_not_allowed") return URL_ERROR_COPY.refused;
  if (data?.code === "invalid_url") {
    const reason = data.reason === "http" || data.reason === "creds" ? data.reason : "format";
    return URL_ERROR_COPY[reason];
  }
  return null;
}

export const FORM_ERROR_COPY: Record<string, string> = {
  invalid_event_types: "Some selected events can't be sent by webhook. Reopen this tab and choose again.",
  limit_reached: "You've reached a webhook limit for this board, your account or this server. Delete an unused webhook to add another.",
};
/**
 * The server refuses a token on create, address change, turn on and rotate.
 * A browser session always passes, so this is a fallback, not a re-verify
 * flow: it says what to do rather than offering a button that cannot do it.
 */
export const SESSION_REQUIRED_COPY = "This change needs a signed-in browser session. Sign out, sign in again, then retry.";
export const FORM_THROTTLED_COPY = "Too many webhook changes in a short time. Try again in a few minutes.";
export const FORM_GENERIC_COPY = "Couldn't save the webhook. Try again.";
export const EVENTS_NONE_SELECTED_COPY = "Choose at least one event, or pick All events.";

/** Reason → headline, body, recovery action (spec Part 8 "Reason → copy → recovery"). */
export interface ReasonCopy {
  headline: string;
  body: string;
  action: string;
}

export function disabledReasonCopy(
  sub: Pick<WebhookSubscription, "disabled_reason" | "configured_by">,
  failuresLimit: number | null,
): ReasonCopy | null {
  switch (sub.disabled_reason) {
    case "failures":
      return {
        headline: "Turned off after repeated delivery failures",
        body: `${failuresLimit ? `Visiban stopped sending after ${failuresLimit} failed deliveries in a row, or a day of failures.` : "Visiban stopped sending after repeated failed deliveries."} Fix the receiving endpoint, send a test event, then turn the webhook back on.`,
        action: "Turn on again",
      };
    case "cursor_expired":
      return {
        headline: "Turned off because it fell too far behind",
        body: "Visiban can't confirm it still has every event this webhook missed, so it can't resume where it stopped. Events from that gap won't be sent. Turning it back on starts with new events.",
        action: "Turn on from now",
      };
    case "creator_lost_access": {
      const who = sub.configured_by ? sub.configured_by.display_name || sub.configured_by.username : "The person who set it up";
      return {
        headline: "Turned off because its creator lost access",
        body: `${who} is no longer an admin of this board, so their webhook stopped. To turn it back on, you take it over: it sends as you, and its notices come to you.`,
        action: "Take over and turn on…",
      };
    }
    case "secret_unavailable":
      return {
        headline: "Turned off because its stored secret can't be read",
        body: "Its stored address or signing secret can no longer be read, usually after the server's secret key changed. Delete it and create a new one.",
        action: "",
      };
    default:
      return null;
  }
}

/** What turning on again does, stated in its confirm (departure 23). */
/**
 * How an announcement names a webhook: by its place in the list, never by its
 * host. The host is part of the URL, and a live region can later be reused for
 * a shared refetch or event (frontend/CLAUDE.md § Webhooks announcements).
 */
export function webhookPosition(subs: readonly Pick<WebhookSubscription, "id">[], id: number): string {
  return `Webhook ${subs.findIndex((s) => s.id === id) + 1} of ${subs.length}`;
}

export function reenableConfirmCopy(sub: Pick<WebhookSubscription, "disabled_reason">): string {
  if (sub.disabled_reason === "creator_lost_access") return "Take it over: it will send as you, and its notices will come to you.";
  if (sub.disabled_reason === "cursor_expired") return "Sending resumes with new events. Events from the gap won't be sent.";
  return "Sending resumes to this address, starting with the events it missed. If it keeps failing, it turns off again.";
}

/** Test-event result copy: headline in tone + remedy (spec Part 8 "Test event"). */
export interface TestResultCopy {
  tone: "ok" | "err" | "warn";
  headline: string;
  remedy: string;
}

function statusLine(status: number | null | undefined): string {
  if (typeof status !== "number") return "an error";
  const reason: Record<number, string> = {
    200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
    301: "Moved Permanently", 302: "Found", 307: "Temporary Redirect", 308: "Permanent Redirect",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
    408: "Request Timeout", 413: "Payload Too Large", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
  };
  return reason[status] ? `${status} ${reason[status]}` : String(status);
}

export function testResultCopy(result: WebhookTestResult | "rate_limited", timeoutSeconds = 10): TestResultCopy {
  if (result === "rate_limited") {
    return { tone: "warn", headline: "Wait a moment before sending another test.", remedy: "Too many test events in a short time." };
  }
  if (result.ok) {
    const latency = typeof result.latency_ms === "number" ? ` in ${result.latency_ms} ms` : "";
    return { tone: "ok", headline: "Test event delivered.", remedy: `The receiver answered ${statusLine(result.status_code)}${latency}.` };
  }
  switch (result.code) {
    case "http_error": {
      const redirect = typeof result.status_code === "number" && result.status_code >= 300 && result.status_code < 400;
      return {
        tone: "err",
        headline: `Test event failed: the receiver answered ${statusLine(result.status_code)}.`,
        remedy: redirect
          ? "Visiban doesn't follow redirects. Use the address the receiver redirects to."
          : result.status_code === 401 || result.status_code === 403
            ? "Check that the receiver verifies X-Visiban-Signature with the current secret."
            : "Check the receiver's logs; it must answer with a 2xx status.",
      };
    }
    case "timeout":
      return { tone: "err", headline: `Test event failed: no answer within ${timeoutSeconds} seconds.`, remedy: "Check that the receiver is running and reachable from the internet." };
    case "tls_error":
      return { tone: "err", headline: "Test event failed: the receiver's TLS certificate was rejected.", remedy: "The certificate must be valid for this host and issued by a trusted authority." };
    case "connection_failed":
      // A blocked target reports as connection_failed: the same neutral copy
      // as the URL error (departure 26), plus the remedy for a receiver that is down.
      return { tone: "err", headline: `Test event not sent: ${ADDRESS_REFUSED_COPY}`, remedy: "If it is allowed, check that the receiver is running and reachable." };
    case "secret_unavailable":
      return { tone: "err", headline: "Test event not sent: this webhook's stored secret can't be read.", remedy: "Delete it and create a new one." };
    default:
      return { tone: "err", headline: "Test event failed.", remedy: "Check that the receiver is running and reachable." };
  }
}

/** Picker groups (follow-up spec): prefix → legend, in display order. */
export const EVENT_GROUPS: { label: string; prefixes: string[] }[] = [
  { label: "Cards", prefixes: ["card"] },
  { label: "Columns", prefixes: ["column"] },
  { label: "Swimlanes", prefixes: ["swimlane"] },
  { label: "Card fields", prefixes: ["custom_field"] },
  { label: "Swimlane fields", prefixes: ["swimlane_custom_field"] },
  { label: "Labels", prefixes: ["label"] },
  { label: "Members", prefixes: ["member"] },
  { label: "Board", prefixes: ["board", "invite_link", "lens_connection"] },
];

/** Group the server's subscribable types; unknown prefixes land in an "Other" group. */
export function groupEventTypes(types: string[]): { label: string; types: string[] }[] {
  const prefixOf = (t: string) => (t.includes(".") ? t.slice(0, t.lastIndexOf(".")) : t);
  const groups = EVENT_GROUPS.map((g) => ({ label: g.label, types: types.filter((t) => g.prefixes.includes(prefixOf(t))) }));
  const known = new Set(EVENT_GROUPS.flatMap((g) => g.prefixes));
  const other = types.filter((t) => !known.has(prefixOf(t)));
  if (other.length) groups.push({ label: "Other", types: other });
  return groups.filter((g) => g.types.length > 0);
}

/** The last error as one sanitized line: a fixed code or a status line, never a body. */
export function lastErrorLabel(
  sub: Pick<WebhookSubscription, "last_error_code" | "last_status_code">,
): string | null {
  if (!sub.last_error_code) return null;
  const label: Record<string, string> = {
    connection_failed: "Connection failed",
    tls_error: "TLS certificate rejected",
    timeout: "Timed out",
    http_error: `HTTP ${sub.last_status_code ?? ""}`.trim(),
    secret_unavailable: "Stored secret can't be read",
  };
  return label[sub.last_error_code] ?? sub.last_error_code;
}

/** "All events" or "3 event types". */
export function eventsSummary(eventTypes: string[]): string {
  if (eventTypes.length === 0) return "All events";
  return `${eventTypes.length} event type${eventTypes.length === 1 ? "" : "s"}`;
}

export const SAMPLE_PAYLOAD = `{
  "id": 84213,
  "event": "card.moved",
  "data": { "id": 392, "title": "…",
            "column": 4, "swimlane": 2 },
  "actor_id": 12,
  "actor": { "id": 12, "username": "…",
             "display_name": "…" },
  "created_at": "2026-11-01T14:02:11Z"
}`;

export const VERIFY_STEPS = `signed   = timestamp + "." + raw request body
expected = hex(HMAC_SHA256(secret, signed))
accept if X-Visiban-Signature == "v1=" + expected
     and |now - X-Visiban-Timestamp| <= 300 seconds`;

export const WEBHOOKS_DOCS_URL = "https://docs.visiban.com/features/webhooks/";
export const WEBHOOKS_VERIFY_URL = "https://docs.visiban.com/api/webhooks/#verifying-signatures";
