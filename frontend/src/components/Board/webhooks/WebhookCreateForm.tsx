import { useEffect, useId, useRef, useState } from "react";
import {
  EVENTS_NONE_SELECTED_COPY,
  SESSION_REQUIRED_COPY,
  FORM_ERROR_COPY,
  FORM_GENERIC_COPY,
  FORM_THROTTLED_COPY,
  URL_ERROR_COPY,
  URL_HELPER_COPY,
  urlErrorFromResponse,
  urlShapeError,
} from "../../../constants/webhooks";
import WebhookEventTypePicker from "./WebhookEventTypePicker";
import { axiosResponse, urlInputClass } from "./webhookFormUtils";

interface Props {
  eventOptions: string[];
  /** Resolves on success; rejects with the axios error. */
  onSubmit: (body: { url: string; event_types: string[] }) => Promise<unknown>;
  onCancel: () => void;
}

/** "Add webhook" view (1.3 UI spec Part 8 § Create). */
export default function WebhookCreateForm({ eventOptions, onSubmit, onCancel }: Props) {
  const uid = useId();
  const urlId = `${uid}-url`;
  const urlHelpId = `${uid}-url-help`;
  const eventsErrorId = `${uid}-events-error`;
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<{ all: boolean; selected: string[] }>({ all: true, selected: [] });
  const [urlError, setUrlError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [formError, setFormError] = useState<{ text: string; tone: "danger" | "warning" } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  // Create → focus the URL field (spec Part 8 § Escape · keyboard).
  useEffect(() => {
    urlRef.current?.focus();
  }, []);

  const failUrl = (text: string) => {
    setUrlError(text);
    // Focus returns to the URL field; its helper slot announces the error.
    urlRef.current?.focus();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setUrlError(null);
    setEventsError(null);
    setFormError(null);
    const shape = urlShapeError(url);
    if (shape) {
      failUrl(URL_ERROR_COPY[shape]);
      return;
    }
    if (!events.all && events.selected.length === 0) {
      setEventsError(EVENTS_NONE_SELECTED_COPY);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ url: url.trim(), event_types: events.all ? [] : events.selected });
    } catch (err) {
      const response = axiosResponse(err);
      const code = typeof response?.data?.code === "string" ? response.data.code : undefined;
      const urlText = urlErrorFromResponse(response?.data);
      if (urlText) failUrl(urlText);
      else if (code === "session_required") setFormError({ text: SESSION_REQUIRED_COPY, tone: "danger" });
      else if (code === "invalid_event_types") setEventsError(FORM_ERROR_COPY.invalid_event_types);
      else if (response?.status === 429) setFormError({ text: FORM_THROTTLED_COPY, tone: "warning" });
      else setFormError({ text: (code && FORM_ERROR_COPY[code]) || FORM_GENERIC_COPY, tone: "danger" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby={`${uid}-heading`} className="flex flex-col gap-4">
      <div>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-1.5 py-0.5 min-h-6 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          ← All webhooks
        </button>
      </div>
      <h3 id={`${uid}-heading`} tabIndex={-1} className="text-base font-semibold text-fg focus:outline-none">
        Add webhook
      </h3>
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={urlId} className="text-xs text-fg-tertiary">Endpoint URL</label>
          <input
            id={urlId}
            ref={urlRef}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://hooks.example.com/visiban"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={urlError ? true : undefined}
            aria-describedby={urlHelpId}
            className={urlInputClass(Boolean(urlError))}
          />
          {/* The helper slot doubles as the error slot (spec Part 8 § Live regions). */}
          <p
            id={urlHelpId}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={`text-xs min-h-4 ${urlError ? "text-danger" : "text-fg-tertiary"}`}
          >
            {urlError ?? URL_HELPER_COPY}
          </p>
        </div>

        <WebhookEventTypePicker
          options={eventOptions}
          all={events.all}
          selected={events.selected}
          onChange={(next) => { setEvents(next); setEventsError(null); }}
          errorId={eventsErrorId}
          invalid={Boolean(eventsError)}
        />
        <p id={eventsErrorId} role="status" aria-live="polite" aria-atomic="true" className="text-xs min-h-4 text-danger -mt-3">
          {eventsError}
        </p>

        <p className="text-xs text-fg-tertiary">After you create it, Visiban shows its signing secret once. Delivery is best effort.</p>
        <p className="text-xs min-h-4" role="status" aria-live="polite" aria-atomic="true">
          {formError && <span className={formError.tone === "warning" ? "text-warning-on-tint" : "text-danger"}>{formError.text}</span>}
        </p>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="text-xs text-fg-tertiary hover:text-fg-secondary px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            aria-disabled={submitting || undefined}
            className="text-xs bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium inline-flex items-center gap-1.5"
          >
            {submitting && (
              <span aria-hidden="true" className="inline-block w-3 h-3 border-2 border-on-primary border-t-transparent rounded-full animate-spin" />
            )}
            {submitting ? "Creating…" : "Create webhook"}
          </button>
        </div>
      </form>
    </section>
  );
}
