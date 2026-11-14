/**
 * Shared client-side text matcher (#2227) for the lane-filter `contains` rule
 * and the card custom-field text filter.
 *
 * Syntax, in the one existing text box:
 *  - plain text: trimmed, case-insensitive substring match (as before);
 *  - `*` (any run of characters, including none) and `?` (exactly one
 *    character) make it a wildcard pattern. Still a substring match, not
 *    anchored; every other regex metacharacter stays literal;
 *  - `/pattern/` is a JavaScript regex, always flag `i`; the user anchors it
 *    with `^` / `$`.
 *
 * An invalid pattern never throws and never matches everything: it compiles
 * to `{ kind: "invalid" }` and callers treat the filter as incomplete.
 *
 * ReDoS: patterns can arrive from shared links and saved filters, so a regex
 * with a quantified group that itself contains a quantifier or an alternation
 * (`(a+)+`, `(a*)*`, `(a|aa)+`) or a backreference is rejected rather than run.
 * The heuristic is deliberately conservative.
 */

export type TextMatcher =
  | { kind: "empty" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; test: (value: string) => boolean };

export const INVALID_PATTERN_MESSAGE = "Invalid regular expression — this filter is ignored";
export const PATTERN_HINT = "Use * as a wildcard, or /regex/";

const CACHE_LIMIT = 64;
const MAX_OPERAND = 500; // mirrors LANE_FILTER_MAX_STRING (laneFilter.ts)
const cache = new Map<string, TextMatcher>();

/** True when the operand is written as `/pattern/` (at least one character between). */
export function isRegexOperand(trimmed: string): boolean {
  return trimmed.length >= 3 && trimmed.startsWith("/") && trimmed.endsWith("/");
}

const MAX_UNBOUNDED = 2;
const MAX_QUANTIFIERS = 8;
/** Values are cut to this length before a user regex runs, bounding polynomial cases. */
const MAX_VALUE = 200;

/**
 * Reason a regex source is unsafe to run, or null. Walks the source tracking
 * escapes and character classes. Rejected: backreferences; a group holding a
 * quantifier or alternation that is itself repeated (`*`, `+`, `{n}`, `{n,m}`;
 * a lone `?` is fine); and too many quantifiers overall (adjacent overlapping
 * `a*a*a*b` and sequential `(a+)?(a+)?...` are polynomial or exponential
 * without nesting).
 */
export function unsafeRegexReason(src: string): string | null {
  if (/\\(?:[1-9]|k<)/.test(src.replace(/\\\\/g, ""))) return "Backreferences are not supported";
  const stack: { quant: boolean; alt: boolean }[] = [{ quant: false, alt: false }];
  let inClass = false;
  let unbounded = 0;
  let total = 0;
  const quantLen = (i: number): { len: number; unbounded: boolean; repeat: boolean } | null => {
    const c = src[i];
    if (c === "*" || c === "+") return { len: 1, unbounded: true, repeat: true };
    if (c === "?") return { len: 1, unbounded: false, repeat: false };
    if (c !== "{") return null;
    const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
    if (!m) return null;
    // {n,} and any range wider than 3 repeats count as unbounded: a{0,999} is as
    // dangerous as a*, and a{0,10} chained is polynomial of high degree.
    const hi = m[2] === undefined ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3]);
    return { len: m[0].length, unbounded: hi > 3, repeat: true };
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(") {
      const g = { quant: false, alt: false };
      stack.push(g);
      if (src[i + 1] === "?") {
        // A group prefix, not a quantifier: skip it. Non-capturing `(?:` and named
        // `(?<n>` groups are ordinary; lookarounds are kept unrepeatable.
        const named = /^\(\?<([A-Za-z_$][\w$]*)>/.exec(src.slice(i));
        if (named) i += named[0].length - 1;
        else if (src[i + 2] === ":") i += 2;
        else { g.alt = true; i += 1; }
      }
      continue;
    }
    if (c === "|") { stack[stack.length - 1].alt = true; continue; }
    const q = c === ")" ? null : quantLen(i);
    if (q) {
      total++;
      if (q.unbounded) unbounded++;
      stack[stack.length - 1].quant = true;
      i += q.len - 1;
      continue;
    }
    if (c === ")") {
      if (stack.length === 1) return null; // unbalanced; RegExp rejects it
      const g = stack.pop() as { quant: boolean; alt: boolean };
      const next = quantLen(i + 1);
      if (next?.repeat && (g.quant || g.alt)) return "Nested quantifiers are not supported";
      // A group that holds a quantifier counts as one for its parent.
      const parent = stack[stack.length - 1];
      if (g.quant) parent.quant = true;
      // An alternation anywhere inside still branches the parent's repeats.
      if (g.alt) parent.alt = true;
    }
  }
  if (unbounded > MAX_UNBOUNDED || total > MAX_QUANTIFIERS) return "Too many repeats in one pattern";
  return null;
}

/**
 * Linear-ish glob matcher for `*` / `?` patterns, anchored nowhere: the
 * pattern is wrapped in an implicit `*` on both sides. Two-pointer with a
 * single backtrack point, so it is O(n*m) worst case and never exponential
 * (a RegExp built from `*a*a*a*b` is not).
 */
function globContains(pattern: string, value: string): boolean {
  const p = `*${pattern}*`;
  let pi = 0, vi = 0, star = -1, mark = 0;
  while (vi < value.length) {
    if (pi < p.length && p[pi] === "*") { star = pi++; mark = vi; }
    else if (pi < p.length && (p[pi] === "?" || p[pi] === value[vi])) { pi++; vi++; }
    else if (star >= 0) { pi = star + 1; vi = ++mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

function compile(operand: string): TextMatcher {
  const trimmed = operand.trim();
  if (trimmed === "") return { kind: "empty" };
  // Same cap as the lane filter: a longer operand (shared link, saved filter) is not run.
  if (trimmed.length > MAX_OPERAND) return { kind: "invalid", reason: "Pattern is too long" };

  if (isRegexOperand(trimmed)) {
    const src = trimmed.slice(1, -1);
    const unsafe = unsafeRegexReason(src);
    if (unsafe) return { kind: "invalid", reason: unsafe };
    try {
      // eslint-disable-next-line security/detect-non-literal-regexp -- user pattern by design; rejected above when it nests quantifiers or backreferences, capped at 500 chars upstream
      const re = new RegExp(src, "i");
      return { kind: "ok", test: (v) => re.test(v.trim().slice(0, MAX_VALUE)) };
    } catch (e) {
      return { kind: "invalid", reason: e instanceof Error ? e.message : "Invalid regular expression" };
    }
  }

  if (/[*?]/.test(trimmed)) {
    const pat = trimmed.toLowerCase();
    return { kind: "ok", test: (v) => globContains(pat, v.trim().toLowerCase()) };
  }

  const want = trimmed.toLowerCase();
  return { kind: "ok", test: (v) => v.trim().toLowerCase().includes(want) };
}

/**
 * Compile an operand once. Memoized by operand text (small bounded cache) so
 * per-card and per-lane callers never recompile within a filter evaluation.
 */
export function compileTextMatcher(operand: string | null | undefined): TextMatcher {
  const key = typeof operand === "string" ? operand : "";
  const hit = cache.get(key);
  if (hit) return hit;
  const m = compile(key);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, m);
  return m;
}

/** Whether the operand is a pattern that failed to compile. */
export function isInvalidTextPattern(operand: string | null | undefined): boolean {
  return compileTextMatcher(operand).kind === "invalid";
}
