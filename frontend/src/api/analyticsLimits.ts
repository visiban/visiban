/**
 * The Analytics Overview's cap on each per-card list (#2429): scatter dots,
 * attention items, each throughput period's drill-down cards, and each
 * swimlane's stalled cards. Every count and percentile is still computed from
 * the whole set; only the lists shrink: on a 12k-card board metrics/overview
 * drops from about 7.8 MB to about 0.6 MB (raw JSON). The analytics heatmap is
 * not capped and grows with the swimlane count. The charts say when they show
 * a sample. scripts/nightly_load_test.py mirrors this value (its self-test
 * fails on drift).
 *
 * Its own module so the many tests that mock `api/flowMetrics` need not stub it.
 */
export const OVERVIEW_LIST_LIMIT = 300;
