const MOVEMENTS_PREFIX = "movements_";

/** True for movement-history exports, recorded as `movements_<format>`. */
export function isMovementsExport(exportFormat: string): boolean {
  return exportFormat.startsWith(MOVEMENTS_PREFIX);
}

/**
 * Friendly label for an export-history row. The API value is unchanged
 * (`csv`, `json`, `movements_csv`); only the display differs.
 */
export function formatExportFormatLabel(exportFormat: string): string {
  if (isMovementsExport(exportFormat)) {
    const fmt = exportFormat.slice(MOVEMENTS_PREFIX.length);
    if (fmt) return `Movements (${fmt.toUpperCase()})`;
  }
  return exportFormat.toUpperCase();
}

/** "12 cards" / "1 movement" — row_count counts movements for movement exports. */
export function formatExportRowCount(exportFormat: string, rowCount: number): string {
  const noun = isMovementsExport(exportFormat) ? "movement" : "card";
  return `${rowCount} ${noun}${rowCount === 1 ? "" : "s"}`;
}
