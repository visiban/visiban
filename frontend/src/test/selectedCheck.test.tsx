import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SelectedCheck from "../components/Common/SelectedCheck";

describe("SelectedCheck", () => {
  it("draws the check inside an aria-hidden slot when selected", () => {
    const { container } = render(<SelectedCheck selected testId="mark" slotClassName="slot w-3" iconClassName="icon" />);
    const mark = screen.getByTestId("mark");
    expect(mark.getAttribute("class")).toBe("icon");
    const slot = container.firstElementChild as HTMLElement;
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(slot.className).toBe("slot w-3");
    expect(slot.contains(mark)).toBe(true);
  });

  it("keeps the reserved blank slot when not selected", () => {
    const { container } = render(<SelectedCheck selected={false} testId="mark" slotClassName="slot" />);
    expect(screen.queryByTestId("mark")).toBeNull();
    const slot = container.firstElementChild as HTMLElement;
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(slot.className).toBe("slot");
    expect(slot.childElementCount).toBe(0);
  });

  it("defaults the icon size", () => {
    render(<SelectedCheck selected testId="mark" slotClassName="slot" />);
    expect(screen.getByTestId("mark").getAttribute("class")).toBe("w-3 h-3");
  });
});
