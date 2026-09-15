import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CardItem from "../components/Card/CardItem";
import type { Card, CustomFieldDefinition } from "../types";
import * as cardsApi from "../api/cards";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}));

vi.mock("../components/Common/Avatar", () => ({
  default: () => null,
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
    blocker_count: 0,
    ...overrides,
  };
}

function makeDefinition(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: 5, uid: "cfuid005", name: "Sprint", field_type: "text", choices: [],
    position: 0, show_on_card: true, is_required: false, help_text: "",
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
});
