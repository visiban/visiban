import { useRef } from "react";
import type { Announcements, DragEndEvent, UniqueIdentifier } from "@dnd-kit/core";
import { useEscapeStack } from "./useEscapeStack";

/**
 * Escape-stack priority while a field row is being dragged (#2190): above the
 * Board Settings modal (40) and its 40.6 discard prompt, so the Escape that
 * cancels a keyboard drag does not also close the modal.
 */
export const FIELD_DRAG_ESCAPE_PRIORITY = 40.7;

/**
 * Shared DndContext wiring for the Board Settings card-field and swimlane-field
 * lists (#1739, #2190): announcements that read the field's name and position
 * (never dnd-kit's internal id), and an escape-stack entry that consumes Escape
 * only while a drag is in progress. Field ids are stable, so unlike the choice
 * rows no focus-follow is needed.
 */
export function useSortableFieldDrag(fields: { id: UniqueIdentifier; name: string }[]) {
  const dragging = useRef(false);
  useEscapeStack(() => (dragging.current ? undefined : false), FIELD_DRAG_ESCAPE_PRIORITY);

  const nameAt = (id: UniqueIdentifier, start = false) => {
    const f = fields.find((x) => x.id === id);
    return `${start ? "Field" : "field"} ${f?.name ?? ""}`.trim();
  };
  const position = (id: UniqueIdentifier) => `position ${fields.findIndex((x) => x.id === id) + 1} of ${fields.length}`;

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameAt(active.id)}, at ${position(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${nameAt(active.id, true)} moved to ${position(over.id)}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `${nameAt(active.id, true)} dropped at ${position(over.id)}.` : `${nameAt(active.id, true)} dropped.`),
    onDragCancel: ({ active }) => `Reorder canceled. ${nameAt(active.id, true)} returned to ${position(active.id)}.`,
  };

  return {
    accessibility: {
      announcements,
      screenReaderInstructions: {
        draggable: "To reorder a field, press Space or Enter to pick it up, the arrow keys to move it, Space or Enter to drop it, or Escape to cancel.",
      },
    },
    onDragStart: () => { dragging.current = true; },
    onDragCancel: () => { dragging.current = false; },
    /** Clears the drag flag, then runs the list's own drop handler. */
    wrapDragEnd: (handler: (e: DragEndEvent) => void) => (e: DragEndEvent) => {
      dragging.current = false;
      handler(e);
    },
  };
}
