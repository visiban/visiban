import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import MultiSelectDropdown from "../components/Common/MultiSelectDropdown";

/**
 * #1391 — the Common commit-on-close checklist primitive: ARIA wiring,
 * scroll-into-view on arrowing, the active-row ring, and positioning
 * (flip upward, close on scroll/resize). The value-editor behaviors built on
 * it are covered in multiSelectCustomField.test.tsx.
 */

const OPTIONS = ["alpha", "beta", "gamma", "delta"];

function renderDropdown(props: Partial<React.ComponentProps<typeof MultiSelectDropdown>> = {}) {
  const onCommit = vi.fn();
  render(
    <MultiSelectDropdown
      label="Tags"
      options={OPTIONS}
      selected={[]}
      onCommit={onCommit}
      escapePriority={39}
      {...props}
    />
  );
  return { onCommit };
}

async function open() {
  fireEvent.click(screen.getByRole("button", { name: /^Tags:/ }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return screen.getByRole("combobox", { name: "Filter Tags choices" });
}

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
});

afterEach(() => {
  cleanup();
  // @ts-expect-error -- jsdom has no scrollIntoView; remove the stub again
  delete Element.prototype.scrollIntoView;
});

describe("MultiSelectDropdown (#1391)", () => {
  it("wires the search as a combobox controlling a multiselectable listbox", async () => {
    renderDropdown();
    const search = await open();
    expect(search).toHaveAttribute("aria-expanded", "true");
    expect(search).toHaveAttribute("aria-autocomplete", "list");
    expect(search).toHaveAttribute("aria-haspopup", "listbox");
    const listbox = screen.getByRole("listbox", { name: "Tags" });
    expect(listbox).toHaveAttribute("aria-multiselectable", "true");
    expect(search).toHaveAttribute("aria-controls", listbox.id);
  });

  it("scrolls the active option into view as the arrows move it", async () => {
    renderDropdown();
    const search = await open();
    scrollIntoView.mockClear();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    const active = screen.getByRole("option", { name: "gamma" });
    expect(search).toHaveAttribute("aria-activedescendant", active.id);
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(active);
  });

  it("marks the active row with a ring, not a second background", async () => {
    renderDropdown({ selected: ["alpha"] });
    await open();
    const active = screen.getByRole("option", { name: "alpha" });
    expect(active.className).toContain("ring-2");
    expect(active.className).toContain("bg-primary-emphasis/20");
    expect(active.className).not.toContain("hover:bg-surface-hover");
    expect(screen.getByRole("option", { name: "beta" }).className).not.toContain("ring-2");
  });

  it("keeps the empty-results message outside the listbox", async () => {
    renderDropdown();
    const search = await open();
    fireEvent.change(search, { target: { value: "zzz" } });
    const message = screen.getByText("No matching choices");
    expect(screen.getByRole("listbox").contains(message)).toBe(false);
    expect(search).not.toHaveAttribute("aria-activedescendant");
  });

  it("closes and commits when the page scrolls, but not when the list scrolls", async () => {
    const { onCommit } = renderDropdown();
    await open();
    fireEvent.mouseDown(screen.getByRole("option", { name: "beta" }));
    fireEvent.scroll(screen.getByRole("listbox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.scroll(document);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onCommit).toHaveBeenCalledWith(["beta"]);
  });

  it("closes on resize", async () => {
    renderDropdown();
    await open();
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens upward when there is no room below the trigger", async () => {
    renderDropdown();
    const trigger = screen.getByRole("button", { name: /^Tags:/ });
    trigger.getBoundingClientRect = () =>
      ({ top: window.innerHeight - 40, bottom: window.innerHeight - 10, left: 20, width: 100, height: 30, right: 120, x: 20, y: 0, toJSON: () => ({}) }) as DOMRect;
    await open();
    const menu = screen.getByRole("listbox").parentElement as HTMLElement;
    expect(menu.style.bottom).toBe("44px");
    expect(menu.style.top).toBe("");
  });

  it("commits a set comparison: re-checking the same entries is not a change", async () => {
    const { onCommit } = renderDropdown({ selected: ["beta", "alpha"] });
    await open();
    fireEvent.mouseDown(screen.getByRole("option", { name: "alpha" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("uses the generic save error message when none is given", async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error("no")));
    renderDropdown({ onCommit });
    await open();
    fireEvent.mouseDown(screen.getByRole("option", { name: "beta" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
  });
});
