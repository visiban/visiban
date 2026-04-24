// Platform detection + shortcut-label helpers. Centralised so every tooltip,
// <kbd> hint, and docs string renders `⌘` on Mac and `Ctrl` on Linux/Windows
// without each call site duplicating the `navigator.platform` check.

interface NavWithUAData extends Navigator {
  userAgentData?: { platform?: string };
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as NavWithUAData;
  // Prefer userAgentData.platform (modern Chromium) because navigator.platform
  // is deprecated; fall back to the deprecated field so Firefox and Safari
  // still resolve correctly.
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The platform-appropriate label for the "primary modifier" key. */
export function modKeyLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

/** The platform-appropriate label for the Shift key in a chord display. */
export function shiftKeyLabel(): string {
  return isMacPlatform() ? "⇧" : "Shift";
}

interface ShortcutParts {
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  key: string;
}

/**
 * Renders a modifier-combo shortcut for the current platform.
 * Mac: glyph-concatenated (⌘⇧E). Non-Mac: plus-separated (Ctrl+Shift+E).
 */
export function formatShortcut(parts: ShortcutParts): string {
  if (isMacPlatform()) {
    let s = "";
    if (parts.mod) s += "⌘";
    if (parts.shift) s += "⇧";
    if (parts.alt) s += "⌥";
    s += parts.key;
    return s;
  }
  const segs: string[] = [];
  if (parts.mod) segs.push("Ctrl");
  if (parts.shift) segs.push("Shift");
  if (parts.alt) segs.push("Alt");
  segs.push(parts.key);
  return segs.join("+");
}

/**
 * Renders a shortcut as the `aria-keyshortcuts` attribute value expected by
 * the ARIA 1.2 spec: space-separated chord with `Meta`/`Control` modifier
 * names, e.g. `"Meta+Shift+L"` on Mac or `"Control+Shift+L"` elsewhere. The
 * single-character key is uppercased because screen readers announce the
 * canonical form.
 *
 * Per the #868 noise-budget rule, only chords with at most one modifier
 * should be exposed via `aria-keyshortcuts`; richer chords (like ⌘⇧L) stay
 * in the shortcuts overlay and tooltip only.
 */
export function formatAriaKeyshortcuts(parts: ShortcutParts): string {
  const segs: string[] = [];
  if (parts.mod) segs.push(isMacPlatform() ? "Meta" : "Control");
  if (parts.shift) segs.push("Shift");
  if (parts.alt) segs.push("Alt");
  // Uppercase bare letter keys so "b" announces as "B"; leave named keys
  // (Escape, Enter, Slash, etc.) untouched for the user agent to canonicalise.
  segs.push(parts.key.length === 1 ? parts.key.toUpperCase() : parts.key);
  return segs.join("+");
}
