import type { CardDensity } from "../types";

/** Mirrors the model cap (`MAX_PINNED_PER_BOARD`), `PIN_CAP` in
 *  BoardSettingsSwimlaneFieldsTab and `MAX_PINNED` in swimlaneAutoWidth. */
export const PINNED_ROW_CAP = 8;

/** How many pinned chips a lane shows before the rest fold into `+N` (#1417).
 *  Undefined density (no board context) uses Standard, like the Default preset. */
export function visibleRowChipCount(density?: CardDensity): number {
  if (density === 'comfortable') return 3;
  if (density === 'dense') return 8;
  return 5;
}
