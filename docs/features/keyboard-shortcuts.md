# Drive the board from the keyboard

<a id="keyboard-shortcuts"></a>

<span class="vb-version" title="Added in 1.1">1.1+</span>

Press `?` on any board (or use the avatar menu → **Keyboard shortcuts**) to open the shortcuts overlay.

**Why it matters:** For someone living in the board all day, a shortcut for every common action is the difference between staying in flow and reaching for the mouse.

**How it works:** shortcuts are platform-aware. macOS renders glyphs (⌘, ⇧, ⌥); Linux and Windows render named chords (`Ctrl`, `Shift`, `Alt`).

**Watch out:** single-letter shortcuts never fire while you type; see the rule below.

<a id="safety-rule-shortcuts-never-fire-while-typing"></a>

## Shortcuts never fire while typing

Single-letter shortcuts are suppressed when focus is in an input, textarea, select, or rich-text editor. Type `b` in the search box without switching to the Board view, or `y` in a card description without toggling the archived panel. Modifier chords (⌘K, ⌘\\) fire everywhere, because the modifier makes the intent unambiguous.

<a id="navigation-works-on-every-authenticated-page"></a>

## Navigation: every authenticated page

| Shortcut | Action |
|---|---|
| <kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd> | Open the command palette |
| <kbd>/</kbd> | Focus the search box (opens the filter bar if closed) |
| <kbd>⌘,</kbd> / <kbd>Ctrl+,</kbd> | Open board settings (admins only) |
| <kbd>G</kbd> then <kbd>U</kbd> | Open the user menu |

- **Command palette:** the single cross-route entry point. Type to find a card, jump to a board, or trigger an action. Placeholder copy adapts to the surface: it searches cards on a board, jumps to a board on the Dashboard, and lists navigation targets on Settings / Admin.
- **Board presets** <span class="vb-version" title="Added in 1.3">1.3+</span>: on a board, the palette offers **Apply preset: Classic** and **Apply preset: Default** (not the one already in use), and **Reset to preset: …** when the active preset is modified. They do exactly what the toolbar [Preset dropdown](board.md#board-presets) does, including the Undo notice. No new shortcut key.
- **Empty query:** the default list starts with your starred boards (alphabetical), then your most recent visits, so a blank `⌘K` → `Enter` jumps into the workspace you care about most.
- **Card actions:** on a board, the palette also lists commands for a card; see [Card actions in the command palette](#card-actions-in-the-command-palette).
- **`G` then `U`** is a chord, not a combo: press and release `G`, then press `U` within one second, to open the [user menu](navigation.md) from anywhere in the authenticated app.

## Board view: switch the active sub-tab

| Shortcut | Action |
|---|---|
| <kbd>B</kbd> | Switch to **Board** view |
| <kbd>S</kbd> | Switch to **Summary** view |
| <kbd>H</kbd> | Switch to **History** view |
| <kbd>A</kbd> | Switch to **Analytics** view |
| <kbd>L</kbd> | Switch to the [Issue Board Lens](issue-board-lens.md) view (only when a lens is configured on the board) |

View-tab shortcuts fire only on a board route (`/boards/<id>`). They write to the `?view=` URL param with replace-history semantics, so the browser Back button skips tab transitions.

## History view

| Shortcut | Action |
|---|---|
| <kbd>↑</kbd> / <kbd>↓</kbd> | Move between rows (only while focus is on the table; they do nothing in the filter controls or the detail panel) |
| <kbd>Enter</kbd> | Open the detail panel for the focused row |
| <kbd>Esc</kbd> | Close an open filter menu, then the detail panel, then return to the board, one level per press |

The rows are a single <kbd>Tab</kbd> stop. Closing the detail panel returns focus to the row that opened it, so <kbd>Enter</kbd> reopens it.

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
| <kbd>Menu</kbd> / <kbd>Shift+F10</kbd> | Open the focused card's [actions menu](board.md#card-actions-menu) |
| <kbd>Space + drag</kbd> | Pan the board with the mouse |
| <kbd>Tab</kbd> | Move between filter chips; <kbd>Delete</kbd> or <kbd>Backspace</kbd> to remove |

- **`E`** mirrors the toolbar's split-button primary action: if anything is expanded, it collapses everything; otherwise it expands everything. The split button's menu still offers granular "Hide all swimlanes / columns" options.
- **`F` and `⌘⇧L` / `Ctrl+Shift+L`** also work on the [Issue Board Lens](issue-board-lens.md) tab, since the lens shares the board's toolbar and its filter-row and card-layout shortcuts.

## Card actions in the command palette

<a id="card-actions-in-the-command-palette"></a>

<span class="vb-version" title="Added in 1.3">1.3+</span>

On a board, the command palette lists commands for a card: **Block card…** (or **Unblock card**), **Move card to…**, **Assign card to…**, **Set priority…**, **Copy link to card** and **Archive card**. It never offers Delete, so a typed command can't delete a card one keystroke from Enter; delete from the card's [actions menu](board.md#card-actions-menu) or the card detail panel.

The palette acts on the first of these that applies, and names it at the top ("Acting on Fix payout rounding"):

1. the card whose detail panel is open,
2. the card that had keyboard focus,
3. the selected cards.

Hovering a card never makes it the target. With none of these, typing a card command shows how to get one. To act on any other card, search for it and press <kbd>→</kbd> on the result.

| Key | In the palette |
|---|---|
| <kbd>→</kbd> | On a card result: show that card's commands |
| <kbd>←</kbd> or <kbd>Backspace</kbd> (empty search) | Go back one level |
| <kbd>Esc</kbd> | Go back one level; close the palette from the top level |

Commands ending in **…** open a second list (columns, people, priorities). **Block card…** closes the palette and opens the card with the block reason ready to type. A command your role can't use is listed, dimmed with the reason, only when you type its name.

No new single-letter shortcut was added for card actions: block a card with <kbd>Menu</kbd> → **Block card…**, or <kbd>⌘K</kbd>, type "bl", <kbd>Enter</kbd>.

## Help

| Shortcut | Action |
|---|---|
| <kbd>?</kbd> | Show this help overlay |
| <kbd>Esc</kbd> | Close the active dialog; go back when nothing is open |

## Accessibility

Every toolbar affordance with a single-key or single-modifier shortcut carries an `aria-keyshortcuts` attribute, so screen readers announce the binding when the control gains focus. Two-modifier chords (like <kbd>⌘⇧L</kbd>) stay in this overlay and the tooltip only, because exposing every chord via ARIA would overwhelm assistive technology without adding value.
