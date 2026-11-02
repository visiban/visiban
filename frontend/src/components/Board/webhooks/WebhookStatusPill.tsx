import type { WebhookSubscription } from "../../../types";
import { WEBHOOK_STATUS_STYLES, webhookRowStatus } from "../../../constants/webhooks";

/**
 * Webhook status pill (1.3 UI spec Part 8, departure 19): a shape and a word,
 * so status never rests on color alone (WCAG 1.4.1). Active is a filled
 * circle, Failing a triangle with the failure count, Disabled a slashed ring.
 */
export default function WebhookStatusPill({ sub }: { sub: Pick<WebhookSubscription, "enabled" | "consecutive_failures"> }) {
  const status = webhookRowStatus(sub);
  const style = WEBHOOK_STATUS_STYLES[status];
  const n = sub.consecutive_failures;
  return (
    <span
      data-status={status}
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border shrink-0 ${style.className}`}
    >
      <svg viewBox="0 0 10 10" className="w-2.5 h-2.5" aria-hidden="true">
        {status === "active" && <circle cx="5" cy="5" r="4" fill="currentColor" />}
        {status === "failing" && <path d="M5 1l4.3 8H.7z" fill="currentColor" />}
        {status === "disabled" && (
          <>
            <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M2.4 7.6l5.2-5.2" stroke="currentColor" strokeWidth="1.4" />
          </>
        )}
      </svg>
      {style.label}
      {status === "failing" && ` · ${n} failure${n === 1 ? "" : "s"}`}
    </span>
  );
}
