import { describe, expect, it } from "vitest";
import { customParentPlural, parentPlural, parentSingular } from "../utils/parentItemNames";

describe("parentItemNames (#2212)", () => {
  it("falls back to Parent / Parents when empty, blank or absent", () => {
    for (const raw of ["", "   ", null, undefined]) {
      expect(parentSingular(raw)).toBe("Parent");
      expect(parentPlural(raw)).toBe("Parents");
      expect(customParentPlural(raw)).toBeNull();
    }
  });

  it("uses the board's own name, trimmed", () => {
    expect(parentSingular(" Initiative ")).toBe("Initiative");
    expect(parentPlural("Initiatives")).toBe("Initiatives");
    expect(customParentPlural(" Releases ")).toBe("Releases");
  });
});
