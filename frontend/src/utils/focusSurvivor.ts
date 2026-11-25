/**
 * Moves focus to an element that outlives a Retry button which is about to unmount,
 * so keyboard focus never drops to `<body>` (frontend/CLAUDE.md, #2568/#2575).
 * For a survivor that is not focusable by itself (a landmark, a section), the
 * `tabindex` is lent only until focus leaves, so a later click on blank space
 * there does not keep focusing it.
 */
export function focusSurvivor(element: HTMLElement | null | undefined): void {
  if (!element) return;
  if (!element.hasAttribute("tabindex")) {
    element.setAttribute("tabindex", "-1");
    element.addEventListener("blur", () => element.removeAttribute("tabindex"), { once: true });
  }
  element.focus({ preventScroll: true });
}
