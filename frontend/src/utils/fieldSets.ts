/**
 * Field set grouping for the card detail (#2570). Pure functions so the rules
 * the ux-design note fixes (what counts toward progress, when an out-of-lane
 * set still shows, chip order) are pinned by unit tests, not by a component.
 */
import type { CustomFieldDefinition, CustomFieldSet, CustomFieldValue, FieldSetSize } from "../types";
import { parseMultiSelect } from "./customFieldValue";

/** Storage key for the ungrouped "Other fields" block. */
export const OTHER_FIELDS_KEY = "_other";

export interface CardFieldBlock {
  /** The set's uid, or `OTHER_FIELDS_KEY`. Stable across renames. */
  key: string;
  set: CustomFieldSet | null;
  name: string;
  definitions: CustomFieldDefinition[];
  /** The set is scoped away from the card's lane but holds a value here. */
  outOfLane: boolean;
}

/** Filled = not empty; a multi-select needs at least one pick. */
export function isValueFilled(definition: CustomFieldDefinition, value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (definition.field_type === "multi_select") return parseMultiSelect(value).length > 0;
  return true;
}

/**
 * Checkbox fields never count ("missing" must never mean "No"), and neither
 * do dimension fields, whose state is a resolution rather than a fill.
 */
export function countsTowardProgress(definition: CustomFieldDefinition): boolean {
  return definition.field_type !== "checkbox" && !definition.is_dimension;
}

export function valueOf(values: CustomFieldValue[], definitionId: number): string | undefined {
  return values.find((v) => v.field_definition === definitionId)?.value;
}

export function blockProgress(definitions: CustomFieldDefinition[], values: CustomFieldValue[]): { filled: number; total: number } {
  const counted = definitions.filter((d) => countsTowardProgress(d));
  return {
    filled: counted.filter((d) => isValueFilled(d, valueOf(values, d.id))).length,
    total: counted.length,
  };
}

/**
 * The blocks one card shows, in set position order, Other fields last.
 * A set with no fields is omitted. A lane-scoped set the card's lane is not in
 * is omitted too, unless one of its fields holds a value on this card: then it
 * shows (collapsed, by the caller) so a stored value is never hidden.
 */
export function buildCardBlocks(
  definitions: CustomFieldDefinition[],
  sets: CustomFieldSet[],
  swimlaneId: number | null,
  values: CustomFieldValue[],
): CardFieldBlock[] {
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const grouped = new Set<number>();
  const blocks: CardFieldBlock[] = [];
  for (const set of [...sets].sort((a, b) => a.position - b.position || a.id - b.id)) {
    const defs = set.field_ids
      .map((id) => byId.get(id))
      .filter((d): d is CustomFieldDefinition => d !== undefined)
      .sort((a, b) => a.position - b.position);
    defs.forEach((d) => grouped.add(d.id));
    if (defs.length === 0) continue;
    const inLane = set.scope === "all" || (swimlaneId !== null && set.swimlanes.includes(swimlaneId));
    if (!inLane && !defs.some((d) => isValueFilled(d, valueOf(values, d.id)))) continue;
    blocks.push({ key: set.uid, set, name: set.name, definitions: defs, outOfLane: !inLane });
  }
  const other = definitions.filter((d) => !grouped.has(d.id)).sort((a, b) => a.position - b.position);
  if (other.length > 0) {
    blocks.push({ key: OTHER_FIELDS_KEY, set: null, name: "Other fields", definitions: other, outOfLane: false });
  }
  return blocks;
}

/** The size a block opens at with no viewer override. */
export function defaultSize(block: CardFieldBlock): FieldSetSize {
  if (block.outOfLane) return "collapsed";
  return block.set?.default_size ?? "expanded";
}

export interface SummaryChip {
  definition: CustomFieldDefinition;
  missing: boolean;
}

/** Summary chips: missing fields first, then the rest, each in field order. */
export function summaryChips(definitions: CustomFieldDefinition[], values: CustomFieldValue[]): SummaryChip[] {
  const chips = definitions.map((definition) => ({
    definition,
    missing: countsTowardProgress(definition) && !isValueFilled(definition, valueOf(values, definition.id)),
  }));
  return [...chips.filter((c) => c.missing), ...chips.filter((c) => !c.missing)];
}

/**
 * How many whole chips fit in `available` px, reserving `reserve` px for the
 * "+N" button whenever not every chip fits. Chips never shrink.
 */
export function chipsThatFit(widths: number[], available: number, reserve: number, gap: number): number {
  const total = widths.reduce((sum, w, i) => sum + w + (i > 0 ? gap : 0), 0);
  if (total <= available) return widths.length;
  let used = 0;
  let count = 0;
  for (const w of widths) {
    const next = used + (count > 0 ? gap : 0) + w;
    if (next + gap + reserve > available) break;
    used = next;
    count += 1;
  }
  return count;
}
