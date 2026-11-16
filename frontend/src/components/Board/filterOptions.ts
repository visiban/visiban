// Filter option lists and custom-field filter helpers shared by FilterBar and
// FilterPanel (#2301). A module of their own so a test that mocks FilterBar
// does not take the panel's data with it.
import type { CustomFieldDefinition, Priority } from "../../types";
import { PRIORITY_COLORS } from "../../constants/colors";
import type { CustomFieldFilterValue, FilterState } from "./FilterBar";

export function isCustomFieldFilterActive(v: CustomFieldFilterValue): boolean {
  return v.kind === "choice" || v.kind === "multi_choice"
    ? v.values.length > 0
    : v.kind === "text" ? v.query !== "" : v.equals !== "";
}


export function emptyCustomFieldFilterValue(def: CustomFieldDefinition): CustomFieldFilterValue {
  switch (def.field_type) {
    case "number":
    case "date":
      return { kind: def.field_type, equals: "" };
    case "dropdown":
    case "checkbox":
      return { kind: "choice", values: [] };
    case "multi_select":
      return { kind: "multi_choice", values: [] };
    case "text":
    case "url": // #1390 — a URL is matched as text ("contains"), like a text field
    default:
      return { kind: "text", query: "" };
  }
}

export const PRIORITY_OPTIONS: { value: Priority; label: string; color: string }[] = [
  { value: "low", label: "Low", color: PRIORITY_COLORS.low },
  { value: "medium", label: "Medium", color: PRIORITY_COLORS.medium },
  { value: "high", label: "High", color: PRIORITY_COLORS.high },
  { value: "urgent", label: "Urgent", color: PRIORITY_COLORS.urgent },
];

export const DUE_DATE_OPTIONS: { value: NonNullable<FilterState["dueDate"]>; label: string }[] = [
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Today" },
  { value: "this_week", label: "Due this week" },
  { value: "none", label: "No due date" },
];

