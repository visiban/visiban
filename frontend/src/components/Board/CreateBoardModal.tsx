import { useEffect, useRef, useState } from "react";

interface TemplateDefinition {
  key: string;
  name: string;
  description: string;
  columns: { name: string; color: string }[];
  swimlane: string | null;
}

const TEMPLATES: TemplateDefinition[] = [
  {
    key: "simple_kanban",
    name: "Simple Kanban",
    description: "General task tracking for any team or project",
    columns: [
      { name: "Backlog", color: "#6B7280" },
      { name: "To Do",   color: "#3B82F6" },
      { name: "Doing",   color: "#F59E0B" },
      { name: "Done",    color: "#10B981" },
    ],
    swimlane: "General",
  },
  {
    key: "sales_pipeline",
    name: "Sales Pipeline",
    description: "Track deals per prospect from lead to close",
    columns: [
      { name: "Lead",          color: "#6B7280" },
      { name: "Qualified",     color: "#3B82F6" },
      { name: "Proposal Sent", color: "#F59E0B" },
      { name: "Negotiation",   color: "#EF4444" },
      { name: "Closed Won",    color: "#10B981" },
      { name: "Closed Lost",   color: "#9CA3AF" },
    ],
    swimlane: "New Prospect",
  },
  {
    key: "bug_tracker",
    name: "Bug Tracker",
    description: "Defect lifecycle from report through resolution",
    columns: [
      { name: "Reported",    color: "#EF4444" },
      { name: "Triaged",     color: "#F59E0B" },
      { name: "In Progress", color: "#3B82F6" },
      { name: "In Review",   color: "#8B5CF6" },
      { name: "Resolved",    color: "#10B981" },
      { name: "Closed",      color: "#6B7280" },
    ],
    swimlane: null,
  },
  {
    key: "product_roadmap",
    name: "Product Roadmap",
    description: "Feature delivery from idea to shipment per team",
    columns: [
      { name: "Ideas",       color: "#8B5CF6" },
      { name: "Backlog",     color: "#6B7280" },
      { name: "In Progress", color: "#3B82F6" },
      { name: "In Review",   color: "#F59E0B" },
      { name: "Shipped",     color: "#10B981" },
    ],
    swimlane: null,
  },
  {
    key: "hiring_pipeline",
    name: "Hiring Pipeline",
    description: "Candidate tracking per open role",
    columns: [
      { name: "Applied",      color: "#6B7280" },
      { name: "Phone Screen", color: "#3B82F6" },
      { name: "Interview",    color: "#F59E0B" },
      { name: "Offer Sent",   color: "#8B5CF6" },
      { name: "Hired",        color: "#10B981" },
    ],
    swimlane: "New Role",
  },
  {
    key: "customer_onboarding",
    name: "Customer Onboarding",
    description: "Post-sale implementation tracking per account",
    columns: [
      { name: "Signed",         color: "#3B82F6" },
      { name: "Kickoff",        color: "#8B5CF6" },
      { name: "Implementation", color: "#F59E0B" },
      { name: "Training",       color: "#F97316" },
      { name: "Go Live",        color: "#EF4444" },
      { name: "Complete",       color: "#10B981" },
    ],
    swimlane: "New Customer",
  },
  {
    key: "content_pipeline",
    name: "Content Pipeline",
    description: "Editorial workflow per author or channel",
    columns: [
      { name: "Ideas",     color: "#8B5CF6" },
      { name: "Drafting",  color: "#3B82F6" },
      { name: "Review",    color: "#F59E0B" },
      { name: "Approved",  color: "#10B981" },
      { name: "Scheduled", color: "#F97316" },
      { name: "Published", color: "#6B7280" },
    ],
    swimlane: "New Author",
  },
  {
    key: "blank",
    name: "Blank Board",
    description: "Start empty and add columns and swimlanes yourself",
    columns: [],
    swimlane: null,
  },
];

// Icons per template — simple SVG paths kept inline to avoid a dependency
const ICONS: Record<string, React.ReactNode> = {
  simple_kanban: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <rect x="3" y="3" width="5" height="18" rx="1" />
      <rect x="10" y="3" width="5" height="13" rx="1" />
      <rect x="17" y="3" width="5" height="9" rx="1" />
    </svg>
  ),
  sales_pipeline: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M2 17l5-5 4 4 5-6 4-4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="21" cy="6" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  bug_tracker: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M12 8a4 4 0 100 8 4 4 0 000-8z" />
      <path d="M12 2v2M4.22 4.22l1.42 1.42M2 12h2M4.22 19.78l1.42-1.42M12 20v2M19.78 19.78l-1.42-1.42M22 12h-2M19.78 4.22l-1.42 1.42" strokeLinecap="round" />
    </svg>
  ),
  product_roadmap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M3 12h4l3-8 4 16 3-8h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  hiring_pipeline: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" strokeLinecap="round" />
      <path d="M16 3.13a4 4 0 010 7.75" strokeLinecap="round" />
      <path d="M21 21v-2a4 4 0 00-3-3.87" strokeLinecap="round" />
    </svg>
  ),
  customer_onboarding: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M16 8a6 6 0 00-8 8" strokeLinecap="round" />
      <path d="M18 10a8 8 0 00-12 8" strokeLinecap="round" />
      <circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  content_pipeline: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  blank: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="4 2" />
      <path d="M12 8v8M8 12h8" strokeLinecap="round" />
    </svg>
  ),
};

interface Props {
  onConfirm: (name: string, template: string) => Promise<void>;
  onCancel: () => void;
}

export default function CreateBoardModal({ onConfirm, onCancel }: Props) {
  const [name, setName] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("simple_kanban");
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Close on backdrop click
  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCancel();
  };

  const handleSubmit = async () => {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(name.trim(), selectedTemplate);
    } finally {
      setSubmitting(false);
    }
  };

  const selected = TEMPLATES.find((t) => t.key === selectedTemplate)!;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={handleBackdrop}
    >
      <div className="bg-gray-900 rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-800">
          <h2 className="text-white text-lg font-semibold">New Board</h2>
          <p className="text-gray-400 text-sm mt-0.5">Choose a template, then name your board.</p>
        </div>

        {/* Body — scrollable */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

          {/* Name input */}
          <div>
            <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-1.5">
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
              className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 text-white rounded-xl px-4 py-2.5 outline-none text-sm placeholder-gray-500 transition"
            />
          </div>

          {/* Template picker */}
          <div>
            <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
              Template
            </label>
            <div className="grid grid-cols-2 gap-2.5">
              {TEMPLATES.map((t) => {
                const isSelected = t.key === selectedTemplate;
                return (
                  <button
                    key={t.key}
                    onClick={() => setSelectedTemplate(t.key)}
                    className={[
                      "text-left rounded-xl p-3.5 border transition-all",
                      isSelected
                        ? "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/40"
                        : "border-gray-700 bg-gray-800 hover:border-gray-500 hover:bg-gray-750",
                    ].join(" ")}
                  >
                    {/* Icon + name row */}
                    <div className="flex items-center gap-2 mb-1">
                      <span className={isSelected ? "text-blue-400" : "text-gray-400"}>
                        {ICONS[t.key]}
                      </span>
                      <span className="text-white text-sm font-medium leading-tight">{t.name}</span>
                    </div>

                    {/* Description */}
                    <p className="text-gray-400 text-xs leading-snug mb-2.5">{t.description}</p>

                    {/* Column preview dots */}
                    {t.columns.length > 0 ? (
                      <div className="flex items-center gap-1 flex-wrap">
                        {t.columns.map((col) => (
                          <span
                            key={col.name}
                            title={col.name}
                            className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: col.color }}
                          />
                        ))}
                      </div>
                    ) : (
                      <span className="text-gray-600 text-xs">No columns</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Preview strip for selected template */}
          {selected.columns.length > 0 && (
            <div className="bg-gray-800 rounded-xl px-4 py-3">
              <p className="text-gray-500 text-xs mb-2 uppercase tracking-wide">Columns created</p>
              <div className="flex gap-2 flex-wrap">
                {selected.columns.map((col) => (
                  <span
                    key={col.name}
                    className="inline-flex items-center gap-1.5 text-xs text-white bg-gray-700 rounded-lg px-2.5 py-1"
                  >
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: col.color }}
                    />
                    {col.name}
                  </span>
                ))}
              </div>
              {selected.swimlane && (
                <p className="text-gray-500 text-xs mt-2">
                  Default swimlane: <span className="text-gray-300">{selected.swimlane}</span>
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            className="text-gray-400 text-sm hover:text-white px-3 py-1.5 transition"
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
