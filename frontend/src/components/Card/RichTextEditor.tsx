import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import ReactMarkdown from "react-markdown";
import type { BoardMembership } from "../../types";

interface Props {
  value: string;
  onSave: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  members?: BoardMembership[];
  minHeight?: string;
}

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
          ? "bg-slate-600 text-white"
          : "text-slate-400 hover:bg-slate-700 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

export default function RichTextEditor({
  value,
  onSave,
  readOnly = false,
  placeholder = "Add a description…",
  minHeight = "min-h-32",
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
      Markdown.configure({
        transformPastedText: true,
        transformCopiedText: false,
      }),
    ],
    content: value,
    editable: true,
    onBlur: ({ event }) => {
      // Don't save if focus moved to a toolbar button (mousedown prevents blur there,
      // but guard against any other child of the container receiving focus)
      if (containerRef.current?.contains(event.relatedTarget as Node)) return;
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
    setIsEditing(true);
    // Focus the editor on next tick so the DOM is ready
    setTimeout(() => editor?.commands.focus("end"), 0);
  }, [readOnly, editor]);

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
            className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700"
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
              : "border-transparent group-hover:border-slate-600"
          }`}
        >
          {value.trim() ? (
            // Wrap in div — react-markdown v9 removed the className prop
            // Slate token overrides prevent gray/warm bleed from prose-invert defaults
            <div className={[
              "prose prose-invert prose-sm max-w-none",
              "prose-headings:text-slate-200 prose-headings:font-semibold",
              "prose-p:text-slate-300 prose-p:leading-relaxed",
              "prose-strong:text-slate-200",
              "prose-em:text-slate-300",
              "prose-li:text-slate-300",
              "prose-ul:text-slate-300 prose-ol:text-slate-300",
              "prose-code:text-slate-200 prose-code:bg-slate-700 prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none",
              "prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700 prose-pre:rounded-lg",
              "prose-blockquote:border-slate-600 prose-blockquote:text-slate-400",
              "prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline",
              "prose-hr:border-slate-700",
            ].join(" ")}>
              <ReactMarkdown>{value}</ReactMarkdown>
            </div>
          ) : (
            !readOnly && (
              <span className="text-sm text-slate-500 italic">{placeholder}</span>
            )
          )}
        </div>
      </div>
    );
  }

  // Edit mode
  return (
    <div ref={containerRef} className="flex flex-col gap-1">
      {/* Minimal toolbar */}
      <div className="flex items-center gap-0.5 px-1 py-0.5 bg-slate-700 rounded-t-lg border border-slate-600 border-b-0">
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
        <div className="w-px h-4 bg-slate-600 mx-0.5" />
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
        <div className="w-px h-4 bg-slate-600 mx-0.5" />
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
      </div>

      {/* Editor area */}
      <EditorContent
        editor={editor}
        className={[
          "w-full text-sm bg-slate-900 border border-blue-400 rounded-b-lg px-3 py-2",
          "outline-none text-slate-200",
          minHeight,
          "overflow-y-auto resize-y",
          // Prose styles inside the editor mirror the view-mode rendering
          "[&_.tiptap]:outline-none",
          "[&_.tiptap]:min-h-full",
          "[&_.tiptap_p]:text-slate-300 [&_.tiptap_p]:leading-relaxed [&_.tiptap_p]:mb-2",
          "[&_.tiptap_h2]:text-slate-200 [&_.tiptap_h2]:font-semibold [&_.tiptap_h2]:text-base [&_.tiptap_h2]:mb-1",
          "[&_.tiptap_h3]:text-slate-200 [&_.tiptap_h3]:font-semibold [&_.tiptap_h3]:text-sm [&_.tiptap_h3]:mb-1",
          "[&_.tiptap_ul]:list-disc [&_.tiptap_ul]:pl-4 [&_.tiptap_ul]:mb-2 [&_.tiptap_ul_li]:text-slate-300",
          "[&_.tiptap_ol]:list-decimal [&_.tiptap_ol]:pl-4 [&_.tiptap_ol]:mb-2 [&_.tiptap_ol_li]:text-slate-300",
          "[&_.tiptap_code]:bg-slate-700 [&_.tiptap_code]:text-slate-200 [&_.tiptap_code]:rounded [&_.tiptap_code]:px-1 [&_.tiptap_code]:text-xs",
          "[&_.tiptap_pre]:bg-slate-800 [&_.tiptap_pre]:border [&_.tiptap_pre]:border-slate-700 [&_.tiptap_pre]:rounded [&_.tiptap_pre]:p-2 [&_.tiptap_pre]:mb-2",
          "[&_.tiptap_blockquote]:border-l-2 [&_.tiptap_blockquote]:border-slate-600 [&_.tiptap_blockquote]:pl-3 [&_.tiptap_blockquote]:text-slate-400 [&_.tiptap_blockquote]:mb-2",
          "[&_.tiptap_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_.is-editor-empty:first-child::before]:text-slate-500 [&_.tiptap_.is-editor-empty:first-child::before]:italic [&_.tiptap_.is-editor-empty:first-child::before]:float-left [&_.tiptap_.is-editor-empty:first-child::before]:pointer-events-none",
        ].join(" ")}
      />
    </div>
  );
}
