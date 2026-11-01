import type { WebhookSubscription } from "../../../types";
import { disabledReasonCopy, eventsSummary, webhookRowStatus } from "../../../constants/webhooks";
import { relativeTime } from "../../../utils/relativeTime";
import WebhookStatusPill from "./WebhookStatusPill";

interface Props {
  subs: WebhookSubscription[];
  now: number;
  highlightId: number | null;
  onManage: (id: number) => void;
  /** Manage-button registration, for focus return and the deep link. */
  manageRef: (id: number) => (el: HTMLButtonElement | null) => void;
}

function lastError(sub: WebhookSubscription, now: number): string | null {
  if (!sub.last_error_code) return null;
  const label: Record<string, string> = {
    connection_failed: "Connection failed",
    tls_error: "TLS certificate rejected",
    timeout: "Timed out",
    http_error: `HTTP ${sub.last_status_code ?? ""}`.trim(),
  };
  const t = sub.last_attempt_at ? Date.parse(sub.last_attempt_at) : NaN;
  return `${label[sub.last_error_code] ?? sub.last_error_code}${Number.isNaN(t) ? "" : ` · ${relativeTime(t, now)}`}`;
}

/** The list view's rows (1.3 UI spec Part 8 § webhooks-list). */
export default function WebhookList({ subs, now, highlightId, onManage, manageRef }: Props) {
  return (
    <ul aria-labelledby="webhooks-heading" className="flex flex-col divide-y divide-line border border-line rounded-lg">
      {subs.map((sub) => {
        const status = webhookRowStatus(sub);
        const err = status !== "active" ? lastError(sub, now) : null;
        const reason = !sub.enabled ? disabledReasonCopy(sub, null) : null;
        const creator = sub.created_by ? sub.created_by.display_name || sub.created_by.username : "a former member";
        return (
          <li
            key={sub.id}
            data-testid={`webhook-row-${sub.id}`}
            className={`flex items-center gap-3 px-3 py-2.5 transition-all duration-150 ${highlightId === sub.id ? "ring-2 ring-warning/60 rounded-lg" : ""}`}
          >
            <div className="flex-1 min-w-0 flex flex-col gap-1">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="font-mono text-sm text-fg truncate" title={sub.url_display}>{sub.url_display}</span>
                <WebhookStatusPill sub={sub} />
              </div>
              <p className="text-xs text-fg-tertiary">
                {eventsSummary(sub.event_types)} · Created by {creator} · <span className="font-mono">#{sub.id}</span>
              </p>
              {err && <p className="text-xs font-mono text-fg-secondary truncate" title={err}>Last error: {err}</p>}
              {!sub.enabled && <p className="text-xs text-fg-secondary">{reason ? reason.headline : "Turned off by a board admin"}</p>}
            </div>
            <button
              ref={manageRef(sub.id)}
              type="button"
              onClick={() => onManage(sub.id)}
              aria-label={`Manage webhook ${sub.url_host}`}
              className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded border border-line-strong transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis shrink-0"
            >
              Manage
            </button>
          </li>
        );
      })}
    </ul>
  );
}
