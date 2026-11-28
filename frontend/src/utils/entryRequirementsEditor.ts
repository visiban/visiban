/**
 * Pure helpers for the entry requirements editor (#1923, MR B), kept out of
 * the component file so React fast refresh keeps working.
 */
import type { Column, ColumnEntryRequirement, CustomFieldDefinition, EntryEnforcement, EntryRequirementOperator } from "../types";
import type { EntryRequirementWrite } from "../api/boards";
import { formatNumberValue } from "./customFieldValue";

/** Server cap (ColumnEntryRequirement.MAX_PER_COLUMN). */
export const ENTRY_REQUIREMENTS_CAP = 10;
/** Escape for the discard prompt: above ModalWrapper's 40 and the policies prompt's 40.6, below the choice-row drag's 40.7. */
export const DISCARD_ESCAPE_PRIORITY = 40.65;

export const ENTRY_MODE_LABEL: Record<EntryEnforcement, string> = { warn: "Warn", block: "Block", hard: "Hard" };
export const MODE_HELP: Record<EntryEnforcement, string> = {
  warn: "Let it in and flag it.",
  block: "Board admins can override.",
  hard: "No override for any role.",
};
/** Mode is told by shape, glyph and color together (ux-design rule 2). */
export const MARKER: Record<EntryEnforcement | "off", { glyph: string; cls: string }> = {
  off: { glyph: "", cls: "border-2 border-line-strong" },
  warn: { glyph: "⚠", cls: "border-2 border-dashed border-warning text-warning-on-tint" },
  block: { glyph: "🔒", cls: "bg-warning-bg border border-warning text-warning-on-tint" },
  hard: { glyph: "⛔", cls: "bg-danger-bg border border-danger text-danger" },
};

export const OPERATOR_LABEL: Record<EntryRequirementOperator, string> = {
  filled: "is filled", gt: "is more than", gte: "is at least", lt: "is less than", lte: "is at most",
  min_count: "has at least N choices", satisfied: "is satisfied", set_complete: "is complete",
};
/** The number comparisons (#1923; upper bounds `lt`/`lte` #2718). Their operand is a value of the field. */
export const NUMBER_COMPARISONS = new Set<EntryRequirementOperator>(["gt", "gte", "lt", "lte"]);
export const NEEDS_OPERAND = new Set<EntryRequirementOperator>([...NUMBER_COMPARISONS, "min_count"]);

/** What a comparison's operand needs from its field to read the way the field does. */
export type OperandField = Pick<CustomFieldDefinition, "uid" | "field_type" | "number_prefix" | "number_suffix" | "number_decimals">;

/**
 * A number comparison's operand in its field's number format (#2718): "20%",
 * "$50,000". The operand is a value of the field, so it reads like one, through
 * the same `formatNumberValue` every field display uses. A field with no
 * format, or no field (a payload naming one this client doesn't have), keeps
 * the plain grouped number ("50,000"). `min_count` is a count of choices, not
 * a field value, so callers never pass it here.
 */
export function formatComparisonOperand(operand: string | null, field?: OperandField | null): string {
  if (operand === null) return "";
  if (field && field.field_type === "number" && (field.number_prefix || field.number_suffix || field.number_decimals != null)) {
    return formatNumberValue(operand, { prefix: field.number_prefix, suffix: field.number_suffix, decimals: field.number_decimals });
  }
  const n = Number(operand);
  return operand.trim() !== "" && Number.isFinite(n) ? n.toLocaleString("en-US") : operand;
}

/** Operators a field accepts, mirroring the server's OPERATORS_BY_TYPE. Checkbox accepts none in 1.3. */
export function operatorsFor(field: Pick<CustomFieldDefinition, "field_type" | "is_dimension">): EntryRequirementOperator[] {
  if (field.field_type === "checkbox") return [];
  const ops: EntryRequirementOperator[] = field.is_dimension ? ["satisfied", "filled"] : ["filled"];
  if (field.field_type === "number") ops.push("gt", "gte", "lt", "lte");
  if (field.field_type === "multi_select") ops.push("min_count");
  return ops;
}

export interface Row {
  key: number;
  kind: "field" | "set";
  uid: string;
  operator: EntryRequirementOperator;
  operand: string;
}

export interface Draft {
  on: boolean;
  mode: EntryEnforcement;
  rows: Row[];
}

export function seed(column: Column): Draft {
  const reqs: ColumnEntryRequirement[] = [...(column.entry_requirements ?? [])].sort((a, b) => a.position - b.position);
  return {
    on: column.entry_enforcement != null,
    mode: column.entry_enforcement ?? "warn",
    rows: reqs.map((r, i) => ({
      key: i,
      kind: r.field_set_uid ? "set" : "field",
      uid: r.field_set_uid ?? r.field_uid ?? "",
      operator: r.operator,
      operand: r.operand ?? "",
    })),
  };
}

export const sameDraft = (a: Draft, b: Draft) =>
  JSON.stringify({ ...a, rows: a.rows.map(({ key: _k, ...r }) => r) }) === JSON.stringify({ ...b, rows: b.rows.map(({ key: _k, ...r }) => r) });

/** The body for the replace-all PUT. Off keeps the rows and sends `null` (owner ruling). */
export function toWrite(draft: Draft): { entry_enforcement: EntryEnforcement | null; requirements: EntryRequirementWrite[] } {
  return {
    entry_enforcement: draft.on && draft.rows.length > 0 ? draft.mode : null,
    requirements: draft.rows.map((r) => ({
      ...(r.kind === "set" ? { field_set_uid: r.uid } : { field_uid: r.uid }),
      operator: r.operator,
      ...(NEEDS_OPERAND.has(r.operator) ? { operand: r.operand.trim() } : {}),
    })),
  };
}

/** First client-side problem with a draft, as `{index, message}`, or null. */
export function validateDraft(draft: Draft): { index: number; message: string } | null {
  for (const [index, r] of draft.rows.entries()) {
    if (!r.uid) return { index, message: `Choose a field for condition ${index + 1}.` };
    if (!NEEDS_OPERAND.has(r.operator)) continue;
    const n = Number(r.operand);
    if (r.operand.trim() === "" || !Number.isFinite(n)) return { index, message: `Enter a number for condition ${index + 1}.` };
    if (r.operator === "min_count" && (!Number.isInteger(n) || n < 1)) {
      return { index, message: `Condition ${index + 1} needs a whole number of at least 1.` };
    }
  }
  return null;
}

/** The server's 400 for a save: `{requirements: {index: msg}}`, `{field: msg}` or `detail`. */
export function saveErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  const pick = (v: unknown): string | null => {
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v)) return pick(v[0]);
    if (v && typeof v === "object") {
      for (const [k, inner] of Object.entries(v)) {
        const m = pick(inner);
        if (m) return /^\d+$/.test(k) ? `Condition ${Number(k) + 1}: ${m}` : m;
      }
    }
    return null;
  };
  return pick(data) ?? "Couldn't save the entry requirements. Try again.";
}

export function laneSuffix(names: string[]): string {
  if (names.length === 0) return "";
  return names.length > 2 ? ` · ${names.length} lanes` : ` · ${names.join(", ")}`;
}

