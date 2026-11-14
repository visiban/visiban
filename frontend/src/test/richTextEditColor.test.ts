/** Editing-view theme adjustment of stored text colors (#2099), against real ProseMirror. */
import { describe, it, expect, afterEach } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { colorDecorations, editColorPlugin } from "../components/Card/richTextEditColor";
import { readableTextColor } from "../utils/colorContrast";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
  marks: {
    textStyle: {
      attrs: { color: { default: null } },
      toDOM: (m) => ["span", { style: `color: ${m.attrs.color}` }, 0],
    },
  },
});

const doc = (...runs: Array<[string, string | null]>) =>
  schema.node("doc", null, [
    schema.node("paragraph", null, runs.map(([t, c]) =>
      schema.text(t, c ? [schema.marks.textStyle.create({ color: c })] : []))),
  ]);

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; });

function mount(d: ReturnType<typeof doc>) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  view = new EditorView(el, { state: EditorState.create({ doc: d, plugins: [editColorPlugin()] }) });
  return view;
}

describe("richTextEditColor (#2099)", () => {
  it("decorates a colored run with the per-theme pair for both themes", () => {
    const [deco] = colorDecorations(doc(["white", "#f1f5f9"])).find();
    const attrs = (deco as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
    expect(attrs.class).toBe("rt-color");
    // Light theme must darken near-white text; dark theme keeps it as stored.
    expect(attrs.style).toContain(`--rt-fg-light: ${readableTextColor("#f1f5f9", "light")}`);
    expect(attrs.style).toContain("--rt-fg-dark: #F1F5F9");
    expect(readableTextColor("#f1f5f9", "light")).not.toBe("#F1F5F9");
  });

  it("reads the rgb() form a browser writes back", () => {
    expect(colorDecorations(doc(["x", "rgb(241, 245, 249)"])).find()).toHaveLength(1);
  });

  it("leaves uncolored text and colors it cannot normalize undecorated", () => {
    expect(colorDecorations(doc(["plain", null], ["named", "red"], ["four", "#abcd"])).find()).toHaveLength(0);
  });

  it("renders .rt-color with both theme properties and leaves the stored color untouched", () => {
    const d = doc(["dark text", "#0f172a"]);
    const before = JSON.stringify(d.toJSON());
    const v = mount(d);
    const span = v.dom.querySelector(".rt-color") as HTMLElement;
    expect(span).not.toBeNull();
    expect(span.textContent).toBe("dark text");
    expect(span.style.getPropertyValue("--rt-fg-light")).toBe("#0F172A");
    // Near-black on the dark surface must be lightened.
    expect(span.style.getPropertyValue("--rt-fg-dark")).not.toBe("#0F172A");
    // Stored value is the raw hex: document and mark attribute are unchanged.
    expect(JSON.stringify(v.state.doc.toJSON())).toBe(before);
    expect(v.state.doc.firstChild!.firstChild!.marks[0].attrs.color).toBe("#0f172a");
  });

  it("re-decorates after an edit so new colored text is adjusted too", () => {
    const v = mount(doc(["a", "#f1f5f9"]));
    v.dispatch(v.state.tr.insertText("b", 2));
    expect(v.dom.querySelectorAll(".rt-color").length).toBeGreaterThan(0);
    expect(v.state.doc.textContent).toBe("ab");
  });
});
