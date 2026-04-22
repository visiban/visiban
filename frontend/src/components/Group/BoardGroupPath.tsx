interface Props {
  ancestors: { id: number; name: string }[];
  currentGroupId: number;
  directGroupName: string;
}

/**
 * Renders the full relative group path for a board shown on a GroupDetail
 * page when "Show subgroup boards" is toggled on (#845).
 *
 * `ancestors` is root-first (from the backend GroupBriefSerializer). We slice
 * to the segments *below* the current group, append the board's direct parent
 * name, and join with " / " as a single text node so the label stays
 * copy-paste friendly (Jordan VoC). Styling follows the project's subdued
 * metadata token (text-xs text-fg-muted) so the path reads as secondary
 * information, not equal weight to the board name (Sam VoC blocker).
 */
export default function BoardGroupPath({ ancestors, currentGroupId, directGroupName }: Props) {
  const currentIdx = ancestors.findIndex((a) => a.id === currentGroupId);
  // If the current group is not in the ancestor chain (e.g. deep-nesting
  // truncation beyond the group traversal depth cap), fall back to the
  // pre-#845 behaviour of showing just the direct parent name — better than
  // rendering a misleading partial path that excludes the current context.
  const below = currentIdx === -1 ? [] : ancestors.slice(currentIdx + 1);
  const segments = [...below.map((a) => a.name), directGroupName];

  if (segments.length === 0) return null;

  const fullPath = segments.join(" / ");

  let displayPath: string;
  if (segments.length <= 3) {
    displayPath = fullPath;
  } else {
    // Middle-ellipsis: preserve first + last so the board's direct parent
    // (the segment users most expect to see) is never hidden (Maya VoC).
    displayPath = `${segments[0]} / … / ${segments[segments.length - 1]}`;
  }

  return (
    <span
      className="text-xs text-fg-muted ml-2 min-w-0 truncate max-w-[16rem]"
      title={fullPath}
    >
      {displayPath}
    </span>
  );
}
