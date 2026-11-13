/**
 * The card detail sheet's key-facts row (#1916), as data.
 *
 * Each fact is one entry in an ordered list, so a later fact (the Readiness
 * fact of #1922 goes between due/urgency and the pinned fields) is one more
 * entry and not a change to the renderer. A fact that does not apply to this
 * card is never produced: the row reserves no space for it.
 *
 * Pure on purpose: no React, no clock except through `formatDueDate`, which
 * already owns "today in the user's timezone".
 */
import type { BoardFull, Card, CustomFieldDefinition } from "../types";
import { userDisplayName } from "../types";
import { chipValueText, formatCustomFieldValue, isValidForType } from "./customFieldValue";
import { formatDueDate } from "./date";

/** What a fact jumps to. A `field:<id>` target is a pinned custom field's row. */
export type KeyFactTarget = "move" | "assignee" | "due" | `field:${number}`;

export interface KeyFact {
  /** Stable React key and test handle. */
  key: string;
  target: KeyFactTarget;
  /** Leading decorative glyph, `aria-hidden`; never the only carrier of meaning. */
  glyph?: string;
  /** Visible value text. */
  text: string;
  /** Accessible name: starts with the visible text (label-in-name), ends "Go to <field>". */
  label: string;
  /** The name without the "Go to" tail, for a chip that cannot be activated. */
  staticLabel: string;
  /** Full value for a tooltip when the visible text is truncated. */
  title?: string;
  /** Text tone for urgency (on-tint tokens); default neutral. #1922 may add a tone when it adds Readiness. */
  tone?: "danger";
  /** Assignee facts show a small avatar. */
  avatarUser?: Card["assignee"];
}

export interface KeyFactsInput {
  card: Card;
  board: BoardFull;
  userTimezone: string;
  userDateFormat: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "November 20" from `YYYY-MM-DD`, without a Date (no timezone shift). */
function longDate(date: string): string {
  const [y, m, d] = date.split("-");
  const month = MONTHS[Number(m) - 1];
  return month && d ? `${month} ${Number(d)}, ${y}` : date;
}

function firstName(user: NonNullable<Card["assignee"]>): string {
  const name = userDisplayName(user);
  return name.split(/\s+/)[0] || name;
}

export function buildKeyFacts({ card, board, userTimezone, userDateFormat }: KeyFactsInput): KeyFact[] {
  const facts: KeyFact[] = [];

  // Column: always shown. The swimlane is appended only when it disambiguates.
  const column = board.columns.find((c) => c.id === card.column);
  const swimlane = board.swimlanes.find((s) => s.id === card.swimlane);
  if (column) {
    const withLane = board.swimlanes.length > 1 && !!swimlane;
    facts.push({
      key: "column",
      target: "move",
      glyph: "▸",
      text: withLane ? `${column.name} · ${swimlane.name}` : column.name,
      label: `${withLane ? `${column.name} · ${swimlane.name}, column and swimlane` : `${column.name}, column`}. Go to Move`,
      staticLabel: withLane ? `${column.name} · ${swimlane.name}, column and swimlane` : `${column.name}, column`,
    });
  }

  if (card.assignee) {
    facts.push({
      key: "assignee",
      target: "assignee",
      text: firstName(card.assignee),
      label: `Assignee: ${userDisplayName(card.assignee)}. Go to Assignee`,
      staticLabel: `Assignee: ${userDisplayName(card.assignee)}`,
      title: userDisplayName(card.assignee),
      avatarUser: card.assignee,
    });
  }

  if (card.due_date) {
    const info = formatDueDate(card.due_date, userTimezone, userDateFormat);
    facts.push({
      key: "due",
      target: "due",
      glyph: info.overdue ? "⚑" : undefined,
      text: info.label,
      label: `${info.label}${info.overdue ? ", overdue" : ""}, ${longDate(card.due_date)}. Go to Due date`,
      staticLabel: `${info.label}${info.overdue ? ", overdue" : ""}, ${longDate(card.due_date)}`,
      tone: info.overdue ? "danger" : undefined,
    });
  }

  // Board-specific facts (deal value, stage) come only from pinned fields that
  // have a value, within the pin cap the board already enforces.
  const pinned = [...board.custom_field_definitions]
    .filter((d: CustomFieldDefinition) => d.show_on_card)
    .sort((a, b) => a.position - b.position);
  for (const def of pinned) {
    const entry = card.custom_field_values.find((v) => v.field_definition === def.id);
    if (!entry || entry.value === "") continue;
    const shown = isValidForType(def, entry.value) ? formatCustomFieldValue(def, entry.value, userDateFormat) : entry.value;
    const shortValue = chipValueText(def, shown, 16);
    const visible = `${def.name} ${shortValue}`;
    facts.push({
      key: `field-${def.id}`,
      target: `field:${def.id}`,
      text: visible,
      label: `${visible}${shown === shortValue ? "" : `, full value ${shown}`}. Go to ${def.name}`,
      staticLabel: `${def.name}: ${shown}`,
      title: `${def.name}: ${shown}`,
    });
  }

  return facts;
}
