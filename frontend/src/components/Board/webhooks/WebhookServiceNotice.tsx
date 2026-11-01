import { WEBHOOKS_DOCS_URL } from "../../../constants/webhooks";

/** Feature off: no button that implies a board admin can turn it on (spec Part 8). */
export function WebhooksOffNotice() {
  return (
    <section aria-labelledby="webhooks-heading" className="flex flex-col gap-3">
      <h3 id="webhooks-heading" className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide">Webhooks</h3>
      <div role="note" className="flex gap-3 rounded-lg border border-line bg-sunken px-3 py-3 text-sm text-fg-secondary">
        <svg viewBox="0 0 16 16" className="w-5 h-5 shrink-0 text-fg-tertiary" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5v4M8 11v.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <div className="flex flex-col gap-1.5">
          <p className="font-medium text-fg">Webhooks are turned off on this Visiban server</p>
          <p>
            A server operator can turn them on with the <code className="font-mono text-xs">WEBHOOKS_ENABLED</code> setting.
            Board admins can't change this here, so ask whoever runs your Visiban server.
          </p>
          <p className="text-xs text-fg-tertiary">
            When they're on, a webhook sends a signed POST to an address you choose each time something changes on this board.{" "}
            <a
              href={WEBHOOKS_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-info underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
            >
              How webhooks work
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * Stale-dispatcher panel (#863 VoC blocker 1). Not dismissible and not
 * focusable: it describes the server, not something the admin can act on.
 */
export function DispatcherStaleNotice({ lastRunLabel }: { lastRunLabel: string | null }) {
  return (
    <div
      role="group"
      aria-labelledby="webhooks-dispatcher-stale"
      className="rounded-lg border border-warning/60 bg-warning/15 px-3 py-2.5 flex gap-2 text-sm text-warning-on-tint"
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
