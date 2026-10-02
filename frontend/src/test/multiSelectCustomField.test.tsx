import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import CustomFieldValueInput from "../components/Card/CustomFieldValueInput";
import CustomFieldValueDisplay from "../components/Card/CustomFieldValueDisplay";
import CustomFieldEditRow from "../components/Card/CustomFieldEditRow";
import { EMPTY_FILTER, isCustomFieldFilterActive, countActiveFilters } from "../components/Board/FilterBar";
import { filterCards, hasActiveClientFilters } from "../utils/filterCards";
import {
  formatCustomFieldValue, isValidForType, parseMultiSelect, serializeMultiSelect,
} from "../utils/customFieldValue";
import type { Card, CustomFieldDefinition, FieldDefinitionShape } from "../types";

/**
 * #1391 — the multi_select custom field type: value helpers, the editor's
 * keyboard map and commit-on-close contract, the read-only chips, and the
 * filter's exact-membership matching.
 */

function msDef(overrides: Partial<FieldDefinitionShape> = {}): FieldDefinitionShape {
  return { name: "Platforms", field_type: "multi_select", choices: ["web", "ios", "android"], help_text: "", ...overrides };
}

function fullDef(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: 5, uid: "cfuid005", name: "Platforms", field_type: "multi_select",
    choices: ["web", "ios", "android"], position: 0, show_on_card: true,
    is_required: false, help_text: "", created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: "carduid00001", column: 10, swimlane: 20, title: "Card",
    description: "", priority: "medium", assignee: null, labels: [],
    due_date: null, weight: 1, position: 0, created_by: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1,
    custom_field_values: [],
    blocker_count: 0, external_ref: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

describe("multi-select value helpers", () => {
  it("parses a stored JSON array", () => {
    expect(parseMultiSelect('["web","ios"]')).toEqual(["web", "ios"]);
  });

  it("treats empty, malformed and non-array values as no entries", () => {
    for (const raw of [undefined, null, "", "web", "{\"a\":1}", "[", "42"]) {
      expect(parseMultiSelect(raw)).toEqual([]);
    }
  });

  it("drops non-string members rather than throwing", () => {
    expect(parseMultiSelect('["web",1,null,"ios"]')).toEqual(["web", "ios"]);
  });

  it("serializes canonically: deduped, choice order, orphans last, compact", () => {
    expect(serializeMultiSelect(["old", "android", "web", "web"], ["web", "ios", "android"]))
      .toBe('["web","android","old"]');
  });

  it("serializes the empty set as an empty string (clears the field)", () => {
    expect(serializeMultiSelect([], ["web"])).toBe("");
  });

  it("keeps non-ASCII entries unescaped, matching the server encoding", () => {
    expect(serializeMultiSelect(["東京"], ["東京"])).toBe('["東京"]');
  });

  it("validates only the JSON-array-of-strings shape", () => {
    expect(isValidForType(msDef(), '["web"]')).toBe(true);
    expect(isValidForType(msDef(), "")).toBe(true);
    expect(isValidForType(msDef(), "web")).toBe(false);
    expect(isValidForType(msDef(), "[1]")).toBe(false);
  });

  it("formats entries comma-separated for plain-text surfaces", () => {
    expect(formatCustomFieldValue(msDef(), '["web","ios"]', "MM/DD/YYYY")).toBe("web, ios");
  });
});

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function renderEditor(value: string | undefined, onCommit = vi.fn(), def = msDef()) {
  const utils = render(<CustomFieldValueInput definition={def} value={value} onCommit={onCommit} />);
  return { ...utils, onCommit };
}

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: /^Platforms:/ }));
  // The search input is focused on the next tick.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return screen.getByRole("combobox", { name: "Filter Platforms choices" });
}

function keyEscape() {
  fireEvent.keyDown(document, { key: "Escape" });
}

describe("multi-select editor (#1391)", () => {
  it("shows the stored entries as chips on the trigger", () => {
    renderEditor('["web","ios"]');
    const trigger = screen.getByRole("button", { name: "Platforms: web, ios" });
    expect(within(trigger).getByText("web")).toBeInTheDocument();
    expect(within(trigger).getByText("ios")).toBeInTheDocument();
  });

  it("shows a placeholder when empty", () => {
    renderEditor(undefined);
    expect(screen.getByRole("button", { name: "Platforms: No value" })).toHaveTextContent("— No value —");
  });

  it("opens a listbox of choices with the search focused", async () => {
    renderEditor('["web"]');
    const search = await openMenu();
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("placeholder", "Type to filter");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["web", "ios", "android"]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("status")).toHaveTextContent("1 selected");
  });

  it("does not commit per click, only once on Done", async () => {
    const { onCommit } = renderEditor('["web"]');
    await openMenu();
    fireEvent.mouseDown(screen.getByRole("option", { name: "android" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "ios" }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("3 selected");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('["web","ios","android"]');
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("does not commit when the selection did not change", async () => {
    const { onCommit } = renderEditor('["web"]');
    await openMenu();
    fireEvent.mouseDown(screen.getByRole("option", { name: "ios" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "ios" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits an empty string when everything is unchecked", async () => {
    const { onCommit } = renderEditor('["web"]');
    await openMenu();
    fireEvent.mouseDown(screen.getByRole("option", { name: "web" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onCommit).toHaveBeenCalledWith("");
  });

  it("arrow keys move the active option and Enter / Space toggle it", async () => {
    const { onCommit } = renderEditor(undefined);
    const search = await openMenu();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "ios" }).id);
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: " " });
    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "ArrowUp" }); // clamps at the top
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByRole("status")).toHaveTextContent("3 selected");
    keyEscape();
    expect(onCommit).toHaveBeenCalledWith('["web","ios","android"]');
  });

  it("typing filters the options; Space types into a non-empty search", async () => {
    renderEditor(undefined);
    const search = await openMenu();
    fireEvent.change(search, { target: { value: "AND" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["android"]);
    // Space with a search typed is a character, not a toggle.
    fireEvent.keyDown(search, { key: " " });
    expect(screen.getByRole("status")).toHaveTextContent("0 selected");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No matching choices")).toBeInTheDocument();
  });

  it("first Escape clears a search, the next closes and commits", async () => {
    const { onCommit } = renderEditor(undefined);
    const search = await openMenu();
    fireEvent.change(search, { target: { value: "ios" } });
    fireEvent.keyDown(search, { key: "Enter" });
    keyEscape();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(search).toHaveValue("");
    expect(onCommit).not.toHaveBeenCalled();
    keyEscape();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onCommit).toHaveBeenCalledWith('["ios"]');
    expect(screen.getByRole("button", { name: /^Platforms:/ })).toHaveFocus();
  });

  it("Tab closes, commits, and moves focus past the trigger", async () => {
    const onCommit = vi.fn();
    render(
      <div>
        <CustomFieldValueInput definition={msDef()} value={undefined} onCommit={onCommit} />
        <button type="button">Next control</button>
      </div>
    );
    const search = await openMenu();
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.keyDown(search, { key: "Tab" });
    expect(onCommit).toHaveBeenCalledWith('["web"]');
    expect(screen.getByRole("button", { name: "Next control" })).toHaveFocus();
  });

  it("a click outside closes and commits", async () => {
    const { onCommit } = renderEditor(undefined);
    await openMenu();
    fireEvent.mouseDown(screen.getByRole("option", { name: "android" }));
    fireEvent.mouseDown(document.body);
    expect(onCommit).toHaveBeenCalledWith('["android"]');
  });

  it("lists orphaned entries under their own heading, checked and removable", async () => {
    const { onCommit } = renderEditor('["web","Legacy"]');
    await openMenu();
    const group = screen.getByRole("group", { name: "No longer a choice" });
    const orphan = within(group).getByRole("option", { name: "Legacy" });
    expect(orphan).toHaveAttribute("aria-selected", "true");
    expect(orphan.className).toContain("text-fg-muted");
    // Kept when only other entries change ...
    fireEvent.mouseDown(screen.getByRole("option", { name: "ios" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onCommit).toHaveBeenLastCalledWith('["web","ios","Legacy"]');
  });

  it("an orphan can be dropped", async () => {
    const { onCommit } = renderEditor('["web","Legacy"]');
    await openMenu();
    fireEvent.mouseDown(screen.getByRole("option", { name: "Legacy" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onCommit).toHaveBeenCalledWith('["web"]');
  });

  it("shows the committed selection until the stored value catches up", async () => {
    const onCommit = vi.fn(() => new Promise<void>(() => {}));
    renderEditor('["web"]', onCommit);
    await openMenu();
    fireEvent.mouseDown(screen.getByRole("option", { name: "ios" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "Platforms: web, ios" })).toBeInTheDocument();
  });

  it("reverts and names the field when the save fails", async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error("boom")));
    renderEditor('["web"]', onCommit);
    await openMenu();
    fireEvent.mouseDown(screen.getByRole("option", { name: "ios" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save Platforms. Try again.");
    expect(screen.getByRole("button", { name: "Platforms: web" })).toBeInTheDocument();
  });

  it("an unparseable stored value opens as no entries, not the text fallback", async () => {
    renderEditor("not json");
    expect(screen.queryByText(/Stored value doesn't match/)).not.toBeInTheDocument();
    await openMenu();
    expect(screen.getByRole("status")).toHaveTextContent("0 selected");
  });

  it("is inert when disabled", () => {
    render(<CustomFieldValueInput definition={msDef()} value='["web"]' onCommit={vi.fn()} disabled />);
    expect(screen.getByRole("button", { name: /^Platforms:/ })).toBeDisabled();
  });
});

describe("CustomFieldEditRow — multi-select (#1391)", () => {
  it("reports a failed save on the row and reverts the editor", async () => {
    const onSave = vi.fn(() => Promise.reject(new Error("boom")));
    render(<CustomFieldEditRow definition={fullDef()} value='["web"]' disabled={false} onSave={onSave} />);
    await openMenu();
    fireEvent.mouseDown(screen.getByRole("option", { name: "android" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });
    expect(onSave).toHaveBeenCalledWith('["web","android"]');
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save Platforms. Try again.");
    expect(screen.getByText("Couldn't save")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Platforms: web" })).toBeInTheDocument();
  });

  it("renders read-only chips when the user cannot edit", () => {
    render(<CustomFieldEditRow definition={fullDef()} value='["web","ios"]' disabled onSave={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Platforms:/ })).not.toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("ios")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

describe("CustomFieldValueDisplay — multi-select (#1391)", () => {
  const value = '["web","ios","android","tvos"]';

  it("card chip shows two entries and a +N overflow listing everything", () => {
    render(<CustomFieldValueDisplay definition={msDef({ choices: ["web", "ios", "android", "tvos"] })} value={value} variant="chip" />);
    expect(screen.getByText("web")).toHaveAttribute("title", "web");
    expect(screen.getByText("ios")).toBeInTheDocument();
    expect(screen.queryByText("android")).not.toBeInTheDocument();
    const more = screen.getByText("+2");
    expect(more).toHaveAttribute("title", "web, ios, android, tvos");
    expect(screen.getByTitle("Platforms: web, ios, android, tvos")).toBeInTheDocument();
  });

  it("row chip shows three entries and wraps", () => {
    render(<CustomFieldValueDisplay definition={msDef()} value={value} variant="row-chip" />);
    expect(screen.getByText("android")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("web").parentElement?.className).toContain("flex-wrap");
  });

  it("detail shows every entry", () => {
    render(<CustomFieldValueDisplay definition={msDef()} value={value} variant="detail" />);
    for (const entry of ["web", "ios", "android", "tvos"]) {
      expect(screen.getByText(entry)).toBeInTheDocument();
    }
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it("renders an orphaned entry like any other", () => {
    render(<CustomFieldValueDisplay definition={msDef()} value='["Legacy"]' variant="chip" />);
    expect(screen.getByText("Legacy")).toBeInTheDocument();
  });

  it("renders nothing for an empty array", () => {
    const { container } = render(<CustomFieldValueDisplay definition={msDef()} value="[]" variant="chip" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back to the raw text for an unparseable value", () => {
    render(<CustomFieldValueDisplay definition={msDef()} value="web" variant="detail" />);
    expect(screen.getByText("web")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe("filterCards — multi_choice (#1391)", () => {
  const cards = [
    makeCard({ id: 1, custom_field_values: [{ field_definition: 5, value: '["web","ios"]' }] }),
    makeCard({ id: 2, custom_field_values: [{ field_definition: 5, value: '["android"]' }] }),
    makeCard({ id: 3, custom_field_values: [{ field_definition: 5, value: '["webhooks"]' }] }),
    makeCard({ id: 4, custom_field_values: [{ field_definition: 5, value: "not json" }] }),
    makeCard({ id: 5, custom_field_values: [] }),
  ];
  const filter = (values: string[]) => ({
    ...EMPTY_FILTER,
    customFields: { 5: { kind: "multi_choice" as const, values } },
  });

  it("matches exact membership, never a substring of the JSON", () => {
    expect(filterCards(cards, filter(["web"]))).toEqual([1]);
  });

  it("is OR within the field", () => {
    expect(filterCards(cards, filter(["ios", "android"]))).toEqual([1, 2]);
  });

  it("is AND across fields", () => {
    const withLabelField = cards.map((c) =>
      c.id === 2 ? { ...c, custom_field_values: [...c.custom_field_values, { field_definition: 6, value: "Red" }] } : c
    );
    const filters = {
      ...EMPTY_FILTER,
      customFields: {
        5: { kind: "multi_choice" as const, values: ["ios", "android"] },
        6: { kind: "choice" as const, values: ["Red"] },
      },
    };
    expect(filterCards(withLabelField, filters)).toEqual([2]);
  });

  it("never matches an empty or unparseable stored value", () => {
    expect(filterCards(cards, filter(["not json"]))).toEqual([]);
  });

  it("an empty selection filters nothing", () => {
    expect(filterCards(cards, filter([]))).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts as an active client filter only when something is picked", () => {
    expect(isCustomFieldFilterActive({ kind: "multi_choice", values: [] })).toBe(false);
    expect(isCustomFieldFilterActive({ kind: "multi_choice", values: ["web"] })).toBe(true);
    expect(hasActiveClientFilters(filter([]))).toBe(false);
    expect(hasActiveClientFilters(filter(["web"]))).toBe(true);
    expect(countActiveFilters(filter(["web"]))).toBe(1);
  });
});
