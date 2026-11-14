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

export type FieldRuleJoin = "and" | "or";
/** Additive-only: the backend validates against the same enum. */
export type FieldRuleOp = "is" | "is_not" | "between" | "contains" | "not_contains" | "wildcard";
/** The field types a rule can target (text and url since #2226). */
export type RuleFieldType = "dropdown" | "number" | "date" | "text" | "url";

export const RULE_FIELD_TYPES: readonly RuleFieldType[] = ["dropdown", "number", "date", "text", "url"];

/** Text-backed types: matched trimmed and case-insensitively. */
export function isTextRuleType(t: RuleFieldType): t is "text" | "url" {
  return t === "text" || t === "url";
}

export interface FieldRule {
  /** Field definition id; null while the user has not picked one yet. */
  field: number | null;
  op: FieldRuleOp;
  /** `is` / `is_not` / `contains` / `not_contains` / `wildcard` operand. */
  value?: string;
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
  if (t === "dropdown") return ["is", "is_not"];
  if (isTextRuleType(t)) return ["is", "is_not", "contains", "not_contains", "wildcard"];
  return ["between"];
}

/** Trimmed, lower-cased text, or null when nothing is left. */
export function normalizeText(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  return t === "" ? null : t;
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
export function isRuleComplete(rule: FieldRule, t: RuleFieldType | null | undefined): boolean {
  if (rule.field === null || !t) return false;
  if (!opsForFieldType(t).includes(rule.op)) return false;
  if (t === "dropdown") return typeof rule.value === "string" && rule.value !== "";
  // A blank or whitespace-only operand (an empty `contains` box) is incomplete.
  if (isTextRuleType(t)) return normalizeText(rule.value) !== null;
  return normalizeFor(t, rule.min) !== null || normalizeFor(t, rule.max) !== null;
}

/**
 * Evaluate one complete rule against a stored raw value (undefined = the
 * item has no value for the field). The empty-value rule: no value (or an
 * unparsable one) fails `is`, `contains`, `wildcard` and `between`, and passes `is_not` and `not_contains`.
 */
export function matchRule(rule: FieldRule, t: RuleFieldType, raw: string | undefined): boolean {
  if (t === "dropdown") {
    const has = typeof raw === "string" && raw !== "";
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
    // no saved or shared filter changes meaning; `wildcard` (#2227) matches the
    // whole value. A lane with no value (handled above) passes not_contains.
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
  return runsOf(entries).some((run) => run.every(test));
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
export function ruleText(rule: FieldRule, t: RuleFieldType, label: string, fmt: (raw: string) => string): string {
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
