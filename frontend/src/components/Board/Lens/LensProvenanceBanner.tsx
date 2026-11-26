import HelpLink from "../../Common/HelpLink";
import type { LensProvider } from "../../../types";
import ExternalRefGlyph from "../../Card/ExternalRefGlyph";
import LensFreshness from "./LensFreshness";
import { isSafeHttpUrl } from "../../../utils/safeUrl";

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
  /** True when the fetch cap counted open issues only (a closed limit applied). */
  openOnly?: boolean;
  /** The closed-issue limit the server applied, or null/undefined for none (#1581). */
  closedLimit?: number | null;
  /** True when more closed issues exist beyond `closedLimit`. */
  closedTruncated?: boolean;
  /** Freshness control lives here (not on Row 2) — it's the one lens control that
   *  depends on the fetched data, which is fetched by LensView next door. */
  fetchedAt: string;
  refetching: boolean;
  onRefresh: () => void;
}

/**
 * Non-dismissible provenance banner for external lens data. Renders a provider
 * glyph + "Read-only lens · {repo}" and, when the provider truncated the
 * result, a warning. Must sit OUTSIDE the grid scroll container so it never
 * scrolls away — see the "external-data provenance banner" rule in
 * frontend/CLAUDE.md.
 */
export default function LensProvenanceBanner({ provider, repo, url, truncated, shownCount, filtersActive, openOnly, closedLimit, closedTruncated, fetchedAt, refetching, onRefresh }: Props) {
  const providerName = provider === "github" ? "GitHub" : "GitLab";
  const noun = `${openOnly ? "open " : ""}issue${shownCount === 1 ? "" : "s"}`;
  // Says what the closed limit hid (#1581). The provider does not report a
  // closed total without extra calls, so this names the rule, not a count. "Up
  // to" because GitHub counts pull requests toward the limit and then drops them,
  // so a full closed page can hold fewer than N issues.
  let closedNote: string | null = null;
  if (closedLimit === 0) closedNote = "Closed issues hidden";
  else if (closedLimit != null && closedTruncated)
    closedNote = `Showing up to ${closedLimit} most recently updated closed issues`;

  return (
    <div
      role="status"
      aria-atomic="true"
      className="bg-primary/15 border-b border-primary-emphasis/40 px-4 py-2 flex items-center gap-3 text-sm text-info shrink-0"
    >
      {/* No brand logos for external providers (frontend/CLAUDE.md) — one generic
          glyph for every provider, same as the card-face PR/MR badge. The provider
          is named in text via the link's title below. */}
      <ExternalRefGlyph className="w-4 h-4 shrink-0" />
      <span className="truncate max-w-[24rem]">
        Read-only lens ·{" "}
        {isSafeHttpUrl(url) ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-info hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            title={`Open ${repo} on ${providerName}`}
          >
            {repo}
          </a>
        ) : (
          <span className="font-medium">{repo}</span>
        )}
      </span>
      <HelpLink topic="lens" />
      {truncated && (
        <span className="text-warning flex items-center gap-1 ml-2 min-w-0">
          <span aria-hidden="true">⚠</span>
          {filtersActive
            ? `Showing first ${shownCount} matching ${noun} — more match beyond the fetch limit`
            : `Showing first ${shownCount} ${noun}`}
        </span>
      )}
      {closedNote && (
        // One line that truncates (full text in title) so it never pushes the
        // freshness/Refresh control out of view; text-info because it names an
        // omission, not ambient metadata (#1581 ux-review).
        <span className="text-info ml-2 min-w-0 truncate" title={closedNote} data-testid="lens-closed-note">
          {closedNote}
        </span>
      )}
      <div className="flex-1" />
      <LensFreshness fetchedAt={fetchedAt} refetching={refetching} onRefresh={onRefresh} />
    </div>
  );
}
