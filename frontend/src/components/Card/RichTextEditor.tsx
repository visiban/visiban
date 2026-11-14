import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isImeComposing } from "../../utils/imeComposition";
import { focusEnclosingDialog } from "../../utils/focusEnclosingDialog";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useEditor, EditorContent, ReactRenderer, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import { Placeholder } from "@tiptap/extensions";
import MentionExtension from "@tiptap/extension-mention";
// @tiptap/pm is the required peer of @tiptap/react and @tiptap/core (same
// version); PluginKey is the only way to address the suggestion plugin.
import { PluginKey } from "@tiptap/pm/state";
import type { MentionOptions } from "@tiptap/extension-mention";
import { Markdown } from "tiptap-markdown";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { BoardUser, EffectiveBoardMember } from "../../types";
import { userDisplayName } from "../../types";
import MentionList from "./MentionList";
import { placeFixedElement, subscribeVisualViewport, type AnchoredSide } from "../../hooks/useAnchoredPlacement";
import type { MentionListRef } from "./MentionList";
import ActiveUnderline from "../Common/ActiveUnderline";
import CustomColorPanel from "../Common/CustomColorPanel";
import { DISMISS_LAYER_ATTR } from "../../utils/dismissLayer";
import ColorSpan from "./RichTextColorSpan";
import { editColorPlugin } from "./richTextEditColor";
import { cssColorToHex } from "../../utils/colorContrast";
import { COLOR_STYLE_PATTERN } from "../../utils/richTextSanitize";

/**
 * Our own key for the mention suggestion plugin, so the popup can end the
 * suggestion the same way Escape does (a metadata-only `{ exit: true }`
 * transaction, as `@tiptap/suggestion`'s `exitSuggestion` dispatches). Hiding
 * the element alone would leave the suggestion active and still capturing
 * Enter and the arrow keys.
 */
const mentionSuggestionKey = new PluginKey("mentionSuggestion");

/**
 * Combobox half of the ARIA pattern for the mention popup (#2149). TipTap owns
 * the editor element, so the attributes are set on `editor.view.dom` directly
 * while the suggestion is active (ProseMirror only rewrites attributes it set
 * itself, so these survive its re-renders) and removed on exit.
 *
 * WAI-ARIA 1.2 combobox: the focused element itself is the combobox, so while
 * the list is open the contenteditable's `role="textbox"` becomes
 * `role="combobox"`, matching `MentionTextarea`. Only attributes ARIA 1.2
 * supports on `combobox` are set (no `aria-multiline`), and it gets an accessible name
 * (the placeholder) if it has none. Every attribute touched is snapshotted and
 * restored, not just the role. `aria-expanded` is not supported on `textbox`, so keeping
 * the textbox role and adding only `aria-activedescendant` would not announce
 * that a list opened. Focus never leaves the editor.
 */
const COMBOBOX_ATTRS = [
  "role",
  "aria-label",
  "aria-expanded",
  "aria-haspopup",
  "aria-autocomplete",
  "aria-controls",
  "aria-activedescendant",
] as const;

type ComboboxSnapshot = Record<(typeof COMBOBOX_ATTRS)[number], string | null>;

function snapshotAttrs(dom: HTMLElement): ComboboxSnapshot {
  return Object.fromEntries(COMBOBOX_ATTRS.map((a) => [a, dom.getAttribute(a)])) as ComboboxSnapshot;
}

function setMentionCombobox(
  dom: HTMLElement,
  state: { listboxId: string; activeId: string } | null,
  label: string,
) {
  dom.setAttribute("role", "combobox");
  if (!dom.getAttribute("aria-label") && !dom.getAttribute("aria-labelledby")) {
    dom.setAttribute("aria-label", label);
  }
  dom.setAttribute("aria-autocomplete", "list");
  dom.setAttribute("aria-haspopup", "listbox");
  dom.setAttribute("aria-expanded", state ? "true" : "false");
  if (state) {
    dom.setAttribute("aria-controls", state.listboxId);
    dom.setAttribute("aria-activedescendant", state.activeId);
  } else {
    dom.removeAttribute("aria-controls");
    dom.removeAttribute("aria-activedescendant");
  }
}

function clearMentionCombobox(dom: HTMLElement, snapshot: ComboboxSnapshot) {
  for (const a of COMBOBOX_ATTRS) {
    const v = snapshot[a];
    if (v === null) dom.removeAttribute(a);
    else dom.setAttribute(a, v);
  }
}

interface Props {
  value: string;
  onSave: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  members?: EffectiveBoardMember[];
  minHeight?: string;
  /** When true, shows explicit Save + Cancel buttons instead of blur-to-save */
  showActions?: boolean;
}

// A small set of text color presets (dark-theme values; view mode adjusts them per theme, #2097).
// Stored as inline HTML spans in markdown. ProseMirror serializes the style from
// dom.style.cssText, so it is written as <span style="color: rgb(r, g, b);">text</span>
// even though the presets below are hex (the sanitizer accepts both forms).
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
      aria-label={title}
      aria-pressed={active ?? false}
      className={`relative px-2 py-1 rounded text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
        active
          ? "bg-surface-active text-fg"
          : "text-fg-secondary hover:bg-surface-hover hover:text-fg"
      }`}
    >
      {children}
      <ActiveUnderline active={active ?? false} />
    </button>
  );
}

const sameColor = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Seed for the custom panel when the selection carries no color of its own. */
const CUSTOM_FALLBACK = "#60A5FA";

// Color swatch picker rendered in the toolbar
function ColorPicker({
  editor,
  containerRef,
  currentColor,
  onSelect,
  onOutsideBlurSave,
}: {
  editor: Editor | null;
  containerRef: RefObject<HTMLDivElement | null>;
  currentColor: string;
  onSelect: (color: string) => void;
  /** Blur-save for a press outside the whole editor while the custom panel holds focus. */
  onOutsideBlurSave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  // Captured when the custom panel opens: focus moves into the panel, and the
  // editor's own selection must still be what Apply colors.
  const rangeRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });
  const [panelKey, setPanelKey] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);

  const close = useCallback(() => {
    setOpen(false);
    setCustom(false);
  }, []);

  // Cancel and Escape put the caret back where it was; the panel's focus is gone.
  const closeAndRestore = useCallback(() => {
    close();
    editor?.chain().focus().setTextSelection(rangeRef.current).run();
  }, [close, editor]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // composedPath, not contains(): pressing the Custom swatch unmounts it during this
      // very event, and a listener re-attached by that render still sees the press.
      if (ref.current && e.composedPath().includes(ref.current)) return;
      const wasCustom = custom;
      close();
      // The editor is unfocused while the panel is open, so its onBlur will not fire
      // for a press outside the whole editor: save-and-exit here, discarding the draft.
      if (wasCustom && !containerRef.current?.contains(target)) onOutsideBlurSave();
    };
    document.addEventListener("mousedown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
    };
  }, [open, custom, close, containerRef, onOutsideBlurSave]);

  // Priority 33 — above RichTextEditor edit-mode cancel (31) so Escape closes the
  // color picker without also exiting edit mode in the same keypress.
  useEscapeStack(() => {
    if (!open) return false;
    if (custom) closeAndRestore();
    else close();
  }, 33);

  // The wider custom body is shifted to stay inside the editor container.
  useLayoutEffect(() => {
    if (!custom) {
      setShift(0);
      return;
    }
    const pop = popoverRef.current;
    const box = containerRef.current;
    if (!pop || !box) return;
    const popRect = pop.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    const overflow = popRect.right - boxRect.right;
    if (overflow > 0) setShift(-Math.min(overflow, popRect.left - boxRect.left));
    pop.scrollIntoView?.({ block: "nearest" });
  }, [custom, containerRef]);

  // Any non-empty color value (including White) means a color is actively set.
  // Previously excluded #f1f5f9 (White) from the active state, causing the
  // toolbar indicator to show as inactive when the user explicitly chose White.
  const active = currentColor !== "";
  const isPreset = TEXT_COLORS.some((c) => sameColor(c.value, currentColor));
  const customSelected = active && !isPreset;

  const toggle = () => {
    if (open) close();
    else setOpen(true);
  };
  const choose = (value: string) => {
    onSelect(value);
    close();
  };
  const openCustom = () => {
    const sel = editor?.state.selection;
    rangeRef.current = { from: sel?.from ?? 0, to: sel?.to ?? 0 };
    setPanelKey((k) => k + 1);
    setCustom(true);
  };

  return (
    <div
      ref={ref}
      className="relative"
      // Tab out of the open popover discards it silently (a null relatedTarget is a
      // window blur or a removed node, not a Tab, and must not close it).
      onBlur={(e) => {
        if (!open || !e.relatedTarget) return;
        // Settle first: a pointer press inside the panel moves focus through
        // transient targets, so judge where focus actually landed.
        setTimeout(() => {
          const now = document.activeElement;
          if (now && now !== document.body && !ref.current?.contains(now)) close();
        }, 0);
      }}
    >
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); toggle(); }}
        // Keyboard activation fires click with detail 0; a mouse click already acted on mousedown.
        onClick={(e) => { if (e.detail === 0) toggle(); }}
        title="Text color"
        aria-label="Text color"
        aria-expanded={open}
        className={`px-2 py-1 rounded text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis relative flex items-center gap-1 ${
          active ? "bg-surface-active text-fg" : "text-fg-secondary hover:bg-surface-hover hover:text-fg"
        }`}
      >
        <span aria-hidden="true" style={{ borderBottom: `2px solid ${currentColor || "rgb(var(--fg-tertiary))"}` }}>A</span>
        {/* Menu trigger, not a toggle (no aria-pressed): the underline is the non-color cue that a color is set (#2188). */}
        <ActiveUnderline active={active} />
      </button>
      {open && (
        <div
          ref={popoverRef}
          {...{ [DISMISS_LAYER_ATTR]: "" }}
          style={shift ? { marginLeft: shift } : undefined}
          // Pressing the panel's padding or preview would otherwise move focus to <body>
          // and blur-save the editor out from under the draft. Controls keep their own focus.
          // Only a control INSIDE the popover counts: closest() also climbs past it, and the
          // card sheet's own tabindex="-1" would otherwise let the press focus the sheet,
          // which closes the panel (#2223).
          onMouseDown={(e) => {
            if (!custom) return;
            const control = (e.target as Element).closest("input,button,[tabindex]");
            if (!control || !e.currentTarget.contains(control)) e.preventDefault();
          }}
          className={`absolute top-full left-0 mt-1 z-50 bg-surface border border-line-strong rounded-lg shadow-xl p-2 ${
            custom ? "w-max" : "flex flex-wrap gap-2.5 w-40"
          }`}
        >
          {custom ? (
            <CustomColorPanel
              key={panelKey}
              value={currentColor || null}
              fallbackColor={CUSTOM_FALLBACK}
              onChange={(hex) => {
                const range = rangeRef.current;
                editor?.chain().focus().setTextSelection(range).setColor(hex).run();
                close();
              }}
              onCancel={closeAndRestore}
              focusSquare
            />
          ) : (
            <>
              {TEXT_COLORS.map((c) => {
                const selected = sameColor(currentColor, c.value);
                return (
                  <button
                    key={c.label}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(c.value);
                    }}
                    onClick={(e) => { if (e.detail === 0) choose(c.value); }}
                    title={c.label}
                    aria-label={`Text color ${c.label}`}
                    aria-pressed={selected}
                    className={`w-5 h-5 rounded-full border-2 transition hover:scale-110 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                      selected
                        ? "border-fg ring-2 ring-fg ring-offset-2 ring-offset-surface"
                        : "border-line-strong"
                    }`}
                    style={{ backgroundColor: c.value || "rgb(var(--fg-tertiary))" }}
                  />
                );
              })}
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); openCustom(); }}
                onClick={(e) => { if (e.detail === 0) openCustom(); }}
                title="Custom"
                aria-label="Text color Custom"
                aria-haspopup="dialog"
                aria-pressed={customSelected}
                className={`w-5 h-5 rounded-full border-2 transition hover:scale-110 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                  customSelected
                    ? "border-fg ring-2 ring-fg ring-offset-2 ring-offset-surface"
                    : "border-line-strong"
                }`}
                style={
                  customSelected
                    ? { backgroundColor: currentColor }
                    : { background: "conic-gradient(#f87171, #fbbf24, #4ade80, #60a5fa, #c084fc, #f87171)" }
                }
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Extend the Mention node with a markdown serializer so @username round-trips
// through tiptap-markdown's getMarkdown() as plain @username text.
const MentionWithMarkdown = MentionExtension.extend({
  addOptions() {
    // Tiptap 3 types every MentionOptions field as required, so spreading a
    // possibly-undefined `this.parent?.()` leaves them all optional and no longer
    // satisfies the return type. `extend()` always supplies a parent for an
    // extension that defines addOptions (Mention does), so assert it here rather
    // than restating each inherited field.
    const parent = this.parent?.() as MentionOptions;
    return {
      ...parent,
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tiptap doesn't export markdown serializer state/node types
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
      ["style", COLOR_STYLE_PATTERN],
    ],
  },
};

const VIEW_COMPONENTS = { span: ColorSpan };

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
  // Set by every deliberate exit (Escape, Cancel, Save) so the focus move to the
  // enclosing dialog does not fire the blur-save with stale content (#2182).
  const exitingRef = useRef(false);
  // Keep the latest members list accessible in the suggestion closure without
  // recreating the Tiptap editor whenever the members prop changes.
  const membersRef = useRef<EffectiveBoardMember[] | undefined>(members);
  // Set to true for one microtask tick when the mention-suggestion popup handles
  // an Escape key. Prevents the same keypress from also cancelling edit mode.
  const mentionJustClosedRef = useRef(false);
  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  const editor = useEditor({
    extensions: [
      // Tiptap 3's StarterKit bundles Link (with autolink: true) and Underline;
      // Tiptap 2's did not. Leaving them on would silently change what gets
      // stored: a bare URL typed into a description would become a link mark and
      // serialize as a markdown link, and Ctrl+U would start emitting <u> HTML.
      // Both are content changes, not rendering changes, so they are disabled
      // here to keep this upgrade behavior-neutral. Adopting autolinking is a
      // deliberate product decision — see #1105.
      StarterKit.configure({ link: false, underline: false }),
      TextStyle,
      // Editing view shows each stored color through the same per-theme adjustment as
      // view mode, as a decoration only; the stored hex is untouched (#2099).
      Color.extend({ addProseMirrorPlugins() { return [editColorPlugin()]; } }),
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
          pluginKey: mentionSuggestionKey,
          render: () => {
            let component: ReactRenderer<MentionListRef>;
            let popup: HTMLDivElement;
            // Placed from its measured height per the #1455 rules (below the
            // caret, else above, else bottom-pinned), and the side found on
            // the first measurement is kept while the typed query narrows the
            // list, so it never jumps across the caret (#1457).
            let side: AnchoredSide | undefined;
            let clientRect: (() => DOMRect | null) | null | undefined;
            const place = (rect: DOMRect) => {
              side = placeFixedElement(popup, rect, side, true) ?? side;
            };
            // A resize changes the viewport the popup was fitted to: end the
            // suggestion (onExit then removes the popup), as Escape does.
            let endSuggestion = () => {};
            // A scroll re-anchors to the live caret instead of dismissing: the
            // named exception in frontend/CLAUDE.md. ProseMirror and the
            // browser scroll the caret into view as the query is typed, which
            // happens exactly when the caret is near the edge, so a
            // scroll-dismiss would close the list mid-word.
            const onScroll = (e: Event) => {
              if (!popup || (e.target instanceof Node && popup.contains(e.target))) return;
              const rect = clientRect?.();
              if (rect) place(rect);
            };
            const onResize = () => endSuggestion();
            // The on-screen keyboard changes the visible viewport without a caret move (#2138):
            // re-anchor, never end the suggestion.
            const onViewportChange = () => {
              const rect = popup ? clientRect?.() : null;
              if (rect) place(rect);
            };
            let unsubscribeViewport: (() => void) | undefined;
            let resizeObserver: ResizeObserver | undefined;
            let editorDom: HTMLElement | undefined;
            let snapshot: ComboboxSnapshot | null = null;
            let comboboxOn = false;
            const onEditorBlur = () => endSuggestion();
            // Stable identity so MentionList's effect does not re-fire per render.
            const onActiveChange = (state: { listboxId: string; activeId: string } | null) => {
              if (editorDom && comboboxOn) setMentionCombobox(editorDom, state, placeholder);
            };

            return {
              onStart(props) {
                component = new ReactRenderer(MentionList, {
                  props: { ...props, onActiveChange },
                  editor: props.editor,
                });
                // Always create the popup, hidden: `clientRect()` can return
                // null until the suggestion's decoration renders, and the list
                // itself renders later still. A later update or resize
                // observation places and shows it.
                clientRect = props.clientRect;
                const { editor } = props;
                endSuggestion = () => {
                  if (editor.isDestroyed) return;
                  editor.view.dispatch(editor.state.tr.setMeta(mentionSuggestionKey, { exit: true }));
                };
                editorDom = editor.view.dom as HTMLElement;
                snapshot = snapshotAttrs(editorDom);
                // The attributes go on at start, while the popup can still be
                // visibility:hidden (it is placed once the caret rect and list
                // height exist). That window is a frame or so and harmless: the
                // option ids only become reachable once the list renders, and
                // aria-controls/activedescendant are set only then.
                comboboxOn = true;
                setMentionCombobox(editorDom, null, placeholder);
                editorDom.addEventListener("blur", onEditorBlur);
                popup = document.createElement("div");
                popup.dataset.testid = "mention-popup";
                popup.style.position = "fixed";
                popup.style.zIndex = "9999";
                // Scrolls when placeFixedElement caps it to the larger side (#2163).
                popup.style.overflowY = "auto";
                document.body.appendChild(popup);
                popup.appendChild(component.element);
                window.addEventListener("scroll", onScroll, true);
                window.addEventListener("resize", onResize);
                unsubscribeViewport = subscribeVisualViewport(onViewportChange);
                popup.style.visibility = "hidden";
                const rect = clientRect?.();
                if (rect) place(rect);
                // ReactRenderer commits the list asynchronously (and React may
                // defer it while the user is still typing), so the height read
                // above can be 0 or stale. Re-place whenever the list's size
                // actually changes: its first render, and each narrowing.
                if (typeof ResizeObserver !== "undefined") {
                  resizeObserver = new ResizeObserver(() => {
                    const next = clientRect?.();
                    if (next && popup.isConnected) place(next);
                  });
                  resizeObserver.observe(popup);
                }
              },
              onUpdate(props) {
                component.updateProps(props);
                if (props.clientRect) clientRect = props.clientRect;
                const rect = clientRect?.();
                if (rect && popup) place(rect);
              },
              onKeyDown({ event }) {
                if (event.key === "Escape" && !isImeComposing(event)) {
                  popup?.remove();
                  comboboxOn = false;
                  if (editorDom && snapshot) clearMentionCombobox(editorDom, snapshot);
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
                comboboxOn = false;
                if (editorDom) {
                  editorDom.removeEventListener("blur", onEditorBlur);
                  if (snapshot) clearMentionCombobox(editorDom, snapshot);
                  editorDom = undefined;
                }
                resizeObserver?.disconnect();
                window.removeEventListener("scroll", onScroll, true);
                window.removeEventListener("resize", onResize);
                unsubscribeViewport?.();
                unsubscribeViewport = undefined;
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
      if (exitingRef.current) return;
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
    exitingRef.current = false;
    setIsEditing(true);
    setTimeout(() => editor?.commands.focus("end"), 0);
  }, [readOnly, editor, value]);

  // Leaving edit mode unmounts the focused control, which would drop focus to
  // <body> (#2182, same class as #2087/#2170). Hand it to the enclosing dialog
  // first; the pencil cannot take it because its onFocus re-enters edit mode.
  const exitEdit = useCallback(() => {
    exitingRef.current = true;
    if (containerRef.current) focusEnclosingDialog(containerRef.current);
    setIsEditing(false);
  }, []);

  const handleSave = useCallback(() => {
    const md = editor?.storage.markdown?.getMarkdown() ?? "";
    onSave(md);
    exitEdit();
  }, [editor, onSave, exitEdit]);

  const handleCancel = useCallback(() => {
    editor?.commands.setContent(originalValueRef.current);
    exitEdit();
  }, [editor, exitEdit]);

  // Priority 31 — fires after ColorPicker (33) but before CardDetail panel-close (30).
  // First Escape while editing cancels the edit; second Escape then closes the panel.
  // When the mention suggestion popup just consumed an Escape, the flag short-circuits
  // this handler so only the popup is dismissed (not the edit mode too).
  useEscapeStack(() => {
    if (mentionJustClosedRef.current) return; // mention popup was just closed, stop chain
    if (!isEditing) return false; // not editing — pass to lower-priority handlers
    handleCancel();
  }, 31);

  // Same as the editor's onBlur save, for a press outside the editor while the custom
  // color panel (which holds focus) is open: onBlur cannot fire then (#2097).
  const blurSave = useCallback(() => {
    if (showActions || exitingRef.current) return;
    onSave(editor?.storage.markdown?.getMarkdown() ?? "");
    setIsEditing(false);
  }, [editor, onSave, showActions]);

  // A parsed span may carry `rgb(r, g, b)`: normalize to hex so the swatch compare and the
  // custom panel seed see one form.
  const rawColor = (editor?.getAttributes("textStyle").color as string) ?? "";
  const currentColor = cssColorToHex(rawColor)?.toLowerCase() ?? rawColor;

  if (!isEditing) {
    return (
      // role="presentation": click-to-edit on the surface is a pointer shortcut; the
      // keyboard path is the pencil button below, which is a real tab stop that
      // enters edit mode on focus/Enter/Space (#1376).
      <div
        role="presentation"
        className={`group relative ${readOnly ? "" : "cursor-text"}`}
        onClick={readOnly ? undefined : enterEdit}
      >
        {/* Pencil icon — visible on hover when editable, per design system pattern */}
        {!readOnly && (
          <button
            type="button"
            onClick={enterEdit}
            className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition p-1 rounded text-fg-muted hover:text-fg-secondary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            title="Edit description"
            aria-label="Edit description"
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
              <ReactMarkdown rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]]} components={VIEW_COMPONENTS}>{value}</ReactMarkdown>
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
          editor={editor}
          containerRef={containerRef}
          onOutsideBlurSave={blurSave}
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
          "[&_.mention]:bg-info/20 [&_.mention]:text-info-on-tint [&_.mention]:rounded [&_.mention]:px-1 [&_.mention]:font-medium",
        ].join(" ")}
      />

      {/* Save / Cancel — only shown when showActions is true.
          onMouseDown with preventDefault keeps editor focus so we can read the
          final content via getMarkdown() before the blur event fires. */}
      {showActions && (
        <div className="flex justify-end items-center gap-3 pt-1">
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
            // Keyboard activation fires click with detail 0; a mouse click already
            // acted on mousedown, so detail > 0 must not run it a second time.
            onClick={(e) => { if (e.detail === 0) handleCancel(); }}
            className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Cancel
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
            onClick={(e) => { if (e.detail === 0) handleSave(); }}
            className="text-sm bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover transition font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}
