/**
 * Generic field-rule evaluator (#2205).
 *
 * A rule names a custom field, an operator and a value or range. Rules sit in
 * a flat chain where every entry after the first carries its own join to the
 * previous one ("and" / "or"). And binds tighter than Or, so a chain splits
 * into runs at every Or and passes when any run has every entry passing.
 *
 * Kept free of swimlane specifics so card-field operators (#1847), mixed
 * And/Or card filters (#1309) and lane-aware analytics (#1924) can reuse the
 * same semantics instead of re-deriving them.
 *
 * Stored number and date values are raw text (the server keeps them in a
 * TextField), so everything is normalized before comparing; a value that does
 * not normalize counts as no value. Text and URL values (#2226) are trimmed
 * and compared case-insensitively, so "Ethan Ross " and "ethan ross" match.
 */

import { wildcardMatch } from "./textMatch";
import { parseMultiSelect } from "./customFieldValue";

export type FieldRuleJoin = "and" | "or";
/** Additive-only: the backend validates against the same enum. */
export type FieldRuleOp = "is" | "is_not" | "between" | "contains" | "not_contains" | "wildcard" | "is_set" | "is_empty";
/**
 * The field types a rule can target (text and url since #2226). `enum` (#2247)
 * is a fixed set of values supplied by a built-in field, e.g. lane health.
 * `checkbox` and `multi_select` (#2438) match the stored value the way the card
 * filters do (#1848, #1391). A multi-select rule may hold several values
 * (#2659) in the optional `values` list; one value stays in `value`, so a
 * single-value rule keeps the shape it was saved with. An older client reads
 * only `value`, so it sees a several-value rule as incomplete and ignores it.
 */
export type RuleFieldType = "dropdown" | "number" | "date" | "text" | "url" | "enum" | "checkbox" | "multi_select";

export const RULE_FIELD_TYPES: readonly RuleFieldType[] = ["dropdown", "number", "date", "text", "url", "enum", "checkbox", "multi_select"];

/** Presence operators (#2247): they take no operand. */
export function isPresenceOp(op: FieldRuleOp): op is "is_set" | "is_empty" {
  return op === "is_set" || op === "is_empty";
}

/** Text-backed types: matched trimmed and case-insensitively. */
export function isTextRuleType(t: RuleFieldType): t is "text" | "url" {
  return t === "text" || t === "url";
}

/**
 * `K` is the field key: a custom field definition id by default. Lane filters
 * widen it with built-in field names (#2336); the evaluator never reads it.
 */
export interface FieldRule<K = number> {
  /** Field key; null while the user has not picked one yet. */
  field: K | null;
  op: FieldRuleOp;
  /** `is` / `is_not` / `contains` / `not_contains` / `wildcard` operand. */
  value?: string;
  /**
   * #2659 — a multi-select `is` / `is_not` rule's several values (two or
   * more). Additive: a rule with one value keeps it in `value` and has no
   * `values`, and the two are never both set (`withRuleValues`).
   */
  values?: string[];
  /** `between` lower bound, inclusive; "" or absent = open. */
  min?: string;
  /** `between` upper bound, inclusive; "" or absent = open. */
  max?: string;
}

export function isRuleFieldType(t: string): t is RuleFieldType {
  return (RULE_FIELD_TYPES as readonly string[]).includes(t);
}

/** The operators a field type offers, in menu order. */
export function opsForFieldType(t: RuleFieldType): FieldRuleOp[] {
  if (t === "dropdown" || t === "multi_select") return ["is", "is_not"];
  // Checkbox: Yes or No only. No presence operators: the backend rejects them on custom fields.
  if (t === "checkbox") return ["is"];
  if (t === "enum") return ["is", "is_not", "is_set", "is_empty"];
  if (isTextRuleType(t)) return ["is", "is_not", "contains", "not_contains", "wildcard"];
  return ["between"];
}

/** Trimmed, lower-cased text, or null when nothing is left. */
export function normalizeText(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  return t === "" ? null : t;
}

/**
 * #2659 — the values a multi-select rule names: `values` when it has any,
 * else the single `value`, else none.
 */
export function ruleValues(rule: Pick<FieldRule<unknown>, "value" | "values">): string[] {
  if (Array.isArray(rule.values) && rule.values.length > 0) return rule.values;
  return typeof rule.value === "string" && rule.value !== "" ? [rule.value] : [];
}

/**
 * #2659 — the operand patch for a multi-select rule holding `picked`. One
 * value goes in `value` (the shape every client reads); two or more go in
 * `values` with no `value`, so an older client sees an incomplete rule rather
 * than misapplying the first value alone. Nothing picked is a half-built rule.
 */
export function withRuleValues(picked: readonly string[]): Pick<FieldRule<unknown>, "value" | "values"> {
  const unique = [...new Set(picked.filter((v) => v !== ""))];
  if (unique.length === 0) return { value: "", values: undefined };
  if (unique.length === 1) return { value: unique[0], values: undefined };
  return { value: undefined, values: unique };
}

/** Raw stored number text to a finite number, else null. */
export function normalizeNumber(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Raw stored date text to a canonical `YYYY-MM-DD`, else null. Accepts a
 * full ISO timestamp by taking its date part; rejects calendar-invalid dates
 * such as 2026-02-30 so they read as no value rather than sorting oddly.
 */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function normalizeFor(t: RuleFieldType, raw: string | null | undefined): number | string | null {
  return t === "number" ? normalizeNumber(raw) : t === "date" ? normalizeDate(raw) : null;
}

/**
 * Whether a rule is complete enough to filter. Incomplete rules are ignored,
 * so a half-built filter never hides anything. A `between` needs at least one
 * bound that normalizes.
 */
export function isRuleComplete(rule: FieldRule<unknown>, t: RuleFieldType | null | undefined): boolean {
  if (rule.field === null || !t) return false;
  if (!opsForFieldType(t).includes(rule.op)) return false;
  if (t === "multi_select") return ruleValues(rule).length > 0;
  // #2659 — several values are a multi-select shape; on any other type the rule is unusable.
  if (rule.values !== undefined) return false;
  if (t === "enum" && isPresenceOp(rule.op)) return true;
  if (t === "checkbox") return rule.value === "true" || rule.value === "false";
  if (t === "dropdown" || t === "enum") return typeof rule.value === "string" && rule.value !== "";
  // A blank or whitespace-only operand (an empty `contains` box) is incomplete.
  if (isTextRuleType(t)) return normalizeText(rule.value) !== null;
  return normalizeFor(t, rule.min) !== null || normalizeFor(t, rule.max) !== null;
}

/**
 * Evaluate one complete rule against a stored raw value (undefined = the
 * item has no value for the field). The empty-value rule: no value (or an
 * unparsable one) fails `is`, `contains`, `wildcard` and `between`, and passes `is_not` and `not_contains`.
 */
export function matchRule(rule: FieldRule<unknown>, t: RuleFieldType, raw: string | undefined): boolean {
  if (t === "checkbox") {
    // #1848: a checkbox row is stored only when set, so a missing row is "false".
    return (raw === undefined ? "false" : raw) === rule.value;
  }
  if (t === "multi_select") {
    // #1391: exact membership in the parsed entries, never a substring test on
    // the JSON text. #2659: `is` is any-of the rule's values, `is_not` none-of.
    // An empty or unparseable value has no entries, so it fails `is` and
    // passes `is_not`.
    const want = ruleValues(rule);
    const has = parseMultiSelect(raw).some((entry) => want.includes(entry));
    return rule.op === "is_not" ? !has : has;
  }
  if (t === "dropdown" || t === "enum") {
    const has = typeof raw === "string" && raw !== "";
    if (rule.op === "is_set") return has;
    if (rule.op === "is_empty") return !has;
    if (rule.op === "is_not") return !has || raw !== rule.value;
    return has && raw === rule.value;
  }
  if (isTextRuleType(t)) {
    const v = normalizeText(raw);
    const want = normalizeText(rule.value) ?? "";
    if (rule.op === "is_not") return v === null || v !== want;
    if (rule.op === "not_contains") return v === null || !v.includes(want);
    if (v === null) return false;
    // `contains` stays a literal substring (`*` / `?` are plain characters), so
    // no saved or shared filter changes meaning; `wildcard` (#2227) matches any
    // part of the value. A lane with no value (handled above) passes not_contains.
    if (rule.op === "wildcard") return wildcardMatch(want, v);
    return rule.op === "contains" ? v.includes(want) : v === want;
  }
  const v = normalizeFor(t, raw);
  if (v === null) return false;
  const lo = normalizeFor(t, rule.min);
  const hi = normalizeFor(t, rule.max);
  // Numbers compare numerically; canonical YYYY-MM-DD strings compare in date order.
  if (lo !== null && v < lo) return false;
  if (hi !== null && v > hi) return false;
  return true;
}

/** Split a chain into And-runs at every Or. The first entry's join is ignored. */
export function runsOf<T extends { join: FieldRuleJoin }>(entries: readonly T[]): T[][] {
  const runs: T[][] = [];
  entries.forEach((e, i) => {
    if (i === 0 || e.join === "or") runs.push([e]);
    else runs[runs.length - 1].push(e);
  });
  return runs;
}

/** And-before-Or evaluation. An empty chain passes (nothing to filter on). */
export function evalChain<T extends { join: FieldRuleJoin }>(entries: readonly T[], test: (e: T) => boolean): boolean {
  if (entries.length === 0) return true;
  return runsOf(entries).some((run) => run.every((element) => test(element)));
}

/**
 * Plain-language text for a chain, matching evalChain: every And-run of two
 * or more entries is parenthesized whenever an Or is present.
 */
export function textChain(entries: readonly { join: FieldRuleJoin; text: string }[]): string {
  const runs = runsOf(entries);
  return runs
    .map((run) => {
      const t = run.map((e) => e.text).join(" and ");
      return runs.length > 1 && run.length > 1 ? `(${t})` : t;
    })
    .join(" or ");
}

const TEXT_OP_WORDS: Partial<Record<FieldRuleOp, string>> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "does not contain",
  wildcard: "matches wildcard",
};

/**
 * Plain-language text for one complete rule. `fmt` renders a stored value for
 * display (number grouping, the user's date format).
 */
export function ruleText(rule: FieldRule<unknown>, t: RuleFieldType, label: string, fmt: (raw: string) => string): string {
  if (t === "enum" && isPresenceOp(rule.op)) return `${label} ${rule.op === "is_set" ? "is set" : "is empty"}`;
  if (t === "enum") return `${label} ${rule.op === "is_not" ? "is not" : "is"} ${fmt(rule.value ?? "")}`;
  // Chips read "PCI in scope: Yes" and "Pricing regions: EMEA, APAC" (#2438,
  // #2659), like the card chips: several values are joined with ", ".
  if (t === "checkbox") return `${label}: ${rule.value === "true" ? "Yes" : "No"}`;
  if (t === "multi_select") {
    const shown = ruleValues(rule).join(", ");
    return rule.op === "is_not" ? `${label}: not ${shown}` : `${label}: ${shown}`;
  }
  if (t === "dropdown") return `${label} ${rule.op === "is_not" ? "is not" : "is"} ${rule.value ?? ""}`;
  if (isTextRuleType(t)) {
    const word = TEXT_OP_WORDS[rule.op] ?? "is";
    return `${label} ${word} ${(rule.value ?? "").trim()}`;
  }
  const lo = normalizeFor(t, rule.min) !== null ? fmt(String(rule.min).trim()) : null;
  const hi = normalizeFor(t, rule.max) !== null ? fmt(String(rule.max).trim()) : null;
  if (lo !== null && hi !== null) return `${label} between ${lo} and ${hi}`;
  if (lo !== null) return t === "date" ? `${label} on or after ${lo}` : `${label} ${lo} or more`;
  return t === "date" ? `${label} on or before ${hi}` : `${label} up to ${hi}`;
}
