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

/**
 * Reason a regex source is unsafe to run, or null. Walks the source tracking
 * escapes and character classes; a group is risky when it is followed by an
 * unbounded quantifier and contains a quantifier or an alternation.
 */
export function unsafeRegexReason(src: string): string | null {
  if (/\\(?:[1-9]|k<)/.test(src.replace(/\\\\/g, ""))) return "Backreferences are not supported";
  const stack: { quant: boolean; alt: boolean }[] = [{ quant: false, alt: false }];
  let inClass = false;
  const isQuantAt = (i: number): boolean => {
    const c = src[i];
    if (c === "*" || c === "+") return true;
    // {n,} and {n,m} repeat; {n} is bounded and harmless.
    return c === "{" && /^\{\d+,\d*\}/.test(src.slice(i));
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(") { stack.push({ quant: false, alt: false }); continue; }
    if (c === "|") { stack[stack.length - 1].alt = true; continue; }
    if (c === ")") {
      if (stack.length === 1) return null; // unbalanced; RegExp rejects it
      const g = stack.pop() as { quant: boolean; alt: boolean };
      const quantified = isQuantAt(i + 1);
      if (quantified && (g.quant || g.alt)) return "Nested quantifiers are not supported";
      // A group that holds a quantifier counts as one for its parent.
      if (g.quant || quantified) stack[stack.length - 1].quant = true;
      continue;
    }
    if (isQuantAt(i)) stack[stack.length - 1].quant = true;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
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
      return { kind: "ok", test: (v) => re.test(v.trim()) };
    } catch (e) {
      return { kind: "invalid", reason: e instanceof Error ? e.message : "Invalid regular expression" };
    }
  }

  if (/[*?]/.test(trimmed)) {
    // Collapse runs of `*` so a long run cannot multiply backtracking paths.
    const src = trimmed
      .replace(/\*+/g, "*")
      .split(/([*?])/)
      .map((part) => (part === "*" ? "[\\s\\S]*" : part === "?" ? "[\\s\\S]" : escapeRegex(part)))
      .join("");
    // eslint-disable-next-line security/detect-non-literal-regexp -- every literal part is escaped; only the fixed [\s\S]* / [\s\S] wildcards are injected
    const re = new RegExp(src, "i");
    return { kind: "ok", test: (v) => re.test(v.trim()) };
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
