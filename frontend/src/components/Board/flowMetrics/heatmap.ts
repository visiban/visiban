/**
 * The dwell heatmap's data (`GET /boards/{id}/analytics/`), its remembered
 * Current / In period mode and its CSV export (#2261: moved out of AnalyticsView).
 */

export interface StalledCard {
  id: number;
  uid: string;
  title: string;
  /** Whole days, floored. */
  days_since_move: number;
  /** The same span to 0.1 day, unfloored (#2297). */
  days_since_move_exact: number;
}

export interface SwimlaneStat {
  id: number;
  name: string;
  /** @deprecated Use throughput_avg_days_per_column for period-filtered dwell. */
  avg_days_per_column: Record<string, number | null>;
  /** @deprecated Use throughput_is_outlier. */
  is_outlier: Record<string, boolean>;
  // Current mode — current dwell for cards presently in each column (snapshot of "now").
  age_avg_days_per_column?: Record<string, number | null>;
  age_is_outlier?: Record<string, boolean>;
  // In period mode — dwell for cards that exited each column within the period.
  throughput_avg_days_per_column?: Record<string, number | null>;
  throughput_card_count_per_column?: Record<string, number>;
  throughput_is_outlier?: Record<string, boolean>;
  /**
   * In the warning band by the unrounded mean (#2306): at or past
   * `stale_warning_pct` of the threshold and below it (1-day floor). Absent from a
   * server older than this field.
   */
  age_is_warning?: Record<string, boolean>;
  throughput_is_warning?: Record<string, boolean>;
  /**
   * The whole heatmap tier from the unrounded mean, 1-day floor on every tier
   * (#2331); null for a cell with no mean. Absent from a server older than this
   * field, where the flags above decide.
   */
  age_heat_level?: Record<string, HeatLevel | null>;
  throughput_heat_level?: Record<string, HeatLevel | null>;
  deal_velocity_days: number | null;
  stalled_cards: StalledCard[];
}

/** Manual blocked time in the analytics window (#1149). */
export interface BlockedSummary {
  /** Blocked days per column (where each block started), every column included. */
  days_per_column: Record<string, number>;
  /** Same time in seconds; absent from a server older than this field. */
  seconds_per_column?: Record<string, number>;
  blocks_per_column: Record<string, number>;
  /** Every block in the window, deleted columns included; absent from a server older than this field. */
  total?: { days: number; seconds: number; blocks: number };
  top_reasons: { reason: string; count: number; total_days: number; total_seconds?: number }[];
}

export interface AnalyticsData {
  days: number;
  columns: string[];
  done_columns?: string[];
  swimlanes: SwimlaneStat[];
  stalled_threshold_days: number;
  staleness_threshold_days: number;
  stale_warning_pct: number;
  /** Additive (#1149); absent from a server that predates it. */
  blocked?: BlockedSummary;
}

export type ViewMode = "age" | "throughput";

export function loadViewMode(boardId: number): ViewMode {
  try {
    const v = localStorage.getItem(`board:${boardId}:analytics-view-mode`);
    if (v === "age" || v === "throughput") return v;
  } catch { /* localStorage unavailable — fall back to default */ }
  return "age";
}

export function saveViewMode(boardId: number, mode: ViewMode) {
  try {
    localStorage.setItem(`board:${boardId}:analytics-view-mode`, mode);
  } catch { /* localStorage unavailable — silently skip */ }
}

/**
 * One CSV field. Strings (swimlane and column names are member-controlled) have
 * leading spreadsheet formula characters stripped, then are quoted per RFC 4180
 * when they contain a comma, quote, CR or LF. The strip rule is kept consistent
 * with the backend's `_sanitize_csv_field` in boards/views/import_export.py:
 * `lstrip("=+-@\t\r")`. Numbers are written as-is (the backend also leaves
 * canonical numbers alone), so a negative value is not altered.
 */
export function csvField(value: string | number): string {
  if (typeof value === "number") return String(value);
  const clean = value.replace(/^[=+\-@\t\r]+/, "");
  return /[",\r\n]/.test(clean) ? `"${clean.replace(/"/g, '""')}"` : clean;
}

export function buildCsv(data: AnalyticsData, mode: ViewMode): string {
  const doneCols = new Set(data.done_columns ?? []);
  const cols = data.columns.filter(c => !doneCols.has(c));
  const modeLabel = mode === "age" ? "Current" : `In period (last ${data.days}d)`;
  const header = ["Swimlane", ...cols.map(c => `${modeLabel} (${c}, days)`), "Velocity (days)", "Stalled cards"];
  const rows = data.swimlanes.map(sw => {
    const avgMap = mode === "age"
      ? (sw.age_avg_days_per_column ?? sw.avg_days_per_column)
      : (sw.throughput_avg_days_per_column ?? sw.avg_days_per_column);
    return [
      sw.name,
      ...cols.map(c => avgMap[c] ?? ""),
      sw.deal_velocity_days ?? "",
      sw.stalled_cards.length,
    ];
  });
  return [header, ...rows].map(r => r.map(csvField).join(",")).join("\n");
}

export function exportCsv(data: AnalyticsData, mode: ViewMode) {
  const csv = buildCsv(data, mode);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `analytics-${mode}-${data.days}d.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** A heatmap cell tier: red, yellow or green (#2331). */
export type HeatLevel = "high" | "warning" | "ok";
