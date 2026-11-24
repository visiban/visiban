/**
 * The Fields part of the field-set editor (#2570): the set's fields in draft
 * order (drag handle; Move earlier / later on phones) and the grouped
 * "+ Add field" menu. Nothing is saved here; the editor's Save does it.
 */
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { CustomFieldDefinition } from "../../types";
import { useDragSensors } from "../../hooks/useDragSensors";
import { useSortableFieldDrag } from "../../hooks/useSortableFieldDrag";
import { CUSTOM_FIELD_TYPE_LABEL } from "../../utils/customFieldValue";
import { FIELD_SET_MENU_ESCAPE_PRIORITY, insertByPosition } from "../../utils/fieldSetSettings";
import { buttonClasses } from "../Page";
import MultiSelectDropdown from "../Common/MultiSelectDropdown";
import SortableRow from "./SortableRow";

const BTN_QUIET = buttonClasses("quiet", { className: "aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent" });

interface Props {
  definitions: CustomFieldDefinition[];
  fieldIds: number[];
  setName: string;
  /** The name of the other set a field is in now, if any. */
  otherSetOf: (fieldId: number) => string | undefined;
  onChange: (fieldIds: number[]) => void;
}

export default function FieldSetFieldList({ definitions, fieldIds, setName, otherSetOf, onChange }: Props) {
  const members = fieldIds.map((id) => definitions.find((d) => d.id === id)).filter((d): d is CustomFieldDefinition => d !== undefined);
  const sensors = useDragSensors({ keyboard: true, sortable: true });
  const drag = useSortableFieldDrag(members);
  const ids = members.map((d) => d.id);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length || from === to) return;
    onChange(arrayMove(ids, from, to));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over) move(ids.indexOf(Number(active.id)), ids.indexOf(Number(over.id)));
  };
  const addable = definitions.filter((d) => !fieldIds.includes(d.id));
  const free = addable.filter((d) => !otherSetOf(d.id)).map((d) => d.name);
  const taken = addable.filter((d) => otherSetOf(d.id)).map((d) => d.name);
  const byName = (name: string) => definitions.find((d) => d.name === name);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-fg-muted">Fields</p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} accessibility={drag.accessibility}
        onDragStart={drag.onDragStart} onDragCancel={drag.onDragCancel} onDragEnd={drag.wrapDragEnd(onDragEnd)}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-1">
            {members.map((d, i) => (
              <SortableRow key={d.id} id={d.id} name={d.name} className="flex items-center gap-2 text-sm">
                {(handle) => (
                  <>
                    {handle}
                    <span className="flex-1 min-w-0 truncate" title={d.name}>{d.name} <span className="text-xs text-fg-muted">{CUSTOM_FIELD_TYPE_LABEL[d.field_type]}</span></span>
                    <button type="button" className={`${BTN_QUIET} sm:hidden max-sm:min-w-11`} aria-label={`Move ${d.name} earlier`} aria-disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
                    <button type="button" className={`${BTN_QUIET} sm:hidden max-sm:min-w-11`} aria-label={`Move ${d.name} later`} aria-disabled={i === members.length - 1} onClick={() => move(i, i + 1)}>↓</button>
                    <button type="button" className={BTN_QUIET} aria-label={`Remove ${d.name} from ${setName || "this set"}`}
                      onClick={() => onChange(ids.filter((x) => x !== d.id))}>Remove</button>
                  </>
                )}
              </SortableRow>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <MultiSelectDropdown
        label="Add field"
        placeholder="+ Add field"
        addOnly
        options={[...free, ...taken]}
        groups={[{ label: "Not in a set", options: free }, { label: "In another set", options: taken }]}
        optionHint={(name) => {
          const other = otherSetOf(byName(name)?.id ?? -1);
          return other ? `Moves it out of ${other}` : undefined;
        }}
        selected={[]}
        escapePriority={FIELD_SET_MENU_ESCAPE_PRIORITY}
        onCommit={(names) => onChange(names.reduce((next, name) => {
          const d = byName(name);
          return d ? insertByPosition(next, d.id, definitions) : next;
        }, ids))}
      />
    </div>
  );
}
