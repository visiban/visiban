/**
 * True while an IME composition is active (#2167).
 *
 * During composition, Enter commits the candidate and Escape cancels it, so
 * neither key may submit a form or close a modal. `keyCode === 229` covers
 * Safari, which fires the keydown that ends a composition with `isComposing`
 * already false.
 */
export function isImeComposing(
  e: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } },
): boolean {
  return Boolean(e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229);
}
