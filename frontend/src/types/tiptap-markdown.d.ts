// Tiptap 3 declares `Storage` as an intentionally empty interface so that each
// extension can augment it with its own storage shape. Tiptap 2 typed
// `editor.storage` as a loose record, so `editor.storage.markdown` type-checked
// with no declaration at all — under v3 it does not.
//
// tiptap-markdown ships a `MarkdownStorage` type but never registers it against
// the `Storage` interface, so we do it here. Without this, every
// `editor.storage.markdown.getMarkdown()` call fails to compile under `tsc -b`.
import type { MarkdownStorage } from "tiptap-markdown";

declare module "@tiptap/core" {
  interface Storage {
    markdown: MarkdownStorage;
  }
}
