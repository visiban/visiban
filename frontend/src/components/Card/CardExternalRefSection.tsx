import { useEffect, useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { CardExternalRef, ExternalRefProvider } from "../../types";
import {
  EXTERNAL_REF_REF_MAX,
  EXTERNAL_REF_URL_MAX,
  PROVIDER_LABELS,
  deriveExternalRef,
  externalRefErrorMessage,
  isHttpUrl,
  validateRef,
} from "../../utils/externalRef";
import ExternalRefGlyph from "./ExternalRefGlyph";

interface Props {
  /** `undefined` is treated exactly like `null` — see `Card.external_ref`. */
  externalRef: CardExternalRef | null | undefined;
  canEdit: boolean;
  /** Rejects on failure; the section surfaces the error and stays in place. */
  onSave: (next: CardExternalRef | null) => Promise<void>;
}

const PROVIDERS: ExternalRefProvider[] = ["github", "gitlab", "other"];
/**
 * The card detail panel's "Pull / merge request" section (#352).
 *
 * Inline editor with explicit Save/Cancel rather than autosave: URL, provider
 * and reference are interdependent, so saving on each field's blur would
 * write half-edited links. Save is pessimistic (no optimistic update) because
 * the server's URL validation is authoritative.
 */
export default function CardExternalRefSection({ externalRef, canEdit, onSave }: Props) {
  const current = externalRef ?? null;
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<ExternalRefProvider>("github");
  const [ref, setRef] = useState("");
  const [providerDirty, setProviderDirty] = useState(false);
  const [refDirty, setRefDirty] = useState(false);
  const [touched, setTouched] = useState<{ url: boolean; ref: boolean }>({ url: false, ref: false });
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const urlInputRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  // Where focus returns when the editor closes: the control that opened it.
  const returnFocusTo = useRef<"add" | "edit">("add");
  // After a save/remove the rendered state changes; focus the new state's
  // primary control once it exists.
  const pendingFocus = useRef<"add" | "edit" | null>(null);

  useEffect(() => {
    if (editing) {
      urlInputRef.current?.focus();
      if (current) urlInputRef.current?.select();
    }
    // Only on entering edit mode — not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once when the editor opens; `current` is read at that moment only
  }, [editing]);

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    (target === "add" ? addButtonRef : editButtonRef).current?.focus();
  });

  const openEditor = (from: "add" | "edit") => {
    returnFocusTo.current = from;
    setUrl(current?.url ?? "");
    setProvider(current?.provider ?? "github");
    setRef(current?.ref ?? "");
    setProviderDirty(false);
    setRefDirty(false);
    setTouched({ url: false, ref: false });
    setSubmitAttempted(false);
    setError(null);
    setRemoveError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setError(null);
    pendingFocus.current = returnFocusTo.current;
  };

  // Priority 38: above the relation picker (37), so the first Escape cancels
  // the edit and the second closes the panel (30). See frontend/CLAUDE.md.
  useEscapeStack(() => {
    if (!editing || saving) return false;
    cancelEdit();
  }, 38);

  const handleUrlChange = (value: string) => {
    setUrl(value);
    const derived = deriveExternalRef(value.trim());
    if (derived) {
      if (!providerDirty) setProvider(derived.provider);
      if (!refDirty) setRef(derived.ref);
    } else if (!providerDirty && isHttpUrl(value.trim())) {
      setProvider("other");
    }
  };

  const trimmedUrl = url.trim();
  const urlValid = isHttpUrl(trimmedUrl);
  const refError = validateRef(ref);
  const canSubmit = urlValid && refError === null && !saving;

  const showUrlError = !urlValid && (touched.url || submitAttempted);
  const showRefError = refError !== null && (touched.ref || submitAttempted);
  const clientError = showUrlError
    ? "Enter a valid http or https URL."
    : showRefError
    ? refError
    : null;
  const statusMessage = error ?? clientError;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitAttempted(true);
    if (!urlValid || refError !== null || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ provider, ref: ref.trim(), url: trimmedUrl });
      setEditing(false);
      pendingFocus.current = "edit";
    } catch (err) {
      setError(externalRefErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      await onSave(null);
      pendingFocus.current = "add";
    } catch (err) {
      setRemoveError(externalRefErrorMessage(err));
    } finally {
      setRemoving(false);
    }
  };

  // Read-only reader with nothing to read: omit the section and its divider
  // entirely rather than rendering an empty heading.
  if (!canEdit && !current) return null;

  const inputClass =
    "w-full bg-sunken border border-primary-soft rounded px-2 py-1.5 text-sm text-fg-secondary placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent";

  return (
    <>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1.5">Pull / merge request</p>

        {editing ? (
          <form className="flex flex-col gap-2" noValidate onSubmit={handleSubmit}>
            <div>
              <label htmlFor="ext-ref-url" className="block mb-0.5 text-xs text-fg-muted">URL</label>
              <input
                ref={urlInputRef}
                id="ext-ref-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                maxLength={EXTERNAL_REF_URL_MAX}
                placeholder="https://github.com/owner/repo/pull/12"
                value={url}
                onChange={(e) => handleUrlChange(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, url: true }))}
                aria-describedby="ext-ref-status"
                aria-invalid={showUrlError || undefined}
                disabled={saving}
                className={inputClass}
              />
            </div>
            <fieldset className="flex flex-wrap gap-2">
              <legend className="sr-only">Provider</legend>
              {PROVIDERS.map((p) => {
                const selected = provider === p;
                return (
                  <label
                    key={p}
                    className={`rounded px-2 py-1 text-xs border cursor-pointer focus-within:ring-2 focus-within:ring-primary-emphasis ${
                      saving ? "opacity-40 cursor-not-allowed " : ""
                    }${
                      selected
                        ? "border-primary-emphasis bg-primary-emphasis/10 text-fg-secondary"
                        : "border-line-strong hover:bg-surface-hover/40 text-fg-muted"
                    }`}
                  >
                    <input
                      type="radio"
                      name="ext-ref-provider"
                      value={p}
                      checked={selected}
                      disabled={saving}
                      onChange={() => { setProvider(p); setProviderDirty(true); }}
                      className="sr-only"
                    />
                    {PROVIDER_LABELS[p]}
                  </label>
                );
              })}
            </fieldset>
            <div>
              <label htmlFor="ext-ref-ref" className="block mb-0.5 text-xs text-fg-muted">Reference</label>
              <input
                id="ext-ref-ref"
                autoComplete="off"
                maxLength={EXTERNAL_REF_REF_MAX}
                placeholder="owner/repo#12"
                value={ref}
                onChange={(e) => { setRef(e.target.value); setRefDirty(true); }}
                onBlur={() => setTouched((t) => ({ ...t, ref: true }))}
                aria-describedby="ext-ref-status"
                aria-invalid={showRefError || undefined}
                disabled={saving}
                className={`${inputClass} font-mono`}
              />
            </div>
            <p id="ext-ref-status" aria-live="polite" className="text-xs min-h-4">
              {statusMessage && <span className="text-danger">{statusMessage}</span>}
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={cancelEdit}
                disabled={saving}
                className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="text-sm bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover transition font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving ? "Saving…" : "Save link"}
              </button>
            </div>
          </form>
        ) : current ? (
          <>
            <div className="flex items-center gap-3 px-1 py-0.5 rounded hover:bg-surface-hover">
              <span className="text-xs text-fg-muted shrink-0">{PROVIDER_LABELS[current.provider] ?? current.provider}</span>
              {isHttpUrl(current.url) ? (
                <a
                  href={current.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  // Parsed host, as on the card face: provider/ref are free
                  // text, so the tooltip is where a reader checks the target.
                  title={`${current.ref} — ${new URL(current.url).host} (opens in new tab)`}
                  aria-label={`${current.ref}, opens in new tab`}
                  className="inline-flex items-center gap-1 min-w-0 flex-1 text-sm text-info hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  <ExternalRefGlyph className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate font-mono">{current.ref}</span>
                </a>
              ) : (
                <span className="inline-flex items-center gap-1 min-w-0 flex-1 text-sm text-fg-secondary">
                  <ExternalRefGlyph className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate font-mono">{current.ref}</span>
                </span>
              )}
              {canEdit && (
                <>
                  <button
                    ref={editButtonRef}
                    type="button"
                    onClick={() => openEditor("edit")}
                    disabled={removing}
                    aria-label="Edit pull or merge request link"
                    className="text-xs text-fg-muted hover:text-fg-secondary px-1.5 py-0.5 transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={handleRemove}
                    disabled={removing}
                    aria-label="Remove pull or merge request link"
                    className="text-xs text-danger hover:underline font-medium px-1.5 py-0.5 transition shrink-0 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Remove
                  </button>
                </>
              )}
            </div>
            {canEdit && removeError && (
              <p role="alert" className="text-xs text-danger mt-1">{removeError}</p>
            )}
          </>
        ) : (
          <button
            ref={addButtonRef}
            type="button"
            onClick={() => openEditor("add")}
            className="text-xs text-fg-muted hover:text-fg-secondary border border-dashed border-line-strong hover:border-line-emphasis rounded px-2.5 py-1 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            + Link a pull or merge request
          </button>
        )}
      </div>
      <div className="border-t border-line" />
    </>
  );
}
