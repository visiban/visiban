import type { FlowGroupingParams } from "../../../api/flowMetrics";
import type { CustomFieldDefinition, FlowGroupBase, FlowGrouping } from "../../../types";
import { ISOLATED_OPACITY, groupColor } from "../../../utils/chartScale";

/**
 * The Overview's "Break down by" choice (#2268). `field` is the card custom
 * field for `custom_field`. Kept in the Overview, not the shared filters: the
 * Swimlanes view has no breakdown.
 */
export type Breakdown =
  | { by: "none" }
  | { by: "swimlane" }
  | { by: "label" }
  | { by: "custom_field"; fieldId: number; fieldName: string };

export const NO_BREAKDOWN: Breakdown = { by: "none" };

/** The request parameters, or undefined for None (the page is then exactly as before). */
export function breakdownParams(breakdown: Breakdown): FlowGroupingParams | undefined {
  if (breakdown.by === "none") return undefined;
  if (breakdown.by === "custom_field") return { by: "custom_field", fieldId: breakdown.fieldId };
  return { by: breakdown.by };
}

export const breakdownKey = (b: Breakdown) => (b.by === "custom_field" ? `custom_field:${b.fieldId}` : b.by);

/** Card fields a breakdown can use: dropdown and checkbox only, in board order. */
export function breakdownFields<T extends Pick<CustomFieldDefinition, "field_type" | "position">>(defs: readonly T[]): T[] {
  return defs
    .filter((d) => d.field_type === "dropdown" || d.field_type === "checkbox")
    .sort((a, b) => a.position - b.position);
}

/** What the color means, as a noun phrase: "swimlane", "label" or the field's name. */
export function breakdownNoun(grouping: Pick<FlowGrouping<FlowGroupBase>, "by" | "field_id">, fieldName?: string): string {
  if (grouping.by === "custom_field") return fieldName ?? "field";
  return grouping.by;
}

/** A group's visible name: checkbox values read Yes / No, the collapsed rest reads Other. */
export function groupName(group: FlowGroupBase): string {
  if (group.key === null) return "Other";
  if (group.name !== null) return group.name;
  return group.key === "true" ? "Yes" : group.key === "false" ? "No" : group.key;
}

/** The index of the first group holding any of `keys`, or -1. Other holds every collapsed key. */
export function groupIndexOf(groups: readonly FlowGroupBase[], keys: readonly string[] | undefined): number {
  if (!keys || keys.length === 0) return -1;
  return groups.findIndex((g) => g.member_keys.some((k) => keys.includes(k)));
}

/** Whether the group at `index` holds any of `keys` (a labeled card is in each of its groups). */
export const inGroup = (groups: readonly FlowGroupBase[], index: number, keys: readonly string[] | undefined) =>
  !!keys && groups[index]?.member_keys.some((k) => keys.includes(k)) === true;

export const colorOfGroup = (groups: readonly FlowGroupBase[], index: number) =>
  groupColor(index, groups[index]?.key === null);

/** The mark color for a card in `groups`, or null when it belongs to none. */
export function cardGroupColor(groups: readonly FlowGroupBase[], keys: readonly string[] | undefined, isolated: number | null = null): string | null {
  // A card in several groups (labels) takes the isolated group's color, so its mark agrees with the selected chip.
  const index = isolated !== null && inGroup(groups, isolated, keys) ? isolated : groupIndexOf(groups, keys);
  return index < 0 ? null : colorOfGroup(groups, index);
}

/** Opacity of a mark when one group is isolated: full for its members, 20% for the rest. */
export function markOpacity(groups: readonly FlowGroupBase[], isolated: number | null, keys: readonly string[] | undefined): number {
  if (isolated === null) return 1;
  return inGroup(groups, isolated, keys) ? 1 : ISOLATED_OPACITY;
}

/** The `opacity` attribute for a mark: absent unless a group is isolated, so None (and no isolation) renders the pre-breakdown DOM. */
export function markOpacityAttr(groups: readonly FlowGroupBase[], isolated: number | null, keys: readonly string[] | undefined): number | undefined {
  return isolated === null ? undefined : markOpacity(groups, isolated, keys);
}

/** The legend note for what a breakdown leaves out or double counts. */
export function breakdownNote(by: Breakdown["by"]): string | null {
  if (by === "label") return "A card with several labels is counted once in each.";
  if (by === "custom_field") return "Cards with no value for this field are left out.";
  return null;
}

/** The names of every group holding any of `keys`, in group order; empty when the card is in none. */
export function groupNamesOf(groups: readonly FlowGroupBase[], keys: readonly string[] | undefined): string[] {
  if (!keys || keys.length === 0) return [];
  return groups.filter((g) => g.member_keys.some((k) => keys.includes(k))).map((element) => groupName(element));
}
