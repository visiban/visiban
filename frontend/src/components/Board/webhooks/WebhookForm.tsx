import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import type { WebhookSubscription } from "../../../types";
import type { WebhookWriteBody } from "../../../api/webhooks";
import {
  CONFIG_ERROR_COPY,
  CONFIG_GENERIC_COPY,
  CONFIG_THROTTLED_COPY,
  EVENTS_NONE_SELECTED_COPY,
  type ConfigErrorSlot,
} from "../../../constants/webhooks";
import WebhookEventTypePicker from "./WebhookEventTypePicker";

interface Props {
  mode: "create" | "edit";
  /** The row being edited (edit mode). */
  initial?: WebhookSubscription;
  /** `status.subscribable_event_types`. */
  eventOptions: string[];
  /** Resolves on success; rejects with the axios error on failure. */
  onSubmit: (body: WebhookWriteBody) => Promise<unknown>;
  onCancel: () => void;
}

export interface WebhookFormHandle {
  cancel: () => void;
  submitting: () => boolean;
}

interface FieldError {
  slot: ConfigErrorSlot;
  text: string;
  tone?: "danger" | "warning";
}

const INPUT_BASE = "bg-surface border rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 placeholder-fg-muted";

function inputClass(invalid: boolean, extra = "") {
  // Invalid keeps its danger border while focused (frontend/CLAUDE.md § Inputs, rule 4).
  return `${INPUT_BASE} ${invalid ? "border-danger focus:ring-danger-emphasis" : "border-line focus:ring-primary-emphasis focus:border-transparent"} ${extra}`;
}

function errorFrom(err: unknown): FieldError {
  const response = (err as { response?: { status?: number; data?: { code?: unknown } } })?.response;
  if (response?.status === 429) return { slot: "form", text: CONFIG_THROTTLED_COPY, tone: "warning" };
  const code = response?.data?.code;
  if (typeof code === "string" && CONFIG_ERROR_COPY[code]) return CONFIG_ERROR_COPY[code];
  return { slot: "form", text: CONFIG_GENERIC_COPY };
}

/** Inline create / edit form for one webhook (#863 UX spec § 4). */
const WebhookForm = forwardRef<WebhookFormHandle, Props>(function WebhookForm(
  { mode, initial, eventOptions, onSubmit, onCancel },
  ref,
) {
  const uid = useId();
  const ids = {
    name: `${uid}-name`,
    nameHelp: `${uid}-name-help`,
    url: `${uid}-url`,
    urlHelp: `${uid}-url-help`,
    eventsHelp: `${uid}-events-help`,
  };
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState("");
  const initialTypes = initial?.event_types ?? [];
  const [allEvents, setAllEvents] = useState(initialTypes.length === 0);
  const [selected, setSelected] = useState<string[]>(initialTypes);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FieldError | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const eventsRef = useRef<HTMLFieldSetElement>(null);
  const submittingRef = useRef(false);

  useImperativeHandle(ref, () => ({
    cancel: () => {
      if (!submittingRef.current) onCancel();
    },
    submitting: () => submittingRef.current,
  }));

  // Opening the form focuses Name.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // A field error moves focus to its field.
  useEffect(() => {
    if (!error) return;
    if (error.slot === "url") urlRef.current?.focus();
    else if (error.slot === "events") eventsRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [error]);

  const urlInvalid = error?.slot === "url";
  const eventsInvalid = error?.slot === "events";

  const buildBody = (): WebhookWriteBody | null => {
    const eventTypes = allEvents ? [] : selected;
    if (!allEvents && selected.length === 0) {
      setError({ slot: "events", text: EVENTS_NONE_SELECTED_COPY });
      return null;
    }
    if (mode === "create") return { name: name.trim(), url: url.trim(), event_types: eventTypes };
    const body: WebhookWriteBody = {};
    if (name.trim() !== (initial?.name ?? "")) body.name = name.trim();
    if (url.trim()) body.url = url.trim();
    const before = initial?.event_types ?? [];
    if (eventTypes.length !== before.length || eventTypes.some((t, i) => t !== before[i])) {
      body.event_types = eventTypes;
    }
    return body;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    setError(null);
    const body = buildBody();
    if (body === null) return;
    if (mode === "edit" && Object.keys(body).length === 0) {
      onCancel();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit(body);
    } catch (err) {
      setError(errorFrom(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const primaryLabel = mode === "create"
    ? (submitting ? "Creating…" : "Create webhook")
    : (submitting ? "Saving…" : "Save changes");

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-3 border border-line rounded-lg p-3 bg-sunken"
      noValidate
      aria-label={mode === "create" ? "New webhook" : `Edit ${initial?.name || initial?.url_host || "webhook"}`}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.name} className="text-xs text-fg-tertiary">Name (optional)</label>
        <input
          id={ids.name}
          ref={nameRef}
          type="text"
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Slack #deploys"
          aria-describedby={ids.nameHelp}
          className={inputClass(false)}
        />
        <p id={ids.nameHelp} className="text-xs min-h-4" />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={ids.url} className="text-xs text-fg-tertiary">Payload URL</label>
        <input
          id={ids.url}
          ref={urlRef}
          type="url"
          spellCheck={false}
          autoComplete="off"
          required={mode === "create"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={mode === "edit" ? `Leave blank to keep ${initial?.url_display ?? ""}` : "https://"}
          aria-describedby={ids.urlHelp}
          aria-invalid={urlInvalid ? true : undefined}
          className={inputClass(urlInvalid, "font-mono")}
        />
        <p id={ids.urlHelp} className={`text-xs min-h-4 ${urlInvalid ? "text-danger" : "text-fg-tertiary"}`}>
          {urlInvalid
            ? error.text
            : mode === "edit"
              ? "Changing the URL makes you this webhook's owner. The signing secret stays the same."
              : "Must start with https://. Every request is signed so your receiver can verify it."}
        </p>
      </div>

      <fieldset ref={eventsRef} className="flex flex-col gap-1.5" aria-describedby={ids.eventsHelp}>
        <legend className="text-xs text-fg-tertiary mb-1">Events</legend>
        <label className="flex items-start gap-2 text-sm text-fg-secondary">
          <input
            type="radio"
            name={`${uid}-events-mode`}
            className="accent-primary mt-1"
            checked={allEvents}
            onChange={() => { setAllEvents(true); if (eventsInvalid) setError(null); }}
          />
          <span>
            All events
            <span className="block text-xs text-fg-tertiary">Includes event types added in later versions</span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm text-fg-secondary">
          <input
            type="radio"
            name={`${uid}-events-mode`}
            className="accent-primary"
            checked={!allEvents}
            onChange={() => setAllEvents(false)}
          />
          Only selected events
        </label>
        {!allEvents && (
          <div className="ml-6 border-l-2 border-line pl-4">
            <WebhookEventTypePicker
              options={eventOptions}
              selected={selected}
              onChange={(next) => { setSelected(next); if (eventsInvalid) setError(null); }}
              describedBy={ids.eventsHelp}
              invalid={eventsInvalid}
            />
          </div>
        )}
        <p id={ids.eventsHelp} className={`text-xs min-h-4 ${eventsInvalid ? "text-danger" : ""}`}>
          {eventsInvalid ? error.text : null}
        </p>
      </fieldset>

      <p className="text-xs min-h-4" role="status" aria-live="polite" aria-atomic="true">
        {error?.slot === "form" && (
          <span className={error.tone === "warning" ? "text-warning" : "text-danger"}>{error.text}</span>
        )}
      </p>

      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={() => { if (!submittingRef.current) onCancel(); }}
          disabled={submitting}
          className="text-xs text-fg-tertiary hover:text-fg-secondary px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || (mode === "create" && url.trim() === "")}
          className="text-xs bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium inline-flex items-center gap-1.5"
        >
          {submitting && (
            <span aria-hidden="true" className="inline-block w-3 h-3 border-2 border-on-primary border-t-transparent rounded-full animate-spin" />
          )}
          {primaryLabel}
        </button>
      </div>
    </form>
  );
});

export default WebhookForm;
