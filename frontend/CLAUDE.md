# Frontend UI Conventions

## How this file works (#2681)

This file is the always-loaded index of the frontend UI rules. The sections below it in full apply to almost every frontend edit. Every other section lives verbatim in a topic file under `frontend/ui-conventions/`, which is not auto-loaded: when a change touches an area in the [Topic index](#topic-index), read that topic file before writing code or reviewing it. A code comment or doc that cites `frontend/CLAUDE.md` § <title> resolves through the Topic index line of that title.

- **A new rule goes into the topic file it belongs to**, inside its section, or as a new `## ` section there. A new section also gets one line in the Topic index: `` - **<Section title>** — <one-sentence rule summary> → `frontend/ui-conventions/<file>.md` ``. A new topic file gets a `### ` heading there.
- **Only a rule that applies to almost every frontend edit goes here in full.** Moving a section between this file and a topic file moves its text unchanged.
- `scripts/check-frontend-claude-md.py` (CI job `frontend-claude-md-size`) fails when this file exceeds 48 KB, an index line exceeds 300 characters, an index line points at a missing file or section, or a topic-file section has no index line.

## Color tokens

- **The Analytics page ground is `bg-page`, never `bg-sunken` (#2311).** `--surface-page` is slate-100 (`241 245 249`) in light and slate-900 (`15 23 42`) in dark, matching the approved artboards; it is used on the Analytics root only (`AnalyticsView`). `bg-sunken` (slate-50 in light) left white panels at 1.05:1 against the page, so the tab read as one white sheet; `bg-page` gives 1.10:1 in light and 1.22:1 in dark. Panels stay `bg-surface`. Text on the page ground measures 9.45 / 12.02 (`fg-secondary`) and 6.92 / 6.96 (`fg-tertiary`), light / dark. Pinned against the chart tokens in `analyticsBreakdown.test.tsx`.
- **A bordered control that has a hover fill rests on `bg-surface` (#2311).** On `bg-page` a control with only a border and `hover:bg-surface-hover` would show the page through it at rest (Export CSV, Retry, the Break down by group). **Never leave `fg-tertiary`, `danger` or `warning` text on a `hover:bg-surface-hover` fill (any row or box):** on that fill dark `fg-tertiary` is 4.04, dark `danger` 3.74 and light `danger` 4.41, all under 4.5. This covers Needs attention rows and the drill drawer's rows. Either signal hover with a border (`hover:border-line-emphasis`) or, for a warning box, `hover:ring-1 hover:ring-inset hover:ring-warning`; or, where the fill stays, put `group` on the row and `group-hover:text-fg-secondary` on its tertiary text (the drill drawer's column and card rows, `AttentionSection`'s secondary line).
- **Always use `slate`, never `gray`** — they are not interchangeable. `gray` is warmer/less blue-tinted and creates visible mismatch on adjacent surfaces in the dark theme.

**Three-level background depth system** — use these levels consistently, never flatten them:

| Level | Usage | Class |
|---|---|---|
| Deepest | Grid cells, page canvas | `bg-canvas` |
| Mid | Column headers, swimlane labels, card surfaces, panels | `bg-surface` |
| Elevated | Dropdowns, modals, popovers | `bg-surface` with `shadow-xl` |

- Borders: `border-line-subtle` for grid lines (subtle), `border-line` for panels, `border-line-strong` for interactive elements
- **Boundary border (#2381).** `border-line-strong` measures 1.93:1 (dark) / 2.56:1 (light) on `surface`, under the 3:1 non-text floor, and is a shared token (80+ uses, plus the chart `neutralTint` exception), so it was not raised. A border that is the only separator or the only cue for a control (sub-column dividers, the open track chip, the empty progress segment, the phone sub-column switcher) uses `border-line-boundary` (`--border-boundary`): 3.64:1 dark (113 128 150) and 4.76:1 light (slate-500) on `surface`, both at least 3:1 on `surface-sunken` too. Pinned in `onTintTokens.test.ts`.
- Text: `text-fg` for primary content, `text-fg-secondary` for secondary, `text-fg-muted` for muted/stats (not on the card face or the row-chip cluster, next bullet)
- **`fg-muted` is AA text on every resting surface; `fg-faint` is decorative-only (#2030).** Dark `--fg-muted` is `132 147 169` (it was slate-500, 3.07:1 on `bg-surface`): 4.69 on `bg-surface` and `bg-raised`, 5.72 on `bg-sunken`, 6.46 on `bg-canvas`. Light is `92 108 131` (slate-500 was 4.34 on `bg-canvas` and `bg-surface-hover`): 5.35 surface, 5.11 sunken, 4.88 canvas and surface-hover. The order `fg-secondary` > `fg-tertiary` > `fg-muted` > `fg-faint` holds in both themes; the tertiary/muted step is the compressed one (1.22:1 dark, 1.42 light), so never let that step alone separate two kinds of information. **Text on a resting `bg-surface-hover` or `bg-surface-active` fill (a chip, a kbd hint, a date field) is `fg-secondary`** (6.97 dark / 9.45 light on surface-hover): dark `fg-muted` is 3.32 there (4.88 light), and even `fg-tertiary` is 4.04 in dark (6.92 light). That covers the `Pinned`, `Emailed` and `Superuser` chips (the #2083 Superuser chip, `fg-secondary` on surface-hover, measures 6.97 / 9.45), the `OverflowMenu` shortcut hint, the column-header stat pill and both `Select a date` fields. A `hover:bg-surface-hover` *state* is different: its text brightens with it (`hover:text-fg`, or `hover:text-fg-secondary` on a control that rests at `fg-tertiary` or `fg-muted`); the #2030 sweep covered every class string whose hover fill and text tone sit within two lines of each other, so check a new site by hand (the scan below does not catch hover states). **`fg-faint` (1.93 dark / 2.56 light on surface) is only for marks that carry no information on their own:** separators, an icon next to its label, emoji, hover-reveal affordances (`opacity-0 group-hover:opacity-100`) and disabled controls. Informative text that used it (empty-state lines, counts, `(optional)`, timestamps, `Unknown`, always-visible remove/clear/delete buttons, the populated cell's `+ Add card`) is now `fg-muted`. The card face and its sibling surfaces keep `fg-tertiary` as their floor (#1862, § Card aging ramp). Measured side effects: the `Avatar` `?` fallback is `bg-fg-muted text-surface` (white on the brighter dark disc would be 3.12; the knocked-out glyph is 4.69 dark / 5.35 light); every `bg-fg-muted/N` pill carries `text-muted-on-tint` (at least 7.25 dark / 7.32 light over canvas, sunken and surface; `fg-tertiary` on the dark `/20` fill fell to 4.20); placeholders, the board scrollbar thumb and the `bg-fg-muted` timeline dots are slightly brighter in dark. `onTintTokens.test.ts` pins these and scans `src/` for three regressions: a `bg-fg-muted/N` literal without `text-muted-on-tint`; a class literal with a resting `bg-surface-hover`/`bg-surface-active` fill and `fg-tertiary`, `fg-muted` or `fg-faint` text; and a `text-fg-faint` line with no decorative marker (`aria-hidden`, `<svg`, `opacity-0`, `opacity-40`, `cursor-not-allowed`) and no listed reason. The marker scan cannot tell visible text that is merely hidden from assistive tech: `aria-hidden` text a sighted user reads (a shortcut hint such as the Navbar `⌘K`) is informative and uses `fg-muted`.

- **Light `--warning` / `--success` are the -700 step (#2029).** The -600 step was 3.56 / 3.30:1 on white. Now `--warning` orange-700 `194 65 12` is 5.18:1 on `bg-surface`, 4.95 on `bg-sunken`, 4.73 on `bg-canvas` and `bg-surface-hover`; `--success` green-700 `21 128 61` 5.02 / 4.79 / 4.58 / 4.58. Dark is unchanged (orange-400 / green-400). Every `text-warning` / `text-success` on those surfaces clears AA, so no card-face or toast exemption remains. Consequences, measured: the `bg-<hue>/N` fills darken with the token, so on-tint text on them drops slightly (light; the worst surfaces to measure a `/N` fill over are `bg-canvas`, `bg-sunken`, `bg-surface` and `bg-surface-active`, the hover fill of the view tabs and other toggles, and every new on-tint pairing is measured over all four; on `bg-surface-active` the light warning/success `/20` fill with on-tint text is 4.51:1, a margin of about 0.01, recomputed by audit, so do not darken either token or the fill further): `/20` warning 5.26 → 5.01, success 5.27 → 5.00 (health floor re-pinned at 5.00); `/15` 5.59 → 5.39 and 5.56 → 5.36; `/30` warning 4.65 → 4.30 on canvas, so do not put `text-warning-on-tint` on `bg-warning/30` over `bg-canvas`. The aging ramp's stale fill moved to its own `--stale-tint` (the old orange) because on `bg-warning/15` at `opacity-85` the light stale badge (`warning-on-tint` text) fell to 4.44:1 (the card title holds 9.71); ramp ratios are unchanged.
- **A badge inside a control whose fill changes with state carries its own opaque fill (#2236).** The Analytics tab's Beta badge was `bg-warning/30` (active) / `bg-warning/20` (inactive) with `text-warning-on-tint`, so its contrast came from the tab underneath: 1.17:1 light / 2.71 dark on the active `bg-primary`, and on the hover `bg-surface-active` 3.55 dark / 4.50 light. In dark mode even unfilled `warning-on-tint` is 4.49:1 on `bg-surface-active`, so no translucent amber fill can work there. It is now one static class in every tab state: `bg-surface text-warning-on-tint ring-1 ring-inset ring-warning/40` (the ring is the amber cue and the chip edge on the light track; it carries no text), 8.67:1 dark / 7.31 light whatever the tab does. Never put a translucent `bg-<hue>/N` badge inside a tab, toggle or selected row that switches between `bg-surface-hover`, `bg-surface-active` and `bg-primary`, and never compute a badge's ratio against only the rest state. Pinned in `onTintTokens.test.ts` (parsed from `BoardView.tsx`) and `boardView.test.tsx`.
- **`success-on-tint` and `info-on-tint` as toast text (#2060).** Measured from `index.css` with the WCAG formula (pinned in `onTintTokens.test.ts`). On `bg-surface`: `success-on-tint` 10.42:1 dark / 7.14:1 light, `info-on-tint` 8.11 / 8.72. On `bg-primary/15` over `bg-surface` (the `info` toast shell): `success-on-tint` 9.11 / 5.78, `info-on-tint` 7.09 / 7.07. All clear AA (4.5:1); no new token. `warning-on-tint` (8.67 / 7.31) and `danger-on-tint` (7.71 / 8.31) on `surface` are recorded in § System signals departure 2.

## Section header actions

When a section header (e.g. "My Boards", "Groups") carries action buttons:
- Place them right-aligned in a `flex items-center gap-2` group
- Primary action (e.g. "+ New board"): primary button variant
- Secondary action (e.g. "Import"): Secondary (bordered) or Quiet button variant — **not** `text-info`; that color is reserved for active filter/selection states
- Do **not** use a full-width dashed bottom button as the primary creation affordance when the section already has content — that pattern reads as an empty state

## Buttons

Seven variants — use no others (#2475; Danger outline added in #2504). `components/Page/buttonClasses.ts` (`buttonClasses(variant)`, `<Button variant>` in `components/Page`) is the source of truth for new code; existing call sites spell the same classes out.

| Variant | Use | Classes |
|---|---|---|
| Primary | the one main action (at most one in a header) | `bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium` |
| Secondary | other actions; the board toolbar's style | bordered: `bg-surface border border-line-strong text-fg font-medium hover:bg-surface-hover` |
| Quiet | Cancel, Discard, low-emphasis actions | bare text: `text-fg-secondary hover:text-fg hover:bg-surface-hover` |
| Danger | destructive actions | `bg-danger-bg hover:bg-danger-bg-hover text-on-danger font-medium` |
| Danger outline | a destructive *trigger* that opens a confirm (group Transfer ownership, Delete group; #2504) | bordered: `bg-surface border border-danger/40 text-danger font-medium hover:bg-danger/20 hover:text-danger-on-tint`, `focus:ring-danger-emphasis`; resting `text-danger` on `bg-surface` measures 5.29:1 (dark) / 4.83:1 (light) |
| Warning | reversible but consequential actions (#2169) | `bg-warning-bg hover:bg-warning-bg-hover text-on-warning font-medium` |
| Icon-only | a glyph with an `aria-label` | `hover:bg-surface-hover` with icon content |

- **Renamed in #2475: the old "Secondary" (bare text) is now Quiet; Secondary is the bordered style.** Nothing was restyled by the rename: a call site that spells out the bare-text classes is Quiet, one that spells out the bordered classes is Secondary. When an older rule below says "secondary variant" for a bare-text control (Mode indicator exit controls, a "Done" button), read Quiet.
- **Shared-look size: 36px, 44px on phones** (`h-9 max-sm:h-11`; the Centered layout's auth controls are 48px on phones, `size: "lg"`). Older dense contexts keep `px-3 py-1.5 text-sm` until their page is redesigned.

- Consistent sizing: `px-3 py-1.5 text-sm rounded` for most buttons
- **Every Cancel button is the Quiet variant (#484, #2475)** — never the bordered Secondary — modal footers and inline Confirm/Cancel prompts alike: `text-fg-secondary hover:text-fg hover:bg-surface-hover` + `rounded`, never `text-fg-tertiary` and never without the hover fill. Sizing follows the context (`px-3 py-1.5 text-sm` in a footer; an inline prompt with no padding gets `px-1` so the fill does not clip the text). `src/test/cancelButtonHover.test.ts` scans every `.tsx` under `src/` (native `<button>`s, `className={buttonClasses("…")}` and the shared `<Button variant>`) and fails on a Cancel button that drifts, including one with a `border-line-strong` border (the three bordered Cancels in `WebhookDetail` moved to Quiet in #2475).
- Focus state: `focus:outline-none focus:ring-2 focus:ring-primary-emphasis` (use `focus:ring-danger-emphasis` for danger buttons) — always use `focus:` not `focus-visible:` for consistency
- **Warning variant (reversible but consequential actions, e.g. Archive; also the GitLab sign-in button) (#2169):** `bg-warning-bg hover:bg-warning-bg-hover text-on-warning font-medium`. Never `text-fg` on `bg-warning-bg`: with the old amber-600 fill it was 2.58:1 in dark mode, and it is 3.56 light / 4.07 dark on amber-700. `--warning-bg` is amber-700 `180 83 9` in both themes and `--warning-bg-hover` amber-800 `146 64 14`; white text is 5.02:1 at rest and 7.09:1 on hover (amber-600 gave 3.19 at rest). Focus ring `focus:ring-warning-emphasis`, or `focus:ring-primary-emphasis` on the sign-in buttons, which match their siblings. In dark mode the fill is 2.91:1 against `bg-surface`, about the same as the danger fill (3.03); the label carries the control. Pinned in `onTintTokens.test.ts`, which also fails on any other text color on a `bg-warning-bg` fill in the three files that define one as a button (`CardDetail`, `ProviderIcons`, `Page/buttonClasses.ts`; the sign-in pages draw theirs from the last two since #2479).
- Disabled state: `disabled:opacity-40 disabled:cursor-not-allowed` — never `disabled:opacity-50`
- Primary and danger buttons always include `font-medium`
- Border radius: always `rounded` — never `rounded-lg` on buttons (sole exception: the file dropzone, see § Multi-step import wizards and file uploads)
- **Every icon-only button carries an `aria-label`, the focus ring above and `type="button"` (#1737).** `title` alone is not a reliable accessible name (Firefox and VoiceOver can skip it); keep `title` as the tooltip and add `aria-label`, naming the target in a repeated row (`Remove direct board role for <name>`, `Remove choice <name>`, `Decrease weight`). A glyph such as `✕`, `✎`, `−` or `+` is never a name. Audit with a multi-line-aware pass: a single-line `grep '<button'` misses a JSX button whose attributes span lines.
- **Never use a `btn-*` class (#2245).** The project defines no `btn-primary` / `btn-secondary` / `btn-*` utilities, so such a class renders an unstyled button with no focus ring and fails silently. Spell the variant's classes out. A bordered secondary action inside a popover or settings block (Confirm status, Recompute now) uses `inline-flex items-center gap-2 text-sm border border-line-strong text-fg px-3 py-1.5 rounded font-medium transition hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40 disabled:cursor-not-allowed`.

**Why `--button-primary` is a separate token from `--primary`:** CTAs use `blue-900` (`#1e3a8a`, 10.36:1 on white) in light mode for comfortable AAA contrast, with `--button-primary-hover` one step darker at `blue-950` (`#172554`) so a primary button **darkens** on hover in both themes (#484; `blue-800` made light-mode buttons lighten, and `src/test/primaryButtonTokens.test.ts` pins hover darker than rest with white text ≥4.5:1 in both), while `--primary` stays `blue-600` for brand-tint surfaces (avatars, active tabs, toggle tracks, saved-filter tabs). Do not consolidate these back into a single token — issue #855 intentionally split them so primary CTAs read as strong actions without desaturating the app's blue accents. Dark mode assigns both tokens the same blue-600 value; the split only matters on light backgrounds. Never use `bg-primary` on a button-shaped element, and never use `text-fg` on a `bg-button-primary` fill — `text-on-primary` is the only permitted text color on primary CTAs.

- **Every per-row text-button action in an admin table must carry the full button compliance set — `rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis` (or `focus:ring-danger-emphasis` for a destructive action) — even though it renders as bare text, not a filled button.** The Admin → Users per-row actions cell (`AdminPage.tsx`) is the reference: as of #1291 only the two highest-frequency actions — Deactivate/Reactivate and Make/Demote admin — stay as inline bare-text buttons, with `focus:ring-danger-emphasis` reserved for Deactivate and Demote admin (the two that remove access). Every remaining low-frequency action (Grant/Revoke all-content, Force reset, Clear lockout, Restart onboarding tour) moved into that row's `OverflowMenu` — see § Admin table row overflow menu below. A bare-text action is still a real button and needs a visible focus indicator and consistent corner radius like any other (#1280).

## Inputs and textareas

- `bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary`
- Focus ring: `focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent`
- Placeholder: `placeholder-fg-muted`
- **A dynamic hint under a form field must be reachable by assistive tech (#2371 ux-review).** A hint that appears or changes with the field's value (Add child's "Lead time without dates: split the work." under Needed) gets an id that the field's `aria-describedby` includes while it is shown (alongside any static help id), or is a `role="status"` region; a sighted-only hint is a defect. Reference: `AddChildDialog`.
- **Inputs in a row with `SingleSelectDropdown` triggers** (rule builders such as `LaneFilterPopover`, #2205/#2226) use `px-2 py-1 text-sm`, matching the trigger, rather than `px-3 py-1.5`, so the row's controls share one height. Standalone form inputs keep `px-3 py-1.5`.

## Motion and reduced motion (#199)

- **Every decorative animation carries `motion-reduce:animate-none`** — `animate-pulse` (highlighted card, search-match cells, "Working..." text, connection-status dots, indeterminate progress) and `animate-fade-in` (e.g. a newly created board row) must stop under `prefers-reduced-motion`.
- **An indeterminate progress bar also falls back to a static one-third width** (`w-full motion-reduce:w-1/3`), never a full bar that reads as "done" — see § Import Board sample gallery (#1452).
- Functional `animate-spin` loading spinners are exempt.

## Native checkbox and radio accent

When a native `<input type="checkbox">` or `<input type="radio">` is rendered with its default browser control visible (i.e. *not* the `sr-only` custom-styled radio pattern above), it **must** set `accent-primary` — never a raw palette value like `accent-blue-500` / `accent-blue-600`. The `accent-primary` token tracks the active theme (including dark mode); a hardcoded `accent-blue-*` stays the same hue regardless of theme and reads as an off-brand control. This applies to filter checkboxes (`CheckboxDropdown`), column-option checkboxes (`EditColumnModal`), and any admin toggle that keeps the native control.

## Tooltips

- Consistent delay: 300 ms show, immediate hide
- Placement: prefer `top` for icon buttons, `bottom` for nav items
- Style: `bg-sunken text-fg text-xs rounded px-2 py-1 shadow-lg`

## Typography

- **Minimum text size for informational content is `text-xs` (12px).** Never use `text-[10px]` or smaller arbitrary pixel sizes for stats, labels, status text, or any text the user is meant to read. Sub-12px arbitrary sizes are reserved for decorative single-glyph indicators where the meaning is carried by an adjacent label or `title` attribute (the collapsed column abbreviation is **not** one of these: it is the only way to identify a collapsed column, so it is `text-xs` (#1738)).
- **Info-tooltip triggers (`RoleInfoTooltip`) are `w-6 h-6 text-xs`** (24px minimum target, 12px glyph floor) (#1857). A child `<strong>` inside an on-tint strip uses the same `*-on-tint` text token, never plain `text-<hue>`.
- Page headings: `text-xl font-semibold text-fg`
- Page-level section headings (Dashboard-style landmark regions like "My Boards", "Groups", "Favorite Boards"): `text-lg font-semibold text-fg`. These are top-level navigation regions on a full page, not sub-sections inside a card or panel. Pair each heading with an `id` and `aria-labelledby` on the enclosing `<section>` so the landmark has an accessible name.
- Section headings (sub-sections inside a card, panel, or modal): `text-sm font-medium text-fg-tertiary uppercase tracking-wide`
- **One section-heading style across the Members surfaces (#1495).** Within Board Settings → Members ("Add member", "To be added"), the board invite panel ("Invite by email", "Pending invites") and the group page's invite panel ("Invite by email"), section headings use the section-heading style above. On the group page, "Invite links" is the panel's title (`text-sm font-semibold text-fg-secondary`), not a section heading; "Pending invites" is a heading of the board panel variant only. Do not use `text-xs font-semibold text-fg-muted uppercase` for a section heading on these Members surfaces: it makes the newer sections look more prominent than the primary one. Two uses of that style in the Members tab are not section headings and stay as they are: the Member/Role column-header row and the "Role permissions" tooltip heading.
- Body: `text-sm text-fg-secondary`
- Muted/secondary: `text-sm text-fg-muted`
- Monospace (version strings, IDs): `font-mono text-xs text-fg-muted`

## Focus ring consistency

The permitted focus-ring form is `focus:ring-2 focus:ring-primary-emphasis` (or `focus:ring-danger-emphasis` for destructive actions, `focus:ring-warning-emphasis` for amber confirms). `focus-visible:` is **not permitted** on standalone buttons, dropdown triggers, or tab controls — Firefox and desktop Safari treat `:focus-visible` as more restrictive than `:focus` and skip the ring on pointer-driven focus, leaving keyboard users with no indicator after a click+keyboard-handoff sequence.

`focus-visible:` is permitted only on elements that receive programmatic focus from drag-and-drop libraries (e.g. `CardItem` while a drag is mid-flight) where suppressing the ring during pointer drag is intentional.

**Gate for any PR that touches interactive elements:** run `grep -r "focus-visible:ring" frontend/src/`. If any new instances appear outside the documented DnD exception, switch them to `focus:`. Issues #933, #949, and #983 all closed the same regression — keep this rule visible so it does not recur.

**Confirmation-dialog Cancel buttons need a ring too.** The Quiet "Cancel" button in a confirm or destructive-action dialog is a real tab stop and the keyboard user's safe escape path — it must carry `focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded`, not only the primary or danger action button. A bare-text Cancel with no ring leaves keyboard users with no focus indicator on the very control they are most likely to reach for.

## Topic index

### App shell and navigation — `frontend/ui-conventions/shell-and-navigation.md`

Top chrome, the board toolbar, the app drawer, Home, search, the command palette and shortcuts.

- **In-app help links (#2589)** — Docs links render only through `HelpLink` keyed by a `help/topics.ts` topic; never a hand-written docs URL. → `frontend/ui-conventions/shell-and-navigation.md`
- **Shared page layouts and parts (#2475)** — Page redesigns import layouts, parts and button classes from `components/Page`, never restate them. → `frontend/ui-conventions/shell-and-navigation.md`
- **Home status page (#2474)** — Home (`Dashboard.tsx`) is the reference Overview page; signals never show 0 for "no data". → `frontend/ui-conventions/shell-and-navigation.md`
- **Sidebar and tab navigation** — Page sidebar section buttons carry the focus ring and `aria-current` on the active item. → `frontend/ui-conventions/shell-and-navigation.md`
- **Top chrome — two-row composition** — Keep the two-row chrome skeleton and its landmarks on every route; features land inside the rows. → `frontend/ui-conventions/shell-and-navigation.md`
- **Board navigation bar** — Row 2 board toolbar controls, menus and their order, per the board redesign spec. → `frontend/ui-conventions/shell-and-navigation.md`
- **Avatar chips** — Avatar chip shape, size and deterministic per-user palette color. → `frontend/ui-conventions/shell-and-navigation.md`
- **User menu (top-chrome)** — `UserMenu` is the single entry point for account-scoped actions. → `frontend/ui-conventions/shell-and-navigation.md`
- **Connection status indicator** — `ConnectionStatus` is the only component that surfaces WebSocket state. → `frontend/ui-conventions/shell-and-navigation.md`
- **Ancestor breadcrumbs** — Use the shared breadcrumb markup whenever showing a full ancestor chain. → `frontend/ui-conventions/shell-and-navigation.md`
- **Version display** — No version badge in the Navbar; the version string shows only in Settings → About. → `frontend/ui-conventions/shell-and-navigation.md`
- **App shell: header, drawer and board switcher (#2473)** — No persistent sidebar or rail: navigation is an on-demand drawer plus the header board switcher. → `frontend/ui-conventions/shell-and-navigation.md`
- **Global search entry (Row 1)** — The Row 1 search button is the only visible command palette trigger. → `frontend/ui-conventions/shell-and-navigation.md`
- **Command palette ownership (#869)** — `GlobalCommandPalette` mounts at exactly two shell-level points. → `frontend/ui-conventions/shell-and-navigation.md`
- **Keyboard shortcuts — noise budget and registry (#868)** — Shortcut wiring lives in three places, under a noise budget and one registry. → `frontend/ui-conventions/shell-and-navigation.md`
- **Board search scope toggle** — The filter bar search scope toggle is URL-persisted via `?scope=all`. → `frontend/ui-conventions/shell-and-navigation.md`
- **Hosted demo surfaces (#1179)** — Hosted demo surfaces: read `demo_mode` from site config and show refused writes up front. → `frontend/ui-conventions/shell-and-navigation.md`

### Board grid, columns and swimlanes — `frontend/ui-conventions/board-grid.md`

Column headers and menus, grid cells, overlays, presets, swimlane bands, stages, limits and the lens.

- **Board redesign reference (#2259)** — The Board view is rebuilt against one reference design; `docs/development/board-redesign.md` is the spec. → `frontend/ui-conventions/board-grid.md`
- **Column kebab menu (#965)** — Column-scoped actions live in the header's `⋮` kebab, the only keyboard path to settings and delete. → `frontend/ui-conventions/board-grid.md`
- **Column delete confirmation (#965)** — Column delete uses a tiered confirmation that scales with how many cards the column holds. → `frontend/ui-conventions/board-grid.md`
- **Column drag-to-trash gating (#965)** — The column trash drop zone is opt-in via Alt during a drag, never shown by default. → `frontend/ui-conventions/board-grid.md`
- **Column headers** — Column header panels, counts and limits per the redesign (#2270). → `frontend/ui-conventions/board-grid.md`
- **Board grid cells** — A grid cell is a `bg-canvas` well; drop targets, add-card and drag states per the redesign. → `frontend/ui-conventions/board-grid.md`
- **Board grid overlay slot (#1147)** — Grid overlays supply per-cell numbers only; the slot owns scale, classes, legend and empty state. → `frontend/ui-conventions/board-grid.md`
- **Board presets (#1146)** — Board presets are code-defined bundles in `boardPresets/registry.ts` (Classic and Default in 1.3). → `frontend/ui-conventions/board-grid.md`
- **Swimlane bands (#2271, #2275)** — Swimlane band layout, name, stats, fields, collapse and the Children-mode variant. → `frontend/ui-conventions/board-grid.md`
- **View menu rows (#2388, #2390)** — Boolean View menu options are native checkboxes, label left and box right. → `frontend/ui-conventions/board-grid.md`
- **Column policy editor and confirm-on-entry checklist (#1101)** — `EditColumnModal` has Settings, Stage and Policy tabs; the confirm-on-entry checklist rules. → `frontend/ui-conventions/board-grid.md`
- **Issue board lens (read-only external data)** — Issue Board Lens and other read-only external-data views: read-only cells, links and provenance. → `frontend/ui-conventions/board-grid.md`
- **Placement limits on the board (#1150)** — Swimlane placement limits: one limit line in the band and the over-limit signal. → `frontend/ui-conventions/board-grid.md`
- **Gated stages and tracks (#2278, #1102, #1920)** — A stage is a column; gated stages, sub-columns and tracks vocabulary and layout. → `frontend/ui-conventions/board-grid.md`

### Card face — `frontend/ui-conventions/cards.md`

Card density, system signals, card-face chips and links, thresholds, bulk actions and the context menu.

- **Card density (#961)** — The admin `card_density` setting picks one of three card-face tiers and what each one renders. → `frontend/ui-conventions/cards.md`
- **System signals (#2046)** — Reserved system-signal vocabulary (blocked, overdue, over limit) that user choice colors cannot reuse. → `frontend/ui-conventions/cards.md`
- **Cards** — Card face rules: lane-team pre-assignment, chips, peek, aging, blocked state and the phone layout. → `frontend/ui-conventions/cards.md`
- **Card-face quick-edit chip affordance (custom fields, #371)** — Pinned checkbox/dropdown custom-field chips on the card face are always visible, a scoped exception. → `frontend/ui-conventions/cards.md`
- **Number custom-field formatting (#1391)** — Every read-only number value goes through `formatCustomFieldValue` → `formatNumberValue`. → `frontend/ui-conventions/cards.md`
- **Custom-field choice color picker (#1391)** — `ChoiceColorPicker` is one control per dropdown/multi-select choice row in both field-editor tabs. → `frontend/ui-conventions/cards.md`
- **Card metadata row coexistence** — Two metadata items for one datum in `CardItem` need a mutual-exclusion rule. → `frontend/ui-conventions/cards.md`
- **Card-face external links (#352)** — A card may carry one nested link, the MR/PR badge, following the lens nested-link rules plus drag safety. → `frontend/ui-conventions/cards.md`
- **URL custom-field links (#1390)** — `CustomFieldLink` is the one renderer for a URL custom-field value. → `frontend/ui-conventions/cards.md`
- **Threshold and status encoding** — A color-tinted element without its own visible label also carries a glyph and text (WCAG 1.4.1). → `frontend/ui-conventions/cards.md`
- **Threshold marks on custom fields (#1122)** — Threshold marks use shape and weight, never hue, on the card face (`ThresholdMark`). → `frontend/ui-conventions/cards.md`
- **Bulk operations (#1733)** — Bulk operations report partial failure and keep the selection. → `frontend/ui-conventions/cards.md`
- **Card context menu (#2059)** — `CardContextMenu` acts on a card without opening it; `BoardView` owns its state and executor. → `frontend/ui-conventions/cards.md`

### Card detail and children — `frontend/ui-conventions/card-detail.md`

The card detail sheet, its tabs and key facts, the rich text editor, checklists, children and field sets.

- **Rich text editor** — `RichTextEditor` is the only editor; view mode uses `react-markdown`, never `dangerouslySetInnerHTML`. → `frontend/ui-conventions/card-detail.md`
- **Swapping the open card (#449)** — Open a different card from `CardDetail` only via the `visiban:open-card` event. → `frontend/ui-conventions/card-detail.md`
- **Card detail sheet placement (#1914)** — Card detail sheet placement rules, including peek suppression while the sheet is open. → `frontend/ui-conventions/card-detail.md`
- **Card detail sheet: Dock to edge toggle (#1915)** — A user's Dock to edge pin goes into the pure placement function and ranks below full screen. → `frontend/ui-conventions/card-detail.md`
- **Card detail tabs and the History type filter (#967)** — Card detail tabs are Details, Comments and History; the History type filter. → `frontend/ui-conventions/card-detail.md`
- **Destructive action in an editor footer; form error slot; locked attributes (#2194)** — A destructive editor action sits far left in the footer; form error slot; locked attributes. → `frontend/ui-conventions/card-detail.md`
- **Card detail key-facts row and section counts (#1916)** — The key-facts row is header row 3 of the card detail sheet, outside the scrolling body. → `frontend/ui-conventions/card-detail.md`
- **Checklist item trailing controls (#445)** — Checklist item assignee and due controls are always visible, never hover-revealed. → `frontend/ui-conventions/card-detail.md`
- **Card-detail extension sections and parent-item naming (#2212)** — Card-detail extension sections render plain text only; parent-item naming. → `frontend/ui-conventions/card-detail.md`
- **One child board per parent, never split (#2208, #2206)** — A parent's children all live on one board; no UI path may split them. → `frontend/ui-conventions/card-detail.md`
- **Child progress footer — segment key (#2210)** — A parent card's child progress footer: one segment per child, with its key. → `frontend/ui-conventions/card-detail.md`
- **Phone bottom-sheet selects and inactive-date helpers (#2549, #2552)** — Phone bottom-sheet selects opt in with `SelectDropdown phoneSheet`; inactive-date helpers. → `frontend/ui-conventions/card-detail.md`
- **Children tab and its lens (#2209)** — Children tab layout thresholds are measured on their own container, never an outer width. → `frontend/ui-conventions/card-detail.md`
- **Child progress, live cues and failed reads (#2210, #2448, #2441)** — Child progress live-change ring, live cues and failed reads. → `frontend/ui-conventions/card-detail.md`
- **Field sets (#2570)** — Field set size toggles use `aria-pressed`; progress excludes some field types. → `frontend/ui-conventions/card-detail.md`

### Modals, menus and toasts — `frontend/ui-conventions/overlays-and-menus.md`

Modals, focus containment, dropdown primitives and the shared toast region.

- **Dropdown menus** — All dropdowns, `SelectDropdown` or hand-rolled, follow one trigger, menu panel and menu item style. → `frontend/ui-conventions/overlays-and-menus.md`
- **Modals and dialogs** — Modal spec, focus handoff when a control unmounts itself, confirm dialogs and dialog footers. → `frontend/ui-conventions/overlays-and-menus.md`
- **Toasts (#2060, #1438)** — One shared toast region (`ToastProvider`); placement, timing, stacking and announcement. → `frontend/ui-conventions/overlays-and-menus.md`
- **Move-blocked toast (MoveBlockedToast)** — Card move refusals use `MoveBlockedToast`, a persistent assertive `blocked` toast. → `frontend/ui-conventions/overlays-and-menus.md`
- **Post-import notice (ImportSkippedToast)** — The post-import summary is an informational `info` toast, never amber. → `frontend/ui-conventions/overlays-and-menus.md`
- **Common dropdown primitives** — Use the shared dropdown primitives in `components/Common/`; never re-implement them inline. → `frontend/ui-conventions/overlays-and-menus.md`
- **Admin offboarding modal** — Destructive admin actions with preconditions use a dedicated modal, not `ConfirmDialog`. → `frontend/ui-conventions/overlays-and-menus.md`
- **Focus containment for modal surfaces (#1732)** — Any `aria-modal` element uses `ModalWrapper` or `useFocusTrap` and restores focus on close. → `frontend/ui-conventions/overlays-and-menus.md`

### Status, badges and feedback — `frontend/ui-conventions/status-and-feedback.md`

Badges, status and empty states, banners, callouts, truncation and loading cues.

- **Badges and labels** — Pill, badge and label shapes, tokens and wording, including the webhook status pill family. → `frontend/ui-conventions/status-and-feedback.md`
- **Capped lists say so (#2254, #2339)** — A server-capped list says so in a muted line above the list, with the total count. → `frontend/ui-conventions/status-and-feedback.md`
- **Truncation inside nested flex chips** — Every truncating span inside a nested `inline-flex` chip gets an explicit `min-w-0`. → `frontend/ui-conventions/status-and-feedback.md`
- **Decorative glyphs (#2012)** — A decorative glyph in its own element is `aria-hidden="true"`. → `frontend/ui-conventions/status-and-feedback.md`
- **Security notices** — Security notices ignore email opt-in and say so in their footer. → `frontend/ui-conventions/status-and-feedback.md`
- **Inline status messages** — Inline status and refusal message wording, placement and roles. → `frontend/ui-conventions/status-and-feedback.md`
- **Loading and spinner states** — Use the canonical spinner classes and an accessible loading label. → `frontend/ui-conventions/status-and-feedback.md`
- **Empty states** — Empty, not-found and unavailable states: copy, structure and actions. → `frontend/ui-conventions/status-and-feedback.md`
- **First-encounter indicators** — Surface an undiscovered feature with a static `bg-primary-emphasis` dot. → `frontend/ui-conventions/status-and-feedback.md`
- **Mode indicator banners** — Mode banners and the single post-join confirmation toast. → `frontend/ui-conventions/status-and-feedback.md`
- **Degraded-state site banners (system-imposed, not user-chosen)** — A site-wide degraded state set by an operator uses the amber degraded-state banner language. → `frontend/ui-conventions/status-and-feedback.md`
- **Inline summary panels (embedded, not chrome)** — An amber status panel inside a form is an inline summary panel, not a site banner. → `frontend/ui-conventions/status-and-feedback.md`
- **De-emphasized controls and context-dependent defaults (#1063)** — De-emphasized controls never drop below AA contrast; context-dependent defaults. → `frontend/ui-conventions/status-and-feedback.md`
- **Inline informational callouts (login demo banner, #1034)** — An informational callout inside a card or form uses `role="note"` and the primary-tint style. → `frontend/ui-conventions/status-and-feedback.md`
- **Transient state cues (#2251)** — A transient cue renders inside a persistent `role="status"` element with only its text conditional. → `frontend/ui-conventions/status-and-feedback.md`

### Controls, forms and settings — `frontend/ui-conventions/controls-and-settings.md`

Form controls, inline editors, settings layouts, admin surfaces, secrets, imports and keyboard parity.

- **Admin table row overflow menu (#1291)** — Fold low-frequency admin table row actions into a row overflow menu before the cell overflows. → `frontend/ui-conventions/controls-and-settings.md`
- **Feature parity between self-service and admin-initiated equivalents** — Self-service and admin-initiated equivalents share one component and copy (e.g. `EmailInviteForm`). → `frontend/ui-conventions/controls-and-settings.md`
- **Color swatch pickers** — Any row of color swatches uses the shared `ColorSwatchPicker`; never hand-roll swatch buttons. → `frontend/ui-conventions/controls-and-settings.md`
- **Board settings layout (#2436)** — `BoardSettingsModal` is a left sidebar plus one panel, not a horizontal tab strip. → `frontend/ui-conventions/controls-and-settings.md`
- **Board Settings tab bar (#1140)** — Board Settings field-list rows: type labels never wrap; tab bar and row layout. → `frontend/ui-conventions/controls-and-settings.md`
- **Withheld row actions and refusal reasons (#1785)** — A row action withheld for a policy reason keeps the reason visible on the row. → `frontend/ui-conventions/controls-and-settings.md`
- **Radio groups** — Never browser-default radios: `sr-only` native inputs in a styled `label`. → `frontend/ui-conventions/controls-and-settings.md`
- **Subordinate settings blocks (toggle/checkbox-gated)** — Settings gated by a toggle above them are indented and hidden or disabled while it is off. → `frontend/ui-conventions/controls-and-settings.md`
- **Board-level field chooser settings row (#2275)** — A setting that picks one custom field is one settings row shaped like the toggles around it. → `frontend/ui-conventions/controls-and-settings.md`
- **Inline description fields (non-RTE)** — Inline-editable plain-text descriptions: a button in view state, textarea on edit, commit on blur. → `frontend/ui-conventions/controls-and-settings.md`
- **Composite inline editors — explicit Save/Cancel (#371)** — Editors for interdependent values use explicit Save/Cancel instead of commit-on-blur. → `frontend/ui-conventions/controls-and-settings.md`
- **Paired numeric settings fields** — Two numeric inputs for one setting share a `<section>` and `<h3>`, each in its own block. → `frontend/ui-conventions/controls-and-settings.md`
- **Conditional admin-only elements** — Admin-only elements are hidden entirely for non-admins, never greyed out. → `frontend/ui-conventions/controls-and-settings.md`
- **Externally-sourced URLs (#1087)** — Every externally-sourced URL passes `isSafeHttpUrl()` before reaching an `href` or `window.open`. → `frontend/ui-conventions/controls-and-settings.md`
- **Long URL display fields** — Truncate long URLs in read-only displays, keep the full value on copy and in `title`. → `frontend/ui-conventions/controls-and-settings.md`
- **Click handlers need keyboard parity (#1376, Sonar S1082)** — Never a click handler on a non-interactive element without keyboard parity; prefer a `<button>`. → `frontend/ui-conventions/controls-and-settings.md`
- **Hover-reveal controls** — Hover-revealed controls also need `focus:opacity-100` and a focus ring. → `frontend/ui-conventions/controls-and-settings.md`
- **Toggle buttons (icon-only)** — Icon-only mode toggles carry `aria-pressed` and an `aria-label`. → `frontend/ui-conventions/controls-and-settings.md`
- **User preference persistence** — Instance flags go on `SiteConfig`, never the frozen `User`; where user UI preferences persist. → `frontend/ui-conventions/controls-and-settings.md`
- **Write-only secret fields ("leave blank to keep")** — Write-only secrets: "leave blank to keep" fields and masked stored URLs. → `frontend/ui-conventions/controls-and-settings.md`
- **Verification actions against a saved configuration** — A verify action tests saved state, never the draft, and is disabled while the form is dirty. → `frontend/ui-conventions/controls-and-settings.md`
- **Disambiguating repeated button labels** — Repeated same-label buttons on one page get distinguishing accessible names. → `frontend/ui-conventions/controls-and-settings.md`
- **Read-only mode for interactive components** — Interactive or draggable components accept `readOnly` and skip their DnD hooks when set. → `frontend/ui-conventions/controls-and-settings.md`
- **Read-only composite editors (#2090)** — A view-only composite form shows disabled fields, omits its actions and adds one muted note. → `frontend/ui-conventions/controls-and-settings.md`
- **One-time token reveal** — Reveal a once-only token inline on the new row, never in a modal or toast. → `frontend/ui-conventions/controls-and-settings.md`
- **Blocked rows in pickers (#1692)** — A picker row the user may not choose stays visible and focusable and says why. → `frontend/ui-conventions/controls-and-settings.md`
- **Multi-step import wizards and file uploads (#456)** — Import and creation wizards reuse the Trello wizard's shell, steps and upload patterns. → `frontend/ui-conventions/controls-and-settings.md`
- **Import Board sample gallery (#1452)** — `SampleGallery` sits above the import dropzone, is named sample, and owns no import logic. → `frontend/ui-conventions/controls-and-settings.md`
- **Local input buffers and timers (#1319)** — Never seed a local input buffer from fetched or prop data in a `useEffect`. → `frontend/ui-conventions/controls-and-settings.md`
- **Locked member rows and assignee pickers (#2164, #1905)** — Locked membership rows drop the role picker and Remove from the DOM; assignee picker rules. → `frontend/ui-conventions/controls-and-settings.md`
- **Site admin on the Settings layout (#2476)** — Site admin on `SettingsLayout`: section groups, counts and the save bar. → `frontend/ui-conventions/controls-and-settings.md`
- **User settings on the Settings layout (#2477)** — `/settings` uses `SettingsLayout` with fixed groups; old `?tab=` deep links still work. → `frontend/ui-conventions/controls-and-settings.md`
- **Group page and Group settings (#2478)** — `GroupDetail` is an `OverviewLayout` page; Group settings layout. → `frontend/ui-conventions/controls-and-settings.md`

### Analytics, charts and history — `frontend/ui-conventions/analytics-and-history.md`

Analytics structure, charts, summary tables and timeline/history rendering.

- **Analytics page structure and URL state (#2457, #2318)** — The Analytics Overview is four question sections in a fixed order, with state kept in the URL. → `frontend/ui-conventions/analytics-and-history.md`
- **History labels that quote user text** — A History label that quotes user text caps that text at 40 characters, then shows the values. → `frontend/ui-conventions/analytics-and-history.md`
- **Summary and analytics table layout** — Wide Summary and Analytics tables pin their first column sticky-left. → `frontend/ui-conventions/analytics-and-history.md`
- **Extension panels (Summary tab)** — `SummaryView` renders enterprise `extension_panels` after the swimlane table, nothing when none. → `frontend/ui-conventions/analytics-and-history.md`
- **Analytics / split-panel scroll layout** — A pinned section above a scrolling list uses an `overflow-hidden` flex column, never outer `overflow-auto`. → `frontend/ui-conventions/analytics-and-history.md`
- **System event visual treatment in timeline views** — Timeline dot and border treatment per event type in `ActivityTabPanel` and `MovementHistoryView`. → `frontend/ui-conventions/analytics-and-history.md`
- **Charts (#448, #2028)** — Charts are hand-rolled SVG on `components/Common/Chart.tsx`; no chart library. → `frontend/ui-conventions/analytics-and-history.md`
