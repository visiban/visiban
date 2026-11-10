import type { WebhookSubscription } from "../../../types";
import { disabledReasonCopy, eventsSummary, lastErrorLabel, webhookPersonLabel, webhookRowStatus } from "../../../constants/webhooks";
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
  const label = lastErrorLabel(sub);
  if (!label) return null;
  const t = sub.last_attempt_at ? Date.parse(sub.last_attempt_at) : NaN;
  return `${label}${Number.isNaN(t) ? "" : ` · ${relativeTime(t, now)}`}`;
}

function dateLabel(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : ` on ${t.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** The list view's rows (1.3 UI spec Part 8 § webhooks-list). */
export default function WebhookList({ subs, now, highlightId, onManage, manageRef }: Props) {
  return (
    <ul aria-labelledby="webhooks-heading" className="flex flex-col divide-y divide-line border border-line rounded-lg">
      {subs.map((sub) => {
        const status = webhookRowStatus(sub);
        const err = status !== "active" ? lastError(sub, now) : null;
        const reason = !sub.enabled ? disabledReasonCopy(sub, null) : null;
        const creator = webhookPersonLabel(sub.created_by);
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
              {!sub.enabled && <p className="text-xs text-fg-secondary">{reason ? reason.headline : `Turned off by a board admin${dateLabel(sub.disabled_at)}`}</p>}
            </div>
            <button
              ref={manageRef(sub.id)}
              type="button"
              onClick={() => onManage(sub.id)}
              // Unique per row: two webhooks on one host are common (no Name field).
              aria-label={`Manage webhook ${sub.url_display} (#${sub.id})`}
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
