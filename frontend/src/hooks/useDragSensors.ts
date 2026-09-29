import { KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";

/**
 * Mouse drags start after 5px of movement so a plain click on a card still
 * opens it instead of starting a drag.
 */
export const MOUSE_ACTIVATION = { distance: 5 } as const;

/**
 * Touch drags start on press-and-hold (#1287). A distance constraint cannot
 * work on touch: the board scrolls on both axes, so the browser claims the
 * first few pixels of finger movement as a pan and cancels the pointer before
 * any threshold is reached. A 250ms hold lets a quick swipe keep scrolling
 * while a long press picks the card up. `tolerance` is how far the finger may
 * drift during the hold before the gesture is treated as a scroll instead.
 */
export const TOUCH_ACTIVATION = { delay: 250, tolerance: 5 } as const;

/**
 * Drag sensors for every DndContext in the app.
 *
 * Deliberately MouseSensor + TouchSensor rather than PointerSensor: pointer
 * events report touch as pointers too, so a PointerSensor alongside a
 * TouchSensor would race it for the same gesture. dnd-kit recommends this
 * split whenever touch and mouse need different activation constraints.
 *
 * `keyboard` adds dnd-kit's KeyboardSensor. It is opt-in because the board
 * grid has never had keyboard dragging (cards move from the keyboard through
 * the card-detail Move popover), while the Board Settings field lists relied
 * on DndContext's default sensors, which include it.
 */
export function useDragSensors({ keyboard = false }: { keyboard?: boolean } = {}) {
  const mouse = useSensor(MouseSensor, { activationConstraint: MOUSE_ACTIVATION });
  const touch = useSensor(TouchSensor, { activationConstraint: TOUCH_ACTIVATION });
  const keys = useSensor(KeyboardSensor);
  // useSensors drops null entries, so this is safe to vary per call site.
  return useSensors(mouse, touch, keyboard ? keys : null);
}
