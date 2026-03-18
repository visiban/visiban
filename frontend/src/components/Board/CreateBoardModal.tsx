import { useEffect, useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { listBoardTemplates } from "../../api/boards";
import type { BoardTemplate, User } from "../../types";

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
  useEscapeStack(onCancel, 40);
  const [name, setName] = useState("");
  const [templates, setTemplates] = useState<BoardTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [selectedSlug, setSelectedSlug] = useState("simple_kanban");
  const [swimlaneName, setSwimlaneName] = useState("");
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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
        // If the API is unreachable, fall back to an empty list with just "Blank Board"
        // so the user can still create a board without columns.
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

  // When the template changes, reset the swimlane name so the user sees the
  // new placeholder and re-enters a context-appropriate value.
  const handleSelectTemplate = (slug: string) => {
    setSelectedSlug(slug);
    setSwimlaneName("");
    // Let the swimlane input focus after state update.
    setTimeout(() => swimlaneRef.current?.focus(), 0);
  };

  // Close on backdrop click.
  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCancel();
  };

  const handleSubmit = async () => {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(name.trim(), selectedSlug, swimlaneName.trim(), setAsDefault);
    } finally {
      setSubmitting(false);
    }
  };

  const userHasNoDefault = !user?.default_board_id;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={handleBackdrop}
    >
      <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-slate-800">
          <h2 className="text-white text-lg font-semibold">New Board</h2>
          <p className="text-slate-400 text-sm mt-0.5">Choose a template, name your board, then add your first swimlane.</p>
        </div>

        {/* Body — scrollable */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

          {/* Board name */}
          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">
              Board name
            </label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
                if (e.key === "Escape") onCancel();
              }}
              placeholder="e.g. Q3 Pipeline, Acme Onboarding…"
              className="w-full bg-slate-800 border border-slate-700 focus:border-blue-500 text-white rounded-xl px-4 py-2.5 outline-none text-sm placeholder-slate-500 transition"
            />
          </div>

          {/* Template picker */}
          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">
              Template
            </label>
            {templatesLoading ? (
              <div className="text-slate-500 text-sm py-4 text-center">Loading templates…</div>
            ) : (
              <div className="grid grid-cols-2 gap-2.5">
                {templates.map((t) => {
                  const isSelected = t.slug === selectedSlug;
                  return (
                    <button
                      key={t.slug}
                      onClick={() => handleSelectTemplate(t.slug)}
                      className={[
                        "text-left rounded-xl p-3.5 border transition-all",
                        isSelected
                          ? "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/40"
                          : "border-slate-700 bg-slate-800 hover:border-slate-500",
                      ].join(" ")}
                    >
                      {/* Icon + name row */}
                      <div className="flex items-center gap-2 mb-1">
                        <span className={isSelected ? "text-blue-400" : "text-slate-400"}>
                          {ICONS[t.slug] ?? FALLBACK_ICON}
                        </span>
                        <span className="text-white text-sm font-medium leading-tight">{t.name}</span>
                      </div>

                      {/* Description */}
                      <p className="text-slate-400 text-xs leading-snug mb-2.5">{t.description}</p>

                      {/* Column color dots */}
                      {t.columns_json.length > 0 ? (
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
                      ) : (
                        <span className="text-slate-600 text-xs">No columns</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Column preview strip */}
          {selected && selected.columns_json.length > 0 && (
            <div className="bg-slate-800 rounded-xl px-4 py-3">
              <p className="text-slate-500 text-xs mb-2 uppercase tracking-wide">Columns created</p>
              <div className="flex gap-2 flex-wrap">
                {selected.columns_json.map((col) => (
                  <span
                    key={col.name}
                    className="inline-flex items-center gap-1.5 text-xs text-white bg-slate-700 rounded-lg px-2.5 py-1"
                  >
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: col.color }}
                    />
                    {col.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* First swimlane prompt */}
          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">
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
              className="w-full bg-slate-800 border border-slate-700 focus:border-blue-500 text-white rounded-xl px-4 py-2.5 outline-none text-sm placeholder-slate-500 transition"
            />
            <p className="text-slate-600 text-xs mt-1">
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
              className="mt-0.5 w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-900 cursor-pointer flex-shrink-0"
            />
            <div>
              <label htmlFor="set-default-board" className="text-sm text-slate-300 cursor-pointer">
                Set as my default board
              </label>
              {userHasNoDefault && !setAsDefault && (
                <p className="text-slate-500 text-xs mt-0.5">
                  Tip: Set a default to skip the board picker on login.
                </p>
              )}
              {setAsDefault && (
                <p className="text-slate-400 text-xs mt-0.5">
                  This board will open on login.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            className="text-slate-400 text-sm hover:text-white px-3 py-1.5 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || submitting}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-5 py-2 rounded-xl transition"
          >
            {submitting ? "Creating…" : "Create Board"}
          </button>
        </div>
      </div>
    </div>
  );
}

