import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CardItem from "../components/Card/CardItem";
import Avatar from "../components/Common/Avatar";
import type { Card, CustomFieldDefinition } from "../types";
import * as cardsApi from "../api/cards";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}));

vi.mock("../components/Common/Avatar", () => ({
  default: vi.fn(() => null),
}));

vi.mock("../api/cards", () => ({
  updateCard: vi.fn(),
}));

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: "carduid00001", column: 10, swimlane: 20, title: "Card face test",
    description: "", priority: "low", assignee: null, labels: [],
    due_date: null, weight: 1, position: 0, created_by: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1,
    custom_field_values: [],
    blocker_count: 0, external_ref: null,
    ...overrides,
  };
}

function makeDefinition(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: 5, uid: "cfuid005", name: "Sprint", field_type: "text", choices: [],
    position: 0, show_on_card: true, is_required: false, help_text: "",
    number_prefix: "", number_suffix: "", number_decimals: null, choice_colors: {},
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(cardsApi.updateCard).mockReset();
});

describe("CardItem — pinned custom field chips (#371)", () => {
  it("renders a populated text chip with the field name and value", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "14" }] })}
        customFieldDefinitions={[makeDefinition()]}
      />
    );
    expect(screen.getByTitle("Sprint: 14")).toBeInTheDocument();
  });

  it("omits an unset pinned field at comfortable density", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [] })}
        customFieldDefinitions={[makeDefinition()]}
        density="comfortable"
      />
    );
    expect(screen.queryByTitle(/Sprint/)).not.toBeInTheDocument();
  });

  it("renders a ghost chip for an unset pinned field at dense density", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [] })}
        customFieldDefinitions={[makeDefinition()]}
        density="dense"
      />
    );
    expect(screen.getByTitle("Sprint: not set")).toBeInTheDocument();
  });

  it("does not render a chip for a field that isn't pinned", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "14" }] })}
        customFieldDefinitions={[makeDefinition({ show_on_card: false })]}
      />
    );
    expect(screen.queryByTitle(/Sprint/)).not.toBeInTheDocument();
  });

  it("renders a checkbox value as Yes/No, not a raw boolean string", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "true" }] })}
        customFieldDefinitions={[makeDefinition({ field_type: "checkbox", name: "Blocked" })]}
      />
    );
    expect(screen.getByTitle("Blocked: Yes")).toBeInTheDocument();
  });

  it("renders a color dot for a populated dropdown chip", () => {
    const { container } = render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "Beta" }] })}
        customFieldDefinitions={[makeDefinition({ field_type: "dropdown", name: "Stage", choices: ["Beta", "GA"] })]}
      />
    );
    const chip = screen.getByTitle("Stage: Beta");
    expect(chip.querySelector('[aria-hidden="true"].rounded-full')).toBeInTheDocument();
    expect(container).toBeInTheDocument();
  });

  it("gives a dropdown chip an editable-badge dotted underline when quick-edit is enabled", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "Beta" }] })}
        customFieldDefinitions={[makeDefinition({ field_type: "dropdown", name: "Stage", choices: ["Beta", "GA"] })]}
        boardId={1}
        onCardUpdated={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /Stage: Beta/ })).toBeInTheDocument();
  });

  it("does not make a text chip interactive even when quick-edit is enabled — only checkbox/dropdown qualify", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "14" }] })}
        customFieldDefinitions={[makeDefinition()]}
        boardId={1}
        onCardUpdated={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: /Sprint: 14/ })).not.toBeInTheDocument();
  });

  it("does not render an interactive chip when boardId/onCardUpdated are omitted (e.g. the share page)", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "Beta" }] })}
        customFieldDefinitions={[makeDefinition({ field_type: "dropdown", name: "Stage", choices: ["Beta"] })]}
      />
    );
    expect(screen.queryByRole("button", { name: /Stage: Beta/ })).not.toBeInTheDocument();
    expect(screen.getByTitle("Stage: Beta")).toBeInTheDocument();
  });

  it("toggling a checkbox chip issues an optimistic update via updateCard and calls onCardUpdated on success", async () => {
    const updatedCard = makeCard({ custom_field_values: [{ field_definition: 5, value: "true" }] });
    vi.mocked(cardsApi.updateCard).mockResolvedValue(updatedCard);
    const onCardUpdated = vi.fn();

    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "false" }] })}
        customFieldDefinitions={[makeDefinition({ field_type: "checkbox", name: "Blocked" })]}
        boardId={7}
        onCardUpdated={onCardUpdated}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Blocked: No/ }));

    await waitFor(() => {
      expect(cardsApi.updateCard).toHaveBeenCalledWith(
        7,
        1,
        { custom_field_values: [{ field_definition: 5, value: "true" }] },
      );
    });
    await waitFor(() => expect(onCardUpdated).toHaveBeenCalledWith(updatedCard));
  });

  it("rolls back silently (no crash, no card mutation) when the quick-edit write fails", async () => {
    vi.mocked(cardsApi.updateCard).mockRejectedValue(new Error("network error"));
    const onCardUpdated = vi.fn();

    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "false" }] })}
        customFieldDefinitions={[makeDefinition({ field_type: "checkbox", name: "Blocked" })]}
        boardId={7}
        onCardUpdated={onCardUpdated}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Blocked: No/ }));

    await waitFor(() => expect(cardsApi.updateCard).toHaveBeenCalled());
    expect(onCardUpdated).not.toHaveBeenCalled();
    // Card face still reflects the last-known-good server state — the click
    // never optimistically mutated the `card` prop itself.
    expect(screen.getByTitle("Blocked: No")).toBeInTheDocument();
  });

  it("clicking a quick-edit chip does not open the card (stopPropagation)", () => {
    const onClick = vi.fn();
    vi.mocked(cardsApi.updateCard).mockResolvedValue(makeCard());

    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "false" }] })}
        customFieldDefinitions={[makeDefinition({ field_type: "checkbox", name: "Blocked" })]}
        boardId={7}
        onCardUpdated={vi.fn()}
        onClick={onClick}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Blocked: No/ }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("selecting a different choice in the dropdown quick-edit popover issues an update via updateCard and calls onCardUpdated on success", async () => {
    const updatedCard = makeCard({ custom_field_values: [{ field_definition: 5, value: "GA" }] });
    vi.mocked(cardsApi.updateCard).mockResolvedValue(updatedCard);
    const onCardUpdated = vi.fn();

    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "Beta" }] })}
        customFieldDefinitions={[makeDefinition({ field_type: "dropdown", name: "Stage", choices: ["Beta", "GA"] })]}
        boardId={7}
        onCardUpdated={onCardUpdated}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Stage: Beta/ }));
    fireEvent.click(screen.getByRole("option", { name: "GA" }));

    await waitFor(() => {
      expect(cardsApi.updateCard).toHaveBeenCalledWith(
        7,
        1,
        { custom_field_values: [{ field_definition: 5, value: "GA" }] },
      );
    });
    await waitFor(() => expect(onCardUpdated).toHaveBeenCalledWith(updatedCard));
  });

  it('selecting "— No value —" in the dropdown quick-edit popover sends an empty value', async () => {
    const updatedCard = makeCard({ custom_field_values: [{ field_definition: 5, value: "" }] });
    vi.mocked(cardsApi.updateCard).mockResolvedValue(updatedCard);
    const onCardUpdated = vi.fn();

    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "Beta" }] })}
        customFieldDefinitions={[makeDefinition({ field_type: "dropdown", name: "Stage", choices: ["Beta", "GA"] })]}
        boardId={7}
        onCardUpdated={onCardUpdated}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Stage: Beta/ }));
    fireEvent.click(screen.getByRole("option", { name: "— No value —" }));

    await waitFor(() => {
      expect(cardsApi.updateCard).toHaveBeenCalledWith(
        7,
        1,
        { custom_field_values: [{ field_definition: 5, value: "" }] },
      );
    });
    await waitFor(() => expect(onCardUpdated).toHaveBeenCalledWith(updatedCard));
  });

  it("rolls back silently (no crash, no card mutation) when the dropdown quick-edit write fails", async () => {
    vi.mocked(cardsApi.updateCard).mockRejectedValue(new Error("network error"));
    const onCardUpdated = vi.fn();

    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "Beta" }] })}
        customFieldDefinitions={[makeDefinition({ field_type: "dropdown", name: "Stage", choices: ["Beta", "GA"] })]}
        boardId={7}
        onCardUpdated={onCardUpdated}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Stage: Beta/ }));
    fireEvent.click(screen.getByRole("option", { name: "GA" }));

    await waitFor(() => expect(cardsApi.updateCard).toHaveBeenCalled());
    expect(onCardUpdated).not.toHaveBeenCalled();
    // Card face still reflects the last-known-good server state — the click
    // never optimistically mutated the `card` prop itself.
    expect(screen.getByTitle("Stage: Beta")).toBeInTheDocument();
  });
});

describe("CardItem — pinned URL chip (#1390)", () => {
  const urlDef = () => makeDefinition({ field_type: "url", name: "Docs" });

  it("shows the hostname without www. as a safe link, with the full URL in the chip title", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "https://www.example.com/runbooks/raid" }] })}
        customFieldDefinitions={[urlDef()]}
      />
    );
    expect(screen.getByTitle("Docs: https://www.example.com/runbooks/raid")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open example.com in new tab" });
    expect(link).toHaveTextContent("example.com");
    expect(link).toHaveAttribute("href", "https://www.example.com/runbooks/raid");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("clicking the link does not open the card", () => {
    const onClick = vi.fn();
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "https://example.com" }] })}
        customFieldDefinitions={[urlDef()]}
        onClick={onClick}
      />
    );
    const link = screen.getByRole("link", { name: "Open example.com in new tab" });
    fireEvent.pointerDown(link);
    fireEvent.mouseDown(link);
    fireEvent.keyDown(link, { key: "Enter" });
    const notPrevented = fireEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
    // stopPropagation only — the link itself must still open.
    expect(notPrevented).toBe(true);
  });

  it("renders a legacy javascript: value as plain text with no link", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "javascript:alert(1)" }] })}
        customFieldDefinitions={[urlDef()]}
      />
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByTitle("Docs: javascript:alert(1)")).toBeInTheDocument();
  });

  it("is not a quick-edit chip", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "https://example.com" }] })}
        customFieldDefinitions={[urlDef()]}
      />
    );
    expect(screen.queryByRole("button", { name: /Docs:/ })).not.toBeInTheDocument();
  });
});

describe("CardItem — pinned multi-select chips (#1391)", () => {
  const msDef = () => makeDefinition({ name: "Platforms", field_type: "multi_select", choices: ["web", "ios", "android"] });

  it("shows two entries and a +N overflow, read-only", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: '["web","ios","android"]' }] })}
        customFieldDefinitions={[msDef()]}
      />
    );
    expect(screen.getByTitle("Platforms: web, ios, android")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("ios")).toBeInTheDocument();
    expect(screen.queryByText("android")).not.toBeInTheDocument();
    expect(screen.getByText("+1")).toHaveAttribute("title", "web, ios, android");
    // No quick-edit chip and no dotted-underline affordance for this type.
    expect(screen.queryByRole("button", { name: /Platforms:/ })).not.toBeInTheDocument();
    expect(document.querySelector(".border-dotted")).toBeNull();
  });

  it("gives each sub-chip span min-w-0 so its truncate ellipsis actually engages (#1411)", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: '["web","ios"]' }] })}
        customFieldDefinitions={[msDef()]}
      />
    );
    expect(screen.getByText("web")).toHaveClass("truncate", "min-w-0");
    expect(screen.getByText("ios")).toHaveClass("truncate", "min-w-0");
  });
});

describe("CardItem — formatted number chips (#1391)", () => {
  it("keeps the whole formatted value, suffix included, instead of slicing at 16 characters", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "1234567.5" }] })}
        customFieldDefinitions={[makeDefinition({ name: "Budget", field_type: "number", number_prefix: "$", number_suffix: " USD", number_decimals: 2 })]}
      />
    );
    // 17 characters: the old 16-character slice would have cut " USD" to " US…".
    expect(screen.getByText("$1,234,567.50 USD")).toHaveClass("truncate");
    expect(screen.getByTitle("Budget: $1,234,567.50 USD")).toBeInTheDocument();
  });

  it("still slices an unformatted long number at 16 characters, as before", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "12345678901234567890" }] })}
        customFieldDefinitions={[makeDefinition({ name: "Big", field_type: "number" })]}
      />
    );
    expect(screen.getByText("1234567890123456…")).toBeInTheDocument();
  });
});

describe("CardItem — colored choices on the card face (#1391)", () => {
  const stage = (overrides: Partial<CustomFieldDefinition> = {}) =>
    makeDefinition({ field_type: "dropdown", name: "Stage", choices: ["Beta", "GA"], choice_colors: { Beta: "amber" }, ...overrides });

  it("renders an explicitly colored dropdown value as a tinted badge inside the neutral chip, label shown", () => {
    const { container } = render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "Beta" }] })}
        customFieldDefinitions={[stage()]}
      />
    );
    const chip = screen.getByTitle("Stage: Beta");
    expect(chip).toHaveClass("border", "border-line");
    const badge = chip.querySelector<HTMLElement>(".cf-choice-badge");
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent("Beta");
    expect(badge).toHaveAttribute("data-choice-color", "amber");
    expect(badge!.style.getPropertyValue("--cf-bg-dark")).toBe("#4D4330");
    // The automatic dot is replaced, not doubled up.
    expect(container.querySelector(".rounded-full")).toBeNull();
  });

  it("keeps the dotted quick-edit underline on a tinted badge", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "Beta" }] })}
        customFieldDefinitions={[stage()]}
        boardId={1}
        onCardUpdated={vi.fn()}
      />
    );
    const chip = screen.getByRole("button", { name: /Stage: Beta/ });
    const badge = chip.querySelector(".cf-choice-badge")!;
    // On an inner text span, in currentColor (the badge fg) — never a border
    // on the badge, which would change its height.
    expect(badge.className).not.toMatch(/border/);
    const hint = badge.querySelector("[data-quick-edit-hint]");
    expect(hint).toHaveClass("underline", "decoration-dotted", "underline-offset-2");
    expect(hint).toHaveTextContent("Beta");
  });

  it("a read-only tinted badge carries no quick-edit underline", () => {
    const { container } = render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "Beta" }] })}
        customFieldDefinitions={[stage()]}
      />
    );
    expect(container.querySelector("[data-quick-edit-hint]")).toBeNull();
  });

  it("an unset color keeps today's neutral chip and hash dot", () => {
    const { container } = render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "GA" }] })}
        customFieldDefinitions={[stage()]}
      />
    );
    expect(container.querySelector(".cf-choice-badge")).toBeNull();
    expect(container.querySelector(".rounded-full")).not.toBeNull();
    expect(screen.getByText("GA")).toHaveClass("text-fg-secondary");
  });

  it("an orphaned value (choice renamed away) renders neutral with its label", () => {
    const { container } = render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "Beta" }] })}
        customFieldDefinitions={[stage({ choices: ["Preview", "GA"] })]}
      />
    );
    expect(container.querySelector(".cf-choice-badge")).toBeNull();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("an unknown color key from a newer server renders neutral", () => {
    const { container } = render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "Beta" }] })}
        customFieldDefinitions={[stage({ choice_colors: { Beta: "chartreuse" } })]}
      />
    );
    expect(container.querySelector(".cf-choice-badge")).toBeNull();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("tints multi-select chips per choice on the card face", () => {
    const { container } = render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: '["web","ios"]' }] })}
        customFieldDefinitions={[makeDefinition({
          field_type: "multi_select", name: "Platforms", choices: ["web", "ios"], choice_colors: { ios: "blue" },
        })]}
      />
    );
    const badges = container.querySelectorAll(".cf-choice-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("ios");
    expect(screen.getByTitle("web")).toHaveClass("bg-surface-hover");
  });
});

describe("CardItem — chip clipping, not overlap, when the card face is narrow (#1411)", () => {
  it("gives a populated non-multi chip's name and value spans a min-w-0-bearing truncate class", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "Reporter count" }] })}
        customFieldDefinitions={[makeDefinition()]}
      />
    );
    const chip = screen.getByTitle("Sprint: Reporter count");
    const nameSpan = chip.querySelector("span.text-fg-muted")!;
    const valueSpan = screen.getByText("Reporter count");
    expect(nameSpan).toHaveClass("truncate", "min-w-0");
    expect(valueSpan).toHaveClass("truncate", "min-w-0");
  });

  it("gives a populated non-multi chip's outer span overflow-hidden and never shrink-0 (regression guard)", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: "14" }] })}
        customFieldDefinitions={[makeDefinition()]}
      />
    );
    const chip = screen.getByTitle("Sprint: 14");
    expect(chip).toHaveClass("overflow-hidden");
    expect(chip.className).not.toMatch(/\bshrink-0\b/);
  });

  it("gives the ghost/unset chip at dense density the same overflow-hidden, no-shrink-0 outer treatment and a min-w-0 name span", () => {
    render(
      <CardItem
        card={makeCard({ custom_field_values: [] })}
        customFieldDefinitions={[makeDefinition()]}
        density="dense"
      />
    );
    const chip = screen.getByTitle("Sprint: not set");
    expect(chip).toHaveClass("overflow-hidden");
    expect(chip.className).not.toMatch(/\bshrink-0\b/);
    const nameSpan = screen.getByText("Sprint");
    expect(nameSpan).toHaveClass("truncate", "min-w-0");
  });
});

describe("CardItem — avatar positioned against the content wrapper, not the metadata row (#1411)", () => {
  beforeEach(() => {
    vi.mocked(Avatar).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub mirrors the real component's narrow prop surface
      ((props: any) => <div data-testid="avatar-stub" className={props.className} />) as typeof Avatar
    );
  });

  afterEach(() => {
    vi.mocked(Avatar).mockImplementation((() => null) as unknown as typeof Avatar);
  });

  it("renders the avatar bottom-right, absolutely positioned, as a sibling of the metadata row rather than inside it", () => {
    const { container } = render(
      <CardItem
        card={makeCard({
          assignee: { id: 9, username: "jordan", display_name: "Jordan", avatar_url: "" },
          custom_field_values: [
            { field_definition: 5, value: "14" },
            { field_definition: 6, value: "Beta" },
          ],
        })}
        customFieldDefinitions={[
          makeDefinition({ id: 5, name: "Sprint" }),
          makeDefinition({ id: 6, name: "Stage", field_type: "dropdown", choices: ["Beta", "GA"] }),
        ]}
      />
    );

    expect(screen.getByTitle("Sprint: 14")).toBeInTheDocument();
    expect(screen.getByTitle("Stage: Beta")).toBeInTheDocument();

    const avatarStub = screen.getByTestId("avatar-stub");
    expect(avatarStub.className).toMatch(/\babsolute\b/);
    expect(avatarStub.className).toMatch(/\bbottom-1\.5\b/);
    expect(avatarStub.className).toMatch(/\bright-1\.5\b/);

    // The row (identified by its overflow-hidden/group-hover:overflow-visible
    // classes) must not contain the avatar — it is now a sibling of the row,
    // positioned against the content wrapper instead.
    const row = container.querySelector(".overflow-hidden.group-hover\\:overflow-visible")!;
    expect(row).not.toBeNull();
    expect(row.querySelector('[data-testid="avatar-stub"]')).toBeNull();
    expect(avatarStub.parentElement).not.toBe(row);
  });

  it("still renders an (empty) metadata row when the card has only an assignee, so the row's pr-7 reserves the avatar's footprint (#1411 ux-review blocker)", () => {
    // card.assignee deliberately stays in the hasMetadataRow OR-chain even
    // though the avatar itself renders outside the row: the row's `pr-7` is
    // the only thing reserving the avatar's space, so an assignee-only card
    // must still render the row — with no chips in it — or the absolutely-
    // positioned avatar has nothing stopping it from sitting on the title.
    const { container } = render(
      <CardItem
        card={makeCard({
          assignee: { id: 9, username: "jordan", display_name: "Jordan", avatar_url: "" },
        })}
        customFieldDefinitions={[]}
      />
    );

    expect(screen.getByTestId("avatar-stub")).toBeInTheDocument();
    const row = container.querySelector(".overflow-hidden.group-hover\\:overflow-visible");
    expect(row).not.toBeNull();
    expect(row).toHaveClass("pr-7");
  });
});
