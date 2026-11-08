/**
 * After an Escape-revert on an inline text field, hand focus to the enclosing
 * dialog container instead of calling `blur()` (#2082). `blur()` leaves focus
 * on `<body>`, so keyboard and screen-reader users lose their place in the open
 * panel. The card panel and `ModalWrapper` roots are `role="dialog"` with
 * `tabIndex={-1}`: programmatically focusable, no tab stop, and inside the
 * focus trap. Moving focus still fires the field's blur handler, so a
 * save-on-blur field must be reverted first. Falls back to `blur()` only when
 * there is no focusable dialog ancestor.
 */
export function focusEnclosingDialog(el: HTMLElement): void {
  const dialog = el.closest<HTMLElement>('[role="dialog"][tabindex]');
  if (dialog) dialog.focus({ preventScroll: true });
  else el.blur();
}
