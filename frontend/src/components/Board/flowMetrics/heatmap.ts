/**
 * The dwell heatmap's data (`GET /boards/{id}/analytics/`), its remembered
 * Current / In period mode and its CSV export (#2261: moved out of AnalyticsView).
 */

export interface StalledCard {
  id: number;
  uid: string;
  title: string;
  days_since_move: number;
}

export interface SwimlaneStat {
  id: number;
  name: string;
  /** @deprecated Use throughput_avg_days_per_column for period-filtered dwell. */
  avg_days_per_column: Record<string, number | null>;
  /** @deprecated Use throughput_is_outlier. */
  is_outlier: Record<string, boolean>;
  // Age mode — current dwell for cards presently in each column (snapshot of "now").
  age_avg_days_per_column?: Record<string, number | null>;
  age_is_outlier?: Record<string, boolean>;
  // Throughput mode — dwell for cards that exited each column within the period.
  throughput_avg_days_per_column?: Record<string, number | null>;
  throughput_card_count_per_column?: Record<string, number>;
  throughput_is_outlier?: Record<string, boolean>;
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

export function exportCsv(data: AnalyticsData, mode: ViewMode) {
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
  const csv = [header, ...rows].map(r => r.map(String).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `analytics-${mode}-${data.days}d.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
