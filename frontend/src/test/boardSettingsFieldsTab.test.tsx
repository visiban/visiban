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
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeBoard(fields: CustomFieldDefinition[] = []): BoardFull {
  return {
    id: 1, uid: "boarduid0001", name: "Board", description: "", group: null, group_name: null,
    columns: [], swimlanes: [], cards: [], labels: [],
    members: [{ id: 10, user: fakeUser, role: "admin", is_moderator: false, joined_at: "" }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false,
    show_wip_at_limit: false, export_min_role: "viewer", card_density: "comfortable",
    is_starred: false, created_at: "", updated_at: "", current_user_role: "admin",
    custom_field_definitions: fields, owner: fakeUser, capabilities: { movement_export: false },
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
