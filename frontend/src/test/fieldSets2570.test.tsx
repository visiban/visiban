import type React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import type { BoardFull, CustomFieldDefinition, CustomFieldSet, CustomFieldValue } from "../types";
import {
  OTHER_FIELDS_KEY, blockProgress, buildCardBlocks, chipsThatFit, countsTowardProgress, defaultSize, isValueFilled, summaryChips,
} from "../utils/fieldSets";
import { fieldSetSizeKey, loadSizes, MAX_ENTRIES } from "../hooks/useFieldSetSizePref";
import { pruneSetFields, pruneSetLane } from "../utils/fieldSets";
import { withCardDefinitions } from "../hooks/useBoard";
import CustomFieldValueInput from "../components/Card/CustomFieldValueInput";

// Stubbed by default; a test that needs the real editor behavior flips `realRow`.
const rowMode = vi.hoisted(() => ({ realRow: false }));
vi.mock("../components/Card/CustomFieldEditRow", async (importOriginal) => {
  const Real = (await importOriginal<typeof import("../components/Card/CustomFieldEditRow")>()).default;
  return {
    default: (props: React.ComponentProps<typeof Real>) =>
      rowMode.realRow ? <Real {...props} /> : <input aria-label={props.definition.name} defaultValue={props.value ?? ""} />,
  };
});
vi.mock("../api/boards", () => ({
  createFieldSet: vi.fn(), updateFieldSet: vi.fn(), deleteFieldSet: vi.fn(), listFieldSets: vi.fn(),
  reorderFieldSets: vi.fn(), reorderCustomFields: vi.fn(), copyFieldSet: vi.fn(), listAllBoards: vi.fn(), listCustomFieldDefinitions: vi.fn(),
}));
import * as api from "../api/boards";
import FieldSetBlocks, { MAXIMIZE_ESCAPE_PRIORITY } from "../components/Card/FieldSetBlocks";
import BoardSettingsFieldSetsSection from "../components/Board/BoardSettingsFieldSetsSection";
import CopyFieldSetDialog from "../components/Board/CopyFieldSetDialog";
import {
  deleteSetPrompt, apiErrorMessage, FIELD_SET_CONFIRM_ESCAPE_PRIORITY, fieldOrderWith, insertByPosition, sortByPosition,
} from "../utils/fieldSetSettings";

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
  it("has one Field sets help link beside the heading, for admins and non-admins (#2592)", () => {
    render(<BoardSettingsFieldSetsSection board={board} isAdmin={false} onFieldSetsUpdated={vi.fn()} onFieldsUpdated={vi.fn()} />);
    const link = screen.getByRole("link", { name: "Learn more about field sets, opens docs" });
    expect(link).toHaveAttribute("href", expect.stringContaining("/features/custom-fields/#field-sets"));
  });

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
    fireEvent.click(screen.getByRole("button", { name: "+ Add field" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "Notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "Remove Notes from New" })).toBeInTheDocument();
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

  it("does not report a failed copy when only the field re-read fails", async () => {
    vi.mocked(api.listAllBoards).mockResolvedValue([{ id: 9, name: "Source" }] as never);
    vi.mocked(api.listFieldSets).mockResolvedValue([fset(20, "Qual", [31])]);
    vi.mocked(api.listCustomFieldDefinitions).mockResolvedValueOnce([def(31, "Fresh")]).mockRejectedValueOnce(new Error("x"));
    vi.mocked(api.copyFieldSet).mockResolvedValue(fset(21, "Qual", [5]));
    render(<BoardSettingsFieldSetsSection board={board} isAdmin onFieldSetsUpdated={vi.fn()} onFieldsUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy from another board" }));
    await screen.findByRole("option", { name: "Source" });
    fireEvent.change(screen.getByLabelText("Board"), { target: { value: "9" } });
    await screen.findByRole("option", { name: "Qual" });
    fireEvent.change(screen.getByLabelText("Field set"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy field set" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Qual was copied, but its fields could not be loaded.");
    expect(screen.queryByText("Could not copy the field set.")).toBeNull();
    expect(screen.queryByLabelText("Board")).toBeNull();
  });

  it("closes the open row without a discard prompt when its set is deleted elsewhere", () => {
    let guard: ((proceed: () => void) => boolean) | null = null;
    const view = (sets: CustomFieldSet[]) => (
      <BoardSettingsFieldSetsSection board={{ ...board, custom_field_sets: sets } as BoardFull} isAdmin
        onFieldSetsUpdated={vi.fn()} onFieldsUpdated={vi.fn()} registerCloseGuard={(g) => { guard = g; }} />
    );
    const { rerender } = render(view(board.custom_field_sets!));
    fireEvent.click(screen.getByRole("button", { name: /^MEDDIC/ }));
    rerender(view([board.custom_field_sets![1]]));
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(guard!(vi.fn())).toBe(false);
    expect(screen.queryByText(/Discard changes/)).toBeNull();
  });

  it("copy previews reuse / create outcomes and copies", async () => {
    vi.mocked(api.listAllBoards).mockResolvedValue([{ id: 1, name: "Here" }, { id: 9, name: "Source" }] as never);
    vi.mocked(api.listFieldSets).mockResolvedValue([fset(20, "MEDDIC", [31, 32, 33])]);
    vi.mocked(api.listCustomFieldDefinitions).mockResolvedValue([def(31, "Notes"), def(32, "Metrics"), def(33, "Brand new")]);
    vi.mocked(api.copyFieldSet).mockResolvedValue(fset(21, "MEDDIC (copy)", [5]));
    const onCopied = vi.fn();
    render(<CopyFieldSetDialog board={board} onClose={vi.fn()} onCopied={onCopied} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Board"), { target: { value: "9" } });
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Field set"), { target: { value: "20" } });
    expect(screen.getByLabelText("Name")).toHaveValue("MEDDIC (copy)");
    expect(screen.getByText("— Uses existing field")).toBeInTheDocument();
    expect(screen.getByText("— Creates a copy of Metrics")).toBeInTheDocument();
    expect(screen.getByText("— Creates new field")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy field set" }));
    await waitFor(() => expect(api.copyFieldSet).toHaveBeenCalledWith(1, { source_board: 9, source_set: 20, name: "MEDDIC (copy)" }));
    expect(onCopied).toHaveBeenCalled();
  });
});

describe("stale id pruning (#2570 D1, D2)", () => {
  const sets = [fset(1, "A", [1, 2], { scope: "swimlanes", swimlanes: [7, 8] }), fset(2, "B", [4])];

  it("drops deleted field ids and lane ids, leaving untouched sets identical", () => {
    const pruned = pruneSetFields(sets, new Set([2]));
    expect(pruned[0].field_ids).toEqual([1]);
    expect(pruned[1]).toBe(sets[1]);
    expect(pruneSetFields(sets, new Set())).toBe(sets);
    const lanes = pruneSetLane(sets, 7);
    expect(lanes[0].swimlanes).toEqual([8]);
    expect(lanes[1]).toBe(sets[1]);
  });

  it("prunes only ids the board held before the definitions change", () => {
    const b = { custom_field_definitions: [def(1, "a"), def(2, "b")], custom_field_sets: [fset(1, "A", [1, 2, 99])] } as unknown as BoardFull;
    expect(withCardDefinitions(b, [def(1, "a")]).custom_field_sets![0].field_ids).toEqual([1, 99]);
  });
});

describe("FieldSetBlocks focus, empty states and live updates (#2570)", () => {
  beforeEach(() => localStorage.clear());

  it("treats cleared values as empty and shows no chips", () => {
    renderBlocks({ values: [val(1, ""), val(2, "")], sets: [fset(1, "MEDDIC", [1, 2])] });
    expect(within(screen.getByTestId("field-set-s1")).getByText("No values yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("field-set-summary")).toBeNull();
  });

  it("moves focus to the first field after Fill in", () => {
    renderBlocks({ values: [], sets: [fset(1, "MEDDIC", [1, 2])] });
    fireEvent.click(screen.getByRole("button", { name: "Fill in" }));
    expect(screen.getByLabelText("Metrics")).toHaveFocus();
  });

  it("says no sets apply only when a lane-scoped set was excluded", () => {
    const { rerender, props } = renderBlocks({ values: [], sets: [fset(1, "Empty", [])] });
    expect(screen.queryByText("No field sets apply to cards in Enterprise.")).toBeNull();
    rerender(<div role="dialog"><FieldSetBlocks {...props} sets={[fset(2, "Lane", [1], { scope: "swimlanes", swimlanes: [99] })]} /></div>);
    expect(screen.getByText("No field sets apply to cards in Enterprise.")).toBeInTheDocument();
  });

  it("holds a removal while a field in the Maximize layer has focus", () => {
    const { props, rerender } = renderBlocks();
    fireEvent.click(screen.getByRole("button", { name: "Maximize MEDDIC" }));
    const input = screen.getByTestId("field-set-maximized").querySelector("input")!;
    input.focus();
    rerender(<div role="dialog"><FieldSetBlocks {...props} sets={[props.sets[1]]} /></div>);
    expect(screen.queryByText(/MEDDIC was removed/)).toBeNull();
    act(() => { input.blur(); });
    expect(screen.getByText(/MEDDIC was removed/)).toBeInTheDocument();
  });

  it("keeps focus on the Maximize layer after Escape reverts a text field", () => {
    rowMode.realRow = true;
    try {
      renderBlocks();
      fireEvent.click(screen.getByRole("button", { name: "Maximize MEDDIC" }));
      const layer = screen.getByTestId("field-set-maximized");
      const input = layer.querySelector("input")!;
      act(() => { input.focus(); });
      fireEvent.keyDown(document, { key: "Escape" });
      expect(layer).toHaveFocus();
      expect(screen.getByTestId("field-set-maximized")).toBeInTheDocument();
    } finally {
      rowMode.realRow = false;
    }
  });

  it("announces a focused field's move once its row blurs", () => {
    const { props, rerender } = renderBlocks();
    const move = (sets: CustomFieldSet[]) => {
      const input = screen.getByLabelText("Notes");
      input.focus();
      rerender(<div role="dialog"><FieldSetBlocks {...props} sets={sets} /></div>);
      // Held: nothing is announced while the row keeps focus.
      expect(screen.getByLabelText("Notes")).toHaveFocus();
      act(() => { input.blur(); });
    };
    move([fset(1, "MEDDIC", [1, 2, 3], { description: "Qualify" }), fset(2, "Money", [4, 5])]);
    expect(screen.getByText("Notes moved to Money.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "All fields" })[1]);
    move(props.sets);
    expect(screen.getByText("Notes moved to Other fields.")).toBeInTheDocument();
  });

  it("reveals a deep-linked field: closes Maximize and expands the owning block", () => {
    const onRevealed = vi.fn();
    const { props, rerender } = renderBlocks();
    fireEvent.click(screen.getByRole("button", { name: "Maximize Money" }));
    rerender(<div role="dialog"><FieldSetBlocks {...props} reveal={1} onRevealed={onRevealed} /></div>);
    expect(screen.queryByTestId("field-set-maximized")).toBeNull();
    expect(screen.getByLabelText("Metrics")).toBeInTheDocument();
    expect(onRevealed).toHaveBeenCalled();
  });

  it("dashes an empty input only when asked", () => {
    const view = render(<CustomFieldValueInput definition={def(1, "T")} value="" onCommit={vi.fn()} dashedWhenEmpty />);
    expect(view.container.querySelector("input")!.className).toContain("border-dashed");
    view.rerender(<CustomFieldValueInput definition={def(1, "T")} value="x" onCommit={vi.fn()} dashedWhenEmpty />);
    expect(view.container.querySelector("input")!.className).not.toContain("border-dashed");
  });
});

describe("Field sets settings focus, guard and errors (#2570)", () => {
  beforeEach(() => vi.clearAllMocks());
  const mount = (over: Partial<Parameters<typeof BoardSettingsFieldSetsSection>[0]> = {}) =>
    render(<BoardSettingsFieldSetsSection board={board} isAdmin onFieldSetsUpdated={vi.fn()} onFieldsUpdated={vi.fn()} {...over} />);
  const row = () => screen.getByRole("button", { name: /^MEDDIC/ });

  it("returns focus to Delete set on cancel, and to the next row after a delete", async () => {
    vi.mocked(api.deleteFieldSet).mockResolvedValue({} as never);
    mount();
    fireEvent.click(row());
    fireEvent.click(screen.getByRole("button", { name: "Delete set" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete set" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Delete set" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete set" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Money/ })).toHaveFocus());
  });

  it("guards leaving with a dirty draft; Cancel keeps it", () => {
    let guard: ((proceed: () => void) => boolean) | null = null;
    mount({ registerCloseGuard: (g) => { guard = g; } });
    const proceed = vi.fn();
    expect(guard!(proceed)).toBe(false);
    fireEvent.click(row());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Changed" } });
    let taken = false;
    act(() => { taken = guard!(proceed); });
    expect(taken).toBe(true);
    // The confirm's Cancel takes focus on open; it keeps the draft.
    expect(document.activeElement).toHaveTextContent("Cancel");
    fireEvent.click(document.activeElement as HTMLElement);
    expect(screen.getByLabelText("Name")).toHaveValue("Changed");
    expect(proceed).not.toHaveBeenCalled();
  });

  it("discards through the guard", () => {
    let guard: ((proceed: () => void) => boolean) | null = null;
    mount({ registerCloseGuard: (g) => { guard = g; } });
    const proceed = vi.fn();
    fireEvent.click(row());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Changed" } });
    act(() => { guard!(proceed); });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(proceed).toHaveBeenCalled();
    expect(row()).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a reorder failure with every row closed, and announces success", async () => {
    vi.mocked(api.reorderFieldSets).mockRejectedValueOnce(new Error("x")).mockResolvedValue([]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Move MEDDIC later" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reorder the field sets.");
    fireEvent.click(screen.getByRole("button", { name: "Move MEDDIC later" }));
    expect(await screen.findByText("Field sets reordered.")).toBeInTheDocument();
  });

  it("explains a disabled Save, shows plain rows to non-admins and an empty state", () => {
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "New field set" }));
    expect(screen.getByRole("button", { name: "Save field set" })).toHaveAccessibleDescription("Enter a name to save.");
    view.unmount();
    const reader = mount({ isAdmin: false });
    expect(screen.queryByRole("button", { name: /^MEDDIC/ })).toBeNull();
    reader.unmount();
    mount({ board: { ...board, custom_field_sets: [] } as BoardFull });
    expect(screen.getByText("No field sets yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create a field set" }));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("explains the set cap on both buttons", () => {
    mount({ board: { ...board, custom_field_sets: Array.from({ length: 10 }, (_, i) => fset(i + 1, `S${i}`, [])) } as BoardFull });
    expect(screen.getByRole("button", { name: "New field set" })).toHaveAccessibleDescription(/10-set limit/);
  });

  it("copy panel focuses Board, drops stale answers, blocks a double copy and returns focus", async () => {
    vi.mocked(api.listAllBoards).mockResolvedValue([{ id: 9, name: "Source" }, { id: 8, name: "Slow" }] as never);
    let releaseSlow: (v: CustomFieldSet[]) => void = () => {};
    vi.mocked(api.listFieldSets).mockImplementation((id) => (id === 8
      ? new Promise<CustomFieldSet[]>((r) => { releaseSlow = r; })
      : Promise.resolve([fset(20, "Right", [31])])));
    vi.mocked(api.listCustomFieldDefinitions).mockResolvedValue([def(31, "Notes")]);
    vi.mocked(api.copyFieldSet).mockReturnValue(new Promise(() => {}));
    mount();
    const trigger = screen.getByRole("button", { name: "Copy from another board" });
    trigger.focus();
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Copy a field set" })).toHaveAttribute("aria-modal", "true");
    const select = screen.getByLabelText("Board");
    expect(select).toHaveFocus();
    await screen.findByRole("option", { name: "Slow" });
    fireEvent.change(select, { target: { value: "8" } });
    expect(screen.getByRole("option", { name: "Loading…" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "9" } });
    await screen.findByRole("option", { name: "Right" });
    await act(async () => { releaseSlow([fset(21, "Wrong", [])]); });
    expect(screen.queryByRole("option", { name: "Wrong" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Field set"), { target: { value: "20" } });
    const copy = screen.getByRole("button", { name: "Copy field set" });
    fireEvent.click(copy);
    fireEvent.click(copy);
    expect(api.copyFieldSet).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Copy a field set" })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe("read-only field row in a set block (#2570)", () => {
  it("says Not set for an empty value, including an empty multi-select, but never for a checkbox", async () => {
    const { default: Row } = await vi.importActual<typeof import("../components/Card/CustomFieldEditRow")>("../components/Card/CustomFieldEditRow");
    const row = (definition: CustomFieldDefinition, value?: string) => (
      <Row definition={definition} value={value} disabled onSave={vi.fn()} fieldSetCell />
    );
    const view = render(row(def(4, "Tags", "multi_select"), "[]"));
    expect(screen.getByText("Not set")).toBeInTheDocument();
    view.rerender(row(def(5, "Notes")));
    expect(screen.getByText("Not set")).toBeInTheDocument();
    view.rerender(row(def(3, "Signed", "checkbox")));
    expect(screen.getByText("Signed")).toBeInTheDocument();
    expect(screen.queryByText("Not set")).toBeNull();
    expect(screen.queryByText("No")).toBeNull();
  });

  it("renders the real rows with canEdit false", async () => {
    const { default: Row } = await vi.importActual<typeof import("../components/Card/CustomFieldEditRow")>("../components/Card/CustomFieldEditRow");
    render(<Row definition={def(3, "Signed", "checkbox")} value="true" disabled onSave={vi.fn()} fieldSetCell />);
    expect(screen.getByText("Signed")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });
});

describe("field set editor controls (#2570, ux-design section 4)", () => {
  beforeEach(() => vi.clearAllMocks());
  const mount = (over: Partial<Parameters<typeof BoardSettingsFieldSetsSection>[0]> = {}) =>
    render(<BoardSettingsFieldSetsSection board={board} isAdmin onFieldSetsUpdated={vi.fn()} onFieldsUpdated={vi.fn()} {...over} />);
  const open = () => fireEvent.click(screen.getByRole("button", { name: /^MEDDIC/ }));

  it("orders, inserts and permutes only the set's own slots", () => {
    expect(sortByPosition([5, 1], defs)).toEqual([1, 5]);
    expect(insertByPosition([1, 5], 3, defs)).toEqual([1, 3, 5]);
    expect(insertByPosition([1], 3, defs)).toEqual([1, 3]);
    expect(fieldOrderWith(defs, [1, 3])).toBeNull();
    expect(fieldOrderWith(defs, [3, 1])).toEqual([3, 2, 1, 4, 5]);
  });

  it("groups Add field, says a pick moves it, and Escape closes only the menu", () => {
    mount();
    open();
    fireEvent.click(screen.getByRole("button", { name: "+ Add field" }));
    expect(within(screen.getByRole("group", { name: "Not in a set" })).getByRole("option", { name: "Notes" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "In another set" })).getByRole("option", { name: /Tags/ })).toHaveTextContent("Moves it out of Money");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: "+ Add field" })).toHaveFocus();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("picks swimlanes in a dropdown", async () => {
    mount();
    open();
    fireEvent.click(screen.getByLabelText("Only cards in these swimlanes"));
    fireEvent.click(screen.getByRole("button", { name: "Swimlanes" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Enterprise" }));
    expect(screen.getByRole("button", { name: "Swimlanes: All" })).toBeInTheDocument();
  });

  it("has a drag handle per set and field, and saves a new field order", async () => {
    const onFields = vi.fn();
    vi.mocked(api.updateFieldSet).mockResolvedValue(fset(1, "MEDDIC", [1, 2]));
    vi.mocked(api.listFieldSets).mockResolvedValue(board.custom_field_sets!);
    vi.mocked(api.reorderCustomFields).mockRejectedValueOnce(new Error("x")).mockResolvedValue(defs);
    mount({ onFieldsUpdated: onFields });
    expect(screen.getByRole("button", { name: "Drag to reorder MEDDIC" })).toBeInTheDocument();
    open();
    expect(screen.getByRole("button", { name: "Drag to reorder Champion" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move Champion earlier" }));
    fireEvent.click(screen.getByRole("button", { name: "Save field set" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("its field order was not");
    fireEvent.click(screen.getByRole("button", { name: "Save field set" }));
    await waitFor(() => expect(onFields).toHaveBeenCalledWith(defs));
    expect(api.reorderCustomFields).toHaveBeenLastCalledWith(1, [2, 1, 3, 4, 5]);
  });

  it("restores the old set order when the server refuses", async () => {
    const onSets = vi.fn();
    vi.mocked(api.reorderFieldSets).mockRejectedValue(new Error("x"));
    mount({ onFieldSetsUpdated: onSets });
    fireEvent.click(screen.getByRole("button", { name: "Move Money earlier" }));
    await screen.findByRole("alert");
    expect((onSets.mock.calls[0][0] as CustomFieldSet[]).map((s) => s.id)).toEqual([2, 1]);
    expect((onSets.mock.calls[1][0] as CustomFieldSet[]).map((s) => s.id)).toEqual([1, 2]);
  });
});
