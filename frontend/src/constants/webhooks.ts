import type { WebhookSubscription } from "../types";

/**
 * Board Settings → Webhooks copy and styles (#863). The UX spec on #863 is the
 * source of every string here; change wording there first.
 */

export type WebhookRowStatus = "active" | "failing" | "disabled" | "stopped";

/** Derive the row's status pill from the subscription. */
export function webhookRowStatus(sub: Pick<WebhookSubscription, "enabled" | "disabled_reason" | "consecutive_failures">): WebhookRowStatus {
  if (!sub.enabled) return sub.disabled_reason === "manual" ? "disabled" : "stopped";
  return sub.consecutive_failures > 0 ? "failing" : "active";
}

export const WEBHOOK_STATUS_STYLES: Record<WebhookRowStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-success/20 text-success-on-tint" },
  failing: { label: "Failing", className: "bg-warning/20 text-warning-on-tint" },
  disabled: { label: "Disabled", className: "bg-fg-muted/20 text-muted-on-tint" },
  stopped: { label: "Stopped", className: "bg-danger/20 text-danger-on-tint" },
};

/** Headline for a delivery error code (row detail, test result). */
export function deliveryErrorCopy(code: string | null | undefined, statusCode: number | null | undefined): string {
  switch (code) {
    case "connection_failed":
      return "Could not connect to the receiver";
    case "tls_error":
      return "The receiver's TLS certificate was rejected";
    case "timeout":
      return "The receiver did not respond in time";
    case "http_error": {
      const status = statusCode ?? "error";
      const redirect = typeof statusCode === "number" && statusCode >= 300 && statusCode < 400;
      return `The receiver answered HTTP ${status}${redirect ? " (redirects are not followed)" : ""}`;
    }
    default:
      return "Delivery failed";
  }
}

/** Line-4 copy for a disabled row. `when` is already a relative time. */
export function disabledReasonCopy(sub: Pick<WebhookSubscription, "disabled_reason" | "last_error_code" | "last_status_code">, when: string): string {
  switch (sub.disabled_reason) {
    case "manual":
      return `Turned off by a board admin ${when}.`;
    case "failures":
      return `Turned off ${when} after repeated failed deliveries. Last error: ${deliveryErrorCopy(sub.last_error_code, sub.last_status_code)}.`;
    case "cursor_expired":
      return `Turned off ${when} because it fell too far behind. The events it had not delivered were removed by history cleanup.`;
    case "creator_lost_access":
      return `Turned off ${when} because the person who set it up no longer administers this board. Re-enable it to take it over.`;
    case "secret_unavailable":
      return `Turned off ${when} because its stored URL or secret can no longer be read, usually after the server's secret key changed. Delete it and create a new one.`;
    default:
      return `Turned off ${when}.`;
  }
}

/** Slot a create/edit error is shown in. */
export type ConfigErrorSlot = "url" | "events" | "form";

export const CONFIG_ERROR_COPY: Record<string, { slot: ConfigErrorSlot; text: string }> = {
  invalid_url: {
    slot: "url",
    text: "Enter a full https:// URL with no username or password. Ports below 1024 other than 443 are not allowed.",
  },
  url_not_allowed: {
    slot: "url",
    text: "Visiban can't send to this address. Private, local and unresolvable addresses are blocked. To allow one, ask whoever runs this server to add it to WEBHOOK_ALLOWED_PRIVATE_TARGETS.",
  },
  invalid_event_types: {
    slot: "events",
    text: "Some selected events can't be sent by webhook. Close and reopen this tab, then choose again.",
  },
  limit_reached: {
    slot: "form",
    text: "You've reached a webhook limit for this board, your account or this server. Delete an unused webhook to add another.",
  },
  session_required: {
    slot: "form",
    text: "This change needs a signed-in browser session. Sign in again and retry.",
  },
};

export const CONFIG_THROTTLED_COPY = "Too many webhook changes in a short time. Try again in a few minutes.";
export const CONFIG_GENERIC_COPY = "Couldn't save the webhook. Try again.";
export const EVENTS_NONE_SELECTED_COPY = "Choose at least one event, or pick All events.";

/** Picker group legends, keyed by the event type's resource prefix. */
export const EVENT_GROUP_LABELS: Record<string, string> = {
  board: "Board",
  card: "Cards",
  column: "Columns",
  swimlane: "Swimlanes",
  label: "Labels",
  custom_field: "Card fields",
  swimlane_custom_field: "Swimlane fields",
  member: "Members",
  invite_link: "Invite links",
  lens_connection: "Issue Board Lens",
};

/** Group event types by prefix, in first-seen order of the server's sorted list. */
export function groupEventTypes(types: string[]): { prefix: string; label: string; types: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const t of types) {
    const prefix = t.includes(".") ? t.slice(0, t.lastIndexOf(".")) : t;
    const list = groups.get(prefix);
    if (list) list.push(t);
    else groups.set(prefix, [t]);
  }
  return [...groups.entries()].map(([prefix, list]) => ({
    prefix,
    label: EVENT_GROUP_LABELS[prefix] ?? prefix,
    types: list,
  }));
}

/** "All events", or "3 events: card.moved, card.created +1". */
export function eventsSummary(eventTypes: string[]): string {
  if (eventTypes.length === 0) return "All events";
  const shown = eventTypes.slice(0, 2).join(", ");
  const extra = eventTypes.length - 2;
  const noun = eventTypes.length === 1 ? "event" : "events";
  return `${eventTypes.length} ${noun}: ${shown}${extra > 0 ? ` +${extra}` : ""}`;
}

export const WEBHOOKS_DOCS_URL = "https://docs.visiban.com/features/webhooks/";
export const WEBHOOKS_VERIFY_URL = "https://docs.visiban.com/api/webhooks/#verifying-signatures";
