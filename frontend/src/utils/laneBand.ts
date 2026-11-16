import type { Card, Column, Swimlane, SwimlaneCustomFieldDefinition } from "../types";
import { laneLimitState, laneUsage, swimlaneLimitModes, type LaneLimitReading, type LaneUsage, type LimitFlags } from "./placementLimits";

/**
 * What a swimlane band shows, shared by the grid band (`SwimlaneRow`) and the
 * phone band (`PhoneBoard`, #2329) so the two never disagree on which fields or
 * which limit state a lane has. The tiers are in `frontend/CLAUDE.md`
 * § Swimlane bands (#2335).
 */

/** Lane fields shown inline before `+N` (#2271). The rest are on demand (#2335). */
export const INLINE_FIELD_COUNT = 2;

export interface LaneBandField {
  def: SwimlaneCustomFieldDefinition;
  value: string;
}

/**
 * The lane's field values in Swimlane fields tab order, split into the first
 * two (inline) and the rest (behind `+N`). Three guards, all deliberate: an
 * empty-string value renders nothing (dashed already means "unset" on the card
 * face, and Edit Swimlane lists every field, so an empty value is never
 * stranded); a value whose definition is missing is dropped silently (a WS race
 * between a definition delete and this render); and the inline slice is capped
 * client-side, so a server-side cap violation cannot blow out the band.
 */
export function laneBandFields(lane: Swimlane, definitions: SwimlaneCustomFieldDefinition[] | undefined): { inline: LaneBandField[]; extra: LaneBandField[] } {
  const byId = new Map((definitions ?? []).map((d) => [d.id, d]));
  const entries = (lane.custom_field_values ?? [])
    .filter((v) => v.value !== "")
    .map((v) => ({ def: byId.get(v.field_definition), value: v.value }))
    .filter((x): x is LaneBandField => !!x.def)
    .sort((a, b) => a.def.position - b.def.position);
  return { inline: entries.slice(0, INLINE_FIELD_COUNT), extra: entries.slice(INLINE_FIELD_COUNT) };
}

export interface LaneBandLimit {
  usage: LaneUsage;
  reading: LaneLimitReading;
  hard: boolean;
}

/**
 * The lane's limit line (#1150, #2275), or null when nothing should show.
 * `laneCards` are the lane's cards in every column; `columns` are all of the
 * board's columns (the lane's counted columns decide what counts).
 *
 * Tertiary tier (#2335): a calm reading (under, at) folds away with a collapsed
 * lane; a violated limit (`overWip`, `overWeight`) always shows, so nothing
 * over its limit is hidden behind the chevron.
 */
export function laneBandLimit(lane: Swimlane, columns: Column[], laneCards: Card[], flags: LimitFlags, collapsed: boolean): LaneBandLimit | null {
  const usage = laneUsage(lane, columns, laneCards);
  const reading = laneLimitState(lane, usage);
  if (reading === null) return null;
  if (collapsed && reading.state !== "overWip" && reading.state !== "overWeight") return null;
  return { usage, reading, hard: swimlaneLimitModes(flags, lane).wip === "hard" };
}
