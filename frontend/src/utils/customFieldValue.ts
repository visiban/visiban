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
import { isChoiceColorKey, type ChoiceColorKey } from "../constants/choiceColors";
import { formatDateStr, todayInTimezone } from "./date";

/**
 * Deterministic string → palette color, same hashing technique as
 * `Avatar.tsx`'s `hashUsername`, applied to a dropdown choice string instead
 * of a username. This is the *automatic* color: a choice with no explicit
 * `choice_colors` entry (#1391) — every choice on a board created before
 * per-choice colors — keeps exactly this dot, so existing boards look
 * unchanged. Explicit colors go through `explicitChoiceColor` instead.
 */
export function choiceColor(choice: string): string {
  let hash = 0;
  for (let i = 0; i < choice.length; i++) {
    hash = (hash * 31 + choice.charCodeAt(i)) >>> 0;
  }
  return PALETTE_COLORS[hash % PALETTE_COLORS.length];
}

/**
 * The explicit palette key an admin picked for `choice` (#1391), or `null`
 * when the choice should render with its automatic hash dot.
 *
 * `null` — never a guess — for: a choice with no entry; an *orphaned* value
 * (no longer in `choices`, e.g. renamed — the server prunes its color too);
 * and a key this client does not know (one added by a newer server). In
 * each case the value still renders, as the neutral chip it was before
 * colors existed, so color never decides whether a label is shown.
 */
export function explicitChoiceColor(definition: FieldDefinitionShape, choice: string): ChoiceColorKey | null {
  if (!definition.choices.includes(choice)) return null;
  const colors = definition.choice_colors;
  // Own properties only: a choice named "constructor" or "toString" must not
  // read Object.prototype's member as its color.
  const key = colors && Object.hasOwn(colors, choice) ? colors[choice] : undefined;
  return isChoiceColorKey(key) ? key : null;
}

/**
 * Build the `choice_colors` payload for a save from an editor draft (#1391).
 * The draft is keyed by the choice text as typed; the payload keeps only
 * entries for choices that survive cleaning (trimmed, non-empty) with a known
 * key. The server prunes the same way — this keeps the request honest rather
 * than relying on it.
 */
export function choiceColorsPayload(choices: string[], draft: Record<string, string>): Record<string, string> {
  const entries: [string, string][] = [];
  for (const raw of choices) {
    const key = Object.hasOwn(draft, raw) ? draft[raw] : undefined;
    const choice = raw.trim();
    if (choice !== "" && isChoiceColorKey(key)) entries.push([choice, key]);
  }
  // Object.fromEntries defines own data properties, so a choice literally
  // named "__proto__" becomes a real key (and is serialized by
  // JSON.stringify) instead of hitting the prototype setter and vanishing.
  return Object.fromEntries(entries);
}

/** Drop `choice`'s entry from an editor's color draft (a rename or removal resets its color). */
export function withoutChoiceColor(draft: Record<string, string>, choice: string): Record<string, string> {
  if (!Object.hasOwn(draft, choice)) return draft;
  // Rebuilt from own entries (never `delete` on a copy) so every surviving
  // key — "__proto__" included — stays an own data property.
  return Object.fromEntries(Object.entries(draft).filter(([k]) => k !== choice));
}

/** Set (or, with `null`, clear) `choice`'s color in an editor draft, as an own property. */
export function withChoiceColor(draft: Record<string, string>, choice: string, key: string | null): Record<string, string> {
  if (key === null) return withoutChoiceColor(draft, choice);
  return Object.fromEntries([...Object.entries(draft).filter(([k]) => k !== choice), [choice, key]]);
}

/**
 * The choices a "Paste a list" block would add to an editor's `existing`
 * choices (#2192). Shared by the card and swimlane field editors so the
 * "Add N choices" count, the Add button, and Save all agree on one answer.
 *
 * Splits on every clipboard row/cell separator: LF, CRLF, bare CR (classic
 * Mac/Excel), and tab (a row of spreadsheet cells). Commas are deliberately
 * not separators — a choice may contain one. Entries are trimmed, blanks
 * dropped, and anything already present (or repeated within the paste) is
 * skipped: the server 400s a duplicate choice, so adding one would only turn
 * into a failed save later.
 */
export function pastedChoicesToAdd(text: string, existing: string[]): string[] {
  const seen = new Set(existing.map((c) => c.trim()));
  const added: string[] = [];
  for (const raw of text.split(/\r\n|[\r\n\t]/)) {
    const choice = raw.trim();
    if (choice === "" || seen.has(choice)) continue;
    seen.add(choice);
    added.push(choice);
  }
  return added;
}

/** The draft's color for `choice`, reading own properties only. */
export function draftChoiceColor(draft: Record<string, string>, choice: string): string | undefined {
  return Object.hasOwn(draft, choice) ? draft[choice] : undefined;
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

// ---------------------------------------------------------------------------
// Threshold marking (#1122)
// ---------------------------------------------------------------------------

/** How far a value has crossed its field's thresholds. */
export type ThresholdLevel = "none" | "warn" | "alert";

const DAY_MS = 86_400_000;

/**
 * `YYYY-MM-DD` for the calendar day `now` falls on in `timeZone`. This is
 * `todayInTimezone`, the function due dates use, so the two can never
 * disagree: a blank timezone (the user never set one) and an unknown one
 * both fall back to UTC, not the browser's zone. `todayInTimezone` keeps a
 * formatter per timezone, which matters because this runs once per card
 * per custom field on every render of a board.
 */
function dayInTimeZone(now: Date, timeZone: string): string {
  return todayInTimezone(timeZone, now);
}

/**
 * A stored date value as a UTC day number, or `null`. Defensive on purpose:
 * the server keeps a date as typed once Python's `date.fromisoformat`
 * accepts it, which on 3.11+ includes `20260101` and ISO week dates
 * (`2026-W01-1`, `2026W011`) as well as `YYYY-MM-DD` (#2218). Anything
 * else, or an impossible calendar date, is `null` (no mark).
 */
function utcDayOf(raw: string): number | null {
  const t = raw.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(t);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const ms = Date.UTC(y, mo - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return ms / DAY_MS;
  }
  m = /^(\d{4})-?W(\d{2})-?([1-7])$/.exec(t);
  if (m) {
    const [y, week, weekday] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (week < 1 || week > 53) return null;
    // ISO week 1 is the week holding 4 January; its Monday anchors the rest.
    const jan4 = Date.UTC(y, 0, 4) / DAY_MS;
    const jan4Weekday = new Date(jan4 * DAY_MS).getUTCDay() || 7;
    return jan4 - (jan4Weekday - 1) + (week - 1) * 7 + (weekday - 1);
  }
  return null;
}

/**
 * The value's position against the field's thresholds (#1122), or `null`
 * when it cannot be measured: a number that is not finite (same rule as the
 * server: `"1e3"`, `"+5"`, `"1.50"` all parse), or an unparseable date.
 * For a date it is the signed day offset from today in `timeZone`.
 */
function thresholdMeasure(def: FieldDefinitionShape, rawValue: string, now: Date, timeZone: string): number | null {
  if (def.field_type === "number") {
    const t = rawValue.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  if (def.field_type === "date") {
    const day = utcDayOf(rawValue);
    const today = utcDayOf(dayInTimeZone(now, timeZone));
    return day === null || today === null ? null : day - today;
  }
  return null;
}

/** The field's warning and alert thresholds for its type, each `null` when unset. */
function thresholdPair(def: FieldDefinitionShape): [number | null, number | null] {
  if (def.field_type === "number") return [def.threshold_warn ?? null, def.threshold_alert ?? null];
  if (def.field_type === "date") return [def.threshold_warn_days ?? null, def.threshold_alert_days ?? null];
  return [null, null];
}

/**
 * Which threshold a card's value has reached (#1122). Pure: the caller
 * passes `now` and the viewer's timezone, the same "today" `dueState` uses.
 *
 * Boundaries are inclusive: `above` marks a value at or over a threshold,
 * `below` one at or under it. Alert wins over warning. For a date field the
 * thresholds are signed day offsets from today, so `below` with alert `0`
 * marks a date that is today or already past.
 */
export function thresholdLevel(def: FieldDefinitionShape, rawValue: string, now: Date, timeZone: string): ThresholdLevel {
  const direction = def.threshold_direction ?? "";
  if (direction === "") return "none";
  const [warn, alert] = thresholdPair(def);
  if (warn === null && alert === null) return "none";
  const measure = thresholdMeasure(def, rawValue, now, timeZone);
  if (measure === null) return "none";
  const reached = (t: number | null) => t !== null && (direction === "above" ? measure >= t : measure <= t);
  if (reached(alert)) return "alert";
  if (reached(warn)) return "warn";
  return "none";
}

/** A signed day offset in words: `today`, `3 days from today`, `1 day ago`. */
function dayOffsetWords(days: number): string {
  if (days === 0) return "today";
  const n = Math.abs(days);
  const unit = n === 1 ? "day" : "days";
  return days > 0 ? `${n} ${unit} from today` : `${n} ${unit} ago`;
}

/**
 * The words for a crossed threshold (#1122), or `""` at level `none`:
 * `Alert: at or above $6,000`, `Warning: 3 days from today or earlier`.
 * The card chip carries them in its `title` and an `sr-only` suffix (the
 * chevron glyph is `aria-hidden`); the peek and card detail show them.
 * Number thresholds use the field's own prefix / suffix / decimals.
 */
export function thresholdPhrase(def: FieldDefinitionShape, level: ThresholdLevel): string {
  if (level === "none") return "";
  const [warn, alert] = thresholdPair(def);
  const t = level === "alert" ? alert : warn;
  if (t === null) return "";
  const label = level === "alert" ? "Alert" : "Warning";
  const above = def.threshold_direction === "above";
  if (def.field_type === "date") {
    return `${label}: ${dayOffsetWords(t)} or ${above ? "later" : "earlier"}`;
  }
  const shown = formatNumberValue(String(t), {
    prefix: def.number_prefix, suffix: def.number_suffix, decimals: def.number_decimals,
  });
  return `${label}: at or ${above ? "above" : "below"} ${shown}`;
}

/** The Thresholds block of a settings field form (#1122): inputs kept as typed text so an invalid entry can be shown and corrected. */
export interface ThresholdDraft {
  direction: "" | "above" | "below";
  warn: string;
  alert: string;
}

export const EMPTY_THRESHOLD_DRAFT: ThresholdDraft = { direction: "", warn: "", alert: "" };

export function thresholdDraftFrom(d: FieldDefinitionShape): ThresholdDraft {
  const [warn, alert] = thresholdPair(d);
  return {
    direction: d.threshold_direction ?? "",
    warn: warn === null ? "" : String(warn),
    alert: alert === null ? "" : String(alert),
  };
}

/** Bounds shared with the server (`THRESHOLD_VALUE_MAX`, `THRESHOLD_DAYS_MAX`). */
export const THRESHOLD_VALUE_MAX = 1e15;
export const THRESHOLD_DAYS_MAX = 3650;

/**
 * Check a threshold draft against the server's rules; returns the message to
 * show, or `null` when the draft is valid. Mirrors `validate_thresholds`, so
 * an invalid entry blocks Save instead of round-tripping to a 400.
 */
export function thresholdDraftError(isDate: boolean, draft: ThresholdDraft): string | null {
  if (draft.direction === "") return null;
  const parse = (text: string): number | null | undefined => {
    const t = text.trim();
    if (t === "") return null;
    if (isDate && !/^[-+]?\d+$/.test(t)) return undefined;
    const n = Number(t);
    if (!Number.isFinite(n)) return undefined;
    const max = isDate ? THRESHOLD_DAYS_MAX : THRESHOLD_VALUE_MAX;
    return Math.abs(n) <= max ? n : undefined;
  };
  const warn = parse(draft.warn);
  const alert = parse(draft.alert);
  if (warn === undefined || alert === undefined) {
    return isDate ? `Enter whole days from -${THRESHOLD_DAYS_MAX} to ${THRESHOLD_DAYS_MAX}.` : "Enter a number.";
  }
  if (warn === null && alert === null) return "Enter a warning or an alert threshold.";
  if (warn !== null && alert !== null) {
    const beyond = draft.direction === "above" ? alert > warn : alert < warn;
    if (!beyond) return `The alert threshold must be ${draft.direction} the warning threshold.`;
  }
  return null;
}

/**
 * The threshold half of a settings save. Off sends the direction and four
 * nulls (so turning thresholds off clears stored values); a non-number /
 * non-date type sends no keys, keeping those requests exactly as before
 * #1122. Returns `null` when the draft is invalid — the caller refuses to save.
 */
export function thresholdPayload(
  fieldType: string,
  draft: ThresholdDraft
): {
  threshold_direction?: "" | "above" | "below";
  threshold_warn?: number | null;
  threshold_alert?: number | null;
  threshold_warn_days?: number | null;
  threshold_alert_days?: number | null;
} | null {
  const isNumber = fieldType === "number";
  const isDate = fieldType === "date";
  if (!isNumber && !isDate) return {};
  if (thresholdDraftError(isDate, draft) !== null) return null;
  const on = draft.direction !== "";
  const num = (text: string) => (on && text.trim() !== "" ? Number(text.trim()) : null);
  return {
    threshold_direction: draft.direction,
    threshold_warn: isNumber ? num(draft.warn) : null,
    threshold_alert: isNumber ? num(draft.alert) : null,
    threshold_warn_days: isDate ? num(draft.warn) : null,
    threshold_alert_days: isDate ? num(draft.alert) : null,
  };
}
