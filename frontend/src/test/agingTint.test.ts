import { describe, it, expect } from "vitest";
import {
  AGING_STAGE_CLASSES,
  agingReference,
  agingTint,
  agingStage,
  formatAgingTooltip,
  idleDays,
  staleBadgeToneClass,
  urgencyBadgeToneClass,
  warningFraction,
} from "../utils/agingTint";

const DAY = 86_400_000;
// Pinned clock: every case passes `now` explicitly, so edges are exact to the
// millisecond and never drift with the wall clock.
const NOW = Date.parse("2026-05-01T12:00:00.000Z");
const THRESHOLD = 14;

/** ISO timestamp for a card idle for `ms` milliseconds at NOW. */
const idleFor = (ms: number) => new Date(NOW - ms).toISOString();
/** ISO timestamp for a card idle for `ratio` × the 14-day threshold. */
const atRatio = (ratio: number) => idleFor(ratio * THRESHOLD * DAY);
const stageAt = (lastMovedAt: string, pct = 50) => agingTint(lastMovedAt, THRESHOLD, pct, NOW).stage;

// ---------------------------------------------------------------------------
// agingTint
// ---------------------------------------------------------------------------

describe("agingTint", () => {
  it("returns zero state when lastMovedAt is null", () => {
    const result = agingTint(null, 14, 50);
    expect(result.overlayClass).toBeNull();
    expect(result.bodyOpacityClass).toBe("");
    expect(result.stage).toBe("none");
    expect(result.idleDays).toBe(0);
  });

  it("returns zero state for a fresh card (moved just now)", () => {
    const now = new Date().toISOString();
    const result = agingTint(now, 14, 50);
    expect(result.overlayClass).toBeNull();
    expect(result.bodyOpacityClass).toBe("");
    expect(result.stage).toBe("none");
  });

  it("keeps a fresh card untinted at every warning percentage, including 0", () => {
    for (const pct of [0, 1, 25, 50, 75, 100]) {
      expect(stageAt(idleFor(60_000), pct)).toBe("none");
    }
  });

  it("returns the yellow warning stage between the warning point and the threshold", () => {
    // threshold=14, warning=50% → warning starts at 7 days; 10 days is past it.
    const result = agingTint(idleFor(10 * DAY), 14, 50, NOW);
    expect(result.stage).toBe("warning");
    expect(result.overlayClass).toBe("absolute inset-0 rounded-md pointer-events-none bg-warning-emphasis/10");
    expect(result.bodyOpacityClass).toBe("opacity-90");
    expect(result.idleDays).toBe(10);
  });

  it("returns the orange stale stage past the threshold", () => {
    const result = agingTint(idleFor(15 * DAY), 14, 50, NOW);
    expect(result.stage).toBe("stale");
    expect(result.overlayClass).toBe("absolute inset-0 rounded-md pointer-events-none bg-warning/15");
    expect(result.bodyOpacityClass).toBe("opacity-85");
  });

  it("renders three distinguishable stages at 1.5x, 2.5x and 4x the threshold", () => {
    const at15 = agingTint(atRatio(1.5), THRESHOLD, 50, NOW);
    const at25 = agingTint(atRatio(2.5), THRESHOLD, 50, NOW);
    const at4 = agingTint(atRatio(4), THRESHOLD, 50, NOW);
    expect([at15.stage, at25.stage, at4.stage]).toEqual(["stale", "stale2x", "stale3x"]);
    expect(at25.overlayClass).toContain("bg-danger/15");
    expect(at4.overlayClass).toContain("bg-stale-severe/20");
    // The darkest stage carries an inset ring (a non-color cue that also keeps
    // the card distinct from the near-black dark canvas). It is inset so the
    // card's priority-colored border is untouched.
    expect(at4.overlayClass).toContain("ring-2 ring-inset ring-stale-severe");
    expect(new Set([at15.overlayClass, at25.overlayClass, at4.overlayClass]).size).toBe(3);
  });

  // Pinned so a regression to the old opacity-60 stale stage (title 4.15:1,
  // badge 1.9:1) fails here; onTintTokens.test.ts derives its contrast check
  // from these same classes.
  it("pins each stage's overlay and body opacity", () => {
    expect(AGING_STAGE_CLASSES.none).toEqual({ overlayClass: null, bodyOpacityClass: "", metaClass: "" });
    expect(AGING_STAGE_CLASSES.warning.bodyOpacityClass).toBe("opacity-90");
    expect(AGING_STAGE_CLASSES.stale.bodyOpacityClass).toBe("opacity-85");
    expect(AGING_STAGE_CLASSES.stale2x.bodyOpacityClass).toBe("opacity-85");
    expect(AGING_STAGE_CLASSES.stale3x.bodyOpacityClass).toBe("opacity-85");
    expect(AGING_STAGE_CLASSES.warning.overlayClass).toContain("bg-warning-emphasis/10");
    expect(AGING_STAGE_CLASSES.stale.overlayClass).toContain("bg-warning/15");
    expect(AGING_STAGE_CLASSES.stale2x.overlayClass).toContain("bg-danger/15");
    expect(AGING_STAGE_CLASSES.stale3x.overlayClass).toContain("bg-stale-severe/20");
  });

  // #1844: every tinted stage scopes the card's metadata text to on-tint tones.
  it.each(["warning", "stale", "stale2x", "stale3x"] as const)("%s carries the on-tint metadata scope", (stage) => {
    expect(AGING_STAGE_CLASSES[stage].metaClass).toBe("card-aging-meta");
    expect(agingTint(new Date(Date.now() - { warning: 8, stale: 15, stale2x: 30, stale3x: 45 }[stage] * DAY).toISOString(), 14, 50).metaClass).toBe("card-aging-meta");
  });

  it("agingReference falls back to created_at for a never-moved card, like the server", () => {
    expect(agingReference({ last_moved_at: "2026-04-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" })).toBe("2026-04-01T00:00:00Z");
    expect(agingReference({ last_moved_at: null, created_at: "2026-01-01T00:00:00Z" })).toBe("2026-01-01T00:00:00Z");
    // 1.5x and 4x the threshold from created_at alone
    expect(agingTint(agingReference({ last_moved_at: null, created_at: atRatio(1.5) }), THRESHOLD, 50, NOW).stage).toBe("stale");
    expect(agingTint(agingReference({ last_moved_at: null, created_at: atRatio(4) }), THRESHOLD, 50, NOW).stage).toBe("stale3x");
  });

  it("does not cap the ratio: 15 days and 150 days idle look different", () => {
    const a = agingTint(idleFor(15 * DAY), 14, 50, NOW);
    const b = agingTint(idleFor(150 * DAY), 14, 50, NOW);
    expect(a.ratio).toBeCloseTo(15 / 14);
    expect(b.ratio).toBeCloseTo(150 / 14);
    expect(a.overlayClass).not.toBe(b.overlayClass);
    expect(b.idleDays).toBe(150);
  });

  // Every lower bound is inclusive: exactly at an edge is the higher stage,
  // one millisecond before it is the lower one.
  describe("stage edges (lower bound inclusive)", () => {
    it.each([
      ["warning point (50%)", 0.5, "none", "warning"],
      ["1.0x", 1, "warning", "stale"],
      ["2.0x", 2, "stale", "stale2x"],
      ["3.0x", 3, "stale2x", "stale3x"],
    ])("%s: just below → %s, at → %s", (_label, ratio, below, at) => {
      const edgeMs = (ratio as number) * THRESHOLD * DAY;
      expect(stageAt(idleFor(edgeMs - 1))).toBe(below);
      expect(stageAt(idleFor(edgeMs))).toBe(at);
    });
  });

  describe("stale_warning_pct is the percent of the threshold used (#1841 inversion fix)", () => {
    it("at 75%: no tint at 70% of the threshold, warning at exactly 75%", () => {
      expect(stageAt(atRatio(0.7), 75)).toBe("none");
      expect(stageAt(idleFor(0.75 * THRESHOLD * DAY - 1), 75)).toBe("none");
      expect(stageAt(atRatio(0.75), 75)).toBe("warning");
    });

    it("at 25%: warning from 25% of the threshold (the old code waited until 75%)", () => {
      expect(stageAt(atRatio(0.2), 25)).toBe("none");
      expect(stageAt(atRatio(0.25), 25)).toBe("warning");
      expect(stageAt(atRatio(0.5), 25)).toBe("warning");
    });

    it("at 0%: the warning stage is off — no tint until the threshold", () => {
      expect(stageAt(atRatio(0.99), 0)).toBe("none");
      expect(stageAt(atRatio(1), 0)).toBe("stale");
    });

    it("at 100%: the warning stage is empty — it coincides with the stale edge", () => {
      expect(stageAt(idleFor(THRESHOLD * DAY - 1), 100)).toBe("none");
      expect(stageAt(atRatio(1), 100)).toBe("stale");
    });
  });

  it("does not throw when thresholdDays is 0 (clamped to 1)", () => {
    expect(() => agingTint(idleFor(10 * DAY), 0, 50, NOW)).not.toThrow();
    // 10 days against a 1-day threshold is 10x → darkest stage.
    expect(agingTint(idleFor(10 * DAY), 0, 50, NOW).stage).toBe("stale3x");
  });

  it("treats a last_moved_at in the future (clock skew) as fresh", () => {
    const result = agingTint(new Date(NOW + DAY).toISOString(), 14, 50, NOW);
    expect(result.stage).toBe("none");
    expect(result.ratio).toBe(0);
    expect(result.idleDays).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// agingStage / warningFraction — shared with the analytics heatmap
// ---------------------------------------------------------------------------

describe("agingStage", () => {
  it("maps ratios onto stages", () => {
    expect(agingStage(0, 50)).toBe("none");
    expect(agingStage(0.5, 50)).toBe("warning");
    expect(agingStage(1, 50)).toBe("stale");
    expect(agingStage(2, 50)).toBe("stale2x");
    expect(agingStage(3, 50)).toBe("stale3x");
    expect(agingStage(40, 50)).toBe("stale3x");
  });

  it("warningFraction returns null for 0 and clamps above 100", () => {
    expect(warningFraction(0)).toBeNull();
    expect(warningFraction(-5)).toBeNull();
    expect(warningFraction(75)).toBe(0.75);
    expect(warningFraction(150)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatAgingTooltip
// ---------------------------------------------------------------------------

describe("formatAgingTooltip", () => {
  const tint = (ms: number, pct = 50) => agingTint(idleFor(ms), THRESHOLD, pct, NOW);

  it("returns null when there is no tint", () => {
    expect(formatAgingTooltip(tint(DAY), THRESHOLD, 50, false, 0)).toBeNull();
  });

  it("warning stage states idle days, the warning point and the stale point", () => {
    expect(formatAgingTooltip(tint(9 * DAY), THRESHOLD, 50, false, 0)).toBe("Idle 9d · warning at 7d · stale at 14d");
  });

  it("warning point in the tooltip follows the corrected percentage", () => {
    expect(formatAgingTooltip(tint(11 * DAY, 75), THRESHOLD, 75, false, 0)).toBe("Idle 11d · warning at 10d · stale at 14d");
  });

  // The warning point is floored like idleDays, so a tinted card never reads
  // "warning at" a day later than its own idle days.
  it.each([
    // [threshold, pct, idle days, expected]
    [14, 75, 10.6, "Idle 10d · warning at 10d · stale at 14d"],
    [7, 50, 3.5, "Idle 3d · warning at 3d · stale at 7d"],
    [7, 50, 3.9, "Idle 3d · warning at 3d · stale at 7d"],
  ])("agrees with the tint inside the rounding window (%id at %i%%, %fd idle)", (thresh, pct, days, expected) => {
    const aging = agingTint(idleFor(days * DAY), thresh, pct, NOW);
    expect(aging.stage).toBe("warning");
    expect(formatAgingTooltip(aging, thresh, pct, false, 0)).toBe(expected);
  });

  it("stale card the server agrees on: Stale · idle days · threshold multiple", () => {
    expect(formatAgingTooltip(tint(41 * DAY), THRESHOLD, 50, true, 0)).toBe("Stale · 41d · 2.9× the 14d threshold");
  });

  it("floors the multiple so a card still in the 2x stage never reads 3.0×", () => {
    const aging = tint(3 * THRESHOLD * DAY - 60_000);
    expect(aging.stage).toBe("stale2x");
    expect(formatAgingTooltip(aging, THRESHOLD, 50, true, 0)).toContain("2.9× the 14d threshold");
  });

  it("mentions blockers on a stale card, singular and plural", () => {
    expect(formatAgingTooltip(tint(41 * DAY), THRESHOLD, 50, true, 2)).toBe(
      "Stale · 41d · 2.9× the 14d threshold · blocked by 2 cards",
    );
    expect(formatAgingTooltip(tint(41 * DAY), THRESHOLD, 50, true, 1)).toBe(
      "Stale · 41d · 2.9× the 14d threshold · blocked by 1 card",
    );
  });

  // #1149: a manual block is "blocked" too, with the relation count kept.
  it("mentions a manual block on a stale card, alone or with relation blockers", () => {
    expect(formatAgingTooltip(tint(41 * DAY), THRESHOLD, 50, true, 0, true)).toBe(
      "Stale · 41d · 2.9× the 14d threshold · blocked",
    );
    expect(formatAgingTooltip(tint(41 * DAY), THRESHOLD, 50, true, 2, true)).toBe(
      "Stale · 41d · 2.9× the 14d threshold · blocked, also by 2 cards",
    );
    expect(formatAgingTooltip(tint(9 * DAY), THRESHOLD, 50, false, 0, true)).not.toContain("blocked");
  });

  it("does not mention blockers before the card is stale", () => {
    expect(formatAgingTooltip(tint(9 * DAY), THRESHOLD, 50, false, 3)).not.toContain("blocked");
  });

  it("does not claim Stale when the server disagrees with the client tint", () => {
    expect(formatAgingTooltip(tint(15 * DAY), THRESHOLD, 50, false, 0)).toBe("Idle 15d · stale at 14d");
  });
});

describe("staleBadgeToneClass", () => {
  it("uses the on-tint token of the stage's hue", () => {
    expect(staleBadgeToneClass("none")).toBe("text-warning-on-tint");
    expect(staleBadgeToneClass("warning")).toBe("text-warning-on-tint");
    expect(staleBadgeToneClass("stale")).toBe("text-warning-on-tint");
    expect(staleBadgeToneClass("stale2x")).toBe("text-danger-on-tint");
    expect(staleBadgeToneClass("stale3x")).toBe("text-danger-on-tint");
  });
});

describe("urgencyBadgeToneClass", () => {
  it("uses plain tokens on an untinted card", () => {
    expect(urgencyBadgeToneClass("danger", "none")).toBe("text-danger");
    // Warning is the exception: plain `text-warning` is 3.56:1 on white (#2029, #871).
    expect(urgencyBadgeToneClass("warning", "none")).toBe("text-warning-on-tint");
    expect(urgencyBadgeToneClass("info", "none")).toBe("text-info");
  });

  it("uses the badge hue's on-tint token on the yellow and orange stages", () => {
    for (const stage of ["warning", "stale"] as const) {
      expect(urgencyBadgeToneClass("danger", stage)).toBe("text-danger-on-tint");
      expect(urgencyBadgeToneClass("warning", stage)).toBe("text-warning-on-tint");
      expect(urgencyBadgeToneClass("info", stage)).toBe("text-info-on-tint");
    }
  });

  it("moves a warning-toned badge to danger-on-tint on the red stages (amber is sub-AA there)", () => {
    for (const stage of ["stale2x", "stale3x"] as const) {
      expect(urgencyBadgeToneClass("warning", stage)).toBe("text-danger-on-tint");
      expect(urgencyBadgeToneClass("danger", stage)).toBe("text-danger-on-tint");
      expect(urgencyBadgeToneClass("info", stage)).toBe("text-info-on-tint");
    }
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
