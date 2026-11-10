import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";

export interface WebhookSecretRevealHandle {
  focusCopy: () => void;
}

interface Props {
  host: string;
  secret: string;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  onDone: () => void;
  /** The close guard's prompt is open (Escape, Close or the backdrop before acknowledging). */
  guardOpen: boolean;
  onGuardConfirm: () => void;
  onGuardCancel: () => void;
}

/**
 * Acknowledged one-time reveal (1.3 UI spec Part 8, departure 22). The secret
 * exists only in the tab's state and is never fetched again. Done is
 * aria-disabled until the acknowledgment is checked; until then Escape, Close
 * and the backdrop open an inline prompt instead of closing Board settings.
 */
const WebhookSecretReveal = forwardRef<WebhookSecretRevealHandle, Props>(function WebhookSecretReveal(
  { host, secret, acknowledged, onAcknowledge, onDone, guardOpen, onGuardConfirm, onGuardCancel },
  ref,
) {
  const uid = useId();
  const headingId = `${uid}-heading`;
  const warningId = `${uid}-warning`;
  const doneHintId = `${uid}-done-hint`;
  const ackRef = useRef<HTMLInputElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useImperativeHandle(ref, () => ({ focusCopy: () => copyRef.current?.focus() }));

  useEffect(() => {
    copyRef.current?.focus();
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
    } catch {
      setCopyState("failed");
      return;
    }
    setCopyState("copied");
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopyState("idle");
      timerRef.current = null;
    }, 2000);
  };

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      data-testid="webhook-secret-reveal"
      className="bg-warning/15 border border-warning/60 rounded-lg p-3 flex flex-col gap-2.5 text-fg"
    >
      <p id={headingId} className="text-sm font-semibold text-warning-on-tint">Signing secret for {host}</p>
      <p id={warningId} className="text-xs text-warning-on-tint">
        Copy this secret now. It won't be shown again. If you lose it, rotate the secret to get a new one.
      </p>
      <div className="flex items-center gap-2">
        {/* A read-only input, not a div: keyboard users can reach and select it
            when the clipboard API is blocked. */}
        <input
          readOnly
          value={secret}
          aria-label="Signing secret"
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 min-w-0 font-mono text-xs bg-sunken border border-warning/60 rounded px-2 py-1.5 text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        />
        <button
          ref={copyRef}
          type="button"
          onClick={() => void copy()}
          aria-describedby={warningId}
          className="text-xs bg-button-primary text-on-primary px-3 py-1.5 rounded hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium shrink-0"
        >
          {copyState === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <label className="flex items-center gap-2 text-sm text-fg min-h-6">
        <input
          ref={ackRef}
          type="checkbox"
          className="accent-primary"
          checked={acknowledged}
          onChange={(e) => onAcknowledge(e.target.checked)}
        />
        I've stored this secret somewhere safe
      </label>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {guardOpen && (
          <div role="status" aria-live="polite" aria-atomic="true" className="flex-1 flex flex-wrap items-center gap-2 text-xs text-fg">
            <span>Close without storing the secret? You'd have to rotate it to get a new one.</span>
            <button
              type="button"
              onClick={onGuardConfirm}
              aria-label="Confirm: close without storing the secret"
              className="min-h-6 text-danger hover:text-danger font-medium transition rounded px-1 focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={onGuardCancel}
              aria-label="Cancel closing, keep the secret on screen"
              className="min-h-6 text-fg-tertiary hover:text-fg transition rounded px-1 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Cancel
            </button>
          </div>
        )}
        <button
          type="button"
          aria-disabled={!acknowledged}
          aria-describedby={acknowledged ? undefined : doneHintId}
          onClick={() => {
            // aria-disabled keeps Done focusable and explained; an inert
            // click points at what is missing instead of doing nothing.
            if (acknowledged) onDone();
            else ackRef.current?.focus();
          }}
          className={`text-xs px-3 py-1.5 rounded border border-line-strong transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
            acknowledged ? "text-fg-secondary hover:text-fg hover:bg-surface-hover" : "text-fg-muted opacity-40 cursor-not-allowed"
          }`}
        >
          Done
        </button>
      </div>
      {!acknowledged && (
        <p id={doneHintId} className="text-xs text-fg-tertiary -mt-1 text-right">Tick the box once the secret is stored to finish.</p>
      )}
      <p className="text-xs min-h-4 text-fg-secondary" role="status" aria-live="polite" aria-atomic="true">
        {copyState === "copied" ? "Secret copied to the clipboard." : copyState === "failed" ? "Couldn't copy. Select the secret and copy it manually." : ""}
      </p>
    </div>
  );
});

export default WebhookSecretReveal;
