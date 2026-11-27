import type { Card, Column, LaneTier, Swimlane, SwimlaneCustomFieldDefinition } from "../types";
import { laneLimitState, laneUsage, swimlaneLimitModes, type LaneLimitReading, type LaneUsage, type LimitFlags } from "./placementLimits";

/**
 * What a swimlane band shows, shared by the grid band (`SwimlaneRow`) and the
 * phone band (`PhoneBoard`, #2329) so the two never disagree on which fields or
 * which limit state a lane has. The tiers are in `frontend/CLAUDE.md`
 * § Swimlane bands (#2335).
 */

/**
 * Band fields with no admin choice: what a board with no tiers set derives by position (#2271,
 * #2658) and what materializing one writes, and the fewest slots a screen offers; `BAND_DEFAULT` on the server.
 */
export const BAND_DEFAULT_COUNT = 2;
/** The most fields an admin may mark Band (#2663); `BAND_MAX` on the server. */
export const BAND_MAX_COUNT = 6;

export interface LaneBandField {
  def: SwimlaneCustomFieldDefinition;
  value: string;
}

/**
 * Every eligible field for the aligned grid (#2354), in Swimlane fields order,
 * empty values included (`""`), so each lane's grid has the same rows in the same
 * places. The server ships every swimlane definition to every board reader (only
 * row values are filtered), so an admin-only definition is dropped here for a
 * non-admin: it would otherwise inflate the "Show N more" count and render as an
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

/**
 * True when no definition carries an explicit tier: a board with no tiers set (every pre-#2439
 * board until its first tier write). It renders the tiers by position (#2658), not a separate band.
 */
export function isLegacyTiers(definitions: TierDef[] | undefined): boolean {
  return (definitions ?? []).every((d) => d.band_visibility == null);
}

/**
 * The smallest cap option that holds `detailsCount`, never below `cap` (#2658, owner decision
 * "Grow cap to fit"); past the largest option, the largest. `cap_to_fit` on the server.
 */
export function laneDetailsCapToFit(detailsCount: number, cap: number): number {
  const fit = LANE_DETAILS_CAP_OPTIONS.find((o) => o >= detailsCount) ?? LANE_DETAILS_CAP_OPTIONS[LANE_DETAILS_CAP_OPTIONS.length - 1];
  return Math.max(cap, fit);
}

/**
 * The cap `definitions` resolve with: on a board with no tiers set, grown to hold every field
 * past the first two (the server writes the same cap on the first tier write); otherwise `cap`.
 * Counts every definition, admin-only or not, so every viewer resolves the same tiers.
 * `effective_cap` on the server.
 */
export function effectiveLaneDetailsCap(definitions: TierDef[] | undefined, cap: number): number {
  const defs = definitions ?? [];
  return isLegacyTiers(defs) ? laneDetailsCapToFit(Math.max(0, defs.length - BAND_DEFAULT_COUNT), cap) : cap;
}

/**
 * Each definition's tier (#2439), the mirror of `resolve_tiers` in
 * `backend/boards/services/lane_field_tiers.py`; the shared fixture
 * `backend/boards/tests/fixtures/lane_field_tiers.json` pins the two together.
 * No tiers set (every row null, #2658): the first two by position are Band, the next
 * `effectiveLaneDetailsCap` Details, the rest Hidden, which is what the server's first tier write stores.
 * Otherwise explicit tiers win, and a null row (an older server's create during a rolling
 * deploy) is never Band: it fills Details in position order up to `cap`, then Hidden, so it
 * never lands on the band without an admin choosing it.
 */
export function resolveLaneTiers(definitions: TierDef[] | undefined, cap: number): Map<number, LaneTier> {
  const ordered = [...(definitions ?? [])].sort((a, b) => a.position - b.position || a.id - b.id);
  const out = new Map<number, LaneTier>();
  if (isLegacyTiers(ordered)) {
    const grown = effectiveLaneDetailsCap(ordered, cap);
    ordered.forEach((d, i) => out.set(d.id, i < BAND_DEFAULT_COUNT ? "band" : i < BAND_DEFAULT_COUNT + grown ? "details" : "hidden"));
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
  /**
   * Non-empty values among the first `slots` Band fields (an empty Band value is dropped, as the
   * pre-1.3 band did, and its slot is not refilled).
   */
  band: LaneBandField[];
  /**
   * Band fields that did not fit this screen (#2663) first, then Details; both in Swimlane
   * fields order, empty values included (the grid shows "—").
   */
  details: LaneBandField[];
  /** Hidden on band, listed last in the lane details so a non-admin can still read them. */
  hidden: LaneBandField[];
}

/**
 * The lane's fields split by tier (#2439). Every board renders through this (#2658): one with no
 * tiers set resolves by position (`resolveLaneTiers`), so it has "Show N more", Hidden on band and
 * the manage link like any other. Built on `laneGridFields`, so every tier (and so every count) leaves out admin-only fields
 * for a non-admin; a caller that cannot tell the viewer's role passes `false`.
 *
 * `slots` (#2663) is how many Band fields this screen shows (`bandSlotsFor`); absent means the
 * default two. Slots are counted over the viewer's Band *definitions*, not the non-empty values,
 * so every lane has the same slots and the same "Show N more" count. Overflow is display-only.
 */
export function laneTierFields(lane: Swimlane, definitions: SwimlaneCustomFieldDefinition[] | undefined, isAdmin: boolean, cap: number, slots: number = BAND_DEFAULT_COUNT): LaneTierFields {
  const tiers = resolveLaneTiers(definitions, cap);
  const grid = laneGridFields(lane, definitions, isAdmin);
  const onBand = grid.filter((f) => tiers.get(f.def.id) === "band");
  const fit = Math.min(slots, BAND_MAX_COUNT);
  return {
    band: onBand.slice(0, fit).filter((f) => f.value !== ""),
    details: [...onBand.slice(fit), ...grid.filter((f) => tiers.get(f.def.id) === "details")],
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
