# Keyboard shortcuts

> **Added in 1.1**

Visiban ships with a keyboard-first control scheme so power users can drive the board without moving their hands from the home row. **Why it matters:** for someone living in the board all day, a shortcut for every common action is the difference between staying in flow and reaching for the mouse.

Shortcuts are platform-aware: macOS renders them as glyphs (⌘, ⇧, ⌥); Linux / Windows renders them as named chords (`Ctrl`, `Shift`, `Alt`).

Open the shortcuts overlay from any board by pressing `?`, or from the avatar menu → **Keyboard shortcuts**.

## Safety rule — shortcuts never fire while typing

Single-letter shortcuts are suppressed whenever the focused element is an input, textarea, select, or rich-text editor. Type `b` in the search box without switching to the Board view, or `y` in a card description without toggling the archived panel. Modifier chords (⌘K, ⌘\\) fire everywhere, because the modifier makes the intent unambiguous.

## Navigation — works on every authenticated page

| Shortcut | Action |
|---|---|
| <kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd> | Open the command palette |
| <kbd>/</kbd> | Focus the search box (opens the filter bar if closed) |
| <kbd>⌘,</kbd> / <kbd>Ctrl+,</kbd> | Open board settings (admins only) |
| <kbd>G</kbd> then <kbd>U</kbd> | Open the user menu |

The command palette is the single cross-route entry point: type to find a card, jump to a board, or trigger an action. Placeholder copy adapts to the current surface — on a board it searches cards; on the Dashboard it jumps to a board; on Settings / Admin it lists navigation targets.

Open the palette with an empty query and the default board list starts with your starred boards (alphabetical), rounded out by your most recent visits — a blank `⌘K` → `Enter` jumps straight into the workspace you care about most.

`G` then `U` is a chord, not a combo: press and release `G`, then press `U` within one second, to open the [user menu](navigation.md) from anywhere in the authenticated app.

## Board view — switch the active sub-tab

| Shortcut | Action |
|---|---|
| <kbd>B</kbd> | Switch to **Board** view |
| <kbd>S</kbd> | Switch to **Summary** view |
| <kbd>H</kbd> | Switch to **History** view |
| <kbd>A</kbd> | Switch to **Analytics** view |
| <kbd>L</kbd> | Switch to the [Issue Board Lens](issue-board-lens.md) view (only when a lens is configured on the board) |

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
| <kbd>⌘⇧E</kbd> / <kbd>Ctrl+Shift+E</kbd> | Export the board (if your role meets the board's [export threshold](permissions.md#permission-matrix)) |
| <kbd>.</kbd> | Open the overflow menu |
| <kbd>Space + drag</kbd> | Pan the board with the mouse |
| <kbd>Tab</kbd> | Move between filter chips; <kbd>Delete</kbd> or <kbd>Backspace</kbd> to remove |

`E` mirrors the toolbar's split-button primary action: if anything is expanded, it collapses everything; otherwise it expands everything. The split button's menu still offers granular "Hide all swimlanes / columns" options.

`F` and `⌘⇧L` / `Ctrl+Shift+L` also work on the [Issue Board Lens](issue-board-lens.md) tab, since the lens shares the board's toolbar and its filter-row and card-layout shortcuts.

## Help

| Shortcut | Action |
|---|---|
| <kbd>?</kbd> | Show this help overlay |
| <kbd>Esc</kbd> | Close the active dialog; go back when nothing is open |

## Accessibility

Every toolbar affordance with a single-key or single-modifier shortcut carries an `aria-keyshortcuts` attribute, so screen readers announce the binding when the control gains focus. Two-modifier chords (like <kbd>⌘⇧L</kbd>) stay in this overlay and the tooltip only — exposing every chord via ARIA would overwhelm assistive technology without adding value.
