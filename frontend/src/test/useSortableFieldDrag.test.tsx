/**
 * #2190: the card-field and swimlane-field lists' DndContext announces by field
 * name and position, and Escape mid-drag does not reach the Board Settings
 * modal's escape entry. dnd-kit's real keyboard drag is covered by
 * e2e/field-keyboard-reorder.spec.ts; here DndContext hands its props to the test.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { Announcements, DragEndEvent } from "@dnd-kit/core";
import BoardSettingsFieldsTab from "../components/Board/BoardSettingsFieldsTab";
import BoardSettingsSwimlaneFieldsTab from "../components/Board/BoardSettingsSwimlaneFieldsTab";
import { useEscapeStack } from "../hooks/useEscapeStack";
import { FIELD_DRAG_ESCAPE_PRIORITY } from "../hooks/useSortableFieldDrag";
import type { BoardFull, CustomFieldDefinition, SwimlaneCustomFieldDefinition } from "../types";

type Captured = {
  onDragStart?: () => void;
  onDragEnd?: (e: DragEndEvent) => void;
  onDragCancel?: () => void;
  accessibility?: { announcements: Announcements; screenReaderInstructions: { draggable: string } };
};
const dnd: { props: Captured } = { props: {} };

vi.mock("@dnd-kit/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/core")>()),
  DndContext: ({ children, ...props }: Captured & { children: React.ReactNode }) => {
    dnd.props = props;
    return <>{children}</>;
  },
}));

const cardField = (id: number, name: string) =>
  ({ id, name, field_type: "text", choices: [], show_on_card: false, order: id } as unknown as CustomFieldDefinition);
const laneField = (id: number, name: string) =>
  ({ id, name, field_type: "text", choices: [], order: id } as unknown as SwimlaneCustomFieldDefinition);

const board = {
  id: 1, name: "B", custom_field_definitions: [cardField(1, "Sprint"), cardField(2, "Cost")],
  swimlane_custom_field_definitions: [laneField(1, "Owner"), laneField(2, "Region")],
} as unknown as BoardFull;

const lists: [string, () => React.ReactElement, string, string][] = [
  ["card-field list", () => <BoardSettingsFieldsTab board={board} isAdmin onFieldsUpdated={vi.fn()} />, "Sprint", "Cost"],
  ["swimlane-field list", () => <BoardSettingsSwimlaneFieldsTab board={board} isAdmin onFieldsUpdated={vi.fn()} />, "Owner", "Region"],
];

describe.each(lists)("%s drag accessibility (#2190)", (_label, renderList, first, second) => {
  it("announces by field name and position, not dnd-kit's id", () => {
    render(renderList());
    const a = dnd.props.accessibility!.announcements as Required<Announcements>;
    const active = { id: 1 } as never;
    const over = { id: 2 } as never;
    expect(a.onDragStart({ active })).toBe(`Picked up field ${first}, at position 1 of 2.`);
    expect(a.onDragOver({ active, over })).toBe(`Field ${first} moved to position 2 of 2.`);
    expect(a.onDragOver({ active, over: null })).toBeUndefined();
    expect(a.onDragEnd({ active, over })).toBe(`Field ${first} dropped at position 2 of 2.`);
    expect(a.onDragEnd({ active, over: null })).toBe(`Field ${first} dropped.`);
    expect(a.onDragCancel({ active: over, over: null })).toBe(`Reorder canceled. Field ${second} returned to position 2 of 2.`);
    expect(dnd.props.accessibility!.screenReaderInstructions.draggable).toMatch(/reorder a field/);
  });

  it("Escape mid-drag does not reach the modal below; outside a drag it does", () => {
    const modalEscape = vi.fn();
    function Modal() { useEscapeStack(modalEscape, 40); return renderList(); }
    expect(FIELD_DRAG_ESCAPE_PRIORITY).toBeGreaterThan(40.6);
    render(<Modal />);
    act(() => { dnd.props.onDragStart!(); });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(modalEscape).not.toHaveBeenCalled();
    act(() => { dnd.props.onDragCancel!(); });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(modalEscape).toHaveBeenCalledTimes(1);
    // A drop also ends the drag.
    act(() => { dnd.props.onDragStart!(); });
    act(() => { dnd.props.onDragEnd!({ active: { id: 1 }, over: null } as unknown as DragEndEvent); });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(modalEscape).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: `Drag to reorder ${first}` })).toBeInTheDocument();
  });
});
