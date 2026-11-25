import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/**
 * One sortable `<li>` of the field-set editor lists (#2570). `children` gets the
 * drag handle to place in the row; phones hide it and use the row's Move
 * earlier / Move later buttons instead.
 */
export default function SortableRow({ id, name, className, children }: {
  id: number;
  name: string;
  className?: string;
  children: (handle: ReactNode) => ReactNode;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id });
  const handle = (
    <button type="button" {...attributes} {...listeners} aria-label={`Drag to reorder ${name}`}
      className="max-sm:hidden shrink-0 w-4 cursor-grab rounded text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
      <span aria-hidden="true">⋮⋮</span>
    </button>
  );
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }} className={className}>
      {children(handle)}
    </li>
  );
}
