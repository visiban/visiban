import { useEffect, useRef, useState } from "react";
import { listBoardTemplates } from "../../api/boards";
import type { BoardTemplate, User } from "../../types";
import ModalWrapper from "../shared/ModalWrapper";

// ---------------------------------------------------------------------------
// Static icon map — SVG paths kept inline to avoid adding a dependency.
// Keys match the template slug. A fallback icon is used for unknown slugs.
// ---------------------------------------------------------------------------
const ICONS: Record<string, React.ReactNode> = {
  sales_pipeline: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M2 17l5-5 4 4 5-6 4-4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="21" cy="6" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  customer_support: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  customer_success: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.563.563 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.563.563 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  simple_kanban: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <rect x="3" y="3" width="5" height="18" rx="1" />
      <rect x="10" y="3" width="5" height="13" rx="1" />
      <rect x="17" y="3" width="5" height="9" rx="1" />
    </svg>
  ),
  product_roadmap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M3 12h4l3-8 4 16 3-8h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  content_production: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.5 7.125L18 8.625" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 20.25h18" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  hiring_recruiting: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18-2.087.277-4.216.42-6.378.42s-4.291-.143-6.378-.42c-1.085-.144-1.872-1.086-1.872-2.18v-4.25m16.5 0a2.18 2.18 0 0 0 .75-1.661V8.706c0-1.081-.768-2.015-1.837-2.175a48.114 48.114 0 0 0-3.413-.387m4.5 8.006c-.194.165-.42.295-.673.38A23.978 23.978 0 0 1 12 15.75c-2.648 0-5.195-.429-7.577-1.22a2.016 2.016 0 0 1-.673-.38m0 0A2.18 2.18 0 0 1 3 12.489V8.706c0-1.081.768-2.015 1.837-2.175a48.111 48.111 0 0 1 3.413-.387m7.5 0V5.25A2.25 2.25 0 0 0 13.5 3h-3a2.25 2.25 0 0 0-2.25 2.25v.894m7.5 0a48.667 48.667 0 0 0-7.5 0M12 12.75h.008v.008H12v-.008Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  legal_compliance: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  infra_devops: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  project_delivery: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  blank: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="4 2" />
      <path d="M12 8v8M8 12h8" strokeLinecap="round" />
    </svg>
  ),
};

const FALLBACK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
    <rect x="3" y="3" width="18" height="18" rx="2" />
  </svg>
);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  /**
   * Called with (boardName, templateSlug, swimlaneName, setAsDefault).
   * setAsDefault=true means the caller should PATCH /api/auth/me/ with the
   * new board's ID after it is created.
   */
  onConfirm: (name: string, template: string, swimlaneName: string, setAsDefault: boolean) => Promise<void>;
  onCancel: () => void;
  /** Current user — used to show the default-board tip. */
  user?: User | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CreateBoardModal({ onConfirm, onCancel, user }: Props) {
  const [name, setName] = useState("");
  const [templates, setTemplates] = useState<BoardTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState("simple_kanban");
  const [swimlaneName, setSwimlaneName] = useState("");
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const swimlaneRef = useRef<HTMLInputElement>(null);

  // Fetch templates from the API on mount.
  useEffect(() => {
    listBoardTemplates()
      .then((data) => {
        setTemplates(data);
        // Default selection: prefer simple_kanban if present, else first template.
        const preferred = data.find((t) => t.slug === "simple_kanban") ?? data[0];
        if (preferred) setSelectedSlug(preferred.slug);
      })
      .catch(() => {
        // If the API is unreachable, show an error and fall back to Blank Board only
        // so the user can still create a board without columns.
        setTemplatesError(true);
        setTemplates([{
          id: "fallback-blank",
          name: "Blank Board",
          slug: "blank",
          description: "Start empty and add columns and swimlanes yourself",
          icon: "blank",
          lane_label: "",
          lane_placeholder: "e.g. General",
          columns_json: [],
          sort_order: 99,
        }]);
        setSelectedSlug("blank");
      })
      .finally(() => setTemplatesLoading(false));
  }, []);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const selected = templates.find((t) => t.slug === selectedSlug) ?? null;

  const handleSelectTemplate = (slug: string) => {
    setSelectedSlug(slug);
    // Do not clear the swimlane name or steal focus — the user may have already
    // typed a name, and focus theft after every template click breaks the
    // locus-of-control expectation.
  };

  const handleSubmit = async () => {
    if (!name.trim() || submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await onConfirm(name.trim(), selectedSlug, swimlaneName.trim(), setAsDefault);
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { name?: string[]; detail?: string } } }).response?.data;
      const msg = data?.name?.[0] ?? data?.detail ?? "Something went wrong. Please try again.";
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const userHasNoDefault = !user?.default_board_id;

  return (
    <ModalWrapper
      open={true}
      onClose={onCancel}
      title="New Board"
      subtitle="Name your board, pick a template, then optionally add a swimlane."
      maxWidth="max-w-2xl"
      noPadding
      panelClassName="max-h-[90vh]"
      headerBorder
    >
        {/* Body — scrollable */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

          {/* Board name */}
          <div>
            <label className="block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5">
              Board name
            </label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => { setName(e.target.value); setSubmitError(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
                if (e.key === "Escape") onCancel();
              }}
              placeholder="e.g. Q3 Pipeline, Acme Onboarding…"
              className="w-full bg-surface border border-line focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent text-fg-secondary rounded px-3 py-1.5 text-sm placeholder-fg-muted transition"
            />
          </div>

          {/* Template picker — fieldset/legend + sr-only radio inputs for screen-reader and keyboard navigation */}
          <fieldset>
            <legend className="block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-2">
              Template
            </legend>
            {templatesLoading ? (
              <div className="flex items-center justify-center py-8">
                <span className="w-5 h-5 border-2 border-line-strong border-t-line-strong rounded-full animate-spin" />
              </div>
            ) : templatesError ? (
              <p className="text-danger text-sm py-4 text-center">
                Could not load templates. You can still create a blank board.
              </p>
            ) : (() => {
              const namedTemplates = templates.filter((t) => t.slug !== "blank");
              const blankTemplate = templates.find((t) => t.slug === "blank") ?? null;
              return (
                <>
                  {/* Named templates — 2-column grid */}
                  <div className="grid grid-cols-2 gap-2.5">
                    {namedTemplates.map((t) => {
                      const isSelected = t.slug === selectedSlug;
                      return (
                        <label
                          key={t.slug}
                          className={[
                            "text-left rounded-lg p-3.5 border transition-colors duration-150 cursor-pointer",
                            "focus-within:ring-2 focus-within:ring-primary-emphasis",
                            isSelected
                              ? "border-primary-emphasis bg-primary-emphasis/10"
                              : "border-line-strong hover:bg-surface-hover/40",
                          ].join(" ")}
                        >
                          <input
                            type="radio"
                            name="template"
                            value={t.slug}
                            checked={isSelected}
                            onChange={() => handleSelectTemplate(t.slug)}
                            className="sr-only"
                          />
                          {/* Icon + name row */}
                          <div className="flex items-center gap-2 mb-1">
                            <span className={isSelected ? "text-info" : "text-fg-tertiary"}>
                              {ICONS[t.slug] ?? FALLBACK_ICON}
                            </span>
                            <span className="text-fg text-sm font-medium leading-tight">{t.name}</span>
                          </div>

                          {/* Description */}
                          <p className="text-fg-tertiary text-xs leading-snug mb-2.5">{t.description}</p>

                          {/* Column color dots */}
                          <div className="flex items-center gap-1 flex-wrap">
                            {t.columns_json.map((col) => (
                              <span
                                key={col.name}
                                title={col.name}
                                className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                                style={{ backgroundColor: col.color }}
                              />
                            ))}
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  {/* Blank Board — full-width row below a separator, visually distinct as the opt-out */}
                  {blankTemplate && (() => {
                    const isSelected = blankTemplate.slug === selectedSlug;
                    return (
                      <div className="border-t border-line pt-3 mt-1">
                        <label
                          className={[
                            "w-full text-left rounded-xl p-3.5 border transition-colors duration-150 flex items-center gap-4 cursor-pointer",
                            "focus-within:ring-2 focus-within:ring-primary-emphasis",
                            isSelected
                              ? "border-primary-emphasis bg-primary-emphasis/10"
                              : "border-line-strong hover:bg-surface-hover/40",
                          ].join(" ")}
                        >
                          <input
                            type="radio"
                            name="template"
                            value={blankTemplate.slug}
                            checked={isSelected}
                            onChange={() => handleSelectTemplate(blankTemplate.slug)}
                            className="sr-only"
                          />
                          <span className={`flex-shrink-0 ${isSelected ? "text-info" : "text-fg-tertiary"}`}>
                            {ICONS.blank}
                          </span>
                          <div className="flex-1 min-w-0">
                            <span className="text-fg text-sm font-medium">{blankTemplate.name}</span>
                            <p className="text-fg-tertiary text-xs leading-snug mt-0.5">{blankTemplate.description}</p>
                          </div>
                          <span className="text-fg-muted text-xs flex-shrink-0">No preset columns</span>
                        </label>
                      </div>
                    );
                  })()}
                </>
              );
            })()}
          </fieldset>

          {/* Column preview strip — always rendered after load to prevent layout jump on template switch */}
          {!templatesLoading && (
            <div className="bg-surface rounded-xl px-4 py-3">
              <p className="text-fg-muted text-xs mb-2 uppercase tracking-wide">Columns created</p>
              {selected && selected.columns_json.length > 0 ? (
                <div className="flex gap-2 flex-wrap">
                  {selected.columns_json.map((col) => (
                    <span
                      key={col.name}
                      className="inline-flex items-center gap-1.5 text-xs text-fg bg-surface-hover rounded-lg px-2.5 py-1"
                    >
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: col.color }}
                      />
                      {col.name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-fg-muted text-xs">No preset columns — add your own after creating the board.</p>
              )}
            </div>
          )}

          {/* First swimlane prompt */}
          <div>
            <label className="block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5">
              {selected?.lane_label
                ? `First ${selected.lane_label} (swimlane)`
                : "First Swimlane (optional)"}
            </label>
            <input
              ref={swimlaneRef}
              value={swimlaneName}
              onChange={(e) => setSwimlaneName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
                if (e.key === "Escape") onCancel();
              }}
              placeholder={selected?.lane_placeholder || "e.g. General"}
              className="w-full bg-surface border border-line focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent text-fg-secondary rounded px-3 py-1.5 text-sm placeholder-fg-muted transition"
            />
            <p className="text-fg-muted text-xs mt-1">
              Leave blank to start with no swimlanes — you can add them later.
            </p>
          </div>

          {/* Set as default board */}
          <div className="flex items-start gap-3">
            <input
              id="set-default-board"
              type="checkbox"
              checked={setAsDefault}
              onChange={(e) => setSetAsDefault(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-line-strong bg-surface text-info focus:ring-primary-emphasis focus:ring-offset-sunken cursor-pointer flex-shrink-0"
            />
            <div>
              <label htmlFor="set-default-board" className="text-sm text-fg-secondary cursor-pointer">
                Set as my default board
              </label>
              {/* Always render the hint line to prevent layout shift on check/uncheck */}
              <p className="text-xs mt-0.5 min-h-[1rem]">
                {setAsDefault ? (
                  <span className="text-fg-tertiary">This board will open on login.</span>
                ) : userHasNoDefault ? (
                  <span className="text-fg-muted">Tip: Set a default to skip the board picker on login.</span>
                ) : null}
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-line flex items-center gap-3">
          <p className="text-xs h-4 flex-1"><span className="text-danger">{submitError}</span></p>
          <button
            onClick={onCancel}
            className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || submitting}
            className="bg-primary hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed text-fg text-sm font-medium px-5 py-2 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {submitting ? "Creating…" : "Create Board"}
          </button>
        </div>
    </ModalWrapper>
  );
}

