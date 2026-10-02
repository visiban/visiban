/**
 * Shared logic for rendering and validating custom field values (#371).
 *
 * `CustomFieldValueDisplay` and `CustomFieldValueInput` both call into this
 * module rather than duplicating per-type logic, so the defensive-rendering
 * contract (a stale dropdown choice, a value that no longer parses for its
 * field's current type, a missing value) lives in exactly one place.
 */
import type { FieldDefinitionShape } from "../types";
import { PALETTE_COLORS } from "../constants/colors";
import { formatDateStr } from "./date";

/**
 * Deterministic string → palette color, same hashing technique as
 * `Avatar.tsx`'s `hashUsername`, applied to a dropdown choice string instead
 * of a username. `CustomFieldDefinition.choices` carries no stored color
 * (see the model — a per-choice color field would be a backend change, out
 * of scope for this frontend-only phase), so the color must be derivable
 * from the string alone and stay stable across renders without one.
 */
export function choiceColor(choice: string): string {
  let hash = 0;
  for (let i = 0; i < choice.length; i++) {
    hash = (hash * 31 + choice.charCodeAt(i)) >>> 0;
  }
  return PALETTE_COLORS[hash % PALETTE_COLORS.length];
}

/**
 * Does `value` parse cleanly for `definition.field_type`? Used to gate the
 * defensive-rendering contract's item (b): a stored value that no longer
 * matches its field's current type (e.g. after a type change — see #1121,
 * which is the backend gap this frontend guard exists to survive).
 *
 * Dropdown is intentionally not validated against `choices` here — an
 * orphaned choice (no longer in the current choice set, which the server
 * allows by design) is a display concern handled directly in
 * `CustomFieldValueDisplay`/`CustomFieldValueInput`, not an invalid-value
 * concern; the stored string is always "valid enough" to display as text.
 */
export function isValidForType(definition: FieldDefinitionShape, value: string): boolean {
  if (value === "") return true; // empty is always valid — it means "no value", never "invalid value"
  switch (definition.field_type) {
    case "number":
      return Number.isFinite(Number(value)) && value.trim() !== "";
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
    case "checkbox":
      return value === "true" || value === "false";
    case "url":
      return normalizeUrl(value).ok;
    case "text":
    case "dropdown":
    default:
      return true;
  }
}

/**
 * Format `value` for read-only display, per type. Assumes `isValidForType`
 * already passed — callers must check validity separately and fall back to
 * the raw string for an invalid value (see the defensive-rendering contract,
 * ux-design spec §5b — display always shows *something*, never NaN/Invalid
 * Date/a broken boolean).
 */
export function formatCustomFieldValue(
  definition: FieldDefinitionShape,
  value: string,
  userDateFormat: string
): string {
  switch (definition.field_type) {
    case "date":
      return formatDateStr(value, userDateFormat);
    case "checkbox":
      return value === "true" ? "Yes" : "No";
    // url: the full URL, not the hostname — this is the peek popover's text
    // and the chips' `title`, where the reader verifies where a link goes.
    // Only the pinned chips shorten it to a hostname (`urlDisplayHostname`).
    case "url":
    case "number":
    case "text":
    case "dropdown":
    default:
      return value;
  }
}

/**
 * Rebuild a card's full `custom_field_values` array with one field's value
 * set (or cleared). Every write goes through this — `CardPatch` sends the
 * whole array, not a delta (matches every other list field on `CardPatch`),
 * so every call site needs the same "replace this entry, or insert it, or
 * drop it" logic rather than reimplementing the merge inline.
 *
 * Clearing a field always sends `value: ""` for its entry rather than
 * removing the entry outright — this matches the existing JSDoc contract on
 * `CustomFieldValue` (no entry = no value; sending `""` clears one) and
 * keeps the write path indifferent to whether the card previously had a
 * populated or already-empty value for this field.
 */
export function withCustomFieldValue(
  current: { field_definition: number; value: string }[],
  fieldDefinitionId: number,
  value: string
): { field_definition: number; value: string }[] {
  const idx = current.findIndex((v) => v.field_definition === fieldDefinitionId);
  if (idx === -1) {
    return [...current, { field_definition: fieldDefinitionId, value }];
  }
  const next = current.slice();
  next[idx] = { field_definition: fieldDefinitionId, value };
  return next;
}

/** Server-side cap on any stored custom field value (`MAX_VALUE_LENGTH`). */
export const CUSTOM_FIELD_VALUE_MAX = 500;

export type UrlNormalizeError = "scheme" | "invalid" | "length";

export type UrlNormalizeResult =
  | { ok: true; url: string }
  | { ok: false; error: UrlNormalizeError };

/** User-facing copy for each `normalizeUrl` failure (#1390). */
export const URL_ERROR_COPY: Record<UrlNormalizeError, string> = {
  scheme: "Enter a web address starting with http:// or https://",
  invalid: "Enter a valid web address",
  length: `Web addresses can be at most ${CUSTOM_FIELD_VALUE_MAX} characters`,
};

// A `scheme:` prefix — but `localhost:8080` and `example.com:8443/x` are a
// bare host with a port, not a scheme, so a colon followed only by digits up
// to the end or a path/query/fragment does not count.
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const HOST_PORT_RE = /^[^/:?#]+:\d+(?:[/?#]|$)/;
// Mirrors the server's `_has_unsafe_chars`: whitespace, C0/C1 controls, and
// the invisible formatting characters a pasted URL can smuggle in.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_CHARS_RE = /[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/;

/**
 * Normalize and validate a URL custom field value (#1390).
 *
 * Mirrors the server's `validate_external_ref_url` so the editor rejects what
 * the API would 400, with one deliberate addition: a bare domain
 * (`example.com`) is accepted and gets `https://` prepended, because nobody
 * types the scheme. A *non*-http(s) scheme (`javascript:`, `data:`, `ftp:`)
 * is rejected, never rewritten — prepending `https://` to `javascript:alert(1)`
 * would turn an attack into a link to a host called "javascript".
 *
 * The returned `url` is the trimmed input (plus any added scheme), not
 * `URL.href`: the server stores the value as typed, and re-serializing here
 * would make the editor and the stored value disagree on every save.
 */
export function normalizeUrl(raw: string): UrlNormalizeResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "invalid" };

  const scheme = SCHEME_RE.exec(trimmed);
  let candidate = trimmed;
  if (scheme && !HOST_PORT_RE.test(trimmed)) {
    const lowered = scheme[1].toLowerCase();
    if (lowered !== "http" && lowered !== "https") return { ok: false, error: "scheme" };
  } else {
    candidate = `https://${trimmed}`;
  }

  if (candidate.length > CUSTOM_FIELD_VALUE_MAX) return { ok: false, error: "length" };
  // Browsers read `\` as `/` in http(s) URLs while Python does not, so the
  // two would disagree on the host — the server rejects it, so do we.
  if (UNSAFE_CHARS_RE.test(candidate) || candidate.includes("\\")) {
    return { ok: false, error: "invalid" };
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "scheme" };
  // `new URL("https://")` throws, but `https:///x` can parse with an empty
  // host in some engines; credentials are rejected so they are never stored.
  if (!parsed.hostname || parsed.username || parsed.password) return { ok: false, error: "invalid" };
  // `%` in the authority: the browser decodes it, Python does not — reject it
  // like the server does. Checked on the raw authority because `URL` has
  // already decoded `parsed.hostname`.
  const authority = candidate.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/, 1)[0];
  if (authority.includes("%") || authority.includes("@")) return { ok: false, error: "invalid" };

  return { ok: true, url: candidate };
}

/** The hostname shown on a pinned chip: `www.` stripped, otherwise as parsed. */
export function urlDisplayHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

/**
 * Map a failed URL-value save to the editor's inline copy, or null when the
 * failure is not a validation 400 (network, 403, 5xx) — those stay with the
 * row's generic autosave error rather than claiming the address was wrong.
 */
export function urlErrorFromServer(err: unknown): string | null {
  const response = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (!response || response.status !== 400) return null;
  const body = JSON.stringify(response.data ?? "");
  if (body.includes("longer than")) return URL_ERROR_COPY.length;
  if (body.includes("http and https")) return URL_ERROR_COPY.scheme;
  return URL_ERROR_COPY.invalid;
}
