import type { CardExtensionField, CardExtensionFieldType, CardExtensionSection } from "../../types";

/**
 * Client-side check of `GET /boards/{b}/cards/{c}/extensions/` (#2212, experimental).
 *
 * The server already validates the same closed shape (`boards/services/card_extensions.py`); this is
 * the second line. Same caps as the server. Anything invalid is SKIPPED, never truncated: a section with
 * a bad field is dropped whole, and so is one left with no fields. Warns once per payload, never with
 * content (titles and values may be sensitive).
 */
export const MAX_SECTIONS = 10;
export const MAX_FIELDS = 30;
const MAX_TITLE = 120;
const MAX_LABEL = 80;
const MAX_TEXT_VALUE = 500;
const MAX_DISPLAY = 200;
const MAX_CHOICES = 50;
const MAX_CHOICE = 80;
const TYPES: readonly CardExtensionFieldType[] = ["text", "number", "date", "choice"];
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const shortStr = (v: unknown, cap: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= cap;

function parseField(raw: unknown): CardExtensionField | null {
  if (!isObj(raw)) return null;
  const { key, label, type, value, display, choices } = raw;
  if (typeof key !== "string" || !KEY_RE.test(key)) return null;
  if (!shortStr(label, MAX_LABEL)) return null;
  if (typeof type !== "string" || !TYPES.includes(type as CardExtensionFieldType)) return null;
  const field: CardExtensionField = { key, label, type: type as CardExtensionFieldType, value: null };
  if (type === "choice") {
    if (!Array.isArray(choices) || choices.length > MAX_CHOICES || !choices.every((c) => shortStr(c, MAX_CHOICE))) return null;
    field.choices = choices as string[];
  }
  if (value !== null && value !== undefined && value !== "") {
    if (type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
    } else if (typeof value !== "string") {
      return null;
    } else if (type === "text" && value.length > MAX_TEXT_VALUE) {
      return null;
    } else if (type === "date" && !DATE_RE.test(value)) {
      return null;
    } else if (type === "choice" && !field.choices?.includes(value)) {
      return null;
    }
    field.value = value as string | number;
  }
  if (display !== undefined && display !== null && display !== "") {
    if (!shortStr(display, MAX_DISPLAY)) return null;
    field.display = display;
  }
  return field;
}

function parseSection(raw: unknown): CardExtensionSection | null {
  if (!isObj(raw)) return null;
  const { id, title, fields } = raw;
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  if (!shortStr(title, MAX_TITLE)) return null;
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_FIELDS) return null;
  const parsed: CardExtensionField[] = [];
  for (const f of fields) {
    const field = parseField(f);
    if (!field) return null;
    parsed.push(field);
  }
  if (new Set(parsed.map((f) => f.key)).size !== parsed.length) return null;
  return { id, title, fields: parsed };
}

export function parseCardExtensionSections(payload: unknown): CardExtensionSection[] {
  const raw = isObj(payload) ? payload.sections : undefined;
  if (!Array.isArray(raw)) {
    if (payload !== undefined) console.warn("Card extension sections: unexpected payload shape; nothing rendered.");
    return [];
  }
  const out: CardExtensionSection[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const s of raw.slice(0, MAX_SECTIONS)) {
    const section = parseSection(s);
    if (!section || seen.has(section.id)) {
      skipped += 1;
      continue;
    }
    seen.add(section.id);
    out.push(section);
  }
  skipped += Math.max(0, raw.length - MAX_SECTIONS);
  if (skipped > 0) console.warn(`Card extension sections: skipped ${skipped} invalid section(s).`);
  return out;
}
