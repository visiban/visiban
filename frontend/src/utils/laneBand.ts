import type { Card, Column, LaneTier, Swimlane, SwimlaneCustomFieldDefinition } from "../types";
import { laneLimitState, laneUsage, swimlaneLimitModes, type LaneLimitReading, type LaneUsage, type LimitFlags } from "./placementLimits";

/**
 * What a swimlane band shows, shared by the grid band (`SwimlaneRow`) and the
 * phone band (`PhoneBoard`, #2329) so the two never disagree on which fields or
 * which limit state a lane has. The tiers are in `frontend/CLAUDE.md`
 * § Swimlane bands (#2335).
 */

/** Lane fields shown inline beside the "N fields" toggle (#2271). The rest are on demand (#2335). */
export const INLINE_FIELD_COUNT = 2;

export interface LaneBandField {
  def: SwimlaneCustomFieldDefinition;
  value: string;
}

/**
 * The lane's field values in Swimlane fields tab order, split into the first
 * two (inline) and the rest. `extra` is retained for compatibility and is no
 * longer rendered by any band: the aligned `LaneFieldGrid` replaced the +N
 * expansion (#2354). Three guards, all deliberate: an
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

/**
 * Every eligible field for the aligned grid (#2354), in Swimlane fields order,
 * empty values included (`""`), so each lane's grid has the same rows in the same
 * places. The server ships every swimlane definition to every board reader (only
 * row values are filtered), so an admin-only definition is dropped here for a
 * non-admin: it would otherwise inflate the "N fields" count and render as an
 * unset row, which falsely says the field is empty. The length is the count.
 */
export function laneGridFields(lane: Swimlane, definitions: SwimlaneCustomFieldDefinition[] | undefined, isAdmin: boolean): LaneBandField[] {
  const values = new Map((lane.custom_field_values ?? []).map((v) => [v.field_definition, v.value]));
  return (definitions ?? [])
    .filter((d) => isAdmin || !d.is_admin_only)
    .sort((a, b) => a.position - b.position)
    .map((def) => ({ def, value: values.get(def.id) ?? "" }));
}

/** The lane details cap choices and default (#2439); `Board.LANE_DETAILS_CAP_CHOICES` on the server. */
export const LANE_DETAILS_CAP_OPTIONS = [4, 6, 9, 12, 16] as const;
export const DEFAULT_LANE_DETAILS_CAP = 6;

type TierDef = Pick<SwimlaneCustomFieldDefinition, "id" | "position" | "band_visibility">;

/** True when no definition carries an explicit tier: a pre-#2439 board, which keeps today's band. */
export function isLegacyTiers(definitions: TierDef[] | undefined): boolean {
  return (definitions ?? []).every((d) => d.band_visibility == null);
}

/**
 * Each definition's tier (#2439), the mirror of `resolve_tiers` in
 * `backend/boards/services/lane_field_tiers.py`; the shared fixture
 * `backend/boards/tests/fixtures/lane_field_tiers.json` pins the two together.
 * Legacy (every row null): the first two by position are Band, the rest Details, uncapped.
 * Otherwise explicit tiers win, and a null row (an older server's create during a rolling
 * deploy) is never Band: it fills Details in position order up to `cap`, then Hidden, so it
 * can never push the band past two.
 */
export function resolveLaneTiers(definitions: TierDef[] | undefined, cap: number): Map<number, LaneTier> {
  const ordered = [...(definitions ?? [])].sort((a, b) => a.position - b.position || a.id - b.id);
  const out = new Map<number, LaneTier>();
  if (isLegacyTiers(ordered)) {
    ordered.forEach((d, i) => out.set(d.id, i < INLINE_FIELD_COUNT ? "band" : "details"));
    return out;
  }
  let detailsUsed = ordered.filter((d) => d.band_visibility === "details").length;
  for (const d of ordered) {
    if (d.band_visibility != null) { out.set(d.id, d.band_visibility); continue; }
    if (detailsUsed < cap) { out.set(d.id, "details"); detailsUsed += 1; } else out.set(d.id, "hidden");
  }
  return out;
}

export interface LaneTierFields {
  /** Non-empty Band values, at most two (an empty Band value is dropped, as the legacy band does). */
  band: LaneBandField[];
  /** Details, empty values included (the grid shows "—"), in Swimlane fields order. */
  details: LaneBandField[];
  /** Hidden on band, listed last in the lane details so a non-admin can still read them. */
  hidden: LaneBandField[];
}

/**
 * The lane's fields split by tier (#2439), or null on a legacy board, whose band keeps
 * `laneBandFields` / `laneGridFields` so it renders identically until an admin sets a tier.
 * Built on `laneGridFields`, so every tier (and so every count) leaves out admin-only fields
 * for a non-admin; a caller that cannot tell the viewer's role passes `false`.
 */
export function laneTierFields(lane: Swimlane, definitions: SwimlaneCustomFieldDefinition[] | undefined, isAdmin: boolean, cap: number): LaneTierFields | null {
  if (isLegacyTiers(definitions)) return null;
  const tiers = resolveLaneTiers(definitions, cap);
  const grid = laneGridFields(lane, definitions, isAdmin);
  return {
    band: grid.filter((f) => tiers.get(f.def.id) === "band" && f.value !== "").slice(0, INLINE_FIELD_COUNT),
    details: grid.filter((f) => tiers.get(f.def.id) === "details"),
    hidden: grid.filter((f) => tiers.get(f.def.id) === "hidden"),
  };
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
