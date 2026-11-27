import type { Card, LaneTier } from "../types";
import type { CustomFieldFilterValue, FilterState } from "../components/Board/FilterBar";
import { parseMultiSelect } from "./customFieldValue";
import {
  LANE_BUILTIN_FIELDS,
  LANE_FILTER_MAX_VALUES,
  isLaneBuiltinField,
  laneValueLabel,
  nextLaneItemId,
  withLaneItems,
  type FieldLike,
  type LaneFieldKey,
  type LaneFilterLane,
  type LaneRule,
} from "./laneFilter";
import { isRuleFieldType, ruleValues, withRuleValues, type FieldRule } from "./fieldRules";

/**
 * Field-name and value search for the Filter panel (#2437). Pure and client-side
 * over the loaded board: no API change, because every reader already receives every
 * swimlane field definition and the server drops only the admin-only lane VALUES.
 *
 * Admin-only lane fields never leak: lane fields are re-checked here against
 * `isAdmin` (an absent role is a non-admin, #1075) on top of the caller passing
 * `laneFilterFields(defs, isAdmin)`, and a hit's value is only read for a field that
 * survives that check. Every field is searchable whatever its band tier (#2439); the
 * tier only decorates a lane value hit ("hidden on band").
 */

export type FieldScope = "card" | "lane";
export type SearchScope = "all" | FieldScope;

/** A card field (custom field definition) as the search needs it. */
export interface CardFieldLike {
  id: number;
  name: string;
  field_type: string;
  choices?: string[];
}

/** A lane field: a swimlane custom field or a built-in (Lane name, Health, Contact email). */
export type LaneFieldLike = FieldLike & { choices?: string[] };

export interface SearchContext {
  cardFields: readonly CardFieldLike[];
  /** Pass `laneFilterFields(defs, isAdmin)`, never the raw definitions. */
  laneFields: readonly LaneFieldLike[];
  cards: readonly Pick<Card, "custom_field_values">[];
  lanes: readonly LaneFilterLane[];
  /** Absent reads as non-admin. */
  isAdmin?: boolean;
  /** `resolveLaneTiers(defs, cap)`; a field with no entry (a built-in) is not hidden. */
  tiers?: ReadonlyMap<number, LaneTier>;
  /** Display text of a stored value (dates, numbers); defaults to the raw text. */
  format?: (scope: FieldScope, field: { id: LaneFieldKey; field_type: string }, raw: string) => string;
}

export interface NameHit {
  kind: "name";
  scope: FieldScope;
  fieldId: LaneFieldKey;
  name: string;
  fieldType: string;
  hiddenOnBand: boolean;
}

export interface ValueHit {
  kind: "value";
  scope: FieldScope;
  fieldId: LaneFieldKey;
  fieldName: string;
  fieldType: string;
  /** The stored value the filter is built from. */
  raw: string;
  /** What the row reads. */
  label: string;
  /** Loaded cards (card scope) or lanes (lane scope) holding the value. */
  count: number;
  hiddenOnBand: boolean;
}

export interface SearchResult {
  names: NameHit[];
  values: ValueHit[];
  /** The text for the "Title contains" row, or null when it does not apply (lane scope, empty query). */
  titleQuery: string | null;
  /** The parsed `field:value` shorthand when it named a field, else null (the colon is then plain text). */
  shorthand: { field: string; value: string } | null;
}

/** At most this many value rows per field, and in total, so a text field with 500 values stays scannable. */
export const MAX_VALUES_PER_FIELD = 5;
export const MAX_VALUE_HITS = 12;

/** Case-insensitive match range of `q` in `text`, or null. The one matcher, so highlight and hit never disagree. */
export function matchRange(text: string, q: string): [number, number] | null {
  const needle = q.trim().toLowerCase();
  if (!needle) return null;
  const at = text.toLowerCase().indexOf(needle);
  return at < 0 ? null : [at, at + needle.length];
}

/**
 * Split `field:value` (e.g. `tier:gold`). Null when there is no usable shorthand: no colon,
 * or an empty field part. The value part may be empty ("tier:" lists that field's values).
 */
export function parseShorthand(query: string): { field: string; value: string } | null {
  const at = query.indexOf(":");
  if (at <= 0) return null;
  const field = query.slice(0, at).trim();
  if (!field) return null;
  return { field, value: query.slice(at + 1).trim() };
}

interface Candidate {
  scope: FieldScope;
  id: LaneFieldKey;
  name: string;
  type: string;
  choices: string[];
  hidden: boolean;
}

function candidates(ctx: SearchContext, scope: SearchScope): Candidate[] {
  const out: Candidate[] = [];
  if (scope !== "lane") {
    for (const f of ctx.cardFields) out.push({ scope: "card", id: f.id, name: f.name, type: f.field_type, choices: f.choices ?? [], hidden: false });
  }
  if (scope !== "card") {
    for (const f of ctx.laneFields) {
      // Defense in depth for #1075: an absent or false role never sees an admin-only lane field.
      if (f.is_admin_only && ctx.isAdmin !== true) continue;
      if (!isRuleFieldType(f.field_type)) continue;
      const hidden = typeof f.id === "number" && ctx.tiers?.get(f.id) === "hidden";
      out.push({ scope: "lane", id: f.id, name: f.name, type: f.field_type, choices: f.choices ?? [], hidden });
    }
  }
  return out;
}

const display = (ctx: SearchContext, c: Candidate, raw: string): string => {
  if (c.type === "checkbox") return raw === "true" ? "Yes" : "No";
  if (c.scope === "lane" && isLaneBuiltinField(c.id)) {
    return laneValueLabel({ id: c.id, name: c.name, field_type: c.type, is_admin_only: false, position: 0 }, raw, (_f, r) => r);
  }
  return ctx.format ? ctx.format(c.scope, { id: c.id, field_type: c.type }, raw) : raw;
};

/** Stored values of one field across the loaded entities, with how many entities hold each. */
function tally(ctx: SearchContext, c: Candidate): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (v: string) => counts.set(v, (counts.get(v) ?? 0) + 1);
  const read = (stored: string | undefined) => {
    if (stored === undefined || stored === "") return;
    if (c.type === "multi_select") new Set(parseMultiSelect(stored)).forEach((element) => { bump(element); });
    else bump(c.type === "checkbox" ? (stored === "true" ? "true" : "false") : stored);
  };
  if (c.scope === "card") {
    for (const card of ctx.cards) read((card.custom_field_values ?? []).find((v) => v.field_definition === c.id)?.value);
    if (c.type === "checkbox") {
      // A card with no stored row reads as "false" (#1848), exactly as the filter treats it.
      const trues = counts.get("true") ?? 0;
      counts.set("false", ctx.cards.length - trues);
    }
  } else {
    const builtin = LANE_BUILTIN_FIELDS.find((b) => b.key === c.id);
    for (const lane of ctx.lanes) {
      read(builtin ? builtin.read(lane) : (lane.custom_field_values ?? []).find((v) => v.field_definition === c.id)?.value);
    }
  }
  return counts;
}

function valueHits(ctx: SearchContext, c: Candidate, q: string): ValueHit[] {
  const counts = tally(ctx, c);
  let raws: string[];
  if (c.type === "dropdown" || c.type === "enum" || c.type === "multi_select") {
    // Definition choices first (in their order), then any stored value the choices no longer list.
    raws = [...c.choices, ...[...counts.keys()].filter((k) => !c.choices.includes(k))];
  } else if (c.type === "checkbox") {
    raws = ["true", "false"];
  } else {
    raws = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  }
  const hits: ValueHit[] = [];
  for (const raw of raws) {
    const label = display(ctx, c, raw);
    // A date or number also matches its stored text, so "2026-11" finds a date shown as 11/20/2026.
    const hit = matchRange(label, q) !== null || ((c.type === "date" || c.type === "number") && matchRange(raw, q) !== null);
    if (!hit) continue;
    hits.push({ kind: "value", scope: c.scope, fieldId: c.id, fieldName: c.name, fieldType: c.type, raw, label, count: counts.get(raw) ?? 0, hiddenOnBand: c.hidden });
    if (hits.length >= MAX_VALUES_PER_FIELD) break;
  }
  return hits;
}

/**
 * Field-name hits and value hits for `query` in `scope`. An empty query returns nothing: the
 * panel then shows its per-field rows. With `field:value` the name part picks fields and the
 * value part picks values inside them; an empty value part returns that field as a name hit.
 */
export function searchFields(query: string, scope: SearchScope, ctx: SearchContext): SearchResult {
  const q = query.trim();
  const none: SearchResult = { names: [], values: [], titleQuery: null, shorthand: null };
  if (!q) return none;
  const fields = candidates(ctx, scope);
  const short = parseShorthand(q);
  if (short) {
    const named = fields.filter((c) => matchRange(c.name, short.field) !== null);
    if (named.length > 0) {
      if (!short.value) return { names: named.map((element) => toName(element)), values: [], titleQuery: null, shorthand: short };
      const values = named.flatMap((c) => valueHits(ctx, c, short.value)).slice(0, MAX_VALUE_HITS);
      return { names: [], values, titleQuery: null, shorthand: short };
    }
    // No field called that: fall through and treat the colon as ordinary text.
  }
  const names = fields.filter((c) => matchRange(c.name, q) !== null).map((element) => toName(element));
  const values = fields.flatMap((c) => valueHits(ctx, c, q)).slice(0, MAX_VALUE_HITS);
  return { names, values, titleQuery: scope === "lane" ? null : q, shorthand: null };
}

function toName(c: Candidate): NameHit {
  return { kind: "name", scope: c.scope, fieldId: c.id, name: c.name, fieldType: c.type, hiddenOnBand: c.hidden };
}

/**
 * The filter state after selecting a value hit. A card dropdown, checkbox or multi-select adds
 * to the field's existing values (selecting twice keeps one); a text, number or date field
 * replaces its value (the filter holds one). A lane value becomes one more `is` / `between`
 * rule joined with "and", skipped when an identical rule is already there.
 */
export function applyValueHit(filters: FilterState, hit: ValueHit): FilterState {
  if (hit.scope === "card") {
    const id = hit.fieldId as number;
    const prev = filters.customFields[id];
    let next: CustomFieldFilterValue;
    if (hit.fieldType === "multi_select") {
      const values = prev?.kind === "multi_choice" ? prev.values : [];
      next = { kind: "multi_choice", values: values.includes(hit.raw) ? values : [...values, hit.raw] };
    } else if (hit.fieldType === "dropdown" || hit.fieldType === "checkbox") {
      const values = prev?.kind === "choice" ? prev.values : [];
      next = { kind: "choice", values: values.includes(hit.raw) ? values : [...values, hit.raw] };
    } else if (hit.fieldType === "number") {
      next = { kind: "number", equals: hit.raw };
    } else if (hit.fieldType === "date") {
      next = { kind: "date", equals: hit.raw };
    } else {
      next = { kind: "text", query: hit.raw };
    }
    return { ...filters, customFields: { ...filters.customFields, [id]: next } };
  }
  const items = filters.laneFilter?.items ?? [];
  if (hit.fieldType === "multi_select") {
    // #2659 — an existing `is` rule on this field is an any-of list: add to it rather than
    // stacking an `and is X` rule that would narrow it.
    const existing = items.find((it): it is LaneRule => it.kind === "rule" && it.field === hit.fieldId && it.op === "is" && ruleValues(it).length > 0);
    if (existing) {
      const cur = ruleValues(existing);
      if (cur.includes(hit.raw) || cur.length >= LANE_FILTER_MAX_VALUES) return filters;
      const merged = items.map((it) => (it === existing ? { ...existing, ...withRuleValues([...cur, hit.raw]) } : it));
      return { ...filters, laneFilter: withLaneItems(filters.laneFilter, merged) };
    }
  }
  const rule: FieldRule<LaneFieldKey> =
    hit.fieldType === "number" || hit.fieldType === "date"
      ? { field: hit.fieldId, op: "between", min: hit.raw, max: hit.raw }
      : { field: hit.fieldId, op: "is", value: hit.raw };
  const dup = items.some(
    (it) => it.kind === "rule" && it.field === rule.field && it.op === rule.op && it.value === rule.value && it.min === rule.min && it.max === rule.max,
  );
  if (dup) return filters;
  const added: LaneRule = { kind: "rule", id: nextLaneItemId(filters.laneFilter), join: "and", ...rule };
  return { ...filters, laneFilter: withLaneItems(filters.laneFilter, [...items, added]) };
}
