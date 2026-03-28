# Card Descriptions

Card descriptions support rich text formatting. You can write plain text, use the toolbar to apply formatting, or type markdown directly — the editor parses both.

## Editing a description

Click anywhere on the description area to enter edit mode. A toolbar appears at the top and the cursor is placed at the end of the existing text.

If the description is empty, the placeholder "Add a description…" is shown in view mode. Click it to start writing.

A **pencil icon (✎)** appears in the top-right corner of the description on hover — clicking it also enters edit mode.

To save, click anywhere outside the description. The editor closes and the formatted result is displayed immediately. Changes are sent to the server on blur — there is no explicit Save button.

!!! tip
    The description area can be resized vertically by dragging its bottom edge. This is useful for longer descriptions that would otherwise require scrolling inside the editor.

## Toolbar reference

The toolbar provides one-click access to common formatting. All actions can also be triggered with keyboard shortcuts.

| Button | Format | Keyboard shortcut |
|---|---|---|
| **B** | Bold | Ctrl+B / Cmd+B |
| *I* | Italic | Ctrl+I / Cmd+I |
| `</>` | Inline code | — |
| ≡ | Bullet list | — |
| 1. | Numbered list | — |
| H | Heading (level 2) | — |
| " | Blockquote | — |
| **A** | Text color | — |

Active formatting is highlighted in the toolbar. Clicking an active button removes the formatting.

### Text color

The **A** button in the toolbar opens a color picker with nine options: Default (reset), White, Red, Orange, Yellow, Green, Blue, Purple, and Pink. Select text first, then click a color swatch to apply it. The toolbar button shows an underline in the currently active color.

To remove a color, select the colored text and click the **Default** swatch. This resets the text to the standard description color.

Text colors are stored as inline HTML spans inside the markdown content. They render correctly in both the editor and the read-only view.

## Supported markdown syntax

Descriptions are stored as markdown. You can type markdown directly in the editor without using the toolbar:

| Syntax | Result |
|---|---|
| `**bold**` | **bold** |
| `_italic_` | *italic* |
| `` `code` `` | `code` |
| `## Heading` | Heading |
| `- item` | Bullet list item |
| `1. item` | Numbered list item |
| `> quote` | Blockquote |
| ` ```code block``` ` | Code block |

Pasted markdown is parsed automatically — paste a formatted document and it renders correctly.

## @mentions

Type `@` followed by a username or display name to mention a board member in a description. An autocomplete dropdown appears as you type, filtered by the characters after `@`. Use the arrow keys and Enter to select a member, or press Escape to dismiss the dropdown.

Mentions are highlighted in blue in both the editor and the rendered view. When you save a description that contains a new @mention, the mentioned user receives an in-app notification — the same notification behavior as @mentions in comments. Editing an existing mention does not send a duplicate notification.

!!! tip
    The autocomplete list shows up to six matching members. If you do not see the person you are looking for, type more characters to narrow the results.

## View mode

When you are not editing, the description renders as formatted text. Bold, italic, headings, lists, code, code blocks, blockquotes, and links are all displayed.

## Permissions

| Role | Can view | Can edit |
|---|---|---|
| Admin | ✅ | ✅ |
| Member | ✅ | ✅ |
| Viewer | ✅ | ❌ |
| Collaborator | ✅ | ❌ |

Viewers and collaborators see the rendered description with no edit affordance — no hover border, no pencil icon, and clicking does not enter edit mode.
