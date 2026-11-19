import type { Card, Column, CustomFieldDefinition, Swimlane } from "../types";
import { getTrackStates, stageSubColumns, cardSubColumnIndex } from "./stages";
import type { TrackState } from "./stages";

/**
 * Sub-column and track-state filters (#2367, #1102 phase 1). Both are
 * optional keys on FilterState (absent = not filtering), so every filter
 * persisted or saved before they existed still loads. The server bounds the
 * saved shape (SavedFilterSerializer); these readers are the tolerant client
 * side: anything malformed reads as "not filtering" rather than throwing.
 */

export const TRACK_STATES: readonly TrackState[] = ["done", "open", "not_applicable"];
/** Mirrors SavedFilterSerializer._STAGE_FILTER_MAX_ITEMS and filter_state_keys.json. */
export const STAGE_FILTER_MAX_IDS = 50;

/** The `subColumnIds` of a persisted or saved filter, or undefined when absent, empty or malformed. */
export function sanitizeSubColumnIds(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter((x): x is number => typeof x === "number" && Number.isInteger(x)).slice(0, STAGE_FILTER_MAX_IDS);
  return ids.length > 0 ? ids : undefined;
}

/** The `trackStates` of a persisted or saved filter, or undefined when absent, empty or malformed. */
export function sanitizeTrackStates(raw: unknown): TrackState[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const states = TRACK_STATES.filter((s) => raw.includes(s));
  return states.length > 0 ? states : undefined;
}

/** Everything a card needs to be matched against the two stage filters. */
export interface StageFilterContext {
  columns: Pick<Column, "id" | "sub_columns" | "tracks">[];
  swimlanes: Pick<Swimlane, "id" | "not_applicable_field_ids">[];
  definitions: CustomFieldDefinition[];
}

/**
 * Whether a card passes the sub-column and track-state filters. A card on a
 * plain stage (no sub-columns, no tracks) never matches an active filter on
 * that dimension: the filter names something it does not have. Track state
 * matches when ANY of the card's tracks on its own stage is in a picked state.
 */
export function matchesStageFilters(
  card: Pick<Card, "column" | "swimlane" | "gates_passed" | "custom_field_values">,
  subColumnIds: readonly number[] | undefined,
  trackStates: readonly TrackState[] | undefined,
  ctx: StageFilterContext | undefined,
): boolean {
  const wantSubs = (subColumnIds?.length ?? 0) > 0;
  const wantTracks = (trackStates?.length ?? 0) > 0;
  if (!wantSubs && !wantTracks) return true;
  const column = ctx?.columns.find((c) => c.id === card.column);
  if (!column) return false;
  if (wantSubs) {
    const subs = stageSubColumns(column);
    const own = subs[cardSubColumnIndex(card, column)];
    if (!own || !subColumnIds!.includes(own.id)) return false;
  }
  if (wantTracks) {
    const lane = ctx?.swimlanes.find((l) => l.id === card.swimlane);
    const states = getTrackStates(card, column, lane, ctx?.definitions);
    if (!states.some((t) => trackStates!.includes(t.state))) return false;
  }
  return true;
}
