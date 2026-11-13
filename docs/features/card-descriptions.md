# Format card descriptions with the toolbar or markdown

<a id="card-descriptions"></a>

Click a card's description to edit it, using the toolbar or typed markdown. Click outside to save.

**Why it matters:** There is no Save button. Changes are sent to the server on blur.

**How it works:** the editor parses both toolbar formatting and typed markdown, and stores the result as markdown. Mentions notify the person you name. Admins and members can edit; viewers and collaborators can only read.

## Editing a description

Click anywhere on the description area. A toolbar appears and the cursor lands at the end of the existing text.

- **Empty description:** view mode shows the placeholder "Add a description…". Click it to start writing.
- **Pencil icon (✎):** appears at the top right on hover. Clicking it also enters edit mode.
- **Save:** click anywhere outside the description. The editor closes and shows the formatted result immediately.

!!! tip
    Drag the description area's bottom edge to resize it vertically. This helps with long descriptions that would otherwise scroll inside the editor.

## Toolbar reference

Every toolbar action is one click. The table lists the Bold and Italic shortcuts; the editor (Tiptap StarterKit, with no custom bindings in Visiban) also binds its own default shortcuts for the other formats.

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

Active formatting is highlighted. Clicking an active button removes the formatting.

### Text color

The **A** button opens a picker with nine preset colors (Default reset, White, Red, Orange, Yellow, Green, Blue, Purple, Pink) and a tenth **Custom** swatch.

- **Apply:** select text, then click a swatch. The button shows an underline in the active color.
- **Custom color:** click **Custom** to open a color square and hue slider with hex and R/G/B fields. The color is applied to the text you had selected when you opened it, only when you click **Apply**. **Cancel** or Escape closes the panel and puts your selection back. Pressing outside the editor discards the unapplied color. A color you chose that is not one of the presets shows as the filled, ringed **Custom** swatch.
- **Keyboard:** the **A** button, the swatches and the panel's controls are all reachable with Tab and activated with Enter or Space.
- **Remove:** select the colored text and click the **Default** swatch.
- **Legibility:** the color you pick is stored as chosen, but the read-only view adjusts it per theme to stay readable. A pale color is darkened on the light theme, and a dark color is lightened on the dark theme, so existing colors such as White are now legible on the light theme. The editing view shows the color as chosen.
- **Storage:** colors are inline HTML spans inside the markdown. They render in both the editor and the read-only view.

## Supported markdown syntax

Type markdown directly; no toolbar needed. Pasted markdown is parsed automatically.

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

## @mentions

Type `@` plus a username or display name to mention a board member. An autocomplete dropdown filters as you type: use the arrow keys and Enter to select, or Escape to dismiss.

- Mentions are highlighted in blue in the editor and the rendered view.
- Saving a description with a new @mention sends that user an in-app notification, the same as @mentions in comments.
- Editing an existing mention does not send a duplicate.

!!! tip
    The autocomplete list shows up to six matching members. If you don't see the person, type more characters to narrow the results.

## View mode

Outside edit mode, the description renders bold, italic, headings, lists, code, code blocks, blockquotes, and links.

## Permissions

| Role | Can view | Can edit |
|---|---|---|
| Admin | ✅ | ✅ |
| Member | ✅ | ✅ |
| Viewer | ✅ | ❌ |
| Collaborator | ✅ | ❌ |

**Yes, but:** viewers and collaborators get no edit affordance at all: no hover border, no pencil icon, and clicking does not enter edit mode.
