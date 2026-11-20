import type { LaneBandField, LaneTierFields } from "../../utils/laneBand";
import AdminOnlyFieldGlyph from "../Common/AdminOnlyFieldGlyph";
import CustomFieldValueDisplay from "../Card/CustomFieldValueDisplay";

interface Props {
  id: string;
  /** Kept for callers; the toggle's label (which names the lane) associates the grid via `aria-controls`. */
  laneName?: string;
  /** The lane color; tints the divider. Empty means a plain `border-line`. */
  laneColor?: string;
  /** Every eligible field in order, empty values included (`laneGridFields`). */
  fields: LaneBandField[];
  userDateFormat?: string;
  /** False drops the top divider (the Hidden on band group sits under its own heading). */
  divider?: boolean;
}

/**
 * The aligned definition grid a lane band opens under its "N fields" toggle
 * (#2354), shared by the grid band and the phone band. Labels sit in a fixed
 * `w-36` column and are always shown (even when the board hides row chip field
 * names), and an unset value is "—", so the same field sits in the same slot on
 * every lane. One column at phone width follows from the 18rem track minimum.
 */
export default function LaneFieldGrid({ id, laneColor, fields, userDateFormat, divider = true }: Props) {
  return (
    <dl
      id={id}
      data-testid="swimlane-field-grid"
      // Double-click selects a value to copy; it must not bubble to the band, which opens Edit swimlane.
      onDoubleClick={(e) => e.stopPropagation()}
      className={`basis-full w-full grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-x-6 gap-y-1 ${divider ? `mt-1 pt-2 border-t ${laneColor ? "" : "border-line"}` : ""}`}
      style={divider && laneColor ? { borderColor: `color-mix(in srgb, ${laneColor} 30%, rgb(var(--border)))` } : undefined}
    >
      {fields.map(({ def, value }) => (
        <div key={def.id} className="flex items-baseline gap-2 min-w-0 py-0.5">
          <dt className="w-36 shrink-0 text-sm text-fg-secondary line-clamp-2 break-words" title={def.name}>
            {def.is_admin_only && <AdminOnlyFieldGlyph />}
            {def.name}
          </dt>
          {/* Chips and badges are inline-flex blocks that line-clamp would silently cut off after line 2, so
              multi-select and choice values wrap unclamped; clamped text and URLs carry a `title`. */}
          <dd className={`min-w-0 flex-1 text-sm font-medium text-fg break-words ${def.field_type === "multi_select" || def.field_type === "dropdown" ? "" : "line-clamp-2"}`}>
            <CustomFieldValueDisplay definition={def} value={value} variant="grid-value" userDateFormat={userDateFormat} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

interface TierDetailsProps {
  id: string;
  laneColor?: string;
  tiers: LaneTierFields;
  userDateFormat?: string;
  /** Admins only (#2435): opens Board settings on Swimlane fields. Omitted, the link is not rendered. */
  onManage?: () => void;
  /** Phone band: lifts the link to the 44px touch target. */
  touch?: boolean;
}

/**
 * The open lane details on a board with tiers (#2439), shared by the grid band and the phone
 * band: the Details grid, then a muted "Hidden on band" group (labeled with
 * `aria-labelledby`, no second expander: Edit swimlane is admin-only, so this is how a
 * non-admin reads a Hidden field), then the counts footer.
 */
export function LaneTierDetails({ id, laneColor, tiers, userDateFormat, onManage, touch = false }: TierDetailsProps) {
  const headingId = `${id}-hidden-heading`;
  const { details, hidden } = tiers;
  return (
    <div id={id} className="basis-full w-full" data-testid="swimlane-lane-details" onDoubleClick={(e) => e.stopPropagation()}>
      {details.length > 0 && <LaneFieldGrid id={`${id}-details`} laneColor={laneColor} fields={details} userDateFormat={userDateFormat} />}
      {hidden.length > 0 && (
        <section aria-labelledby={headingId} className={`mt-2 ${details.length > 0 ? "" : "pt-2 border-t border-line"}`} data-testid="swimlane-hidden-group">
          <h4 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1">Hidden on band</h4>
          <LaneFieldGrid id={`${id}-hidden`} fields={hidden} userDateFormat={userDateFormat} divider={false} />
        </section>
      )}
      <p className="flex flex-wrap items-center gap-x-1 mt-1 text-xs text-fg-muted" data-testid="swimlane-lane-details-footer">
        <span>{details.length} in details · {hidden.length} hidden on band</span>
        {onManage && (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onManage(); }}
              className={`inline-flex items-center ${touch ? "min-h-11" : "min-h-6"} font-semibold text-info-on-tint underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
            >
              Manage swimlane fields
            </button>
          </>
        )}
      </p>
    </div>
  );
}
