import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useEditor, EditorContent, ReactRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextStyle from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import Placeholder from "@tiptap/extension-placeholder";
import MentionExtension from "@tiptap/extension-mention";
import { Markdown } from "tiptap-markdown";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { BoardMembership, BoardUser } from "../../types";
import { userDisplayName } from "../../types";
import MentionList from "./MentionList";
import type { MentionListRef } from "./MentionList";

interface Props {
  value: string;
  onSave: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  members?: BoardMembership[];
  minHeight?: string;
  /** When true, shows explicit Save + Cancel buttons instead of blur-to-save */
  showActions?: boolean;
}

// A small set of readable text colors for the dark theme.
// Stored as inline HTML spans in markdown: <span style="color: #hex">text</span>
const TEXT_COLORS: { label: string; value: string }[] = [
  { label: "Default",  value: ""        },
  { label: "White",    value: "#f1f5f9" },
  { label: "Red",      value: "#f87171" },
  { label: "Orange",   value: "#fb923c" },
  { label: "Yellow",   value: "#fbbf24" },
  { label: "Green",    value: "#4ade80" },
  { label: "Blue",     value: "#60a5fa" },
  { label: "Purple",   value: "#c084fc" },
  { label: "Pink",     value: "#f472b6" },
];

// Toolbar button: icon-only variant per design system
function ToolbarButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        // Prevent blur on the editor when clicking toolbar buttons
        e.preventDefault();
        onClick();
      }}
      title={title}
      className={`px-2 py-1 rounded text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${
        active
          ? "bg-surface-active text-white"
          : "text-fg-tertiary hover:bg-surface-hover hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

// Color swatch picker rendered in the toolbar
function ColorPicker({
  currentColor,
  onSelect,
}: {
  currentColor: string;
  onSelect: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
    };
  }, [open]);

  // Priority 33 — above RichTextEditor edit-mode cancel (31) so Escape closes the
  // color picker without also exiting edit mode in the same keypress.
  useEscapeStack(() => {
    if (!open) return false;
    setOpen(false);
  }, 33);

  // Any non-empty color value (including White) means a color is actively set.
  // Previously excluded #f1f5f9 (White) from the active state, causing the
  // toolbar indicator to show as inactive when the user explicitly chose White.
  const active = currentColor !== "";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }}
        title="Text color"
        className={`px-2 py-1 rounded text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-blue-500 flex items-center gap-1 ${
          active ? "bg-surface-active text-white" : "text-fg-tertiary hover:bg-surface-hover hover:text-white"
        }`}
      >
        <span style={{ borderBottom: `2px solid ${currentColor || "#94a3b8"}` }}>A</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-surface border border-line-strong rounded-lg shadow-xl p-2 flex flex-wrap gap-1.5 w-36">
          {TEXT_COLORS.map((c) => (
            <button
              key={c.label}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(c.value);
                setOpen(false);
              }}
              title={c.label}
              className={`w-5 h-5 rounded-full border-2 transition hover:scale-110 ${
                currentColor === c.value ? "border-white" : "border-line-strong"
              }`}
              style={{ backgroundColor: c.value || "#94a3b8" }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Extend the Mention node with a markdown serializer so @username round-trips
// through tiptap-markdown's getMarkdown() as plain @username text.
const MentionWithMarkdown = MentionExtension.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          state.write(`@${node.attrs.id}`);
        },
      },
    };
  },
});

// Allowlist-based sanitization schema for card descriptions rendered via rehypeRaw.
// rehypeRaw is required to preserve <span style="color:..."> tags written by the
// Tiptap Color extension. rehypeSanitize with this schema strips <script>, event
// handlers, javascript: hrefs, and all other unsafe HTML while permitting only the
// specific color: style value the Color extension emits.
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["style", /^color:\s*(#[0-9a-fA-F]{3,6}|[a-z]+)$/],
    ],
  },
};

export default function RichTextEditor({
  value,
  onSave,
  readOnly = false,
  placeholder = "Add a description…",
  members,
  minHeight = "min-h-32",
  showActions = false,
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Captures the committed value at the moment the user clicks to edit,
  // so Cancel can restore it without calling onSave.
  const originalValueRef = useRef(value);
  // Keep the latest members list accessible in the suggestion closure without
  // recreating the Tiptap editor whenever the members prop changes.
  const membersRef = useRef<BoardMembership[] | undefined>(members);
  // Set to true for one microtask tick when the mention-suggestion popup handles
  // an Escape key. Prevents the same keypress from also cancelling edit mode.
  const mentionJustClosedRef = useRef(false);
  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      TextStyle,
      Color,
      Placeholder.configure({ placeholder }),
      Markdown.configure({
        // html: true (default) is required — html: false strips <span style="color:...">
        // from the serialized output, silently discarding text colors on save.
        // Trade-off: html: true means tiptap-markdown will parse HTML-like sequences
        // (e.g. </path> in URL paths or self-closing tags like />) as raw HTML nodes.
        // In practice this is rare and the content round-trips correctly for typical
        // card descriptions. If the slash-parsing edge case becomes a user complaint,
        // investigate tiptap-markdown's `escapeSlash` option (added in 0.8.x).
        transformPastedText: true,
        transformCopiedText: false,
      }),
      MentionWithMarkdown.configure({
        HTMLAttributes: { class: "mention" },
        // Serialize the mention node to @username when copying as plain text.
        renderText: ({ node }) => `@${node.attrs.id}`,
        suggestion: {
          items: ({ query }: { query: string }): BoardUser[] => {
            if (!membersRef.current?.length) return [];
            return membersRef.current
              .map((m) => m.user)
              .filter((u) => {
                const q = query.toLowerCase();
                return (
                  u.username.toLowerCase().startsWith(q) ||
                  userDisplayName(u).toLowerCase().startsWith(q)
                );
              })
              .slice(0, 6);
          },
          render: () => {
            let component: ReactRenderer<MentionListRef>;
            let popup: HTMLDivElement;

            return {
              onStart(props) {
                component = new ReactRenderer(MentionList, {
                  props,
                  editor: props.editor,
                });
                if (!props.clientRect) return;
                popup = document.createElement("div");
                popup.style.position = "fixed";
                popup.style.zIndex = "9999";
                const rect = props.clientRect();
                if (rect) {
                  popup.style.left = `${rect.left}px`;
                  popup.style.top = `${rect.bottom + 4}px`;
                }
                document.body.appendChild(popup);
                popup.appendChild(component.element);
              },
              onUpdate(props) {
                component.updateProps(props);
                if (!props.clientRect || !popup) return;
                const rect = props.clientRect();
                if (rect) {
                  popup.style.left = `${rect.left}px`;
                  popup.style.top = `${rect.bottom + 4}px`;
                }
              },
              onKeyDown({ event }) {
                if (event.key === "Escape") {
                  popup?.remove();
                  // Signal that this Escape was consumed by the mention popup so
                  // the useEscapeStack handler at priority 31 doesn't also cancel
                  // edit mode in the same keypress.
                  mentionJustClosedRef.current = true;
                  setTimeout(() => { mentionJustClosedRef.current = false; }, 0);
                  return true;
                }
                return component.ref?.onKeyDown({ event }) ?? false;
              },
              onExit() {
                popup?.remove();
                component?.destroy();
              },
            };
          },
        },
      }),
    ],
    content: value,
    editable: true,
    onBlur: ({ event }) => {
      // Don't save if focus moved to a toolbar button, color picker, or action button —
      // all of these are inside containerRef
      if (containerRef.current?.contains(event.relatedTarget as Node)) return;
      // When showActions is true the Save button is the only save trigger — blur does nothing
      if (showActions) return;
      const md = editor?.storage.markdown?.getMarkdown() ?? "";
      onSave(md);
      setIsEditing(false);
    },
  });

  // Keep editor content in sync when the value prop changes externally
  useEffect(() => {
    if (!editor || isEditing) return;
    const current = editor.storage.markdown?.getMarkdown() ?? "";
    if (current !== value) {
      editor.commands.setContent(value);
    }
  }, [value, editor, isEditing]);

  const enterEdit = useCallback(() => {
    if (readOnly) return;
    originalValueRef.current = value;
    setIsEditing(true);
    setTimeout(() => editor?.commands.focus("end"), 0);
  }, [readOnly, editor, value]);

  const handleSave = useCallback(() => {
    const md = editor?.storage.markdown?.getMarkdown() ?? "";
    onSave(md);
    setIsEditing(false);
  }, [editor, onSave]);

  const handleCancel = useCallback(() => {
    editor?.commands.setContent(originalValueRef.current);
    setIsEditing(false);
  }, [editor]);

  // Priority 31 — fires after ColorPicker (33) but before CardDetail panel-close (30).
  // First Escape while editing cancels the edit; second Escape then closes the panel.
  // When the mention suggestion popup just consumed an Escape, the flag short-circuits
  // this handler so only the popup is dismissed (not the edit mode too).
  useEscapeStack(() => {
    if (mentionJustClosedRef.current) return; // mention popup was just closed, stop chain
    if (!isEditing) return false; // not editing — pass to lower-priority handlers
    handleCancel();
  }, 31);

  const currentColor = (editor?.getAttributes("textStyle").color as string) ?? "";

  if (!isEditing) {
    return (
      <div
        className={`group relative ${readOnly ? "" : "cursor-text"}`}
        onClick={readOnly ? undefined : enterEdit}
      >
        {/* Pencil icon — visible on hover when editable, per design system pattern */}
        {!readOnly && (
          <button
            type="button"
            onClick={enterEdit}
            className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition p-1 rounded text-fg-muted hover:text-fg-secondary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-blue-500"
            title="Edit description"
            tabIndex={0}
            onFocus={enterEdit}
          >
            ✎
          </button>
        )}

        {/* Hover border signals editability */}
        <div
          className={`rounded-lg px-3 py-2 border transition ${minHeight} ${
            readOnly
              ? "border-transparent"
              : "border-transparent group-hover:border-line-emphasis"
          }`}
        >
          {value.trim() ? (
            // prose prose-sm provides spacing/layout; explicit [&_el]: selectors
            // override colors — more reliable than prose-p:text-* modifiers across
            // Tailwind JIT scan contexts. rehypeRaw renders <span style="color:...">
            // from the Color extension.
            <div className={[
              "prose prose-sm max-w-none text-fg-secondary",
              "[&_h1]:text-fg [&_h1]:font-semibold",
              "[&_h2]:text-fg [&_h2]:font-semibold",
              "[&_h3]:text-fg [&_h3]:font-semibold",
              "[&_p]:text-fg-secondary [&_p]:leading-relaxed",
              "[&_strong]:text-fg",
              "[&_em]:text-fg-secondary",
              "[&_li]:text-fg-secondary",
              "[&_a]:text-info [&_a]:no-underline hover:[&_a]:underline",
              "[&_code]:text-fg [&_code]:bg-surface-hover [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs",
              "[&_pre]:bg-sunken [&_pre]:border [&_pre]:border-line [&_pre]:rounded-lg",
              "[&_blockquote]:border-l-4 [&_blockquote]:border-line-strong [&_blockquote]:pl-4 [&_blockquote]:text-fg-tertiary",
              "[&_hr]:border-line",
            ].join(" ")}>
              <ReactMarkdown rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]]}>{value}</ReactMarkdown>
            </div>
          ) : (
            !readOnly && (
              <span className="text-sm text-fg-muted italic">{placeholder}</span>
            )
          )}
        </div>
      </div>
    );
  }

  // Edit mode — containerRef wraps everything (toolbar + editor + actions) so
  // the blur-check correctly covers all child elements including Save/Cancel.
  return (
    <div ref={containerRef} className="flex flex-col gap-1">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-1 py-0.5 bg-surface-hover rounded-t-lg border border-line-strong border-b-0 flex-wrap">
        <ToolbarButton
          onClick={() => editor?.chain().focus().toggleBold().run()}
          active={editor?.isActive("bold")}
          title="Bold (Ctrl+B)"
        >
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          active={editor?.isActive("italic")}
          title="Italic (Ctrl+I)"
        >
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor?.chain().focus().toggleCode().run()}
          active={editor?.isActive("code")}
          title="Inline code"
        >
          {"</>"}
        </ToolbarButton>
        <div className="w-px h-4 bg-surface-active mx-0.5" />
        <ToolbarButton
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          active={editor?.isActive("bulletList")}
          title="Bullet list"
        >
          ≡
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          active={editor?.isActive("orderedList")}
          title="Numbered list"
        >
          1.
        </ToolbarButton>
        <div className="w-px h-4 bg-surface-active mx-0.5" />
        <ToolbarButton
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          active={editor?.isActive("heading", { level: 2 })}
          title="Heading"
        >
          H
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          active={editor?.isActive("blockquote")}
          title="Blockquote"
        >
          "
        </ToolbarButton>
        <div className="w-px h-4 bg-surface-active mx-0.5" />
        <ColorPicker
          currentColor={currentColor}
          onSelect={(color) => {
            if (color === "") {
              editor?.chain().focus().unsetColor().run();
            } else {
              editor?.chain().focus().setColor(color).run();
            }
          }}
        />
      </div>

      {/* Editor area.
          onKeyDown stopPropagation prevents board-level single-key shortcuts
          (e.g. "f" for filter) from firing while the user is typing here.
          Escape is intentionally excluded so it reaches useEscapeStack — first
          press cancels edit mode (priority 31), second press closes the panel (30). */}
      <EditorContent
        editor={editor}
        onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }}
        className={[
          "w-full text-sm bg-sunken border border-info rounded-b-lg px-3 py-2",
          "outline-none",
          minHeight,
          "overflow-y-auto resize-y",
          // Base text color on the root tiptap element — prevents browser-default
          // black text from showing against the dark bg-sunken background
          "[&_.tiptap]:outline-none",
          "[&_.tiptap]:min-h-full",
          "[&_.tiptap]:text-fg-secondary",
          "[&_.tiptap]:caret-white",
          "[&_.tiptap_p]:text-fg-secondary [&_.tiptap_p]:leading-relaxed [&_.tiptap_p]:mb-2",
          "[&_.tiptap_h2]:text-fg [&_.tiptap_h2]:font-semibold [&_.tiptap_h2]:text-base [&_.tiptap_h2]:mb-1",
          "[&_.tiptap_h3]:text-fg [&_.tiptap_h3]:font-semibold [&_.tiptap_h3]:text-sm [&_.tiptap_h3]:mb-1",
          "[&_.tiptap_ul]:list-disc [&_.tiptap_ul]:pl-4 [&_.tiptap_ul]:mb-2 [&_.tiptap_ul_li]:text-fg-secondary",
          "[&_.tiptap_ol]:list-decimal [&_.tiptap_ol]:pl-4 [&_.tiptap_ol]:mb-2 [&_.tiptap_ol_li]:text-fg-secondary",
          "[&_.tiptap_code]:bg-surface-hover [&_.tiptap_code]:text-fg [&_.tiptap_code]:rounded [&_.tiptap_code]:px-1 [&_.tiptap_code]:text-xs",
          "[&_.tiptap_pre]:bg-surface [&_.tiptap_pre]:border [&_.tiptap_pre]:border-line [&_.tiptap_pre]:rounded [&_.tiptap_pre]:p-2 [&_.tiptap_pre]:mb-2",
          "[&_.tiptap_blockquote]:border-l-2 [&_.tiptap_blockquote]:border-line-strong [&_.tiptap_blockquote]:pl-3 [&_.tiptap_blockquote]:text-fg-tertiary [&_.tiptap_blockquote]:mb-2",
          "[&_.tiptap_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_.is-editor-empty:first-child::before]:text-fg-muted [&_.tiptap_.is-editor-empty:first-child::before]:italic [&_.tiptap_.is-editor-empty:first-child::before]:float-left [&_.tiptap_.is-editor-empty:first-child::before]:pointer-events-none",
          // Mention chips in the editor
          "[&_.mention]:bg-info/20 [&_.mention]:text-info [&_.mention]:rounded [&_.mention]:px-1 [&_.mention]:font-medium",
        ].join(" ")}
      />

      {/* Save / Cancel — only shown when showActions is true.
          onMouseDown with preventDefault keeps editor focus so we can read the
          final content via getMarkdown() before the blur event fires. */}
      {showActions && (
        <div className="flex justify-end items-center gap-2 pt-1">
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
            className="text-sm text-fg-tertiary hover:text-white px-3 py-1.5 transition rounded"
          >
            Cancel
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
            className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 transition font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}
