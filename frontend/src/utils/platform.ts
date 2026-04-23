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
