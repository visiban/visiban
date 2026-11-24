import { useEffect, useId, useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { OVERRIDE_REASON_MAX_LENGTH } from "../../utils/forceOverride";

interface Props {
  busy?: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
  /** Set when the form is nested in another surface (36.5 in the Move popover and
   *  the peek sheet). Omitted inside a ModalWrapper, which owns Escape. */
  escapePriority?: number;
}

/**
 * The required reason for an assignee's "Move anyway" (#1923). The server
 * refuses an assignee override without one, so every surface that offers it
 * collects it here.
 */
export default function OverrideReasonForm({ busy = false, onSubmit, onCancel, escapePriority }: Props) {
  const [reason, setReason] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const helpId = `${id}-help`;
  const trimmed = reason.trim();
  const blocked = busy || trimmed === "";

  useEffect(() => { fieldRef.current?.focus(); }, []);

  useEscapeStack(() => {
    if (escapePriority === undefined) return false;
    // Swallowed while the move runs, as the surface around it does.
    if (!busy) onCancel();
  }, escapePriority ?? 0);

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <label htmlFor={id} className="text-xs text-fg-secondary">Reason (required)</label>
      <textarea
        id={id}
        ref={fieldRef}
        rows={3}
        required
        maxLength={OVERRIDE_REASON_MAX_LENGTH}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        aria-describedby={helpId}
        className="w-full bg-surface-hover border border-line-strong rounded px-2 py-1 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      />
      <div id={helpId} className="flex justify-between gap-2 text-xs text-fg-tertiary">
        <span>Visible to everyone on this board.</span>
        <span>{reason.length}/{OVERRIDE_REASON_MAX_LENGTH}</span>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="max-sm:min-h-11 text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40"
        >Cancel</button>
        <button
          type="button"
          onClick={() => { if (!blocked) onSubmit(trimmed); }}
          aria-disabled={blocked}
          aria-describedby={helpId}
          className="max-sm:min-h-11 text-sm font-medium bg-warning-bg hover:bg-warning-bg-hover text-on-warning px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-warning-emphasis aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
        >{busy ? "Moving anyway…" : "Move anyway"}</button>
      </div>
    </div>
  );
}
