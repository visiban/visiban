import type { ReactNode } from "react";
import type { FlowFilters } from "../../../api/flowMetrics";
import SingleSelectDropdown from "../../Common/SingleSelectDropdown";
import { DEFAULT_DAYS, RANGES } from "./useAnalyticsFilters";

interface Props {
  filters: FlowFilters;
  onFiltersChange: (filters: FlowFilters) => void;
  swimlanes: { id: number; name: string }[];
  labels: { id: number; name: string }[];
  /** The Swimlanes view (#2267) has no Swimlane filter: it shows every swimlane. */
  showSwimlane?: boolean;
  /** Right-aligned page actions, such as Export CSV. */
  actions?: ReactNode;
}

/**
 * Region 3 (#2261): the one Period, Swimlane and Label selection that drives
 * every panel on the page. Dropdowns pass `portalMenu`: the page scrolls.
 */
export default function AnalyticsFilterBar({
  filters, onFiltersChange, swimlanes, labels, showSwimlane = true, actions,
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
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
