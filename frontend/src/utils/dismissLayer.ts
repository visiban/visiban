/**
 * "One press dismisses one layer", to match Escape (#2095). A popover that opens inside
 * a host with its own press-to-dismiss surface (a modal's backdrop, the card sheet's
 * click-catcher) can mark its root with this attribute. While it is mounted, a press on
 * that surface dismisses only the popover; the next press reaches the host. Only the
 * custom color popover and the rich-text color popover opt in so far. The check searches the host's DOM, so a portaled
 * popover (SelectDropdown, MultiSelectDropdown) cannot opt in this way.
 *
 * Asked of the DOM, at press time, so there is no registry or listener to outlive the
 * popover. The host must ask before the press closes it: its `pointerdown` handler or
 * its React `mouseDown` both run before a popover's document-level `mousedown` listener.
 */
export const DISMISS_LAYER_ATTR = "data-dismiss-layer";

export function hasOpenDismissLayer(host: HTMLElement | null): boolean {
  return host?.querySelector(`[${DISMISS_LAYER_ATTR}]`) != null;
}
