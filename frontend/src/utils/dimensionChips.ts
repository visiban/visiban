import type { Card, CustomFieldDefinition } from "../types";
import type { CardTrackState, TrackState } from "./stages";
import { isDimensionField } from "./stages";

/**
 * Dimension chips on the card face (#1922): pure derivations, no React.
 *
 * Pinned dimensions (`show_on_card` on a dimension field) render as state
 * chips in the track-chip visual language, capped by the server at
 * `DIMENSION_PIN_CAP`. A dimension needs attention when it is open (an unset
 * or unmapped value counts as open) AND its plan's target date is before
 * today, so a card nobody has planned never reads as needing attention.
 */
export const DIMENSION_PIN_CAP = 3;

function dimensionState(card: Pick<Card, "custom_field_values">, def: CustomFieldDefinition): TrackState {
  const value = card.custom_field_values.find((v) => v.field_definition === def.id)?.value ?? "";
  const resolution = value ? def.choice_resolutions?.[value] ?? "open" : "open";
  return resolution === "satisfied" ? "done" : resolution === "not_applicable" ? "not_applicable" : "open";
}

/** Pinned dimensions in field order, minus those already drawn as track chips. */
export function pinnedDimensionStates(
  card: Pick<Card, "custom_field_values">,
  definitions: CustomFieldDefinition[],
  trackStates: Pick<CardTrackState, "id">[] = [],
): CardTrackState[] {
  const shown = new Set(trackStates.map((t) => t.id));
  return definitions
    .filter((d) => isDimensionField(d) && d.show_on_card && !shown.has(d.id))
    .sort((a, b) => a.position - b.position)
    .slice(0, DIMENSION_PIN_CAP)
    .map((d) => ({ id: d.id, name: d.name, state: dimensionState(card, d), fromLane: false }));
}

/** Names of open dimensions past their plan's target date, in field order. */
export function dimensionsNeedingAttention(
  card: Pick<Card, "custom_field_values" | "dimension_plans">,
  definitions: CustomFieldDefinition[],
  today: string,
): string[] {
  const plans = card.dimension_plans ?? [];
  if (plans.length === 0) return [];
  return definitions
    .filter((d) => isDimensionField(d))
    .sort((a, b) => a.position - b.position)
    .filter((d) => {
      const target = plans.find((p) => p.field_id === d.id)?.target_date;
      return !!target && target < today && dimensionState(card, d) === "open";
    })
    .map((d) => d.name);
}

/** "1 needs attention" / "N need attention"; `""` for zero. */
export function attentionText(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "1 needs attention" : `${count} need attention`;
}
