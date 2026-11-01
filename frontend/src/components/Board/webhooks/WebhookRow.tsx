import type { ReactNode, Ref } from "react";
import type { WebhookSubscription } from "../../../types";
import { relativeTime } from "../../../utils/relativeTime";
import {
  WEBHOOK_STATUS_STYLES,
  deliveryErrorCopy,
  disabledReasonCopy,
  eventsSummary,
  webhookRowStatus,
} from "../../../constants/webhooks";

export type WebhookRowAction = "test" | "edit" | "disable" | "reenable" | "rotate" | "delete";

export interface WebhookRowMessage {
  tone: "success" | "danger" | "warning" | "neutral";
  text: string;
  /** A muted follow-up line, e.g. a remedy after a failed test. */
  remedy?: string;
}

interface Props {
  sub: WebhookSubscription;
  /** Epoch ms used for every relative time on the row. */
  now: number;
  highlighted?: boolean;
  /** Edit form; replaces lines 3-5 while open. */
  editForm?: ReactNode;
  /** Inline confirm or prompt; rendered full-width in the actions line. */
  inlinePanel?: ReactNode;
  /** Rotate reveal; rendered under the URL line. */
  reveal?: ReactNode;
  testing?: boolean;
  /** Disables every action while any request for this row is in flight. */
  busy?: boolean;
  message?: WebhookRowMessage | null;
  onAction: (action: WebhookRowAction) => void;
  /** useConfirmFocusReturn trigger registration, keyed by `${id}:${action}`. */
  triggerRef: (key: string) => (el: HTMLElement | null) => void;
  /** First action button, for deep-link focus. */
  firstActionRef?: Ref<HTMLButtonElement>;
  rowRef?: Ref<HTMLLIElement>;
}

const ACTION_CLASS = "text-xs px-1.5 py-0.5 rounded focus:outline-none focus:ring-2 disabled:opacity-40 transition";
const NEUTRAL_ACTION = `${ACTION_CLASS} text-fg-secondary hover:text-fg hover:bg-surface-hover focus:ring-primary-emphasis`;
const DANGER_ACTION = `${ACTION_CLASS} text-danger hover:bg-surface-hover focus:ring-danger-emphasis`;

const MESSAGE_TONE: Record<WebhookRowMessage["tone"], string> = {
  success: "text-success",
  danger: "text-danger",
  warning: "text-warning",
  neutral: "text-fg-secondary",
};

function since(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : relativeTime(t, now);
}

/** One webhook in the Board Settings → Webhooks list (#863 UX spec § 3). */
export default function WebhookRow({
  sub,
  now,
  highlighted = false,
  editForm,
  inlinePanel,
  reveal,
  testing = false,
  busy = false,
  message,
  onAction,
  triggerRef,
  firstActionRef,
  rowRef,
}: Props) {
  const status = webhookRowStatus(sub);
  const pill = WEBHOOK_STATUS_STYLES[status];
  const name = sub.name || sub.url_host;
  const lastDelivered = sub.last_success_at ? `Last delivered ${since(sub.last_success_at, now)}` : "Never delivered";
  const owner = sub.configured_by
    ? `Set up by ${sub.configured_by.display_name || sub.configured_by.username}`
    : "Set up by a former member";
  const secretUnavailable = sub.disabled_reason === "secret_unavailable";

  let detail: string | null = null;
  if (!sub.enabled) {
    detail = disabledReasonCopy(sub, since(sub.disabled_at, now) || "recently");
  } else if (sub.consecutive_failures > 0) {
    const n = sub.consecutive_failures;
    detail = `${n} ${n === 1 ? "delivery" : "deliveries in a row"} failed. ${deliveryErrorCopy(sub.last_error_code, sub.last_status_code)}. Visiban keeps retrying and turns the webhook off if failures continue.`;
  }

  const actions: WebhookRowAction[] = sub.enabled
    ? ["test", "edit", "disable", "rotate", "delete"]
    : (secretUnavailable ? ["test", "edit", "delete"] : ["reenable", "test", "edit", "rotate", "delete"]);

  const label: Record<WebhookRowAction, string> = {
    test: testing ? "Sending…" : "Send test",
    edit: "Edit",
    disable: "Disable",
    reenable: "Re-enable",
    rotate: "Rotate secret",
    delete: "Delete",
  };
  const ariaLabel: Record<WebhookRowAction, string> = {
    test: `Send test to ${name}`,
    edit: `Edit ${name}`,
    disable: `Disable ${name}`,
    reenable: `Re-enable ${name}`,
    rotate: `Rotate secret for ${name}`,
    delete: `Delete ${name}`,
  };

  return (
    <li
      ref={rowRef}
      data-testid={`webhook-row-${sub.id}`}
      data-status={status}
      className={`flex flex-col gap-1.5 p-3 rounded-lg border border-line transition-all duration-150 ${highlighted ? "ring-2 ring-warning/60" : ""}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium text-fg truncate flex-1" title={name}>{name}</span>
        <span className={`px-2 py-0.5 text-xs font-semibold rounded-full shrink-0 ${pill.className}`}>{pill.label}</span>
      </div>
      <span className="font-mono text-xs text-fg-tertiary truncate" title={sub.url_display}>{sub.url_display}</span>
      {reveal}
      {editForm ?? (
        <>
          <p className="text-xs text-fg-tertiary">
            {[eventsSummary(sub.event_types), lastDelivered, owner].join(" · ")}
          </p>
          {detail && <p className="text-xs text-fg-secondary">{detail}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {actions.map((action, i) => (
              <button
                key={action}
                type="button"
                ref={(el) => {
                  triggerRef(`${sub.id}:${action}`)(el);
                  if (i === 0 && firstActionRef) {
                    if (typeof firstActionRef === "function") firstActionRef(el);
                    else (firstActionRef as { current: HTMLButtonElement | null }).current = el;
                  }
                }}
                onClick={() => onAction(action)}
                disabled={busy}
                aria-label={ariaLabel[action]}
                className={action === "delete" ? DANGER_ACTION : NEUTRAL_ACTION}
              >
                {label[action]}
              </button>
            ))}
            {inlinePanel}
          </div>
        </>
      )}
      <p className="text-xs min-h-4" role="status" aria-live="polite" aria-atomic="true">
        {message && (
          <>
            <span className={MESSAGE_TONE[message.tone]}>{message.text}</span>
            {message.remedy && <span className="text-fg-muted"> {message.remedy}</span>}
          </>
        )}
      </p>
    </li>
  );
}
