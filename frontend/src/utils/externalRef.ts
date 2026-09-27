import type { CardExternalRef, ExternalRefProvider } from "../types";

/** Display names for each `external_ref.provider` value (#352). */
export const PROVIDER_LABELS: Record<ExternalRefProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  other: "Other",
};

export const EXTERNAL_REF_URL_MAX = 2048;
export const EXTERNAL_REF_REF_MAX = 255;

/**
 * True only for an absolute http(s) URL within the server's length limit.
 *
 * The server already rejects every other scheme, but this runs at every
 * render site anyway: an `href` is an XSS sink, and data can arrive from
 * older rows, imports, or a future writer that validates differently. A
 * `javascript:` URL must never reach an anchor.
 */
export function isHttpUrl(value: string | null | undefined): boolean {
  if (!value || value.length > EXTERNAL_REF_URL_MAX) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // Mirror the server: no credentials in the URL, and a real host.
  if (parsed.username || parsed.password || !parsed.hostname) return false;
  return true;
}

/** Client-side mirror of the server's `ref` rule. Returns an error string or null. */
export function validateRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return "Reference is required.";
  if (/\s/.test(trimmed)) return "Reference can't contain spaces.";
  if (trimmed.length > EXTERNAL_REF_REF_MAX) return `Reference must be ${EXTERNAL_REF_REF_MAX} characters or fewer.`;
  return null;
}

/**
 * Best-effort provider + ref from a pasted PR/MR URL, or null when the URL is
 * not a recognizable one. A convenience only — the user can always override
 * both fields.
 *
 * - GitHub: `github.com/{owner}/{repo}/pull/{n}` -> `owner/repo#n`
 * - GitLab: any host whose path contains `/-/merge_requests/{n}` (so
 *   self-hosted instances work) -> `{namespace/project}!n`, keeping subgroups
 *
 * Trailing segments (`/files`, `/diffs`, `/commits`), query strings and hashes
 * are ignored.
 */
export function deriveExternalRef(url: string): Pick<CardExternalRef, "provider" | "ref"> | null {
  if (!isHttpUrl(url)) return null;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  if (host === "github.com" || host === "www.github.com") {
    const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(path);
    if (m) return { provider: "github", ref: `${m[1]}/${m[2]}#${m[3]}` };
    return null;
  }

  const gl = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/|$)/.exec(path);
  if (gl) return { provider: "gitlab", ref: `${gl[1]}!${gl[2]}` };

  return null;
}

const FALLBACK_ERROR = "Couldn't save the link. Try again.";
const FIELD_NAMES: Record<string, string> = { url: "URL", ref: "Reference", provider: "Provider" };

/**
 * Turn a failed PATCH into one line of copy. The server nests field errors
 * under `external_ref` as an object (`{url: [...]}`), but a non-object body
 * yields `{non_field_errors: [...]}` and some paths return `detail` — handle
 * each rather than string-matching.
 */
export function externalRefErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
  if (!data) return FALLBACK_ERROR;
  const nested = data.external_ref;
  if (Array.isArray(nested) && nested.length > 0) return nested.map(String).join(" ");
  if (nested && typeof nested === "object") {
    for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string" && first) {
        const label = FIELD_NAMES[key];
        return label ? `${label}: ${first}` : first;
      }
    }
  }
  if (typeof data.detail === "string" && data.detail) return data.detail;
  return FALLBACK_ERROR;
}
