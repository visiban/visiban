/**
 * Wildcard matcher for the lane-filter "matches wildcard" operator (#2227).
 *
 * `*` matches any run of characters (including none), `?` matches exactly one,
 * everything else is literal, and the pattern must match the WHOLE value (so
 * `Ethan*` is "starts with" and `*ross*` is "contains"). Case-insensitive and
 * trimmed on both sides.
 *
 * Deliberately not a RegExp: patterns arrive from shared links and saved
 * filters, and a two-pointer glob with a single backtrack point is O(n*m) with
 * no exponential case, so there is no ReDoS surface.
 */

/** True when `value` matches the whole `pattern`. */
export function wildcardMatch(pattern: string, value: string): boolean {
  // Compare by code point so `?` matches one character, not one UTF-16 unit.
  const p = Array.from(pattern.trim().toLowerCase());
  const v = Array.from(value.trim().toLowerCase());
  let pi = 0, vi = 0, star = -1, mark = 0;
  while (vi < v.length) {
    if (pi < p.length && p[pi] === "*") { star = pi++; mark = vi; }
    else if (pi < p.length && (p[pi] === "?" || p[pi] === v[vi])) { pi++; vi++; }
    else if (star >= 0) { pi = star + 1; vi = ++mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}
