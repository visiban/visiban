import { useEffect, useId, useRef, useState } from "react";
import { WEBHOOKS_VERIFY_URL } from "../../../constants/webhooks";

interface Props {
  /** Shown only after create; omitted after a rotate. */
  url?: string;
  secret: string;
  onDone: () => void;
  /** Escape guard message ("Copy the secret, then choose Done."), owned by the tab. */
  guardMessage?: string | null;
}

/**
 * Reveal-once panel for a new webhook's URL and signing secret, or a rotated
 * secret (#863 UX spec § 5). The values exist only in the tab's state; the
 * tab clears them on Done, on unmount and on tab switch.
 */
export default function WebhookSecretReveal({ url, secret, onDone, guardMessage }: Props) {
  const uid = useId();
  const warningId = `${uid}-warning`;
  const copySecretRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState<"secret" | "url" | null>(null);
  const [copyError, setCopyError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    copySecretRef.current?.focus();
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async (what: "secret" | "url", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setCopyError(true);
      return;
    }
    setCopyError(false);
    setCopied(what);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(null);
      timerRef.current = null;
    }, 2000);
  };

  const field = (label: string, value: string) => (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-fg-tertiary">{label}</span>
      <div
        className="font-mono text-xs bg-sunken border border-warning/50 rounded px-2 py-1.5 text-fg truncate select-all"
        title={value}
      >
        {value}
      </div>
    </div>
  );

  return (
    <div
      className="bg-sunken border border-warning/50 rounded-lg p-3 flex flex-col gap-2 transition-all duration-150"
      data-testid="webhook-secret-reveal"
    >
      <p id={warningId} className="text-xs text-warning">
        {url
          ? "Copy the URL and signing secret now. You won't see either again. If you lose the secret, rotate it."
          : "Copy the new signing secret now. You won't see it again. The old secret has already stopped working."}
      </p>
      {url && field("Payload URL", url)}
      {field("Signing secret", secret)}
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={copySecretRef}
          type="button"
          onClick={() => void copy("secret", secret)}
          aria-describedby={warningId}
          className="text-xs bg-button-primary text-on-primary px-3 py-1.5 rounded hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
        >
          {copied === "secret" ? "Copied!" : "Copy secret"}
        </button>
        {url && (
          <button
            type="button"
            onClick={() => void copy("url", url)}
            aria-describedby={warningId}
            className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {copied === "url" ? "Copied!" : "Copy URL"}
          </button>
        )}
        <a
          href={WEBHOOKS_VERIFY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-info hover:underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
        >
          How to verify signatures
        </a>
        <button
          type="button"
          onClick={onDone}
          aria-label="Done, hide the webhook secret"
          className="ml-auto text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Done
        </button>
      </div>
      <p className="text-xs min-h-4" role="status" aria-live="polite" aria-atomic="true">
        {copyError ? (
          <span className="text-danger">Couldn't copy. Select the value and copy it manually.</span>
        ) : guardMessage ? (
          <span className="text-warning">{guardMessage}</span>
        ) : copied ? (
          <span className="text-success">{copied === "secret" ? "Secret copied." : "URL copied."}</span>
        ) : null}
      </p>
    </div>
  );
}
