/**
 * The four page layouts of the shared look (#2475): Workspace (Board, Analytics), Overview
 * (Home, group page), Settings (Site admin, user settings, group and board settings) and
 * Centered (sign in, invite, reset, the shared board's revoked state). See frontend/CLAUDE.md
 * § Shared page layouts and parts.
 */
import { useId, useMemo, useState, type ReactNode, type Ref } from "react";
import { useSearchParams } from "react-router-dom";
import { filterSettingsSections, type SettingsSection } from "./model";

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/**
 * Full width, no max. The header (with star and status beside the title) is the app header's
 * (#2473); `toolbar` is the optional row under it.
 */
export function WorkspaceLayout({ toolbar, children }: { toolbar?: ReactNode; children: ReactNode }) {
  return (
    <div data-layout="workspace" className="flex h-full min-h-0 w-full flex-col bg-page">
      {toolbar}
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/**
 * Max 1200px: content plus an optional side column that drops below it on phones and tablets.
 * `heading` is a `PageHeading` (its `accessory` carries the star and status beside the `h2`).
 */
export function OverviewLayout({ heading, aside, children }: { heading?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div data-layout="overview" className="min-h-full bg-page">
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6">
        {heading && <div className="mb-6">{heading}</div>}
        <div className={aside ? "grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]" : ""}>
          <div className="min-w-0 flex flex-col gap-6">{children}</div>
          {aside && <aside className="min-w-0 flex flex-col gap-6">{aside}</aside>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Max 1240px: a 240px section nav with "Find a setting" and one section per view. On phones the
 * nav becomes a select. The active section lives in the URL (`?<param>=<id>`, default `tab`),
 * so existing deep links such as `/admin?tab=users` keep working; an unknown id falls back to
 * the first section.
 */
export function SettingsLayout({ title, sections, param = "tab", navLabel = "Settings sections", defaultId }: {
  title?: ReactNode;
  sections: SettingsSection[];
  param?: string;
  navLabel?: string;
  /** Section shown when the URL names none (default: the first); a page that is entered from a redirect lands here. */
  defaultId?: string;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const findId = useId();
  const selectId = useId();
  const requested = searchParams.get(param);
  const active = sections.find((s) => s.id === requested) ?? sections.find((s) => s.id === defaultId) ?? sections[0];
  const visible = useMemo(() => filterSettingsSections(sections, query), [sections, query]);

  const select = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set(param, id);
    setSearchParams(next);
  };

  return (
    <div data-layout="settings" className="min-h-full bg-page">
      <div className="mx-auto w-full max-w-[1240px] px-4 py-6 sm:px-6">
        {title && <div className="mb-6">{title}</div>}
        <div className="flex flex-col gap-6 md:flex-row">
          <div className="md:hidden">
            <label htmlFor={selectId} className="mb-1 block text-sm font-medium text-fg-secondary">Section</label>
            <select
              id={selectId}
              value={active?.id}
              onChange={(e) => select(e.target.value)}
              className="w-full h-11 bg-surface border border-line-strong text-fg rounded px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              {sections.map((s) => <option key={s.id} value={s.id}>{s.count !== undefined ? `${s.label} (${s.count})` : s.label}</option>)}
            </select>
          </div>
          <nav aria-label={navLabel} className="hidden md:block w-[240px] shrink-0">
            <label htmlFor={findId} className="sr-only">Find a setting</label>
            <input
              id={findId}
              type="search"
              placeholder="Find a setting"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="mb-3 w-full h-9 bg-surface border border-line-strong text-fg placeholder-fg-muted rounded px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            />
            {visible.length === 0 ? (
              <p className="px-3 text-sm text-fg-muted">No settings match.</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {visible.map((s, i) => {
                  const current = s.id === active?.id;
                  const heading = s.group && s.group !== visible[i - 1]?.group ? s.group : null;
                  return (
                    <li key={s.id} className={heading ? (i === 0 ? "" : "mt-3") : undefined}>
                      {heading && (
                        <p className="px-3 pb-1 text-[13px] leading-5 font-semibold uppercase tracking-[0.06em] text-fg-tertiary">{heading}</p>
                      )}
                      <button
                        type="button"
                        aria-current={current ? "page" : undefined}
                        onClick={() => select(s.id)}
                        className={`flex w-full h-9 max-sm:h-11 items-center justify-between gap-2 rounded px-3 text-left text-sm transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                          current ? "bg-primary-emphasis/10 text-info-on-tint font-semibold" : "text-fg-secondary hover:text-fg hover:bg-surface-hover"
                        }`}
                      >
                        <span>{s.label}</span>
                        {s.count !== undefined && <span className="text-xs tabular-nums text-fg-tertiary">{s.count}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </nav>
          <div className="min-w-0 flex-1 flex flex-col gap-4">{active?.render()}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Centered
// ---------------------------------------------------------------------------

/**
 * The logo tile at the top of a Centered card or the public header. Not a button: there is no
 * drawer outside the app shell.
 */
export function BrandTile({ size = "md", decorative = false }: { size?: "sm" | "md"; decorative?: boolean }) {
  return (
    <img
      src="/brand/visiban_fullbleed_pulse_light.png"
      alt={decorative ? "" : "Visiban"}
      aria-hidden={decorative ? true : undefined}
      className={`${size === "sm" ? "h-8 w-8" : "h-11 w-11"} shrink-0 rounded-lg object-contain`}
    />
  );
}

/**
 * One card, max 380px, centered on the page ground. On phones there is no card: the content
 * sits on the page ground at full width (its controls are 48px, from the parts' `lg` size).
 * Pages using it are outside the app shell and keep their own `h1`.
 */
export function CenteredLayout({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div data-layout="centered" data-testid={testId} className="min-h-screen bg-page flex justify-center sm:items-center">
      <main className="w-full px-4 py-8 sm:max-w-[380px] sm:px-0">
        <div className="sm:rounded-[10px] sm:border sm:border-line sm:bg-surface sm:p-8 sm:shadow-xl">{children}</div>
      </main>
    </div>
  );
}

/** The top of a Centered card: logo tile, the page's `h1`, an optional line under it. */
export function CenteredHeader({ title, subtitle, headingRef }: { title: ReactNode; subtitle?: ReactNode; headingRef?: Ref<HTMLHeadingElement> }) {
  return (
    <div className="mb-6 flex flex-col items-center gap-3 text-center">
      <BrandTile />
      <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="text-xl font-semibold text-fg focus:outline-none">{title}</h1>
      {subtitle && <div className="text-sm text-fg-secondary">{subtitle}</div>}
    </div>
  );
}

export type StatusCardTone = "neutral" | "danger" | "success";

/**
 * A terminal state inside a Centered card (an invalid link, a confirmed email): heading, a
 * sentence and its actions. The heading takes focus through `headingRef` so assistive tech
 * announces the change. The tone colors the small mark only; the heading says the outcome.
 */
export function StatusCard({ title, tone = "neutral", children, actions, headingRef, testId }: {
  title: ReactNode;
  tone?: StatusCardTone;
  children?: ReactNode;
  actions?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  testId?: string;
}) {
  const mark = tone === "danger" ? "bg-danger/15 text-danger-on-tint" : tone === "success" ? "bg-success/15 text-success-on-tint" : "bg-surface-hover text-fg-secondary";
  const glyph = tone === "danger" ? "!" : tone === "success" ? "✓" : "i";
  return (
    <div data-testid={testId} data-tone={tone} className="flex flex-col items-center gap-3 text-center">
      <BrandTile />
      <span aria-hidden="true" className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${mark}`}>{glyph}</span>
      <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="text-xl font-semibold text-fg focus:outline-none">{title}</h1>
      {children && <div className="text-sm text-fg-secondary">{children}</div>}
      {actions && <div className="mt-2 flex w-full flex-col gap-2">{actions}</div>}
    </div>
  );
}
