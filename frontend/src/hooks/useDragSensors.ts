import { KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";

/**
 * MouseSensor that only starts on the primary (left) button. Stock MouseSensor
 * rejects only right-click, so a middle-button press would start a drag and
 * fight middle-click autoscroll; the PointerSensor it replaced (#1287)
 * accepted only the primary button, and this keeps that behavior.
 */
export class PrimaryButtonMouseSensor extends MouseSensor {
  static activators = MouseSensor.activators.map((activator) => ({
    ...activator,
    handler: (...args: Parameters<typeof activator.handler>) =>
      (args[0].nativeEvent as MouseEvent).button === 0 && activator.handler(...args),
  }));
}

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
  const mouse = useSensor(PrimaryButtonMouseSensor, { activationConstraint: MOUSE_ACTIVATION });
  const touch = useSensor(TouchSensor, { activationConstraint: TOUCH_ACTIVATION });
  const keys = useSensor(KeyboardSensor);
  // useSensors drops null entries, so this is safe to vary per call site.
  return useSensors(mouse, touch, keyboard ? keys : null);
}
