import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SectionErrorBoundary from "../components/SectionErrorBoundary";

function BrokenComponent(): JSX.Element {
  throw new Error("test crash");
}

function WorkingComponent() {
  return <div>works fine</div>;
}

describe("SectionErrorBoundary", () => {
  beforeEach(() => {
    // Suppress React's console.error for expected boundary catches.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders children when there is no error", () => {
    render(
      <SectionErrorBoundary section="Test">
        <WorkingComponent />
      </SectionErrorBoundary>
    );
    expect(screen.getByText("works fine")).toBeInTheDocument();
  });

  it("renders inline fallback when a child throws", () => {
    render(
      <SectionErrorBoundary section="Analytics">
        <BrokenComponent />
      </SectionErrorBoundary>
    );
    expect(screen.getByText("Analytics failed to load")).toBeInTheDocument();
    expect(screen.getByText("test crash")).toBeInTheDocument();
  });

  it("shows a retry button that clears the error", async () => {
    // First render with a broken child, then after retry render a working one.
    let shouldThrow = true;

    function MaybeBroken() {
      if (shouldThrow) throw new Error("intermittent");
      return <div>recovered</div>;
    }

    const { rerender } = render(
      <SectionErrorBoundary section="Board Grid">
        <MaybeBroken />
      </SectionErrorBoundary>
    );
    expect(screen.getByText("Board Grid failed to load")).toBeInTheDocument();

    // Fix the child and click retry.
    shouldThrow = false;
    await userEvent.click(screen.getByText("Retry"));

    // After retry, the boundary re-renders children.
    // We need to trigger a rerender after state clears.
    rerender(
      <SectionErrorBoundary section="Board Grid">
        <MaybeBroken />
      </SectionErrorBoundary>
    );
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });

  it("logs the error with the section name", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <SectionErrorBoundary section="Card Detail">
        <BrokenComponent />
      </SectionErrorBoundary>
    );
    expect(spy).toHaveBeenCalledWith(
      "[Card Detail] Uncaught error:",
      expect.any(Error),
      expect.any(String)
    );
  });
});
