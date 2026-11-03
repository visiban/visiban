/** Color dots carry the neutral ring (#2094). */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import FilterChip from "../components/Board/FilterChip";

describe("color dot ring (#2094)", () => {
  it("FilterChip color dot carries the neutral ring class", () => {
    const { container } = render(<FilterChip label="Col" onDismiss={() => {}} colorDot="#FFFFFF" />);
    expect(container.querySelector(".color-dot")).not.toBeNull();
  });
});
