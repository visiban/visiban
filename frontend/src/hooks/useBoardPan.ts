import { useEffect, useRef } from "react";

/**
 * Space+drag board panning — Figma/Miro convention.
 *
 * Holding Space arms pan mode (cursor: grab). Pressing the primary mouse
 * button while pan mode is armed activates dragging (cursor: grabbing) and
 * translates subsequent mouse movement 1:1 into scrollLeft/scrollTop on the
 * scroll container. Releasing Space or the mouse button ends pan mode.
 *
 * Guards:
 *   - Space keydown is ignored when focus is inside an input, textarea, or
 *     contenteditable so users can type spaces normally in form fields.
 *   - mousedown suppresses dnd-kit via preventDefault + stopPropagation only
 *     while pan mode is active, so normal card drag-and-drop is unaffected.
 *   - Hit-area guard: elements with [data-no-pan] (column headers, swimlane
 *     labels, card surfaces) prevent pan from starting when clicked directly,
 *     although Space+drag on the cell background always works.
 */
export function useBoardPan(scrollRef: React.RefObject<HTMLElement | null>) {
  const panArmed = useRef(false);   // Space is currently held
  const panActive = useRef(false);  // mouse button is down while Space held
  const origin = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function isEditableFocused() {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      const ce = (document.activeElement as HTMLElement)?.isContentEditable;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ce;
    }

    function armPan() {
      if (isEditableFocused()) return;
      panArmed.current = true;
      el!.style.cursor = "grab";
    }

    function disarmPan() {
      panArmed.current = false;
      panActive.current = false;
      el!.style.cursor = "";
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.code === "Space" && !e.repeat && !panArmed.current) armPan();
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") disarmPan();
    }

    function onMouseDown(e: MouseEvent) {
      if (!panArmed.current || e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-no-pan]")) return;
      e.preventDefault();
      e.stopPropagation();
      panActive.current = true;
      el!.style.cursor = "grabbing";
      origin.current = {
        x: e.clientX,
        y: e.clientY,
        scrollLeft: el!.scrollLeft,
        scrollTop: el!.scrollTop,
      };
    }

    function onMouseMove(e: MouseEvent) {
      if (!panActive.current) return;
      const dx = e.clientX - origin.current.x;
      const dy = e.clientY - origin.current.y;
      el!.scrollLeft = origin.current.scrollLeft - dx;
      el!.scrollTop = origin.current.scrollTop - dy;
    }

    function onMouseUp() {
      if (!panActive.current) return;
      panActive.current = false;
      if (panArmed.current) el!.style.cursor = "grab";
    }

    // Blur deactivates pan so Space held during window switch doesn't linger
    function onBlur() { disarmPan(); }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    el.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      el.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      el.style.cursor = "";
    };
  }, [scrollRef]);
}
