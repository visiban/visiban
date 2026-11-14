import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { cssColorToHex, textColorStyle } from "../../utils/colorContrast";

/**
 * Editing-view counterpart of RichTextColorSpan (#2099). The stored color is the raw
 * hex the author picked and must stay that way (it is what getMarkdown() writes), so
 * the adjustment is a ProseMirror inline *decoration*: it wraps the colored text in a
 * `.rt-color` span carrying the same `--rt-fg-{light,dark}` pair view mode uses
 * (`textColorStyle`, picked by `[data-theme]` in index.css), and never touches the
 * document, the mark or the serializer. Because the theme choice is pure CSS, a theme
 * toggle while the editor is open needs no re-render. Colors the helper cannot
 * normalize get no decoration and keep their raw value, same as view mode.
 */
export function colorDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name !== "textStyle") continue;
      const hex = cssColorToHex(mark.attrs.color);
      const vars = hex ? textColorStyle(hex) : null;
      if (!vars) continue;
      const style = Object.entries(vars).map(([k, v]) => `${k}: ${v}`).join("; ");
      decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: "rt-color", style }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const editColorPluginKey = new PluginKey("richTextEditColor");

export function editColorPlugin(): Plugin {
  return new Plugin({
    key: editColorPluginKey,
    props: { decorations: (state) => colorDecorations(state.doc) },
  });
}
