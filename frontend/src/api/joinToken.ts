/**
 * Allowlist validation for invite tokens interpolated into a request path.
 *
 * Real tokens are `vbnb_`/`vbng_` + hex (`secrets.token_hex`), so
 * `[A-Za-z0-9_-]` covers every format the backend issues. `.`, `/`, `%`, `?`
 * and `#` are deliberately excluded: `encodeURIComponent` leaves `.` alone, so
 * a `..` token would otherwise resolve to a different endpoint.
 *
 * Returns the regex match rather than the input so the sanitization is
 * visible to taint analysis (Sonar tssecurity:S8476).
 */
const JOIN_TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;

export function safeJoinToken(token: string): string {
  const match = JOIN_TOKEN_RE.exec(token);
  if (!match) throw new Error("Invalid join token");
  return match[0];
}
