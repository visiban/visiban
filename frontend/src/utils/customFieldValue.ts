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
    case "multi_select":
      return isMultiSelectEncoding(value);
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
    case "multi_select":
      return parseMultiSelect(value).join(", ");
    case "number":
      return formatNumberValue(value, {
        prefix: definition.number_prefix,
        suffix: definition.number_suffix,
        decimals: definition.number_decimals,
      });
    // url: the full URL, not the hostname — this is the peek popover's text
    // and the chips' `title`, where the reader verifies where a link goes.
    // Only the pinned chips shorten it to a hostname (`urlDisplayHostname`).
    case "url":
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

/**
 * A stored multi-select value is a JSON array of strings (#1391). True for
 * that shape only — a newer server or a hand-edited row that sent anything
 * else fails, so display falls back to the raw text (§5b contract).
 */
function isMultiSelectEncoding(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string");
  } catch {
    return false;
  }
}

/**
 * The entries of a stored multi-select value (#1391). Tolerant: `undefined`,
 * `""`, malformed JSON or a non-array yields `[]` (no entries) and non-string
 * members are dropped — never a throw, because this runs while rendering.
 */
export function parseMultiSelect(value: string | undefined | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Encode multi-select entries the way the server stores them (#1391):
 * deduplicated, entries that are current `choices` first in choice order,
 * then any orphaned entries in their given order, compact JSON. `""` for the
 * empty set, which clears the field.
 *
 * Mirrors `boards.custom_field_types` on the server so the editor can tell
 * "nothing changed" (no request) from a real edit by string comparison.
 */
export function serializeMultiSelect(entries: string[], choices: string[]): string {
  const wanted = Array.from(new Set(entries));
  if (wanted.length === 0) return "";
  const wantedSet = new Set(wanted);
  const ordered = choices.filter((choice) => wantedSet.has(choice));
  const inChoices = new Set(ordered);
  ordered.push(...wanted.filter((entry) => !inChoices.has(entry)));
  return JSON.stringify(ordered);
}

/** The display-only number-format options of a definition (#1391). */
export interface NumberFormatOptions {
  prefix?: string;
  suffix?: string;
  decimals?: number | null;
}

/** Upper bound on `number_decimals`, mirroring the serializer's `max_value`. */
export const NUMBER_DECIMALS_MAX = 10;

/**
 * Locale for number grouping and decimal separators (#1391). Number
 * formatting always uses en-US, so one stored value reads the same for every
 * teammate; the per-user `number_locale` preference (Settings → Number
 * format) is not applied here.
 */
const NUMBER_LOCALE = "en-US";

/**
 * Render a stored number value with its field's display-only format (#1391).
 * Every number display surface (card-face chip, row header, card detail read
 * view, peek popover, filter chip) reaches this through
 * `formatCustomFieldValue`, so they cannot disagree.
 *
 * - Not a finite number (an orphaned value after a retype, free text): the
 *   raw text, unchanged — the §5b "always show *something*" contract.
 * - All options at their defaults: the raw text, unchanged — exactly the
 *   pre-#1391 rendering, with no grouping added.
 * - `decimals` null: the number as typed. Set: exactly that many decimal
 *   places, rounded, with thousands grouping.
 * - `prefix`/`suffix` are added verbatim (spaces included). A minus sign goes
 *   before the prefix — `-$5.00`, not `$-5.00` — and is dropped when the value
 *   rounds to zero, so `-0.001` at 2 decimals shows `$0.00`, not `-$0.00`.
 *
 * The stored value is never touched; this is display only.
 */
export function formatNumberValue(raw: string, options: NumberFormatOptions = {}): string {
  const prefix = options.prefix ?? "";
  const suffix = options.suffix ?? "";
  const decimals = options.decimals ?? null;
  const trimmed = raw.trim();
  if (trimmed === "") return raw;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return raw;
  if (prefix === "" && suffix === "" && decimals === null) return raw;

  let negative: boolean;
  let body: string;
  if (decimals === null) {
    negative = trimmed.startsWith("-");
    body = negative ? trimmed.slice(1) : trimmed;
  } else {
    const places = Math.min(Math.max(Math.trunc(decimals), 0), NUMBER_DECIMALS_MAX);
    const magnitude = Math.abs(n);
    negative = n < 0 && Number(magnitude.toFixed(places)) !== 0;
    body = new Intl.NumberFormat(NUMBER_LOCALE, {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
      useGrouping: true,
    }).format(magnitude);
  }
  return `${negative ? "-" : ""}${prefix}${body}${suffix}`;
}

/**
 * Clip a chip's value text to `max` characters with an ellipsis (#371) —
 * except a number field with any format option set (#1391). Slicing the
 * formatted string cuts the suffix (the unit) first, so those values are left
 * whole for the chip's CSS `truncate` to clip only when they truly do not
 * fit; the chip's `title` always carries the full text. Unformatted numbers
 * and every other type keep the character cap unchanged.
 */
export function chipValueText(definition: FieldDefinitionShape, displayText: string, max: number): string {
  const formattedNumber =
    definition.field_type === "number" &&
    (!!definition.number_prefix || !!definition.number_suffix ||
      (definition.number_decimals !== null && definition.number_decimals !== undefined));
  if (formattedNumber || displayText.length <= max) return displayText;
  return `${displayText.slice(0, max)}…`;
}

/**
 * Parse the settings form's decimals input (#1391): `""` means "as typed"
 * (`null`); a whole number 0-10 is itself; anything else is `undefined`
 * (invalid — the form shows "Enter 0 to 10." and refuses to save).
 */
export function parseDecimalsInput(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n <= NUMBER_DECIMALS_MAX ? n : undefined;
}

/** The number-format part of a settings field form (#1391). Decimals is kept as the typed text so an invalid entry can be shown and corrected. */
export interface NumberFormatDraft {
  number_prefix: string;
  number_suffix: string;
  number_decimals: string;
}

export const EMPTY_NUMBER_FORMAT: NumberFormatDraft = { number_prefix: "", number_suffix: "", number_decimals: "" };

export function numberFormatDraftFrom(d: { number_prefix: string; number_suffix: string; number_decimals: number | null }): NumberFormatDraft {
  return {
    number_prefix: d.number_prefix,
    number_suffix: d.number_suffix,
    number_decimals: d.number_decimals === null ? "" : String(d.number_decimals),
  };
}

/**
 * The payload half of a settings save. A non-number type sends none of the
 * keys: the server clears a stored format when a field is retyped away from
 * number, so omitting them keeps every other type's request exactly as it
 * was before #1391. Returns `null` when the decimals text is invalid — the
 * caller refuses to save.
 */
export function numberFormatPayload(
  isNumber: boolean,
  draft: NumberFormatDraft
): { number_prefix?: string; number_suffix?: string; number_decimals?: number | null } | null {
  if (!isNumber) return {};
  const decimals = parseDecimalsInput(draft.number_decimals);
  if (decimals === undefined) return null;
  return { number_prefix: draft.number_prefix, number_suffix: draft.number_suffix, number_decimals: decimals };
}
