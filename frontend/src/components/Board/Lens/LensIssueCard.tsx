import Avatar from "../../Common/Avatar";
import type { NormalizedIssue } from "../../../types";

interface Props {
  issue: NormalizedIssue;
  /**
   * How many lanes this card is rendered in. When > 1 a small "🔗 ×N"
   * indicator is shown so the reader knows the same issue appears elsewhere
   * (an issue with multiple matching swimlane values renders in each lane).
   */
  laneCount?: number;
}

const MAX_AVATARS = 3;

/**
 * Read-only issue card for the lens grid. A forked, non-draggable sibling of
 * CardItem — it is a <button> (cursor-pointer + hover wash, never cursor-grab /
 * translate-y) and opens the upstream issue in a new tab on click. See the
 * "Read-only external cells/headers" rule in frontend/CLAUDE.md.
 */
export default function LensIssueCard({ issue, laneCount = 1 }: Props) {
  const closed = issue.state === "closed";
  const extraAssignees = issue.assignees.length - MAX_AVATARS;
  const ev = issue.pipeline_evidence;

  const openIssue = () => window.open(issue.url, "_blank", "noopener,noreferrer");

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
      className={`group block w-full text-left bg-surface rounded border border-line p-2.5 transition-colors cursor-pointer hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
        closed ? "opacity-70" : ""
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-xs text-fg-muted shrink-0">#{issue.number}</span>
        <span
          className={`text-xs font-medium px-1.5 py-0.5 rounded-full shrink-0 ${
            closed
              ? "bg-surface-hover text-fg-muted"
              : "bg-success/15 text-success"
          }`}
        >
          {closed ? "Closed" : "Open"}
        </span>
        {laneCount > 1 && (
          <span
            className="text-xs text-fg-muted shrink-0 ml-auto"
            title={`This issue appears in ${laneCount} swimlanes`}
            aria-label={`Appears in ${laneCount} lanes`}
          >
            <span aria-hidden="true">🔗</span> ×{laneCount}
          </span>
        )}
      </div>

      <p className="text-sm text-fg line-clamp-2">{issue.title}</p>

      {issue.labels.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap mt-1.5">
          {issue.labels.map((label) => (
            <span
              key={label.name}
              className="text-xs font-semibold px-1 py-0.5 rounded leading-none"
              style={{
                backgroundColor: `#${label.color}22`,
                color: `#${label.color}`,
                border: `1px solid #${label.color}44`,
              }}
              title={label.name}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}

      {(issue.milestone || issue.assignees.length > 0 || ev) && (
        <div className="flex items-center gap-2 mt-1.5 text-xs text-fg-muted">
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
            {ev?.mr_number != null && ev.mr_url && (
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
