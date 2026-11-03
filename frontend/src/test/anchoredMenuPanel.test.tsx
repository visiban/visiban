import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CheckboxDropdown from "../components/Common/CheckboxDropdown";
import ActivityFilterDropdown from "../components/Card/ActivityFilterDropdown";
import SavedFiltersDropdown from "../components/Board/SavedFiltersDropdown";
import { useEscapeStack } from "../hooks/useEscapeStack";
import { EMPTY_FILTER } from "../components/Board/FilterBar";

// #1482 — the in-flow `absolute top-full` menus became anchored `fixed` panels.
// jsdom does not clip or lay out, so these assert the structural contract that
// makes clipping impossible (fixed, portaled out of any scroll region) plus the
// dismissal/focus behavior; the real-browser hit-test is in e2e/anchored-menus-clip.spec.ts.

const OPTIONS = [
  { value: 1, label: "Alpha" },
  { value: 2, label: "Beta" },
];

function ScrollRegion({ children }: { children: React.ReactNode }) {
  return <div data-testid="region" style={{ overflow: "auto", height: 40 }}>{children}</div>;
}

describe("CheckboxDropdown menu (#1482)", () => {
  it("portals a fixed panel out of an overflow ancestor", async () => {
    render(<ScrollRegion><CheckboxDropdown label="Label" options={OPTIONS} selected={[]} onChange={() => {}} /></ScrollRegion>);
    await userEvent.setup().click(screen.getByRole("button", { name: /label/i }));
    const menu = screen.getByRole("group", { name: "Label" });
    expect(menu.style.position).toBe("fixed");
    expect(screen.getByTestId("region").contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  it("focuses the first checkbox once placed", async () => {
    render(<CheckboxDropdown label="Label" options={OPTIONS} selected={[]} onChange={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /label/i }));
    expect(screen.getByRole("checkbox", { name: /alpha/i })).toHaveFocus();
  });

  it("keeps the menu open for a click inside the portaled panel and closes on an outside click", async () => {
    const onOpenChange = vi.fn();
    render(<CheckboxDropdown label="Label" options={OPTIONS} selected={[]} onChange={() => {}} onOpenChange={onOpenChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /label/i }));
    await user.click(screen.getByText("Beta"));
    expect(screen.getByRole("group")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("closes on Escape, returning focus to the trigger", async () => {
    render(<CheckboxDropdown label="Label" options={OPTIONS} selected={[]} onChange={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /label/i }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /label/i })).toHaveFocus();
  });

  it("dismisses on window resize and on a scroll outside the panel, not inside it", async () => {
    render(<CheckboxDropdown label="Label" options={OPTIONS} selected={[]} onChange={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /label/i }));
    fireEvent.scroll(screen.getByRole("group").firstElementChild!);
    expect(screen.getByRole("group")).toBeInTheDocument();
    fireEvent.scroll(document.body);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /label/i }));
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("reports a resize or outside-scroll dismissal through onOpenChange (FilterBar collapses the facet)", async () => {
    const onOpenChange = vi.fn();
    render(<CheckboxDropdown label="Label" options={OPTIONS} selected={[]} onChange={() => {}} onOpenChange={onOpenChange} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /label/i }));
    fireEvent.scroll(document.body);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("caps the panel at the viewport so a long list scrolls", async () => {
    render(<CheckboxDropdown label="Label" options={OPTIONS} selected={[]} onChange={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /label/i }));
    expect(screen.getByRole("group").style.maxHeight).toBe("calc(100vh - 16px)");
  });
});

describe("ActivityFilterDropdown menu (#1482)", () => {
  it("stays in the trigger's DOM subtree (inside the card sheet's focus trap) but fixed", async () => {
    render(
      <ScrollRegion>
        <ActivityFilterDropdown label="Filter" options={[{ value: "a", label: "A" }]} selected={[]} onChange={() => {}} />
      </ScrollRegion>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /filter/i }));
    const menu = screen.getByRole("group", { name: "Filter" });
    expect(menu.style.position).toBe("fixed");
    expect(screen.getByTestId("region").contains(menu)).toBe(true);
  });

  it("Escape closes the menu without reaching the card panel's close handler (priority 30)", async () => {
    const closePanel = vi.fn();
    function Host() {
      useEscapeStack(() => { closePanel() }, 30);
      return <ActivityFilterDropdown label="Filter" options={[{ value: "a", label: "A" }]} selected={[]} onChange={() => {}} />;
    }
    render(<Host />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /filter/i }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Filter" })).not.toBeInTheDocument();
    expect(closePanel).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(closePanel).toHaveBeenCalledTimes(1);
  });

  it("dismisses on an outside scroll and focuses the All checkbox once placed", async () => {
    render(<ActivityFilterDropdown label="Filter" options={[{ value: "a", label: "A" }]} selected={[]} onChange={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /filter/i }));
    expect(screen.getByRole("checkbox", { name: /select all event types/i })).toHaveFocus();
    fireEvent.scroll(document.body);
    expect(screen.queryByRole("group", { name: "Filter" })).not.toBeInTheDocument();
  });
});

describe("SavedFiltersDropdown menu (#1482)", () => {
  const props = {
    boardId: 1, filters: EMPTY_FILTER, savedFilters: [], loading: false,
    onLoad: vi.fn(), onSave: vi.fn().mockResolvedValue({}), onDelete: vi.fn(),
  };

  it("portals a fixed panel out of an overflow ancestor", async () => {
    render(<ScrollRegion><SavedFiltersDropdown {...props} /></ScrollRegion>);
    await userEvent.setup().click(screen.getByRole("button", { name: /saved filters/i }));
    const text = screen.getByText(/no saved filters yet/i);
    const panel = text.closest("div[style]") as HTMLElement;
    expect(panel.style.position).toBe("fixed");
    expect(screen.getByTestId("region").contains(panel)).toBe(false);
  });

  it("moves focus into the portaled panel once placed", async () => {
    render(<SavedFiltersDropdown {...props} filters={{ ...EMPTY_FILTER, search: "x" }} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /saved filters/i }));
    expect(screen.getByText(/save current filters/i).closest("button")).toHaveFocus();
  });

  it("closes on an outside scroll and leaves save mode", async () => {
    render(<SavedFiltersDropdown {...props} filters={{ ...EMPTY_FILTER, search: "x" }} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /saved filters/i }));
    await user.click(screen.getByText(/save current filters/i));
    expect(screen.getByPlaceholderText(/filter name/i)).toBeInTheDocument();
    fireEvent.scroll(document.body);
    expect(screen.queryByPlaceholderText(/filter name/i)).not.toBeInTheDocument();
  });

  it("a click on the portaled panel does not count as an outside click", async () => {
    render(<SavedFiltersDropdown {...props} filters={{ ...EMPTY_FILTER, search: "x" }} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /saved filters/i }));
    await user.click(screen.getByText(/save current filters/i));
    await user.click(screen.getByPlaceholderText(/filter name/i));
    expect(screen.getByPlaceholderText(/filter name/i)).toBeInTheDocument();
  });
});
