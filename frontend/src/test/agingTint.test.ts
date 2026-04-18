import { describe, it, expect } from "vitest";
import { agingTint, idleDays } from "../utils/agingTint";

// ---------------------------------------------------------------------------
// agingTint
// ---------------------------------------------------------------------------

describe("agingTint", () => {
  it("returns zero state when lastMovedAt is null", () => {
    const result = agingTint(null, 14, 50);
    expect(result.overlayClass).toBeNull();
    expect(result.bodyOpacityClass).toBe("");
  });

  it("returns zero state for a fresh card (moved just now)", () => {
    const now = new Date().toISOString();
    const result = agingTint(now, 14, 50);
    expect(result.overlayClass).toBeNull();
    expect(result.bodyOpacityClass).toBe("");
  });

  it("returns warning state when card is in warning stage but not yet stale", () => {
    // threshold=14, warning=50% → warning starts at 7 days
    // Move to 10 days ago: beyond warning (7d) but before threshold (14d)
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const result = agingTint(tenDaysAgo, 14, 50);
    expect(result.overlayClass).toBe("absolute inset-0 rounded-md pointer-events-none bg-warning/10");
    expect(result.bodyOpacityClass).toBe("opacity-80");
  });

  it("returns stale state when card is past the threshold", () => {
    // Move to 15 days ago: beyond threshold of 14
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000).toISOString();
    const result = agingTint(fifteenDaysAgo, 14, 50);
    expect(result.overlayClass).toBe("absolute inset-0 rounded-md pointer-events-none bg-warning/20");
    expect(result.bodyOpacityClass).toBe("opacity-60");
  });

  it("does not throw when thresholdDays is 0 (clamped to 1)", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    // Should not throw — thresholdDays=0 is clamped to 1
    expect(() => agingTint(tenDaysAgo, 0, 50)).not.toThrow();
    // Card is well past a 1-day threshold, so should be stale
    const result = agingTint(tenDaysAgo, 0, 50);
    expect(result.overlayClass).toBe("absolute inset-0 rounded-md pointer-events-none bg-warning/20");
  });
});

// ---------------------------------------------------------------------------
// idleDays
// ---------------------------------------------------------------------------

describe("idleDays", () => {
  it("returns 0 when lastMovedAt is null", () => {
    expect(idleDays(null)).toBe(0);
  });

  it("returns the correct number of whole days for a card moved 5 days ago", () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
    expect(idleDays(fiveDaysAgo)).toBe(5);
  });

  it("returns 0 for a card moved just now (less than a full day)", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(idleDays(oneHourAgo)).toBe(0);
  });
});
