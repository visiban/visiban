import { HELP_TOPICS, type HelpTopicKey } from "./topics";

/** The one place the public docs host is named (#2589). */
export const DEFAULT_DOCS_BASE_URL = "https://docs.visiban.com";

declare const __APP_VERSION__: string;

/**
 * Docs version segment for a running build.
 *
 * mike publishes a release X.Y.Z at `/X.Y/` (and `/X.Y.Z/`, `latest`), but a
 * prerelease (`1.3.0-beta.1`) only at `/next/` (.gitlab-ci.yml docs-deploy), so
 * linking it to `/1.3/` could 404. Anything that is not semver (`dev`, `test`,
 * empty) falls back to `latest`.
 */
export function docsVersionSegment(version: string | undefined): string {
  const match = /^v?(\d+)\.(\d+)\.\d+(-.+)?$/.exec((version ?? "").trim());
  if (!match) return "latest";
  if (match[3]) return "next";
  return `${match[1]}.${match[2]}`;
}

function sanitizeBase(base: string | undefined): string | null {
  const trimmed = (base ?? "").trim().replace(/\/+$/, "");
  // The value ends up in an href: http(s) only, never javascript: or data:.
  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : null;
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

/** Full docs URL for a registry topic: version-matched, override-aware. */
export function docsUrl(topic: HelpTopicKey, opts: DocsUrlOptions = {}): string {
  const entry: { path: string; anchor?: string } = HELP_TOPICS[topic];
  const override = sanitizeBase(opts.base ?? buildBase());
  const root = override ?? `${DEFAULT_DOCS_BASE_URL}/${docsVersionSegment(opts.version ?? buildVersion())}`;
  const anchor = entry.anchor ? `#${entry.anchor}` : "";
  return `${root}/${entry.path}${anchor}`;
}
