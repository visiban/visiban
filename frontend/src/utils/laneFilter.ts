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
 */
import type { Swimlane, SwimlaneCustomFieldDefinition } from "../types";
import {
  evalChain,
  isRuleComplete,
  isRuleFieldType,
  isTextRuleType,
  matchRule,
  normalizeDate,
  normalizeNumber,
  opsForFieldType,
  ruleText,
  textChain,
  type FieldRule,
  type FieldRuleJoin,
  type FieldRuleOp,
  type RuleFieldType,
} from "./fieldRules";

export interface LaneRule extends FieldRule {
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
}

/** Bounds shared with SavedFilterSerializer (backend/boards/serializers.py). */
export const LANE_FILTER_MAX_ITEMS = 20;
export const LANE_FILTER_MAX_RULES = 50;
export const LANE_FILTER_MAX_STRING = 500;
export const LANE_FILTER_MAX_ID = 2 ** 31 - 1;

// An op this client does not know (a newer client's, say) drops the whole
// rule in parseRule, so it can never filter with semantics it cannot apply.
const OPS: readonly FieldRuleOp[] = ["is", "is_not", "between", "contains", "not_contains", "wildcard"];

type FieldLike = Pick<SwimlaneCustomFieldDefinition, "id" | "name" | "field_type" | "is_admin_only" | "position">;

/** The swimlane fields this viewer can rule on, in board order. */
export function laneFilterFields<T extends FieldLike>(defs: readonly T[], isAdmin: boolean): T[] {
  return defs
    .filter((d) => isRuleFieldType(d.field_type) && (isAdmin || !d.is_admin_only))
    .sort((a, b) => a.position - b.position);
}

function typeMap(fields: readonly FieldLike[]): Map<number, RuleFieldType> {
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
    const op = typeof o.op === "string" && (OPS as readonly string[]).includes(o.op) ? (o.op as FieldRuleOp) : null;
    if (!op) return null;
    const field = o.field === null || o.field === undefined ? null : validId(o.field) ? o.field : undefined;
    if (field === undefined) return null;
    ruleBudget--;
    const rule: LaneRule = { kind: "rule", id: takeId(o.id), join: o.join === "or" ? "or" : "and", field, op };
    const value = str(o.value);
    const min = str(o.min);
    const max = str(o.max);
    if (op === "contains" || op === "not_contains" || op === "wildcard") {
      // The server accepts these only with a string value and no range
      // bounds. The compact URL form drops an empty value, so restore it.
      rule.value = value ?? "";
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
      const rules = o.rules.map(parseRule).filter((r): r is LaneRule => r !== null);
      if (rules.length === 0) continue;
      items.push({ kind: "group", id: takeId(o.id), join: o.join === "or" ? "or" : "and", rules });
    } else {
      const rule = parseRule(o);
      if (rule) items.push(rule);
    }
  }
  return items.length > 0 ? { items } : undefined;
}

// URL form: `f_lanes=1.<compact JSON>`. The leading version lets a later
// shape change keep reading old links. Compact keys keep shared links short.
interface CompactRule { j?: "o"; f: number | null; o: FieldRuleOp; v?: string; a?: string; b?: string }
interface CompactGroup { j?: "o"; g: CompactRule[] }

function toCompactRule(r: LaneRule): CompactRule {
  const c: CompactRule = { f: r.field, o: r.op };
  if (r.join === "or") c.j = "o";
  if (r.value) c.v = r.value;
  if (r.min) c.a = r.min;
  if (r.max) c.b = r.max;
  return c;
}

function fromCompactRule(c: unknown): unknown {
  if (typeof c !== "object" || c === null) return null;
  const o = c as Record<string, unknown>;
  return { kind: "rule", join: o.j === "o" ? "or" : "and", field: o.f, op: o.o, value: o.v, min: o.a, max: o.b };
}

export function serializeLaneFilterParam(f: LaneFilter | undefined): string | null {
  if (!f || f.items.length === 0) return null;
  const items: (CompactRule | CompactGroup)[] = f.items.map((it) => {
    if (it.kind === "rule") return toCompactRule(it);
    const g: CompactGroup = { g: it.rules.map(toCompactRule) };
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
      return { kind: "group", join: o.j === "o" ? "or" : "and", rules: o.g.map(fromCompactRule) };
    }
    return fromCompactRule(it);
  });
  return sanitizeLaneFilter({ items });
}

// ---------------------------------------------------------------------------
// Pruning against the viewer's fields
// ---------------------------------------------------------------------------

function pruneRule(r: LaneRule, types: Map<number, RuleFieldType>): LaneRule | null {
  if (r.field === null) return r;
  const t = types.get(r.field);
  // A field this viewer may not rule on (deleted, unsupported, or admin-only
  // for a non-admin) is dropped, so its rule can never hide lanes.
  if (!t || !opsForFieldType(t).includes(r.op)) return null;
  if (t === "dropdown" || isTextRuleType(t)) return r;
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
  return items.length > 0 ? { items } : undefined;
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
    r.field !== null && (r.op === "between" ? !!(r.min || r.max) : !!r.value?.trim());
  return f.items.some((it) => (it.kind === "rule" ? done(it) : it.rules.some(done)));
}

function laneValues(s: Pick<Swimlane, "custom_field_values">): Map<number, string> {
  return new Map((s.custom_field_values ?? []).map((v) => [v.field_definition, v.value]));
}

interface CompiledEntry {
  join: FieldRuleJoin;
  test: (values: Map<number, string>) => boolean;
}

function compileRules(rules: readonly LaneRule[], types: Map<number, RuleFieldType>): CompiledEntry[] {
  return rules
    .filter((r) => isRuleComplete(r, r.field === null ? null : types.get(r.field)))
    .map((r) => {
      const t = types.get(r.field as number) as RuleFieldType;
      const id = r.field as number;
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
): ((lane: Pick<Swimlane, "custom_field_values">) => boolean) | null {
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
  swimlanes: readonly Pick<Swimlane, "id" | "custom_field_values">[],
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
 * saved-filter bound is left out: a rule on it could not be saved.
 */
export function laneTextValueChoices(
  swimlanes: readonly Pick<Swimlane, "custom_field_values">[],
  fields: readonly FieldLike[],
): Map<number, string[]> {
  const textIds = new Set(fields.filter((f) => isRuleFieldType(f.field_type) && isTextRuleType(f.field_type)).map((f) => f.id));
  const seen = new Map<number, Map<string, string>>();
  for (const s of swimlanes) {
    for (const v of s.custom_field_values ?? []) {
      if (!textIds.has(v.field_definition) || typeof v.value !== "string") continue;
      const shown = v.value.trim();
      if (shown === "" || shown.length > LANE_FILTER_MAX_STRING) continue;
      const byKey = seen.get(v.field_definition) ?? new Map<string, string>();
      seen.set(v.field_definition, byKey);
      const key = shown.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, shown);
    }
  }
  const out = new Map<number, string[]>();
  for (const [id, byKey] of seen) {
    out.set(id, [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
  }
  return out;
}

export type LaneValueFormatter = (field: FieldLike, raw: string) => string;

function ruleLabel(r: LaneRule, fieldsById: Map<number, FieldLike>, fmt: LaneValueFormatter): string {
  const def = fieldsById.get(r.field as number) as FieldLike;
  return ruleText(r, def.field_type as RuleFieldType, def.name, (raw) => fmt(def, raw));
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
  const byId = new Map(fields.map((d) => [d.id, d]));
  const complete = (r: LaneRule) => isRuleComplete(r, r.field === null ? null : types.get(r.field));
  const out: LaneChipItem[] = [];
  for (const it of f.items) {
    if (it.kind === "rule") {
      if (complete(it)) out.push({ id: it.id, join: it.join, label: ruleLabel(it, byId, fmt) });
    } else {
      const inner = it.rules.filter(complete).map((r) => ({ join: r.join, text: ruleLabel(r, byId, fmt) }));
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
): LaneFilterSummary {
  const types = typeMap(fields);
  const leaves = (f?.items ?? []).flatMap((it) => (it.kind === "rule" ? [it] : it.rules));
  const completeCount = leaves.filter((r) => isRuleComplete(r, r.field === null ? null : types.get(r.field))).length;
  const incompleteCount = leaves.length - completeCount;
  const chips = laneFilterChipItems(f, fields, fmt);
  const body = chips.length === 0 ? "all lanes shown" : textChain(chips.map((c) => ({ join: c.join, text: c.label })));
  const suffix =
    incompleteCount === 0 ? "" : ` · ${incompleteCount} incomplete ${incompleteCount === 1 ? "filter" : "filters"} ignored`;
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
  const items = f.items.filter((it) => it.id !== id);
  return items.length > 0 ? { items } : undefined;
}
