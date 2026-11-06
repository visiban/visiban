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

/**
 * Share links use `Board.share_token`, a UUID (hyphenated, 36 chars). Same
 * contract as `safeJoinToken`: return the regex match so the sanitization is
 * visible to taint analysis, and reject anything that could rewrite the path.
 */
const SHARE_TOKEN_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function safeShareToken(token: string): string {
  const match = SHARE_TOKEN_RE.exec(token);
  if (!match) throw new Error("Invalid share token");
  return match[0];
}
