import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ActivityFilterDropdown from "../components/Card/ActivityFilterDropdown";

const OPTIONS = [
  { value: "move", label: "Column moves", color: "#3b82f6" },
  { value: "comment", label: "Comments", color: "#38bdf8" },
  { value: "field", label: "Field changes", color: "#64748b" },
  { value: "system", label: "System events", color: "#475569" },
];

describe("ActivityFilterDropdown", () => {
  it("renders the default label when nothing is selected", () => {
    render(
      <ActivityFilterDropdown
        label="Filter"
        options={OPTIONS}
        selected={[]}
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: /filter/i })).toBeInTheDocument();
  });

  it("opens the menu on trigger click and renders every option with its full label", async () => {
    const user = userEvent.setup();
    render(
      <ActivityFilterDropdown
        label="Filter"
        options={OPTIONS}
        selected={[]}
        onChange={() => {}}
      />
    );
    await user.click(screen.getByRole("button", { name: /filter/i }));
    // Every option label must render in full — regression guard against truncation.
    for (const opt of OPTIONS) {
      expect(screen.getByText(opt.label)).toBeInTheDocument();
    }
  });

  it("right-aligns the menu panel (right-0, no left-0) so it does not clip off the drawer", async () => {
    const user = userEvent.setup();
    render(
      <ActivityFilterDropdown
        label="Filter"
        options={OPTIONS}
        selected={[]}
        onChange={() => {}}
      />
    );
    await user.click(screen.getByRole("button", { name: /filter/i }));
    const menu = screen.getByRole("menu");
    expect(menu.className).toMatch(/\bright-0\b/);
    expect(menu.className).not.toMatch(/\bleft-0\b/);
  });

  it("uses whitespace-nowrap on option rows so labels never wrap/truncate", async () => {
    const user = userEvent.setup();
    render(
      <ActivityFilterDropdown
        label="Filter"
        options={OPTIONS}
        selected={[]}
        onChange={() => {}}
      />
    );
    await user.click(screen.getByRole("button", { name: /filter/i }));
    const label = screen.getByText("Column moves").closest("label");
    expect(label?.className).toMatch(/whitespace-nowrap/);
  });

  it("calls onChange with the toggled value when an unchecked option is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ActivityFilterDropdown
        label="Filter"
        options={OPTIONS}
        selected={[]}
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole("button", { name: /filter/i }));
    await user.click(screen.getByLabelText("Column moves"));
    expect(onChange).toHaveBeenCalledWith(["move"]);
  });

  it("calls onChange with the value removed when a checked option is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ActivityFilterDropdown
        label="Filter"
        options={OPTIONS}
        selected={["move", "comment"]}
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole("button", { name: /filter/i }));
    await user.click(screen.getByLabelText("Column moves"));
    expect(onChange).toHaveBeenCalledWith(["comment"]);
  });

  it("shows 'Filter: All' when every option is selected", () => {
    render(
      <ActivityFilterDropdown
        label="Filter"
        options={OPTIONS}
        selected={OPTIONS.map((o) => o.value)}
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: /filter: all/i })).toBeInTheDocument();
  });

  it("applies the active border color when one or more options are selected", () => {
    render(
      <ActivityFilterDropdown
        label="Filter"
        options={OPTIONS}
        selected={["move"]}
        onChange={() => {}}
      />
    );
    const trigger = screen.getByRole("button", { name: /filter/i });
    expect(trigger.className).toMatch(/border-blue-400/);
    expect(trigger.className).toMatch(/text-blue-400/);
  });

  it("closes the menu when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(
      <ActivityFilterDropdown
        label="Filter"
        options={OPTIONS}
        selected={[]}
        onChange={() => {}}
      />
    );
    await user.click(screen.getByRole("button", { name: /filter/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
