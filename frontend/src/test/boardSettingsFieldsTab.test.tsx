import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BoardSettingsFieldsTab from "../components/Board/BoardSettingsFieldsTab";
import type { BoardFull, CustomFieldDefinition, User } from "../types";
import * as boardsApi from "../api/boards";

vi.mock("../api/boards", () => ({
  createCustomFieldDefinition: vi.fn(),
  updateCustomFieldDefinition: vi.fn(),
  deleteCustomFieldDefinition: vi.fn(),
  reorderCustomFields: vi.fn(),
}));

const fakeUser: User = {
  id: 1, username: "admin", email: "admin@example.com", first_name: "Admin", last_name: "User",
  avatar_url: "", display_name: "Admin User", is_site_admin: false,
  must_change_password: false, must_change_username: false, has_usable_password: true,
};

function makeDefinition(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: 1, uid: "cfuid001", name: "Sprint", field_type: "text", choices: [],
    position: 0, show_on_card: false, is_required: false, help_text: "",
    number_prefix: "", number_suffix: "", number_decimals: null, choice_colors: {},
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeBoard(fields: CustomFieldDefinition[] = []): BoardFull {
  return {
    id: 1, uid: "boarduid0001", name: "Board", description: "", group: null, group_name: null,
    archived_card_count: 0,
    columns: [], swimlanes: [], cards: [], labels: [],
    members: [{ id: 10, user: fakeUser, role: "admin", is_moderator: false, joined_at: "" }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false,
    show_wip_at_limit: false, export_min_role: "viewer", card_density: "comfortable",
    is_starred: false, created_at: "", updated_at: "", current_user_role: "admin",
    custom_field_definitions: fields, swimlane_custom_field_definitions: [],
    owner: fakeUser, capabilities: { movement_export: false },
    share_token: null, share_token_expires_at: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BoardSettingsFieldsTab (#371)", () => {
  it("renders the admin empty state with an Add field CTA", () => {
    render(<BoardSettingsFieldsTab board={makeBoard()} isAdmin onFieldsUpdated={vi.fn()} />);
    expect(screen.getByText("No custom fields yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add field" })).toBeInTheDocument();
  });

  it("renders the non-admin empty state without a CTA", () => {
    render(<BoardSettingsFieldsTab board={makeBoard()} isAdmin={false} onFieldsUpdated={vi.fn()} />);
    expect(screen.getByText("This board has no custom fields.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add field/i })).not.toBeInTheDocument();
  });

  it("lists existing fields with name, type, and pin state", () => {
    const board = makeBoard([
      makeDefinition({ id: 1, name: "Sprint", field_type: "text", show_on_card: true }),
      makeDefinition({ id: 2, name: "Cost", field_type: "number", show_on_card: false }),
    ]);
    render(<BoardSettingsFieldsTab board={board} isAdmin onFieldsUpdated={vi.fn()} />);
    expect(screen.getByText("Sprint")).toBeInTheDocument();
    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Unpin Sprint/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pin Cost/ })).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === "2 of 30 · 1 of 2 pinned")).toBeInTheDocument();
  });

  it("non-admin rows carry no pin/edit/delete affordances", () => {
    const board = makeBoard([makeDefinition({ id: 1, name: "Sprint", show_on_card: true })]);
    render(<BoardSettingsFieldsTab board={board} isAdmin={false} onFieldsUpdated={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Unpin/ })).not.toBeInTheDocument();
    expect(screen.getByText("Pinned")).toBeInTheDocument(); // static tag, not a control
  });

  it("creating a field validates a blank name and makes no API call", async () => {
    const user = userEvent.setup();
    render(<BoardSettingsFieldsTab board={makeBoard()} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "+ Add field" }));
    await user.click(screen.getByRole("button", { name: "Save field" }));
    expect(await screen.findByText("Name is required.")).toBeInTheDocument();
    expect(boardsApi.createCustomFieldDefinition).not.toHaveBeenCalled();
  });

  it("a dropdown field requires at least one choice before it can be saved", async () => {
    const user = userEvent.setup();
    render(<BoardSettingsFieldsTab board={makeBoard()} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "+ Add field" }));
    await user.type(screen.getByPlaceholderText("e.g. Sprint"), "Stage");
    await user.click(screen.getByRole("button", { name: /Dropdown/ }));
    await user.click(screen.getByRole("button", { name: "Save field" }));
    expect(await screen.findByText("A dropdown field needs at least one choice.")).toBeInTheDocument();
    expect(boardsApi.createCustomFieldDefinition).not.toHaveBeenCalled();
  });

  it("creates a field and calls onFieldsUpdated with the new definition", async () => {
    const user = userEvent.setup();
    const created = makeDefinition({ id: 9, name: "Region", field_type: "text" });
    vi.mocked(boardsApi.createCustomFieldDefinition).mockResolvedValue(created);
    const onFieldsUpdated = vi.fn();

    render(<BoardSettingsFieldsTab board={makeBoard()} isAdmin onFieldsUpdated={onFieldsUpdated} />);
    await user.click(screen.getByRole("button", { name: "+ Add field" }));
    await user.type(screen.getByPlaceholderText("e.g. Sprint"), "Region");
    await user.click(screen.getByRole("button", { name: "Save field" }));

    await waitFor(() => {
      expect(boardsApi.createCustomFieldDefinition).toHaveBeenCalledWith(1, {
        name: "Region",
        field_type: "text",
        choices: undefined,
        help_text: undefined,
      });
    });
    await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith([created]));
  });

  it("rejects a duplicate field name (case-insensitive) without calling the API", async () => {
    const user = userEvent.setup();
    const board = makeBoard([makeDefinition({ id: 1, name: "Sprint" })]);
    render(<BoardSettingsFieldsTab board={board} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "+ Add field" }));
    await user.type(screen.getByPlaceholderText("e.g. Sprint"), "sprint");
    await user.click(screen.getByRole("button", { name: "Save field" }));
    expect(await screen.findByText("A field with this name already exists.")).toBeInTheDocument();
    expect(boardsApi.createCustomFieldDefinition).not.toHaveBeenCalled();
  });

  it("pins a field directly when under the pin cap", async () => {
    const user = userEvent.setup();
    const board = makeBoard([makeDefinition({ id: 1, name: "Sprint", show_on_card: false })]);
    const pinned = { ...board.custom_field_definitions[0], show_on_card: true };
    vi.mocked(boardsApi.updateCustomFieldDefinition).mockResolvedValue(pinned);
    const onFieldsUpdated = vi.fn();

    render(<BoardSettingsFieldsTab board={board} isAdmin onFieldsUpdated={onFieldsUpdated} />);
    await user.click(screen.getByRole("button", { name: /Pin Sprint/ }));

    await waitFor(() => {
      expect(boardsApi.updateCustomFieldDefinition).toHaveBeenCalledWith(1, 1, { show_on_card: true });
    });
    await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith([pinned]));
  });

  it("shows the swap prompt instead of pinning directly when already at the 2-field cap", async () => {
    const user = userEvent.setup();
    const board = makeBoard([
      makeDefinition({ id: 1, name: "Sprint", show_on_card: true }),
      makeDefinition({ id: 2, name: "Status", show_on_card: true }),
      makeDefinition({ id: 3, name: "Cost", show_on_card: false }),
    ]);
    render(<BoardSettingsFieldsTab board={board} isAdmin onFieldsUpdated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Pin Cost/ }));

    expect(screen.getByText("The card face holds 2 fields.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Replace/ })).toHaveLength(2);
    expect(boardsApi.updateCustomFieldDefinition).not.toHaveBeenCalled();
  });

  it("swapping replaces one pinned field with the newly chosen one", async () => {
    const user = userEvent.setup();
    const board = makeBoard([
      makeDefinition({ id: 1, name: "Sprint", show_on_card: true }),
      makeDefinition({ id: 2, name: "Status", show_on_card: true }),
      makeDefinition({ id: 3, name: "Cost", show_on_card: false }),
    ]);
    vi.mocked(boardsApi.updateCustomFieldDefinition).mockImplementation((_boardId, fieldId, data) =>
      Promise.resolve({ ...board.custom_field_definitions.find((f) => f.id === fieldId)!, ...data })
    );
    const onFieldsUpdated = vi.fn();

    render(<BoardSettingsFieldsTab board={board} isAdmin onFieldsUpdated={onFieldsUpdated} />);
    await user.click(screen.getByRole("button", { name: /Pin Cost/ }));
    const replaceButtons = screen.getAllByRole("button", { name: /Replace/ });
    await user.click(replaceButtons[0]); // replaces Sprint (listed first)

    await waitFor(() => {
      expect(boardsApi.updateCustomFieldDefinition).toHaveBeenCalledWith(1, 1, { show_on_card: false });
      expect(boardsApi.updateCustomFieldDefinition).toHaveBeenCalledWith(1, 3, { show_on_card: true });
    });
  });

  it("deletion requires typing the exact field name before Delete is enabled", async () => {
    const user = userEvent.setup();
    const board = makeBoard([makeDefinition({ id: 1, name: "Sprint" })]);
    render(<BoardSettingsFieldsTab board={board} isAdmin onFieldsUpdated={vi.fn()} />);

    await user.click(screen.getByTitle("Delete Sprint"));
    const dialog = await screen.findByRole("dialog", { name: "Delete field?" });
    const deleteButton = within(dialog).getByRole("button", { name: "Delete" });
    expect(deleteButton).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/Type/), "Sprint");
    expect(deleteButton).toBeEnabled();
  });

  it("confirming deletion calls deleteCustomFieldDefinition and updates the list", async () => {
    const user = userEvent.setup();
    // deleteCustomFieldDefinition resolves to an AxiosResponse the component
    // never reads — the default vi.fn() (implicitly resolving `undefined`
    // when awaited) is enough here, no explicit mockResolvedValue needed.
    const board = makeBoard([makeDefinition({ id: 1, name: "Sprint" })]);
    const onFieldsUpdated = vi.fn();

    render(<BoardSettingsFieldsTab board={board} isAdmin onFieldsUpdated={onFieldsUpdated} />);
    await user.click(screen.getByTitle("Delete Sprint"));
    const dialog = await screen.findByRole("dialog", { name: "Delete field?" });
    await user.type(within(dialog).getByLabelText(/Type/), "Sprint");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(boardsApi.deleteCustomFieldDefinition).toHaveBeenCalledWith(1, 1));
    await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith([]));
  });

  it("shows an amber warning near the 30-field cap", () => {
    const near = makeBoard(Array.from({ length: 28 }, (_, i) => makeDefinition({ id: i + 1, name: `Field ${i + 1}` })));
    render(<BoardSettingsFieldsTab board={near} isAdmin onFieldsUpdated={vi.fn()} />);
    expect(screen.getByText("2 fields left on this board.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add field" })).toBeEnabled();
  });

  it("disables Add field with an explanation at the 30-field cap", () => {
    const atCap = makeBoard(Array.from({ length: 30 }, (_, i) => makeDefinition({ id: i + 1, name: `Field ${i + 1}` })));
    render(<BoardSettingsFieldsTab board={atCap} isAdmin onFieldsUpdated={vi.fn()} />);
    expect(screen.getByRole("button", { name: "+ Add field" })).toBeDisabled();
    expect(screen.getByText(/reached its 30-field limit/)).toBeInTheDocument();
  });

  it("re-syncs from an updated board prop when no row is being edited (e.g. another admin's concurrent edit arriving via WS)", () => {
    const board = makeBoard([makeDefinition({ id: 1, name: "Sprint" })]);
    const { rerender } = render(<BoardSettingsFieldsTab board={board} isAdmin onFieldsUpdated={vi.fn()} />);
    expect(screen.getByText("Sprint")).toBeInTheDocument();

    const updatedBoard = makeBoard([
      makeDefinition({ id: 1, name: "Sprint" }),
      makeDefinition({ id: 2, name: "Added by someone else" }),
    ]);
    rerender(<BoardSettingsFieldsTab board={updatedBoard} isAdmin onFieldsUpdated={vi.fn()} />);
    expect(screen.getByText("Added by someone else")).toBeInTheDocument();
  });

  it("does not clobber an in-progress edit when the board prop updates concurrently", async () => {
    const user = userEvent.setup();
    const board = makeBoard([makeDefinition({ id: 1, name: "Sprint" })]);
    const { rerender } = render(<BoardSettingsFieldsTab board={board} isAdmin onFieldsUpdated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "+ Add field" }));
    await user.type(screen.getByPlaceholderText("e.g. Sprint"), "In progress");

    const updatedBoard = makeBoard([
      makeDefinition({ id: 1, name: "Sprint" }),
      makeDefinition({ id: 2, name: "Added by someone else" }),
    ]);
    rerender(<BoardSettingsFieldsTab board={updatedBoard} isAdmin onFieldsUpdated={vi.fn()} />);

    expect(screen.getByPlaceholderText("e.g. Sprint")).toHaveValue("In progress");
  });
});

describe("BoardSettingsFieldsTab — URL type (#1390)", () => {
  it("offers URL last in the type picker and creates a url field", async () => {
    const user = userEvent.setup();
    const created = makeDefinition({ id: 9, name: "Runbook", field_type: "url" });
    vi.mocked(boardsApi.createCustomFieldDefinition).mockResolvedValue(created);

    render(<BoardSettingsFieldsTab board={makeBoard()} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "+ Add field" }));
    const typeButtons = ["Aa Text", "# Number", "📅 Date", "▾ Dropdown", "☑ Checkbox", "↗ URL"].map((name) =>
      screen.getByRole("button", { name })
    );
    expect(typeButtons[typeButtons.length - 1]).toHaveTextContent("URL");
    await user.type(screen.getByPlaceholderText("e.g. Sprint"), "Runbook");
    await user.click(screen.getByRole("button", { name: "↗ URL" }));
    await user.click(screen.getByRole("button", { name: "Save field" }));

    await waitFor(() => {
      expect(boardsApi.createCustomFieldDefinition).toHaveBeenCalledWith(1, {
        name: "Runbook",
        field_type: "url",
        choices: undefined,
        help_text: undefined,
      });
    });
  });

  it("lists an existing url field with the URL label and glyph", () => {
    render(<BoardSettingsFieldsTab board={makeBoard([makeDefinition({ field_type: "url", name: "Runbook" })])} isAdmin onFieldsUpdated={vi.fn()} />);
    expect(screen.getByText("URL")).toBeInTheDocument();
    expect(screen.getByText("↗")).toBeInTheDocument();
  });
});

describe("BoardSettingsFieldsTab — multi-select type (#1391)", () => {
  it("offers Multi-select with the choices editor and helper text, and sends choices", async () => {
    const user = userEvent.setup();
    const created = makeDefinition({ id: 9, name: "Platforms", field_type: "multi_select", choices: ["web", "ios"] });
    vi.mocked(boardsApi.createCustomFieldDefinition).mockResolvedValue(created);

    render(<BoardSettingsFieldsTab board={makeBoard()} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "+ Add field" }));
    await user.type(screen.getByPlaceholderText("e.g. Sprint"), "Platforms");
    await user.click(screen.getByRole("button", { name: "☰ Multi-select" }));
    expect(screen.getByText("People can pick more than one choice.")).toBeInTheDocument();
    expect(screen.getByText("Choices")).toBeInTheDocument();

    // Like a dropdown, a multi-select needs a choice before it can be saved.
    await user.click(screen.getByRole("button", { name: "Save field" }));
    expect(await screen.findByText("A multi-select field needs at least one choice.")).toBeInTheDocument();
    expect(boardsApi.createCustomFieldDefinition).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "+ Add choice" }));
    await user.click(screen.getByRole("button", { name: "+ Add choice" }));
    const [first, second] = screen.getAllByRole("textbox").filter((el) => !el.getAttribute("placeholder"));
    await user.type(first, "web");
    await user.type(second, "ios");
    await user.click(screen.getByRole("button", { name: "Save field" }));

    await waitFor(() => {
      expect(boardsApi.createCustomFieldDefinition).toHaveBeenCalledWith(1, {
        name: "Platforms",
        field_type: "multi_select",
        choices: ["web", "ios"],
        choice_colors: {},
        help_text: undefined,
      });
    });
  });

  it("lists an existing multi-select field with its label and glyph", () => {
    render(<BoardSettingsFieldsTab board={makeBoard([makeDefinition({ field_type: "multi_select", name: "Platforms", choices: ["web"] })])} isAdmin onFieldsUpdated={vi.fn()} />);
    expect(screen.getByText("Multi-select")).toBeInTheDocument();
    expect(screen.getByText("☰")).toBeInTheDocument();
  });
});

describe("BoardSettingsFieldsTab — number format (#1391)", () => {
  it("shows the Format block only for a number field, with a live preview, and sends the options", async () => {
    const user = userEvent.setup();
    const created = makeDefinition({ id: 9, name: "Budget", field_type: "number", number_prefix: "$", number_decimals: 2 });
    vi.mocked(boardsApi.createCustomFieldDefinition).mockResolvedValue(created);

    render(<BoardSettingsFieldsTab board={makeBoard()} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "+ Add field" }));
    await user.type(screen.getByPlaceholderText("e.g. Sprint"), "Budget");
    // Text is the default type: no Format block.
    expect(screen.queryByText("Format")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "# Number" }));
    expect(screen.getByText("Format")).toBeInTheDocument();
    // All defaults: the number exactly as typed.
    expect(screen.getByText("Preview: 1234.5")).toBeInTheDocument();
    // Only the error is announced; the preview is not an alert.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Prefix")).toHaveAttribute("maxLength", "10");
    expect(screen.getByLabelText("Suffix")).toHaveAttribute("maxLength", "10");

    await user.type(screen.getByLabelText("Prefix"), "$");
    await user.type(screen.getByLabelText("Decimals"), "2");
    expect(screen.getByText("Preview: $1,234.50")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Suffix"), " USD");
    expect(screen.getByText("Preview: $1,234.50 USD")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save field" }));
    await waitFor(() => {
      expect(boardsApi.createCustomFieldDefinition).toHaveBeenCalledWith(1, {
        name: "Budget",
        field_type: "number",
        choices: undefined,
        help_text: undefined,
        number_prefix: "$",
        number_suffix: " USD",
        number_decimals: 2,
      });
    });
  });

  it("sends null decimals when the Decimals input is left empty", async () => {
    const user = userEvent.setup();
    vi.mocked(boardsApi.createCustomFieldDefinition).mockResolvedValue(makeDefinition({ id: 9, field_type: "number" }));
    render(<BoardSettingsFieldsTab board={makeBoard()} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "+ Add field" }));
    await user.type(screen.getByPlaceholderText("e.g. Sprint"), "Hours");
    await user.click(screen.getByRole("button", { name: "# Number" }));
    await user.type(screen.getByLabelText("Suffix"), " h");
    await user.click(screen.getByRole("button", { name: "Save field" }));
    await waitFor(() => {
      expect(boardsApi.createCustomFieldDefinition).toHaveBeenCalledWith(1, expect.objectContaining({
        number_prefix: "", number_suffix: " h", number_decimals: null,
      }));
    });
  });

  it("flags decimals outside 0-10 inline and refuses to save", async () => {
    const user = userEvent.setup();
    render(<BoardSettingsFieldsTab board={makeBoard()} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "+ Add field" }));
    await user.type(screen.getByPlaceholderText("e.g. Sprint"), "Budget");
    await user.click(screen.getByRole("button", { name: "# Number" }));
    await user.type(screen.getByLabelText("Decimals"), "11");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter 0 to 10.");
    expect(screen.getByLabelText("Decimals")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText(/^Preview:/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save field" }));
    expect(boardsApi.createCustomFieldDefinition).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Decimals"));
    await user.type(screen.getByLabelText("Decimals"), "10");
    expect(screen.queryByText("Enter 0 to 10.")).not.toBeInTheDocument();
  });

  it("Cancel on the Change type prompt returns focus to the type button (#1367)", async () => {
    const user = userEvent.setup();
    const def = makeDefinition({ id: 4, name: "Budget", field_type: "number", number_prefix: "$", number_suffix: "", number_decimals: 0 });
    render(<BoardSettingsFieldsTab board={makeBoard([def])} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Edit Budget" }));

    await user.click(screen.getByRole("button", { name: "Aa Text" }));
    const prompt = screen.getByText(/may make existing values unreadable/).parentElement as HTMLElement;
    await user.click(within(prompt).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/may make existing values unreadable/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aa Text" })).toHaveFocus();
  });

  it("loads an existing format, and retyping away from number hides the block and omits the options", async () => {
    const user = userEvent.setup();
    const def = makeDefinition({ id: 4, name: "Budget", field_type: "number", number_prefix: "$", number_suffix: "", number_decimals: 0 });
    vi.mocked(boardsApi.updateCustomFieldDefinition).mockResolvedValue({ ...def, field_type: "text", number_prefix: "", number_decimals: null });
    render(<BoardSettingsFieldsTab board={makeBoard([def])} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Edit Budget" }));
    expect(screen.getByLabelText("Prefix")).toHaveValue("$");
    expect(screen.getByLabelText("Decimals")).toHaveValue(0);
    expect(screen.getByText("Preview: $1,235")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Aa Text" }));
    await user.click(screen.getByRole("button", { name: "Change type" }));
    expect(screen.queryByText("Format")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save field" }));
    await waitFor(() => {
      // The server clears a stored format on a retype away from number.
      expect(boardsApi.updateCustomFieldDefinition).toHaveBeenCalledWith(1, 4, {
        name: "Budget", field_type: "text", choices: undefined, help_text: undefined,
      });
    });
  });
});
