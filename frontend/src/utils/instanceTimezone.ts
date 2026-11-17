/**
 * The instance time zone (`INSTANCE_TIMEZONE`, served on /auth/site-config/ as
 * `instance_timezone`), held for the overdue rule (#2313).
 *
 * Module state rather than a context because `classifyCardUrgency` is a pure
 * helper called from list utilities (Show chips, lane status) that have no
 * React tree to read a context from. `useInstanceFlagsState` sets it once the
 * site config loads; until then, and on a server older than the field, it is
 * UTC, the server's own default.
 */
let zone = "UTC";

export function setInstanceTimezone(value: string | null | undefined): void {
  zone = value && value.trim() ? value : "UTC";
}

export function instanceTimezone(): string {
  return zone;
}
