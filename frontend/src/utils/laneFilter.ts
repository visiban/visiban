/**
 * Lane filters (#2205): hide swimlanes by their own custom field values.
 *
 * The state is a flat list of items, each a rule or a one-level group of
 * rules, and each carrying its own join to the previous item. Evaluation and
 * the "Reads as" text both come from the generic evaluator in fieldRules.ts,
 * so what the popover says and what the board shows can never disagree.
 *
 * Dropdown, number, date, text and url swimlane fields can be ruled on
 * (text and url since #2226). Admin-only fields are offered to admins only: their values are never sent
 * to other roles, so a rule on one would hide every lane for a member.
 *
 * Two built-in fields (#2336) sit alongside them: the lane's name (everyone)
 * and its contact email (admins only, for the same reason: `contact_email`
 * is never sent to other roles). A rule names a built-in by its string key
 * instead of a numeric id, so an older client's parser drops it rather than
 * misapplying it.
 */
import type { Swimlane } from "../types";
import { HEALTH_STATUS_LABELS, HEALTH_STATUS_VALUES } from "../constants/healthStatus";
import {
  evalChain,
  isRuleComplete,
  isPresenceOp,
  isRuleFieldType,
  isTextRuleType,
  matchRule,
  normalizeDate,
  normalizeNumber,
  opsForFieldType,
  ruleText,
  textChain,
  withRuleValues,
  type FieldRule,
  type FieldRuleJoin,
  type FieldRuleOp,
  type RuleFieldType,
} from "./fieldRules";

/** Built-in swimlane fields a rule can target (#2336). */
export type LaneBuiltinField = "name" | "contact_email" | "health_status";
/** A rule's field: a swimlane custom field id or a built-in field. */
export type LaneFieldKey = number | LaneBuiltinField;

export interface LaneRule extends FieldRule<LaneFieldKey> {
  kind: "rule";
  /** Stable per-filter id (React key, focus target); not semantic. */
  id: number;
  /** Join to the previous rule; ignored on the first one. */
  join: FieldRuleJoin;
}

export interface LaneGroup {
  kind: "group";
  id: number;
  join: FieldRuleJoin;
  rules: LaneRule[];
}

export type LaneFilterItem = LaneRule | LaneGroup;

export interface LaneFilter {
  items: LaneFilterItem[];
  /**
   * #2214 — while a card filter or Show chip is active, also hide lanes with
   * no matching card. Off by default and absent when off. It is a setting on
   * the lane filter, not a rule: it never counts as an active lane filter, and
   * a filter holding only this flag keeps `items: []` so the flag survives
   * clearing the rules. An older client drops the key and keeps the rules.
   */
  hideUnmatched?: boolean;
}

/**
 * A lane filter with these items, keeping `f`'s hideUnmatched (#2214).
 * Undefined when there is nothing left (no items and the flag off), so every
 * "rules changed" path keeps the flag without special-casing it.
 */
export function withLaneItems(f: LaneFilter | undefined, items: LaneFilterItem[]): LaneFilter | undefined {
  if (f?.hideUnmatched === true) return { items, hideUnmatched: true };
  return items.length > 0 ? { items } : undefined;
}

/** Turn hideUnmatched (#2214) on or off, keeping the rules. */
export function withHideUnmatched(f: LaneFilter | undefined, on: boolean): LaneFilter | undefined {
  const items = f?.items ?? [];
  if (on) return { items, hideUnmatched: true };
  return items.length > 0 ? { items } : undefined;
}

/** Bounds shared with SavedFilterSerializer (backend/boards/serializers.py). */
export const LANE_FILTER_MAX_ITEMS = 20;
export const LANE_FILTER_MAX_RULES = 50;
export const LANE_FILTER_MAX_STRING = 500;
export const LANE_FILTER_MAX_ID = 2 ** 31 - 1;
/**
 * #2659 — most values one multi-select rule may hold (SavedFilterSerializer._LANE_MAX_VALUES):
 * the most choices a multi-select field may have, so ticking every choice always saves.
 */
export const LANE_FILTER_MAX_VALUES = 100;

// An op this client does not know (a newer client's, say) drops the whole
// rule in parseRule, so it can never filter with semantics it cannot apply.
export const LANE_FILTER_OPS: readonly FieldRuleOp[] = ["is", "is_not", "between", "contains", "not_contains", "wildcard", "is_set", "is_empty"];

/** A field a lane rule can target: a custom field definition or a built-in. */
export interface FieldLike {
  id: LaneFieldKey;
  name: string;
  field_type: string;
  is_admin_only: boolean;
  position: number;
}

/** A built-in field modeled as a synthetic field definition (#2336, #2247). */
export interface LaneBuiltinFieldDef extends FieldLike {
  id: LaneBuiltinField;
  field_type: "text" | "enum";
  /** Empty for a text built-in; the stored values of an enum built-in. */
  choices: string[];
}

/** One entry of the built-in lane attribute registry (#2247). */
export interface LaneBuiltinSpec {
  key: LaneBuiltinField;
  name: string;
  field_type: "text" | "enum";
  is_admin_only: boolean;
  /** Stored values of an enum built-in, in menu order. */
  choices?: readonly string[];
  /** Display label of one enum value. */
  choiceLabel?: (value: string) => string;
  /**
   * The raw value a lane carries for this field, undefined when it has none.
   * The one place a built-in's source is named, so evaluation, the value
   * choices and the picker never special-case a field.
   */
  read: (lane: LaneFilterLane) => string | undefined;
}

/**
 * Built-in fields, in picker order. Contact email is admin-only exactly like
 * an `is_admin_only` custom field: the value is never sent to other roles.
 * Health (#2247) reads the lane's pin, else its effective (computed) status
 * (#2245), in the same order as laneHealthFields: the status the lane header
 * shows, so the filter and the pill never disagree. A lane with no status has no value and matches
 * "is empty".
 */
export const LANE_BUILTIN_FIELDS: readonly LaneBuiltinSpec[] = [
  { key: "name", name: "Lane name", field_type: "text", is_admin_only: false, read: (l) => (typeof l.name === "string" ? l.name : undefined) },
  {
    key: "contact_email",
    name: "Contact email",
    field_type: "text",
    is_admin_only: true,
    read: (l) => (typeof l.contact_email === "string" ? l.contact_email : undefined),
  },
  {
    key: "health_status",
    name: "Health",
    field_type: "enum",
    is_admin_only: false,
    choices: HEALTH_STATUS_VALUES,
    choiceLabel: (v) => (HEALTH_STATUS_LABELS as Record<string, string>)[v] ?? v,
    read: (l) => l.health_status ?? l.effective_health_status ?? undefined,
  },
];

const BUILTIN_KEYS: readonly string[] = LANE_BUILTIN_FIELDS.map((b) => b.key);

/** Display text of a rule value: an enum built-in's label, else the shared formatter. */
export function laneValueLabel(field: FieldLike, raw: string, fmt: LaneValueFormatter): string {
  const spec = LANE_BUILTIN_FIELDS.find((b) => b.key === field.id);
  return spec?.choiceLabel ? spec.choiceLabel(raw) : fmt(field, raw);
}

export function isLaneBuiltinField(v: unknown): v is LaneBuiltinField {
  return typeof v === "string" && BUILTIN_KEYS.includes(v);
}

/**
 * The fields this viewer can rule on: the built-ins first, then the swimlane
 * custom fields in board order. A custom field named like a built-in keeps its
 * name; the built-in reads "Lane name (built-in)" instead, set here once so
 * the picker, chips and "Reads as" all agree.
 */
export function laneFilterFields<T extends FieldLike>(defs: readonly T[], isAdmin: boolean | undefined): (T | LaneBuiltinFieldDef)[] {
  const custom = defs
    .filter((d) => isRuleFieldType(d.field_type) && (isAdmin || !d.is_admin_only))
    .sort((a, b) => a.position - b.position);
  const taken = new Set(custom.map((d) => d.name.trim().toLowerCase()));
  const builtins: LaneBuiltinFieldDef[] = LANE_BUILTIN_FIELDS.filter((b) => isAdmin || !b.is_admin_only).map((b, i) => ({
    id: b.key,
    name: taken.has(b.name.toLowerCase()) ? `${b.name} (built-in)` : b.name,
    field_type: b.field_type,
    is_admin_only: b.is_admin_only,
    position: i - LANE_BUILTIN_FIELDS.length,
    choices: [...(b.choices ?? [])],
  }));
  return [...builtins, ...custom];
}

/**
 * Whether the Lanes trigger is offered (#2336). With the built-ins there is
 * always a field to rule on, so the gate is "something worth filtering": a
 * custom field, two or more lanes, or a filter already set (so it can be
 * cleared). Shared by FilterBar and FilterPanel so they cannot disagree.
 */
export function laneFilterAvailable(customLaneFieldCount: number, laneCount: number, filter: LaneFilter | undefined): boolean {
  // A filter holding only hideUnmatched (#2214) still needs its control, to turn it off.
  return customLaneFieldCount > 0 || laneCount >= 2 || (filter?.items.length ?? 0) > 0 || filter?.hideUnmatched === true;
}

function typeMap(fields: readonly FieldLike[]): Map<LaneFieldKey, RuleFieldType> {
  return new Map(fields.filter((f) => isRuleFieldType(f.field_type)).map((f) => [f.id, f.field_type as RuleFieldType]));
}

// ---------------------------------------------------------------------------
// Defensive parsing (localStorage, saved filters, URL)
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length <= LANE_FILTER_MAX_STRING && !v.includes("\u0000") ? v : undefined;
}

function validId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= LANE_FILTER_MAX_ID;
}

/**
 * Parse an untrusted value into a LaneFilter. Malformed entries are dropped
 * rather than failing the whole load, matching the per-field defensive reads
 * elsewhere in the filter state. Returns undefined when nothing survives.
 */
export function sanitizeLaneFilter(raw: unknown): LaneFilter | undefined {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { items?: unknown }).items)) return undefined;
  const seen = new Set<number>();
  let nextId = 1;
  let ruleBudget = LANE_FILTER_MAX_RULES;
  const takeId = (v: unknown): number => {
    if (validId(v) && !seen.has(v)) {
      seen.add(v);
      return v;
    }
    while (seen.has(nextId)) nextId++;
    seen.add(nextId);
    return nextId;
  };
  const parseRule = (r: unknown): LaneRule | null => {
    if (typeof r !== "object" || r === null || ruleBudget <= 0) return null;
    const o = r as Record<string, unknown>;
    if (o.kind !== undefined && o.kind !== "rule") return null;
    const op = typeof o.op === "string" && (LANE_FILTER_OPS as readonly string[]).includes(o.op) ? (o.op as FieldRuleOp) : null;
    if (!op) return null;
    const field =
      o.field === null || o.field === undefined ? null : validId(o.field) || isLaneBuiltinField(o.field) ? o.field : undefined;
    if (field === undefined) return null;
    // The server rejects a presence op on any field but an enum built-in, and
    // an enum built-in value outside its choices; drop those, never send them.
    const choices = isLaneBuiltinField(field) ? LANE_BUILTIN_FIELDS.find((b) => b.key === field)?.choices : undefined;
    if (isPresenceOp(op) && !choices) return null;
    if (choices && !isPresenceOp(op) && typeof o.value === "string" && o.value !== "" && !choices.includes(o.value)) return null;
    // #2659 — several values belong to a multi-select is / is not rule on a
    // custom field only, bounded like the server, with no range bounds. Any
    // other `values` is a shape this client cannot apply: drop the rule.
    let values: string[] | undefined;
    if (o.values !== undefined) {
      const ok =
        Array.isArray(o.values) &&
        o.values.length > 0 &&
        o.values.length <= LANE_FILTER_MAX_VALUES &&
        o.values.every((v) => str(v) !== undefined && v !== "") &&
        (op === "is" || op === "is_not") &&
        validId(field) &&
        o.min === undefined &&
        o.max === undefined;
      if (!ok) return null;
      values = o.values as string[];
    }
    ruleBudget--;
    const rule: LaneRule = { kind: "rule", id: takeId(o.id), join: o.join === "or" ? "or" : "and", field, op };
    const value = str(o.value);
    const min = str(o.min);
    const max = str(o.max);
    if (isPresenceOp(op)) return rule; // is set / is empty carry no operand
    if (values) {
      // One value reads back as `value`, the shape every client knows.
      const operand = withRuleValues(values);
      if (operand.values) rule.values = operand.values;
      else rule.value = operand.value;
      return rule;
    }
    if (op === "contains" || op === "not_contains" || op === "wildcard") {
      // The server accepts these only with a string value and no range
      // bounds. The compact URL form drops an empty value, so restore it.
      rule.value = value ?? "";
      return rule;
    }
    if (isLaneBuiltinField(field)) {
      // Built-ins are text-only: the server rejects range bounds on them.
      if (value !== undefined) rule.value = value;
      return rule;
    }
    if (value !== undefined) rule.value = value;
    if (min !== undefined) rule.min = min;
    if (max !== undefined) rule.max = max;
    return rule;
  };
  const items: LaneFilterItem[] = [];
  for (const it of (raw as { items: unknown[] }).items.slice(0, LANE_FILTER_MAX_ITEMS)) {
    if (typeof it !== "object" || it === null) continue;
    const o = it as Record<string, unknown>;
    if (o.kind === "group") {
      if (!Array.isArray(o.rules)) continue;
      const rules = o.rules.map((element) => parseRule(element)).filter((r): r is LaneRule => r !== null);
      if (rules.length === 0) continue;
      items.push({ kind: "group", id: takeId(o.id), join: o.join === "or" ? "or" : "and", rules });
    } else {
      const rule = parseRule(o);
      if (rule) items.push(rule);
    }
  }
  // #2214 — strictly true; anything else reads as off.
  return withLaneItems((raw as { hideUnmatched?: unknown }).hideUnmatched === true ? { items: [], hideUnmatched: true } : undefined, items);
}

// URL form: `f_lanes=1.<compact JSON>`. The leading version lets a later
// shape change keep reading old links. Compact keys keep shared links short.
// `vs` (#2659) carries a multi-select rule's several values; an older client ignores it.
interface CompactRule { j?: "o"; f: LaneFieldKey | null; o: FieldRuleOp; v?: string; vs?: string[]; a?: string; b?: string }
interface CompactGroup { j?: "o"; g: CompactRule[] }

function toCompactRule(r: LaneRule): CompactRule {
  const c: CompactRule = { f: r.field, o: r.op };
  if (r.join === "or") c.j = "o";
  if (r.value) c.v = r.value;
  if (r.values && r.values.length > 0) c.vs = r.values;
  if (r.min) c.a = r.min;
  if (r.max) c.b = r.max;
  return c;
}

function fromCompactRule(c: unknown): unknown {
  if (typeof c !== "object" || c === null) return null;
  const o = c as Record<string, unknown>;
  return { kind: "rule", join: o.j === "o" ? "or" : "and", field: o.f, op: o.o, value: o.v, values: o.vs, min: o.a, max: o.b };
}

export function serializeLaneFilterParam(f: LaneFilter | undefined): string | null {
  if (!f || f.items.length === 0) return null;
  const items: (CompactRule | CompactGroup)[] = f.items.map((it) => {
    if (it.kind === "rule") return toCompactRule(it);
    const g: CompactGroup = { g: it.rules.map((element) => toCompactRule(element)) };
    if (it.join === "or") g.j = "o";
    return g;
  });
  return `1.${JSON.stringify(items)}`;
}

/** Parse `f_lanes`; anything unrecognized reads as no lane filter. */
export function parseLaneFilterParam(param: string | null): LaneFilter | undefined {
  if (!param || !param.startsWith("1.") || param.length > 20000) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(param.slice(2));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const items = parsed.map((it) => {
    if (typeof it === "object" && it !== null && Array.isArray((it as { g?: unknown }).g)) {
      const o = it as { j?: unknown; g: unknown[] };
      return { kind: "group", join: o.j === "o" ? "or" : "and", rules: o.g.map((element) => fromCompactRule(element)) };
    }
    return fromCompactRule(it);
  });
  return sanitizeLaneFilter({ items });
}

// ---------------------------------------------------------------------------
// Pruning against the viewer's fields
// ---------------------------------------------------------------------------

function pruneRule(r: LaneRule, types: Map<LaneFieldKey, RuleFieldType>): LaneRule | null {
  if (r.field === null) return r;
  const t = types.get(r.field);
  // A field this viewer may not rule on (deleted, unsupported, or admin-only
  // for a non-admin, Contact email included) is dropped. Inside an Or run
  // that narrows the result rather than widening it; the stored state is
  // left as is, so an admin's own filter comes back if they regain the role.
  if (!t || !opsForFieldType(t).includes(r.op)) return null;
  // #2659 — several values on a field that is no longer a multi-select (its type changed).
  if (r.values !== undefined && t !== "multi_select") return null;
  if (t === "dropdown" || t === "enum" || t === "checkbox" || t === "multi_select" || isTextRuleType(t)) return r;
  const norm = t === "number" ? normalizeNumber : normalizeDate;
  const badMin = !!r.min && norm(r.min) === null;
  const badMax = !!r.max && norm(r.max) === null;
  if (!badMin && !badMax) return r;
  return { ...r, ...(badMin ? { min: "" } : {}), ...(badMax ? { max: "" } : {}) };
}

/**
 * Drop rules on fields this viewer cannot rule on and blank unparsable range
 * bounds. Returns the same object when nothing changes, so callers can detect
 * a change by identity (same contract as pruneStaleFilters).
 */
export function pruneLaneFilter(f: LaneFilter | undefined, fields: readonly FieldLike[]): LaneFilter | undefined {
  if (!f) return f;
  const types = typeMap(fields);
  let changed = false;
  const items: LaneFilterItem[] = [];
  for (const it of f.items) {
    if (it.kind === "rule") {
      const r = pruneRule(it, types);
      if (r !== it) changed = true;
      if (r) items.push(r);
    } else {
      const rules = it.rules.map((r) => pruneRule(r, types)).filter((r): r is LaneRule => r !== null);
      if (rules.length !== it.rules.length || rules.some((r, i) => r !== it.rules[i])) changed = true;
      if (rules.length > 0) items.push(rules.length === it.rules.length && rules.every((r, i) => r === it.rules[i]) ? it : { ...it, rules });
    }
  }
  if (!changed) return f;
  return withLaneItems(f, items);
}

/**
 * #2337 — leaf rules this viewer's filter carries on fields they cannot use:
 * an admin-only custom field (its definition is sent to every role, flagged
 * `is_admin_only`) or the admin-only Contact email built-in, for a non-admin.
 * pruneLaneFilter drops these silently; this count lets the popover say so.
 * Rules on a deleted field are not counted: that is stale state, not a
 * permission, and they keep dropping silently.
 */
export function countUnusableLaneRules(
  f: LaneFilter | undefined,
  defs: readonly Pick<FieldLike, "id" | "is_admin_only">[],
  isAdmin: boolean,
): number {
  if (!f || isAdmin) return 0;
  const adminOnly = new Set<LaneFieldKey>(defs.filter((d) => d.is_admin_only).map((d) => d.id));
  for (const b of LANE_BUILTIN_FIELDS) if (b.is_admin_only) adminOnly.add(b.key);
  const leaves = f.items.flatMap((it) => (it.kind === "rule" ? [it] : it.rules));
  return leaves.filter((r) => r.field !== null && adminOnly.has(r.field)).length;
}

/** #2337 — "1 filter ignored: you cannot use this field" (the popover line; Reads as prefixes " · "). */
export function ignoredRulesText(n: number): string {
  return n === 1 ? "1 filter ignored: you cannot use this field" : `${n} filters ignored: you cannot use these fields`;
}

// ---------------------------------------------------------------------------
// Evaluation and text
// ---------------------------------------------------------------------------

/**
 * Structural "has at least one complete rule" check, without field types.
 * Used for the filter badge; callers pass a filter already pruned against the
 * viewer's fields (BoardView's effective filters), so it agrees with the
 * typed check.
 */
export function isLaneFilterActive(f: LaneFilter | undefined): boolean {
  if (!f) return false;
  const done = (r: LaneRule) =>
    r.field !== null &&
    (isPresenceOp(r.op) ? true : r.op === "between" ? !!(r.min || r.max) : !!r.value?.trim() || (r.values?.length ?? 0) > 0);
  return f.items.some((it) => (it.kind === "rule" ? done(it) : it.rules.some((element) => done(element))));
}

/** The lane fields a filter reads. `contact_email` is absent for non-admins. */
export type LaneFilterLane = Pick<Swimlane, "custom_field_values"> &
  Partial<Pick<Swimlane, "name" | "contact_email" | "health_status" | "effective_health_status">>;

function laneValues(s: LaneFilterLane): Map<LaneFieldKey, string> {
  const m = new Map<LaneFieldKey, string>((s.custom_field_values ?? []).map((v) => [v.field_definition, v.value]));
  // Matched on the full stored text; "" normalizes to no value, so an empty
  // contact email fails is / contains / wildcard and passes the negations.
  for (const b of LANE_BUILTIN_FIELDS) {
    const v = b.read(s);
    if (v !== undefined) m.set(b.key, v);
  }
  return m;
}

interface CompiledEntry {
  join: FieldRuleJoin;
  test: (values: Map<LaneFieldKey, string>) => boolean;
}

function compileRules(rules: readonly LaneRule[], types: Map<LaneFieldKey, RuleFieldType>): CompiledEntry[] {
  return rules
    .filter((r) => isRuleComplete(r, r.field === null ? null : types.get(r.field)))
    .map((r) => {
      const t = types.get(r.field as LaneFieldKey) as RuleFieldType;
      const id = r.field as LaneFieldKey;
      return { join: r.join, test: (vals) => matchRule(r, t, vals.get(id)) };
    });
}

/**
 * Compile a lane filter into a predicate, or null when it has no complete
 * rule (so callers can skip per-lane work entirely). Incomplete rules and
 * empty groups are skipped, never treated as failing.
 */
export function compileLaneFilter(
  f: LaneFilter | undefined,
  fields: readonly FieldLike[],
): ((lane: LaneFilterLane) => boolean) | null {
  if (!f) return null;
  const types = typeMap(fields);
  const top: CompiledEntry[] = [];
  for (const it of f.items) {
    if (it.kind === "rule") {
      top.push(...compileRules([it], types).map((e) => ({ ...e, join: it.join })));
    } else {
      const inner = compileRules(it.rules, types);
      if (inner.length > 0) top.push({ join: it.join, test: (vals) => evalChain(inner, (e) => e.test(vals)) });
    }
  }
  if (top.length === 0) return null;
  return (lane) => {
    const vals = laneValues(lane);
    return evalChain(top, (e) => e.test(vals));
  };
}

/** Ids of the lanes the filter hides; empty when it has no complete rule. */
export function laneIdsHiddenByFilter(
  swimlanes: readonly (LaneFilterLane & Pick<Swimlane, "id">)[],
  f: LaneFilter | undefined,
  fields: readonly FieldLike[],
): Set<number> {
  const test = compileLaneFilter(f, fields);
  if (!test) return new Set();
  return new Set(swimlanes.filter((s) => !test(s)).map((s) => s.id));
}

/**
 * For each text or url field, the distinct non-empty values the lanes carry,
 * trimmed and sorted alphabetically: the choices for a text `is` / `is not`
 * rule (#2226). Values that differ only in case collapse to the first
 * spelling seen, since matching ignores case. A value longer than the
 * saved-filter bound is left out: a rule on it could not be saved. The
 * built-ins (#2336) offer the lanes' names, and their contact emails only
 * when `fields` carries Contact email (admins).
 */
export function laneTextValueChoices(
  swimlanes: readonly LaneFilterLane[],
  fields: readonly FieldLike[],
): Map<LaneFieldKey, string[]> {
  const textIds = new Set(fields.filter((f) => isRuleFieldType(f.field_type) && isTextRuleType(f.field_type)).map((f) => f.id));
  const seen = new Map<LaneFieldKey, Map<string, string>>();
  const add = (fid: LaneFieldKey, raw: unknown) => {
    if (!textIds.has(fid) || typeof raw !== "string") return;
    const shown = raw.trim();
    if (shown === "" || shown.length > LANE_FILTER_MAX_STRING) return;
    const byKey = seen.get(fid) ?? new Map<string, string>();
    seen.set(fid, byKey);
    const key = shown.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, shown);
  };
  for (const s of swimlanes) {
    for (const [fid, raw] of laneValues(s)) add(fid, raw);
  }
  const out = new Map<LaneFieldKey, string[]>();
  for (const [id, byKey] of seen) {
    out.set(id, [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
  }
  return out;
}

export type LaneValueFormatter = (field: FieldLike, raw: string) => string;

function ruleLabel(r: LaneRule, fieldsById: Map<LaneFieldKey, FieldLike>, fmt: LaneValueFormatter): string {
  const def = fieldsById.get(r.field as LaneFieldKey) as FieldLike;
  return ruleText(r, def.field_type as RuleFieldType, def.name, (raw) => laneValueLabel(def, raw, fmt));
}

export interface LaneChipItem {
  id: number;
  join: FieldRuleJoin;
  label: string;
}

/**
 * One entry per complete top-level item, in order, with its plain-language
 * label. Groups are always parenthesized. Joins of skipped (incomplete)
 * items are not carried over, matching how evalChain sees the list.
 */
export function laneFilterChipItems(
  f: LaneFilter | undefined,
  fields: readonly FieldLike[],
  fmt: LaneValueFormatter,
): LaneChipItem[] {
  if (!f) return [];
  const types = typeMap(fields);
  const byId = new Map<LaneFieldKey, FieldLike>(fields.map((d) => [d.id, d]));
  const complete = (r: LaneRule) => isRuleComplete(r, r.field === null ? null : types.get(r.field));
  const out: LaneChipItem[] = [];
  for (const it of f.items) {
    if (it.kind === "rule") {
      if (complete(it)) out.push({ id: it.id, join: it.join, label: ruleLabel(it, byId, fmt) });
    } else {
      const inner = it.rules.filter((element) => complete(element)).map((r) => ({ join: r.join, text: ruleLabel(r, byId, fmt) }));
      if (inner.length > 0) out.push({ id: it.id, join: it.join, label: `(${textChain(inner)})` });
    }
  }
  return out;
}

export interface LaneFilterSummary {
  /** Full "Reads as: …" sentence. */
  readsAs: string;
  /** Complete leaf rules (the Lanes trigger badge). */
  completeCount: number;
  /** Incomplete leaf rules, which are ignored. */
  incompleteCount: number;
}

export function summarizeLaneFilter(
  f: LaneFilter | undefined,
  fields: readonly FieldLike[],
  fmt: LaneValueFormatter,
  /** #2337 — rules dropped because the viewer cannot use their field (countUnusableLaneRules). */
  ignoredCount = 0,
): LaneFilterSummary {
  const types = typeMap(fields);
  const leaves = (f?.items ?? []).flatMap((it) => (it.kind === "rule" ? [it] : it.rules));
  const completeCount = leaves.filter((r) => isRuleComplete(r, r.field === null ? null : types.get(r.field))).length;
  const incompleteCount = leaves.length - completeCount;
  const chips = laneFilterChipItems(f, fields, fmt);
  const body = chips.length === 0 ? "all lanes shown" : textChain(chips.map((c) => ({ join: c.join, text: c.label })));
  const suffix =
    (incompleteCount === 0 ? "" : ` · ${incompleteCount} incomplete ${incompleteCount === 1 ? "filter" : "filters"} ignored`) +
    (ignoredCount > 0 ? ` · ${ignoredRulesText(ignoredCount)}` : "");
  return { readsAs: `Reads as: ${body}${suffix}`, completeCount, incompleteCount };
}

/** Next unused item id (for new rules and groups). */
export function nextLaneItemId(f: LaneFilter | undefined): number {
  let max = 0;
  for (const it of f?.items ?? []) {
    max = Math.max(max, it.id);
    if (it.kind === "group") for (const r of it.rules) max = Math.max(max, r.id);
  }
  return max + 1;
}

/** Total leaf rules, for the add-rule bound. */
export function laneRuleCount(f: LaneFilter | undefined): number {
  return (f?.items ?? []).reduce((n, it) => n + (it.kind === "rule" ? 1 : it.rules.length), 0);
}

/** Remove a top-level item (a chip dismiss); the next item's join then binds to whatever precedes it. */
export function removeLaneItem(f: LaneFilter, id: number): LaneFilter | undefined {
  return withLaneItems(f, f.items.filter((it) => it.id !== id));
}
