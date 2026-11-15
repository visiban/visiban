import type { ReactNode } from "react";
import type { FlowFilters } from "../../../api/flowMetrics";
import SingleSelectDropdown from "../../Common/SingleSelectDropdown";
import ActiveMark from "../../Common/ActiveMark";
import type { Breakdown } from "./breakdown";
import { DEFAULT_DAYS, RANGES } from "./useAnalyticsFilters";

interface Props {
  filters: FlowFilters;
  onFiltersChange: (filters: FlowFilters) => void;
  swimlanes: { id: number; name: string }[];
  labels: { id: number; name: string }[];
  /** The Swimlanes view (#2267) has no Swimlane filter: it shows every swimlane. */
  showSwimlane?: boolean;
  /** "Break down by" (#2268); the Swimlanes view passes none, so it has no such control. */
  breakdown?: Breakdown;
  onBreakdownChange?: (breakdown: Breakdown) => void;
  /** The card fields a breakdown may use (dropdown and checkbox), in board order. */
  breakdownFields?: { id: number; name: string }[];
  /** Right-aligned page actions, such as Export CSV. */
  actions?: ReactNode;
}

/**
 * Region 3 (#2261): the one Period, Swimlane and Label selection that drives
 * every panel on the page. Dropdowns pass `portalMenu`: the page scrolls.
 */
export default function AnalyticsFilterBar({
  filters, onFiltersChange, swimlanes, labels, showSwimlane = true, actions,
  breakdown, onBreakdownChange, breakdownFields = [],
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0" role="group" aria-label="Filters">
      {/* The default is not an active filter: it keeps the neutral trigger. */}
      <SingleSelectDropdown
        label="Last 90 days"
        ariaLabel="Date range"
        options={RANGES}
        selected={filters.days === DEFAULT_DAYS ? null : filters.days}
        onChange={(value) => onFiltersChange({ ...filters, days: value ?? DEFAULT_DAYS })}
        portalMenu
      />
      {showSwimlane && (
        <SingleSelectDropdown
          label="All swimlanes"
          ariaLabel="Swimlane"
          options={swimlanes.map((s) => ({ value: s.id, label: s.name }))}
          selected={filters.swimlaneId}
          onChange={(swimlaneId) => onFiltersChange({ ...filters, swimlaneId })}
          portalMenu
        />
      )}
      <SingleSelectDropdown
        label="All labels"
        ariaLabel="Label"
        options={labels.map((l) => ({ value: l.id, label: l.name }))}
        selected={filters.labelId}
        onChange={(labelId) => onFiltersChange({ ...filters, labelId })}
        portalMenu
      />
      {breakdown && onBreakdownChange && (
        <BreakdownControl breakdown={breakdown} onChange={onBreakdownChange} fields={breakdownFields} />
      )}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** The segmented "Break down by" group: None, Swimlane, Label, then one entry per eligible card field. */
function BreakdownControl({ breakdown, onChange, fields }: {
  breakdown: Breakdown; onChange: (b: Breakdown) => void; fields: { id: number; name: string }[];
}) {
  const options: { label: string; value: Breakdown }[] = [
    { label: "None", value: { by: "none" } },
    { label: "Swimlane", value: { by: "swimlane" } },
    { label: "Label", value: { by: "label" } },
    ...fields.map((f) => ({ label: f.name, value: { by: "custom_field", fieldId: f.id, fieldName: f.name } as Breakdown })),
  ];
  const isActive = (v: Breakdown) =>
    v.by === breakdown.by && (v.by !== "custom_field" || (breakdown.by === "custom_field" && breakdown.fieldId === v.fieldId));
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <span id="breakdown-label" className="text-xs text-fg-tertiary">Break down by</span>
      <div role="group" aria-labelledby="breakdown-label" data-testid="breakdown-control" className="inline-flex flex-wrap rounded overflow-hidden border border-line-strong bg-surface">
        {options.map((o, i) => (
          <button
            key={o.value.by === "custom_field" ? `f${o.value.fieldId}` : o.value.by}
            type="button"
            // Names the control, so the Swimlane and Label filter dropdowns stay the only buttons of that name; it contains the visible text (label-in-name).
            aria-label={`Break down by ${o.label.toLowerCase()}`}
            aria-pressed={isActive(o.value)}
            onClick={() => onChange(o.value)}
            className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-inset ${
              i > 0 ? "border-l border-line-strong" : ""
            } ${isActive(o.value) ? "bg-primary text-on-primary font-semibold" : "text-fg-secondary hover:text-fg hover:bg-surface-hover"}`}
          >
            <ActiveMark active={isActive(o.value)} />
            <span className="truncate max-w-[10rem]">{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
