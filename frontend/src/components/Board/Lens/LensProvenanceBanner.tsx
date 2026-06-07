import type { LensProvider } from "../../../types";

interface Props {
  provider: LensProvider;
  repo: string;
  url: string;
  truncated: boolean;
  /** Number of issues actually rendered — used in the truncation warning. */
  shownCount: number;
  /** True when a server-side filter (state/milestone) is active — rewords the
   *  truncation copy so the cap reads as relative to the filter. */
  filtersActive?: boolean;
}

/**
 * Non-dismissible provenance banner for external lens data. Renders a provider
 * glyph + "Read-only lens · {repo}" and, when the provider truncated the
 * result, a warning. Must sit OUTSIDE the grid scroll container so it never
 * scrolls away — see the "external-data provenance banner" rule in
 * frontend/CLAUDE.md.
 */
export default function LensProvenanceBanner({ provider, repo, url, truncated, shownCount, filtersActive }: Props) {
  const glyph = provider === "github" ? "" : "";
  const providerName = provider === "github" ? "GitHub" : "GitLab";

  return (
    <div
      role="status"
      aria-atomic="true"
      className="bg-primary/15 border-b border-primary-emphasis/40 px-4 py-2 flex items-center gap-3 text-sm text-info shrink-0"
    >
      <span aria-hidden="true" className="text-base leading-none">{glyph}</span>
      <span>
        Read-only lens ·{" "}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-info hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          title={`Open ${repo} on ${providerName}`}
        >
          {repo}
        </a>
      </span>
      {truncated && (
        <span className="text-warning flex items-center gap-1 ml-2">
          <span aria-hidden="true">⚠</span>
          {filtersActive
            ? `Showing first ${shownCount} matching issues — more match beyond the fetch limit`
            : `Showing first ${shownCount} issues`}
        </span>
      )}
    </div>
  );
}
