/**
 * The Analytics Overview's cap on each per-card list (#2429): scatter dots,
 * attention items, each throughput period's drill-down cards, and each
 * swimlane's stalled cards. Every count and percentile is still computed from
 * the whole set; only the lists shrink, so a 12k-card board's Overview stays
 * under a megabyte. The charts say when they show a sample.
 *
 * Its own module so the many tests that mock `api/flowMetrics` need not stub it.
 */
export const OVERVIEW_LIST_LIMIT = 300;
