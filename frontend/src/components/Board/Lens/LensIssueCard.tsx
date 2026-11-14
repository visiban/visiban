import Avatar from "../../Common/Avatar";
import type { NormalizedIssue } from "../../../types";
import { isSafeHttpUrl } from "../../../utils/safeUrl";
import { colorChipStyle } from "../../../utils/colorContrast";

interface Props {
  issue: NormalizedIssue;
  /**
   * How many lanes this card is rendered in. When > 1 a small "🔗 ×N"
   * indicator is shown so the reader knows the same issue appears elsewhere
   * (an issue with multiple matching swimlane values renders in each lane).
   */
  laneCount?: number;
  /**
   * Compact strips the card to #number + state pill + single-line title (drops
   * labels, milestone, branch/MR evidence, and avatars) for an at-a-glance scan —
   * needed because compact lays cards out multiple-per-row (narrower cards).
   * Defaults to false so a caller that forgets it degrades gracefully.
   */
  compact?: boolean;
}

const MAX_AVATARS = 3;

/**
 * Read-only issue card for the lens grid. A forked, non-draggable sibling of
 * CardItem — it is a <button> (cursor-pointer + hover wash, never cursor-grab /
 * translate-y) and opens the upstream issue in a new tab on click. See the
 * "Read-only external cells/headers" rule in frontend/CLAUDE.md.
 */
export default function LensIssueCard({ issue, laneCount = 1, compact = false }: Props) {
  const closed = issue.state === "closed";
  const extraAssignees = issue.assignees.length - MAX_AVATARS;
  const ev = issue.pipeline_evidence;

  // Provider-supplied URL: fail closed on anything but http(s) (#1087).
  const openIssue = () => {
    if (isSafeHttpUrl(issue.url)) window.open(issue.url, "_blank", "noopener,noreferrer");
  };

  return (
    // role="button" (not <button>) so the pipeline MR chip can be a nested <a> —
    // interactive nesting inside a <button> is invalid HTML. See the lens card
    // rule in frontend/CLAUDE.md.
    <div
      role="button"
      tabIndex={0}
      onClick={openIssue}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openIssue();
        }
      }}
      aria-label={`Open issue #${issue.number}: ${issue.title} (opens in new tab)`}
      // #2238: a closed issue recedes onto bg-sunken with a bordered "Closed" pill and a
      // fg-secondary title, never whole-card opacity (the old 70% dim dropped the pill to 1.72:1
      // and #number to 2.13 dark). Hover is a border step, not a fill: on bg-surface-hover
      // even fg-tertiary is 4.04:1 dark. Every text tone here holds AA on surface and sunken
      // (onTintTokens.test.ts); see frontend/CLAUDE.md § Card aging ramp.
      className={`group block w-full text-left rounded border border-line transition-colors cursor-pointer hover:border-line-emphasis focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
        compact ? "p-1.5" : "p-2.5"
      } ${closed ? "bg-sunken" : "bg-surface"}`}
    >
      <div className={`flex items-center gap-2 ${compact ? "mb-0.5" : "mb-1"}`}>
        <span className="font-mono text-xs text-fg-tertiary shrink-0">#{issue.number}</span>
        <span
          className={`text-xs font-medium px-1.5 py-0.5 rounded-full border shrink-0 ${
            closed
              ? "border-line text-fg-tertiary"
              : "border-transparent bg-success/15 text-success-on-tint"
          }`}
        >
          {closed ? "Closed" : "Open"}
        </span>
        {laneCount > 1 && (
          <span
            className="text-xs text-fg-tertiary shrink-0 ml-auto"
            title={`This issue appears in ${laneCount} swimlanes`}
            aria-label={`Appears in ${laneCount} lanes`}
          >
            <span aria-hidden="true">🔗</span> ×{laneCount}
          </span>
        )}
      </div>

      <p className={`text-sm ${closed ? "text-fg-secondary" : "text-fg"} ${compact ? "line-clamp-1" : "line-clamp-2"}`}>{issue.title}</p>

      {!compact && issue.labels.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap mt-1.5">
          {issue.labels.map((label) => (
            <span
              key={label.name}
              className="cf-choice-badge border text-xs font-semibold px-1 py-0.5 rounded leading-none"
              style={colorChipStyle(`#${label.color}`)}
              title={label.name}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}

      {!compact && (issue.milestone || issue.assignees.length > 0 || ev) && (
        <div className="flex items-center gap-2 mt-1.5 text-xs text-fg-tertiary">
          {/* Left cluster: milestone + pipeline evidence. May flex-wrap — the one
              permitted exception to single-row metadata, so the branch/MR that
              explains a Doing/Review placement is never truncated away. */}
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            {issue.milestone && (
              <span className="flex items-center gap-1 min-w-0" title={`Milestone: ${issue.milestone}`}>
                <span aria-hidden="true">🚩</span>
                <span className="truncate">{issue.milestone}</span>
              </span>
            )}
            {ev?.branch && (
              <span
                className="flex items-center gap-1 min-w-0 max-w-[10rem] text-fg-tertiary"
                title={`Linked branch: ${ev.branch}`}
              >
                <span aria-hidden="true">⎇</span>
                <span className="truncate font-mono">{ev.branch}</span>
              </span>
            )}
            {ev?.mr_number != null && ev.mr_url && !isSafeHttpUrl(ev.mr_url) && (
              <span className="flex items-center gap-0.5 shrink-0 text-fg-tertiary">
                <span aria-hidden="true">{ev.mr_closes ? "⮰" : "↗"}</span>
                <span className="font-mono">!{ev.mr_number}</span>
              </span>
            )}
            {ev?.mr_number != null && isSafeHttpUrl(ev.mr_url) && (
              <a
                href={ev.mr_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-0.5 shrink-0 text-info hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                title={
                  ev.mr_closes
                    ? `Closing merge request !${ev.mr_number} (opens in new tab)`
                    : `Referenced in merge request !${ev.mr_number} (opens in new tab)`
                }
                aria-label={
                  ev.mr_closes
                    ? `Open closing merge request !${ev.mr_number} in new tab`
                    : `Open referencing merge request !${ev.mr_number} in new tab`
                }
              >
                <span aria-hidden="true">{ev.mr_closes ? "⮰" : "↗"}</span>
                <span className="font-mono">!{ev.mr_number}</span>
              </a>
            )}
          </div>
          {issue.assignees.length > 0 && (
            <div className="flex items-center gap-0.5 ml-auto shrink-0">
              {issue.assignees.slice(0, MAX_AVATARS).map((a) => (
                <Avatar
                  key={a.username}
                  user={{ username: a.username, display_name: a.username, avatar_url: a.avatar_url }}
                  size="xs"
                />
              ))}
              {extraAssignees > 0 && (
                <span className="text-xs text-fg-tertiary ml-0.5">+{extraAssignees}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
