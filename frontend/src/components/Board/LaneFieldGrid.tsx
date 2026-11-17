import type { LaneBandField } from "../../utils/laneBand";
import AdminOnlyFieldGlyph from "../Common/AdminOnlyFieldGlyph";
import CustomFieldValueDisplay from "../Card/CustomFieldValueDisplay";

interface Props {
  id: string;
  laneName: string;
  /** The lane color; tints the divider. Empty means a plain `border-line`. */
  laneColor?: string;
  /** Every eligible field in order, empty values included (`laneGridFields`). */
  fields: LaneBandField[];
  userDateFormat?: string;
}

/**
 * The aligned definition grid a lane band opens under its "N fields" toggle
 * (#2354), shared by the grid band and the phone band. Labels sit in a fixed
 * `w-36` column and are always shown (even when the board hides row chip field
 * names), and an unset value is "—", so the same field sits in the same slot on
 * every lane. One column at phone width follows from the 18rem track minimum.
 */
export default function LaneFieldGrid({ id, laneName, laneColor, fields, userDateFormat }: Props) {
  return (
    <dl
      id={id}
      aria-label={`Fields for ${laneName}`}
      data-testid="swimlane-field-grid"
      className={`basis-full w-full grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-x-6 gap-y-1 mt-1 pt-2 border-t ${laneColor ? "" : "border-line"}`}
      style={laneColor ? { borderColor: `color-mix(in srgb, ${laneColor} 30%, rgb(var(--border)))` } : undefined}
    >
      {fields.map(({ def, value }) => (
        <div key={def.id} className="flex items-baseline gap-2 min-w-0 py-0.5">
          <dt className="w-36 shrink-0 text-sm text-fg-secondary line-clamp-2 break-words" title={def.name}>
            {def.is_admin_only && <AdminOnlyFieldGlyph />}
            {def.name}
          </dt>
          <dd className="min-w-0 flex-1 text-sm font-medium text-fg line-clamp-2 break-words">
            <CustomFieldValueDisplay definition={def} value={value} variant="grid-value" userDateFormat={userDateFormat} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
