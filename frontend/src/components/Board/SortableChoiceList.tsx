import { useEffect, useRef, type ReactNode } from "react";
import { DndContext, type Announcements, type DragEndEvent, type UniqueIdentifier } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useDragSensors } from "../../hooks/useDragSensors";
import { useEscapeStack } from "../../hooks/useEscapeStack";

/**
 * Escape-stack priority while a choice is being dragged (#2190): above the
 * Board Settings modal (40) and its 40.6 discard prompt, so the Escape that
 * cancels a keyboard drag does not also close the modal and drop the draft.
 * Returns false (passes Escape on) whenever no drag is in progress.
 */
export const CHOICE_DRAG_ESCAPE_PRIORITY = 40.7;

/** The name a choice row is read by: its text, else its 1-based position (as the Remove button does). */
function choiceRowName(choice: string, index: number): string {
  return choice.trim() ? choice.trim() : String(index + 1);
}

// Choices are plain strings that may repeat or be empty while typed, so the
// sortable id is the row index (the rows are keyed by index too).
const idFor = (i: number) => `choice-${i}`;
const indexOf = (id: UniqueIdentifier) => Number(String(id).slice("choice-".length));

interface Props {
  choices: string[];
  onMove: (from: number, to: number) => void;
  /** The row's controls after the drag handle (color, text input, remove). */
  renderRow: (choice: string, index: number) => ReactNode;
}

/**
 * The choice rows of the card-field and swimlane-field editors (#2190), each
 * with a real drag-handle button: dnd-kit's KeyboardSensor with
 * `sortableKeyboardCoordinates` is the keyboard reorder path (Space or Enter
 * lifts, arrows move one row, Space drops, Escape cancels), the same as the
 * field lists' handles (#1739). Mouse and touch use the shared sensors.
 */
export default function SortableChoiceList({ choices, onMove, renderRow }: Props) {
  const sensors = useDragSensors({ keyboard: true, sortable: true });
  const handleRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Rows are keyed by index, so after a move the focused handle (left in
  // place) belongs to a different choice. Focus follows the moved choice to
  // its new row once the reordered list has rendered.
  const focusAfterMove = useRef<number | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const to = focusAfterMove.current;
    if (to === null) return;
    focusAfterMove.current = null;
    handleRefs.current[to]?.focus();
  }, [choices]);

  // The escape stack's document listener is registered before dnd-kit's (added at
  // pick-up), so it runs first and still sees the drag; dnd-kit then cancels it.
  useEscapeStack(() => (dragging.current ? undefined : false), CHOICE_DRAG_ESCAPE_PRIORITY);

  // "Choice Red" at the start of a sentence, "choice Red" inside one.
  const nameAt = (id: UniqueIdentifier, start = false) => {
    const i = indexOf(id);
    return `${start ? "Choice" : "choice"} ${choiceRowName(choices[i] ?? "", i)}`;
  };
  const position = (id: UniqueIdentifier) => `position ${indexOf(id) + 1} of ${choices.length}`;
  // Read by choice name and position, not by dnd-kit's internal ids.
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameAt(active.id)}, at ${position(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${nameAt(active.id, true)} moved to ${position(over.id)}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `${nameAt(active.id, true)} dropped at ${position(over.id)}.` : `${nameAt(active.id, true)} dropped.`),
    onDragCancel: ({ active }) => `Reorder canceled. ${nameAt(active.id, true)} returned to ${position(active.id)}.`,
  };

  const handleDragEnd = ({ active, over, activatorEvent }: DragEndEvent) => {
    dragging.current = false;
    if (!over || active.id === over.id) return;
    const from = indexOf(active.id);
    const to = indexOf(over.id);
    if (activatorEvent instanceof KeyboardEvent) focusAfterMove.current = to;
    onMove(from, to);
  };

  return (
    <DndContext
      sensors={sensors}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: "To reorder a choice, press Space or Enter to pick it up, the arrow keys to move it, Space or Enter to drop it, or Escape to cancel.",
        },
      }}
      onDragStart={() => { dragging.current = true; }}
      onDragEnd={handleDragEnd}
      onDragCancel={() => { dragging.current = false; }}
    >
      <SortableContext items={choices.map((_, i) => idFor(i))} strategy={verticalListSortingStrategy}>
        {choices.map((choice, i) => (
          <SortableChoiceRow
            key={i}
            id={idFor(i)}
            name={choiceRowName(choice, i)}
            handleRef={(el) => { handleRefs.current[i] = el; }}
          >
            {renderRow(choice, i)}
          </SortableChoiceRow>
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableChoiceRow({ id, name, handleRef, children }: {
  id: string;
  name: string;
  handleRef: (el: HTMLButtonElement | null) => void;
  children: ReactNode;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2">
      {/* A real button (#2190, the #1739 rule): a named, ringed tab stop that
          dnd-kit's KeyboardSensor picks up. `attributes` adds the sortable
          role description and the instructions via aria-describedby. */}
      <button
        type="button"
        ref={handleRef}
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder choice ${name}`}
        className="w-4 text-fg-tertiary hover:text-fg text-xs cursor-grab shrink-0 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>
      {children}
    </div>
  );
}
