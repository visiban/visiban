# Keyboard shortcuts

> **Added in 1.1**

Visiban ships with a keyboard-first control scheme so power users can drive the board without moving their hands from the home row. Shortcuts are platform-aware: on macOS they render as glyphs (⌘, ⇧, ⌥) and on Linux / Windows they render as named chords (`Ctrl`, `Shift`, `Alt`).

You can open the shortcuts overlay from any board at any time by pressing `?`, or from the avatar menu → **Keyboard shortcuts**.

## Safety rule — shortcuts never fire while typing

Single-letter shortcuts are suppressed whenever the focused element is an input, textarea, select, or rich-text editor. You can type `b` in the search box without switching to the Board view, and `y` in a card description without toggling the archived panel. Modifier chords (⌘K, ⌘\\) fire everywhere because the modifier makes the intent unambiguous.

## Navigation — works on every authenticated page

| Shortcut | Action |
|---|---|
| <kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd> | Open the command palette |
| <kbd>/</kbd> | Focus the search box (opens the filter bar if closed) |
| <kbd>⌘,</kbd> / <kbd>Ctrl+,</kbd> | Open board settings (admins only) |

The command palette is the single cross-route entry point: type to find a card, jump to a board, or trigger an action. Placeholder copy adapts to the current surface — on a board it searches cards; on the Dashboard it jumps to a board; on Settings / Admin it lists navigation targets.

When you open the palette with an empty query, the default board list starts with your starred boards (alphabetical) and is rounded out by your most recent visits, so a blank `⌘K` → `Enter` jumps straight into the workspace you care about most.

## Board view — switch the active sub-tab

| Shortcut | Action |
|---|---|
| <kbd>B</kbd> | Switch to **Board** view |
| <kbd>S</kbd> | Switch to **Summary** view |
| <kbd>H</kbd> | Switch to **History** view |
| <kbd>A</kbd> | Switch to **Analytics** view |

View-tab shortcuts only fire while you are on a board route (`/boards/<id>`). They write to the `?view=` URL param with replace-history semantics so the browser Back button skips tab transitions.

## Board actions

| Shortcut | Action |
|---|---|
| <kbd>F</kbd> | Toggle the filter bar |
| <kbd>E</kbd> | Collapse or expand every swimlane and column |
| <kbd>C</kbd> | Collapse the hovered swimlane |
| <kbd>Y</kbd> | Toggle the archived cards panel |
| <kbd>⌘⇧L</kbd> / <kbd>Ctrl+Shift+L</kbd> | Switch card layout (compact ↔ expanded) |
| <kbd>⌘\\</kbd> / <kbd>Ctrl+\\</kbd> | Toggle the activity drawer |
| <kbd>⌘⇧E</kbd> / <kbd>Ctrl+Shift+E</kbd> | Export the board (members and above) |
| <kbd>.</kbd> | Open the overflow menu |
| <kbd>Space + drag</kbd> | Pan the board with the mouse |
| <kbd>Tab</kbd> | Move between filter chips; <kbd>Delete</kbd> or <kbd>Backspace</kbd> to remove |

`E` mirrors the toolbar's split-button primary action: if anything is expanded it collapses everything, otherwise it expands everything. The menu on the split button still offers granular "Hide all swimlanes / columns" options.

## Help

| Shortcut | Action |
|---|---|
| <kbd>?</kbd> | Show this help overlay |
| <kbd>Esc</kbd> | Close the active dialog; go back when nothing is open |

## Accessibility

Every toolbar affordance that responds to a single-key or single-modifier shortcut carries an `aria-keyshortcuts` attribute so screen readers announce the binding when the control gains focus. Two-modifier chords (like <kbd>⌘⇧L</kbd>) stay in this overlay and the tooltip only — exposing every chord via ARIA would overwhelm assistive technology without adding value.
