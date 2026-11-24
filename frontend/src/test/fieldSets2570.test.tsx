import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { BoardFull, CustomFieldDefinition, CustomFieldSet, CustomFieldValue } from "../types";
import {
  OTHER_FIELDS_KEY, blockProgress, buildCardBlocks, chipsThatFit, countsTowardProgress, defaultSize, isValueFilled, summaryChips,
} from "../utils/fieldSets";
import { fieldSetSizeKey, loadSizes, MAX_ENTRIES } from "../hooks/useFieldSetSizePref";

vi.mock("../components/Card/CustomFieldEditRow", () => ({
  default: ({ definition, value }: { definition: CustomFieldDefinition; value?: string }) => (
    <input aria-label={definition.name} defaultValue={value ?? ""} />
  ),
}));
vi.mock("../api/boards", () => ({
  createFieldSet: vi.fn(), updateFieldSet: vi.fn(), deleteFieldSet: vi.fn(), listFieldSets: vi.fn(),
  reorderFieldSets: vi.fn(), copyFieldSet: vi.fn(), listBoards: vi.fn(), listCustomFieldDefinitions: vi.fn(),
}));
import * as api from "../api/boards";
import FieldSetBlocks, { MAXIMIZE_ESCAPE_PRIORITY } from "../components/Card/FieldSetBlocks";
import BoardSettingsFieldSetsSection, { CopyFieldSetPanel, deleteSetPrompt, apiErrorMessage, FIELD_SET_CONFIRM_ESCAPE_PRIORITY } from "../components/Board/BoardSettingsFieldSetsSection";

const def = (id: number, name: string, field_type: CustomFieldDefinition["field_type"] = "text", extra: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition => ({
  id, uid: `u${id}`, name, field_type, choices: [], position: id, show_on_card: false, is_required: false, help_text: "",
  number_prefix: "", number_suffix: "", number_decimals: null, choice_colors: {}, threshold_direction: "",
  threshold_warn: null, threshold_alert: null, threshold_warn_days: null, threshold_alert_days: null, created_at: "", ...extra,
});
const fset = (id: number, name: string, field_ids: number[], extra: Partial<CustomFieldSet> = {}): CustomFieldSet => ({
  id, uid: `s${id}`, name, description: null, position: id, default_size: "summary", scope: "all", swimlanes: [], field_ids, created_at: "", ...extra,
});
const val = (field_definition: number, value: string) => ({ field_definition, value }) as CustomFieldValue;

const defs = [def(1, "Metrics"), def(2, "Champion"), def(3, "Signed", "checkbox"), def(4, "Tags", "multi_select"), def(5, "Notes")];

describe("fieldSets utils", () => {
  it("fill and progress rules exclude checkbox and dimension fields", () => {
    expect(isValueFilled(defs[0], undefined)).toBe(false);
    expect(isValueFilled(defs[0], "")).toBe(false);
    expect(isValueFilled(defs[3], "[]")).toBe(false);
    expect(isValueFilled(defs[3], '["a"]')).toBe(true);
    expect(countsTowardProgress(defs[2])).toBe(false);
    expect(countsTowardProgress(def(9, "D", "dropdown", { is_dimension: true }))).toBe(false);
    expect(blockProgress(defs.slice(0, 3), [val(1, "x"), val(3, "true")])).toEqual({ filled: 1, total: 2 });
  });

  it("builds blocks in position order with Other fields last, hiding empty out-of-lane sets", () => {
    const sets = [fset(2, "B", [2]), fset(1, "A", [1]), fset(3, "Lane", [4], { scope: "swimlanes", swimlanes: [7] }), fset(4, "Empty", [])];
    const blocks = buildCardBlocks(defs, sets, 8, []);
    expect(blocks.map((b) => b.name)).toEqual(["A", "B", "Other fields"]);
    expect(blocks[2].definitions.map((d) => d.id)).toEqual([3, 5]);
    const withValue = buildCardBlocks(defs, sets, 8, [val(4, '["a"]')]);
    const lane = withValue.find((b) => b.name === "Lane")!;
    expect(lane.outOfLane).toBe(true);
    expect(defaultSize(lane)).toBe("collapsed");
    expect(buildCardBlocks(defs, sets, 7, []).some((b) => b.name === "Lane" && !b.outOfLane)).toBe(true);
    expect(defaultSize(blocks[2])).toBe("expanded");
    expect(blocks[2].key).toBe(OTHER_FIELDS_KEY);
  });

  it("orders missing chips first and fits whole chips only", () => {
    expect(summaryChips(defs.slice(0, 3), [val(1, "x")]).map((c) => [c.definition.id, c.missing])).toEqual([[2, true], [1, false], [3, false]]);
    expect(chipsThatFit([50, 50, 50], 200, 40, 5)).toBe(3);
    expect(chipsThatFit([50, 50, 50], 120, 40, 5)).toBe(1);
    expect(chipsThatFit([300], 100, 40, 5)).toBe(0);
  });
});

describe("useFieldSetSizePref storage", () => {
  beforeEach(() => localStorage.clear());
  it("prunes gone sets, caps entries and treats malformed JSON as empty", () => {
    const key = fieldSetSizeKey(1, 2);
    localStorage.setItem(key, "{not json");
    expect(loadSizes(key, null)).toEqual({});
    const store: Record<string, unknown> = { "5:gone": { s: "summary" }, "5:s1": { s: "expanded", o: "expanded" }, "5:bad": { s: "huge" } };
    for (let i = 0; i < MAX_ENTRIES + 3; i++) store[`${i + 100}:s1`] = { s: "collapsed", o: "summary" };
    localStorage.setItem(key, JSON.stringify(store));
    const loaded = loadSizes(key, new Set(["s1"]));
    expect(loaded["5:gone"]).toBeUndefined();
    expect(loaded["5:bad"]).toBeUndefined();
    expect(Object.keys(loaded)).toHaveLength(MAX_ENTRIES);
  });
});

function renderBlocks(over: Partial<Parameters<typeof FieldSetBlocks>[0]> = {}) {
  const props = {
    boardId: 1, cardId: 10, cardTitle: "Deal", swimlaneId: 7, swimlaneName: "Enterprise", definitions: defs,
    sets: [fset(1, "MEDDIC", [1, 2, 3], { description: "Qualify" }), fset(2, "Money", [4])], values: [val(1, "42")],
    canEdit: true, isAdmin: true, userId: 3, userDateFormat: "MM/DD/YYYY", userTimezone: "", onSave: vi.fn(async () => {}),
    onOpenBoardSettings: vi.fn(), ...over,
  };
  return { props, ...render(<div role="dialog"><FieldSetBlocks {...props} /></div>) };
}

describe("FieldSetBlocks", () => {
  beforeEach(() => localStorage.clear());

  it("renders a block per set with progress, chips and Other fields", () => {
    renderBlocks();
    expect(screen.getByRole("heading", { name: "Field sets" })).toBeInTheDocument();
    expect(screen.getByText("2 on this card")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 filled")).toBeInTheDocument();
    expect(screen.getByText("Champion — missing")).toBeInTheDocument();
    expect(screen.getByText("Signed: No")).toBeInTheDocument();
    expect(screen.getByText("Qualify")).toBeInTheDocument();
    // Other fields defaults to All fields.
    expect(screen.getByLabelText("Notes")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "MEDDIC size" })).toBeInTheDocument();
  });

  it("toggles size, persists it, and Reset / Collapse all act on this card", () => {
    renderBlocks();
    const disclosure = screen.getByRole("button", { name: /^MEDDIC/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const all = screen.getAllByRole("button", { name: "All fields" })[0];
    fireEvent.click(all);
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Metrics")).toBeInTheDocument();
    expect(localStorage.getItem(fieldSetSizeKey(3, 1))).toContain("10:s1");
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(screen.getByLabelText("Metrics")).toBeInTheDocument(); // back to last open size
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.getByRole("button", { name: "Collapse all" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("button", { name: "Reset" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: /^MEDDIC/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("Maximize opens a dialog, navigates, and Restore returns focus to the trigger", async () => {
    expect(MAXIMIZE_ESCAPE_PRIORITY).toBe(30.5);
    renderBlocks();
    const trigger = screen.getByRole("button", { name: "Maximize MEDDIC" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(trigger);
    const dialog = screen.getByTestId("field-set-maximized");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("field-set-max-region").className).toContain("scroll-pb-8");
    expect(screen.getByText("Deal › Field sets")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous field set" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next field set" }));
    expect(screen.getByText("Showing Money, 2 of 3.")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("field-set-maximized")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Maximize Money" })).toHaveFocus());
  });

  it("shows an out-of-lane set with a value collapsed with 'Not used in'", () => {
    renderBlocks({ sets: [fset(1, "Lane", [1], { scope: "swimlanes", swimlanes: [99] })] });
    expect(screen.getByText("Not used in Enterprise")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Lane/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("No field sets apply to cards in Enterprise.")).toBeNull();
  });

  it("announces a removed set and moves its fields to Other fields", () => {
    const { props, rerender } = renderBlocks();
    rerender(<div role="dialog"><FieldSetBlocks {...props} sets={[props.sets[1]]} /></div>);
    expect(screen.getByText("MEDDIC was removed. Its fields are now under Other fields.")).toBeInTheDocument();
    expect(screen.getByLabelText("Metrics")).toBeInTheDocument();
  });

  it("offers Fill in on an empty summary block and Manage field sets to admins", () => {
    const { props } = renderBlocks({ values: [] , sets: [fset(1, "MEDDIC", [1, 2])] });
    fireEvent.click(screen.getByRole("button", { name: "Fill in" }));
    expect(screen.getByLabelText("Metrics")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage field sets" }));
    expect(props.onOpenBoardSettings).toHaveBeenCalled();
  });
});

const board = {
  id: 1, swimlanes: [{ id: 7, name: "Enterprise" }], custom_field_definitions: defs,
  custom_field_sets: [fset(1, "MEDDIC", [1, 2]), fset(2, "Money", [4])],
} as unknown as BoardFull;

describe("BoardSettingsFieldSetsSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is read-only for non-admins", () => {
    render(<BoardSettingsFieldSetsSection board={board} isAdmin={false} onFieldSetsUpdated={vi.fn()} onFieldsUpdated={vi.fn()} />);
    expect(screen.getByText("Only board admins can add or edit field sets.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New field set" })).toBeNull();
    expect(screen.getByText("3 of 5 card fields are in a set · 2 of 10 sets")).toBeInTheDocument();
  });

  it("creates a set and re-reads the list", async () => {
    const onSets = vi.fn();
    vi.mocked(api.createFieldSet).mockResolvedValue(fset(3, "New", [5]));
    vi.mocked(api.listFieldSets).mockResolvedValue([fset(3, "New", [5])]);
    render(<BoardSettingsFieldSetsSection board={board} isAdmin onFieldSetsUpdated={onSets} onFieldsUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New field set" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " New " } });
    fireEvent.change(screen.getByLabelText("+ Add field"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save field set" }));
    await waitFor(() => expect(api.createFieldSet).toHaveBeenCalledWith(1, expect.objectContaining({ name: "New", field_ids: [5], description: null })));
    await waitFor(() => expect(onSets).toHaveBeenCalledWith([fset(3, "New", [5])]));
    expect(await screen.findByText("Field set saved.")).toBeInTheDocument();
  });

  it("deletes after the confirm, and Escape cancels it", async () => {
    expect(FIELD_SET_CONFIRM_ESCAPE_PRIORITY).toBe(40.8);
    const onSets = vi.fn();
    vi.mocked(api.deleteFieldSet).mockResolvedValue({} as never);
    render(<BoardSettingsFieldSetsSection board={board} isAdmin onFieldSetsUpdated={onSets} onFieldsUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^MEDDIC/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete set" }));
    expect(screen.getByText(deleteSetPrompt(board.custom_field_sets![0]))).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Confirm delete" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete set" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete set" }).at(-1)!);
    await waitFor(() => expect(api.deleteFieldSet).toHaveBeenCalledWith(1, 1));
    const updater = onSets.mock.calls[0][0] as (p: CustomFieldSet[]) => CustomFieldSet[];
    expect(updater(board.custom_field_sets!).map((s) => s.id)).toEqual([2]);
  });

  it("asks before discarding a dirty editor, and reorders", async () => {
    vi.mocked(api.reorderFieldSets).mockResolvedValue([]);
    render(<BoardSettingsFieldSetsSection board={board} isAdmin onFieldSetsUpdated={vi.fn()} onFieldsUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^MEDDIC/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: /^Money/ }));
    expect(screen.getByText("Discard changes to Changed?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Money");
    fireEvent.click(screen.getByRole("button", { name: "Move Money earlier" }));
    await waitFor(() => expect(api.reorderFieldSets).toHaveBeenCalledWith(1, [2, 1]));
    expect(apiErrorMessage({ response: { data: { name: ["Taken"] } } }, "x")).toBe("Taken");
    expect(apiErrorMessage(new Error("boom"), "fallback")).toBe("fallback");
  });

  it("copy previews reuse / create outcomes and copies", async () => {
    vi.mocked(api.listBoards).mockResolvedValue([{ id: 1, name: "Here" }, { id: 9, name: "Source" }] as never);
    vi.mocked(api.listFieldSets).mockResolvedValue([fset(20, "MEDDIC", [31, 32, 33])]);
    vi.mocked(api.listCustomFieldDefinitions).mockResolvedValue([def(31, "Notes"), def(32, "Metrics"), def(33, "Brand new")]);
    vi.mocked(api.copyFieldSet).mockResolvedValue(fset(21, "MEDDIC (copy)", [5]));
    const onCopied = vi.fn();
    render(<CopyFieldSetPanel board={board} onClose={vi.fn()} onCopied={onCopied} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Board"), { target: { value: "9" } });
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Field set"), { target: { value: "20" } });
    expect(screen.getByLabelText("Name")).toHaveValue("MEDDIC (copy)");
    expect(screen.getByText("— Uses existing field")).toBeInTheDocument();
    expect(screen.getByText("— Creates Metrics (copied)")).toBeInTheDocument();
    expect(screen.getByText("— Creates new field")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy field set" }));
    await waitFor(() => expect(api.copyFieldSet).toHaveBeenCalledWith(1, { source_board: 9, source_set: 20, name: "MEDDIC (copy)" }));
    expect(onCopied).toHaveBeenCalled();
  });
});
