import { WEBHOOKS_DOCS_URL } from "../../../constants/webhooks";

/** Feature-off callout: the whole tab when `WEBHOOKS_ENABLED` is off (#863). */
export function WebhooksOffNotice() {
  return (
    <div
      role="note"
      className="rounded border border-primary-emphasis/30 bg-primary-emphasis/10 px-3 py-2.5 text-sm text-fg-secondary"
    >
      <p>
        Webhooks are turned off on this server. Whoever runs this Visiban server can turn them on with the{" "}
        <code className="font-mono text-xs">WEBHOOKS_ENABLED</code> setting, and must also start the webhook dispatcher.
      </p>
      <a
        href={WEBHOOKS_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block mt-1.5 text-info hover:underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
      >
        How to set up webhooks
      </a>
    </div>
  );
}

/**
 * Stale-dispatcher panel. Not dismissible and not focusable: it describes the
 * server, not something the admin can act on here.
 */
export function DispatcherStaleNotice({ lastRunLabel }: { lastRunLabel: string | null }) {
  return (
    <div
      role="group"
      aria-labelledby="webhooks-dispatcher-stale"
      className="rounded border border-warning/30 bg-warning/10 px-3 py-2.5 flex gap-2 text-sm text-warning-on-tint"
    >
      <span aria-hidden="true" className="text-base leading-none shrink-0">⚠</span>
      <p id="webhooks-dispatcher-stale">
        {lastRunLabel === null
          ? "The webhook dispatcher has never run on this server, so no events are being delivered. Ask whoever runs this server to start it."
          : `The webhook dispatcher last ran ${lastRunLabel}. Events are queued but not being delivered. Ask whoever runs this server to check it.`}
      </p>
    </div>
  );
}
