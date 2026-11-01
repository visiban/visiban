import { useId, useState } from "react";
import type { WebhookResumeFrom } from "../../../api/webhooks";

interface Props {
  name: string;
  /** True when the reason is `cursor_expired`, or the server answered 409 `cursor_expired`. */
  cursorExpired: boolean;
  inFlight: boolean;
  error: string | null;
  onConfirm: (resumeFrom: WebhookResumeFrom) => void;
  onCancel: () => void;
}

/** Inline re-enable prompt with the resume choice (#863 UX spec § 6). */
export default function WebhookReenablePrompt({ name, cursorExpired, inFlight, error, onConfirm, onCancel }: Props) {
  const uid = useId();
  const [resumeFrom, setResumeFrom] = useState<WebhookResumeFrom>("cursor");
  return (
    <div className="basis-full flex flex-col gap-2 text-xs" role="group" aria-label={`Re-enable ${name}`}>
      {cursorExpired ? (
        <p className="text-fg-tertiary">The events it missed are gone, so it resumes with new events only.</p>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-fg-tertiary mb-1">Resume from</legend>
          <label className="flex items-center gap-2 text-fg-secondary">
            <input
              type="radio"
              name={`${uid}-resume`}
              className="accent-primary"
              checked={resumeFrom === "cursor"}
              onChange={() => setResumeFrom("cursor")}
            />
            Send the events it missed
          </label>
          <label className="flex items-center gap-2 text-fg-secondary">
            <input
              type="radio"
              name={`${uid}-resume`}
              className="accent-primary"
              checked={resumeFrom === "latest"}
              onChange={() => setResumeFrom("latest")}
            />
            Skip to new events only
          </label>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onConfirm(cursorExpired ? "latest" : resumeFrom)}
          disabled={inFlight}
          aria-label={cursorExpired ? `Re-enable ${name} with new events only` : `Re-enable ${name}`}
          className="text-xs bg-button-primary text-on-primary px-3 py-1 rounded hover:bg-button-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
        >
          {cursorExpired ? "Re-enable with new events only" : "Re-enable"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={inFlight}
          aria-label={`Cancel re-enabling ${name}`}
          className="text-fg-tertiary hover:text-fg transition rounded disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}
