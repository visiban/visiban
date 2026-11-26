import { HELP_TOPICS, type HelpTopicKey } from "./topics";

/** The one place the public docs host is named (#2589). */
export const DEFAULT_DOCS_BASE_URL = "https://docs.visiban.com";

declare const __APP_VERSION__: string;

/**
 * Docs version segment for a running build.
 *
 * docs-deploy publishes a release X.Y.Z at `/vX.Y.Z/` with the aliases `/vX.Y/`
 * and `/latest/`. The `v` is always there: scripts/resolve-docs-version.sh adds
 * it, so an unprefixed `/X.Y/` does not exist (#2612). A prerelease
 * (`1.3.0-beta.1`) gets no minor alias, only `/vX.Y.Z-pre/` and `/next/`
 * (.gitlab-ci.yml docs-deploy), so linking it to `/v1.3/` could 404. Anything
 * that is not semver (`dev`, `test`, empty) falls back to `latest`.
 */
export function docsVersionSegment(version: string | undefined): string {
  const match = /^v?(\d+)\.(\d+)\.\d+(-.+)?$/.exec((version ?? "").trim());
  if (!match) return "latest";
  if (match[3]) return "next";
  return `v${match[1]}.${match[2]}`;
}

function sanitizeBase(base: string | undefined): string | null {
  const trimmed = (base ?? "").trim().replace(/\/+$/, "");
  // The value ends up in an href: http(s) only, never javascript: or data:. No backslash either:
  // browsers read it as "/", which can move the host away from what the server validated.
  return /^https?:\/\/[^\s\\]+$/i.test(trimmed) ? trimmed : null;
}

export interface DocsUrlOptions {
  /** Instance docs base override. Used verbatim (no version segment): an air-gapped mirror hosts one doc set. */
  base?: string;
  /** Running app version; defaults to the build's `__APP_VERSION__`. */
  version?: string;
}

function buildVersion(): string {
  try {
    return __APP_VERSION__;
  } catch {
    return "";
  }
}

/** Instance override baked in at build time (`VITE_DOCS_BASE_URL`). */
function buildBase(): string | undefined {
  return import.meta.env.VITE_DOCS_BASE_URL as string | undefined;
}

/**
 * Instance override set at runtime by a site admin (#2604): Site settings, served
 * on /auth/site-config/ as `docs_base_url`. Module state, like the instance time
 * zone, because `docsUrl` is a plain function called during render with no React
 * tree to read a context from. `useInstanceFlagsState` (mounted at the app root,
 * signed in or not) sets it when site-config loads; until then, and on a server
 * older than the field, it is unset and the build-time value applies.
 */
let runtimeBase: string | undefined;

export function setRuntimeDocsBase(value: string | null | undefined): void {
  runtimeBase = value ?? undefined;
}

/**
 * Full docs URL for a registry topic: version-matched, override-aware.
 *
 * Base precedence: an explicit `opts.base`, then the runtime Site settings value,
 * then the build-time `VITE_DOCS_BASE_URL`, then the version-matched public
 * docs. Each candidate must pass `sanitizeBase`; one that does not is skipped,
 * so a bad runtime value falls back to the operator's build-time mirror rather
 * than straight to the public host.
 */
export function docsUrl(topic: HelpTopicKey, opts: DocsUrlOptions = {}): string {
  const entry: { path: string; anchor?: string } = HELP_TOPICS[topic];
  const override =
    sanitizeBase(opts.base) ?? sanitizeBase(runtimeBase) ?? sanitizeBase(buildBase());
  const root = override ?? `${DEFAULT_DOCS_BASE_URL}/${docsVersionSegment(opts.version ?? buildVersion())}`;
  const anchor = entry.anchor ? `#${entry.anchor}` : "";
  return `${root}/${entry.path}${anchor}`;
}
