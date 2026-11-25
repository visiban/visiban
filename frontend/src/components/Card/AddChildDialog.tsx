import { useEffect, useId, useState } from "react";
import HelpLink from "../Common/HelpLink";
import axios from "axios";
import { addChild, getChildBoardOptions } from "../../api/cards";
import { patchBoard } from "../../api/boards";
import type { ChildBoardOptions, EffectiveBoardMember } from "../../types";
import LaneTeamAssignee from "../Board/LaneTeamAssignee";
import { assignableMembers, childCaption, memberName } from "../../utils/swimlaneDefaultTeam";
import { linkErrorCopy } from "./cardParent";
import { boardsCapLine } from "./childBoardOptionsCap";
import ModalWrapper from "../shared/ModalWrapper";
import SelectDropdown from "../Common/SelectDropdown";

interface Props {
  /** The parent card and the board it is on. */
  boardId: number;
  boardName: string;
  cardId: number;
  /** The parent card's title and column, for the header line (#2209). */
  parentTitle?: string;
  parentColumn?: string;
  /** The parent board's members, to name the lane team's pre-assigned member (#2211). */
  members?: EffectiveBoardMember[];
  onClose: () => void;
  /** Called once the child exists; the board's own socket event adds it to its board. */
  onAdded: (info: { boardName: string; title: string; defaultNotSet?: boolean }) => void;
  /**
   * Called before the first await of a submit, so the Children tab can mark its own write pending before the
   * server's echo ping lands (rule R-C). Optional: other callers need not know about it.
   */
  onWriteStart?: () => void;
  /** Called when the add itself failed, so the pending mark can be cleared. */
  onWriteFailed?: () => void;
  /**
   * The parent board's columns after the parent's own (#2371), for "Needed". Empty or absent hides the field, and
   * the child is Needed: Now as before.
   */
  laterColumns?: { id: number; name: string }[];
}

/**
 * The server's refusal text for an Add child write, or a generic line. A link rule answers
 * `CodedValidationError`'s `{code, detail}` (for example `parent_archived`): show `detail`, or the
 * coded copy when there is none, never the bare code. A field error (`{title: ["..."]}`) shows its
 * first message.
 */
function refusal(err: unknown): { text: string; refetch: boolean } {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as Record<string, unknown> | undefined;
    if (status === 404) return { text: "That board is no longer available. Choose another.", refetch: true };
    if (status === 403) return { text: "You don't have permission to add children to this card.", refetch: false };
    if (status === 400 && data) {
      if (typeof data.detail === "string" && data.detail.trim()) return { text: data.detail, refetch: true };
      if (typeof data.code === "string") return { text: linkErrorCopy(err), refetch: true };
      const first = Object.values(data).flat().find((v): v is string => typeof v === "string");
      if (first) return { text: first, refetch: true };
    }
  }
  return { text: "Couldn't add the child. Try again.", refetch: false };
}

/**
 * "Add child" (#2208): a dialog on desktop and a full-screen sheet below 640px (phone). The server decides
 * where a child may go (`child-board-options`): a parent's children share one board, so once it has any the
 * select is replaced by that board's name, and a board the viewer cannot open disables Add child.
 */
export default function AddChildDialog({ boardId, boardName, cardId, parentTitle, parentColumn, members, onClose, onAdded, onWriteStart, onWriteFailed, laterColumns }: Props) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const selectId = `${uid}-board`;
  const capId = `${uid}-cap`;
  const archivedReasonId = `${uid}-archived`;
  const titleFieldId = `${uid}-card-title`;
  const titleHintId = `${uid}-title-hint`;
  const [options, setOptions] = useState<ChildBoardOptions | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [chosen, setChosen] = useState<string>("");
  const [title, setTitle] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // #2211: Unassign drops the lane team's member for this child only.
  const [unassigned, setUnassigned] = useState(false);
  // #2371: "now", or the id of a later parent column the child is planned for.
  const [needed, setNeeded] = useState("now");
  const neededId = `${uid}-needed`;
  const neededHelpId = `${uid}-needed-help`;
  const neededHintId = `${uid}-needed-hint`;

  useEffect(() => {
    let live = true;
    getChildBoardOptions(boardId, cardId)
      .then((o) => {
        if (!live) return;
        setOptions(o);
        setChosen((cur) => {
          if (o.fixed_board && !o.fixed_board.hidden) return String(o.fixed_board.id);
          if (cur && o.boards.some((b) => String(b.id) === cur)) return cur;
          return o.default ? String(o.default.id) : "";
        });
      })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [boardId, cardId, reload]);

  const fixed = options?.fixed_board ?? null;
  const fixedHidden = fixed?.hidden === true;
  const fixedVisible = fixed && !fixed.hidden ? fixed : null;
  const chosenBoard = options?.boards.find((b) => String(b.id) === chosen) ?? null;
  const targetName = fixedVisible?.name ?? chosenBoard?.name ?? null;
  const fixedBlocked = fixedVisible?.can_add === false;
  // #2447: the server refuses a new child under an archived parent; say so before the write does.
  const parentArchived = options?.disabled_reason === "parent_archived";
  const canPick = !parentArchived && !fixedHidden && !fixedBlocked && (fixedVisible != null || chosenBoard != null);
  const hasDefault = options?.default != null;
  const offerDefault = !fixedVisible && chosenBoard?.can_set_default === true && options?.default?.id !== chosenBoard.id;
  // #2211: the server names who it pre-assigns on each board (a member who can't be assigned there
  // is skipped and never shown); the other team members are only listed in the caption.
  const team = options?.default_team ?? null;
  // Only listed non-viewers, the lane team's own rule, so someone Edit Swimlane and the band hide (a
  // member demoted to viewer) can never produce a chip or a caption name.
  const byId = new Map(assignableMembers(members ?? []).map((m) => [m.user.id, m.user]));
  const assigneeId = (fixedVisible ?? chosenBoard)?.default_assignee_id ?? null;
  const teamAssignee = team && assigneeId != null ? byId.get(assigneeId) ?? null : null;
  const teamOthers = team
    ? team.member_ids.filter((id) => id !== assigneeId && byId.has(id)).map((id) => memberName(byId.get(id)!))
    : [];
  const capLine = options ? boardsCapLine(options.boards.length, options.boards_total) : null;
  const hasTitle = title.trim().length > 0;
  const ready = canPick && hasTitle && !submitting;

  const submit = async () => {
    if (!ready || !targetName) return;
    const targetId = fixedVisible ? fixedVisible.id : Number(chosen);
    setSubmitting(true);
    setError(null);
    onWriteStart?.();
    try {
      await addChild(boardId, cardId, {
        board_id: targetId, title: title.trim(),
        // The server applies the lane team unless told not to, so say no whenever no chip was shown
        // (nobody listed, or a stale roster) or the chip was removed: what is applied is what was shown.
        // When the chip is kept, name its person: the server picks again at submit, and if its pick is
        // someone else by then it creates the child unassigned rather than assign who was not shown.
        ...(!teamAssignee || unassigned ? { apply_default_team: false } : { expected_assignee_id: assigneeId }),
        // #2371: omitted is Needed: Now, exactly as before the field existed.
        ...(needed !== "now" && { needed_at_column: Number(needed) }),
      });
    } catch (err) {
      const r = refusal(err);
      onWriteFailed?.();
      setError(r.text);
      if (r.refetch) setReload((n) => n + 1);
      setSubmitting(false);
      return;
    }
    // The checkbox is a second write by design (one write path for the default). The child exists
    // either way, so a refusal here is not an error for the add.
    let defaultNotSet = false;
    if (offerDefault && makeDefault) {
      try { await patchBoard(boardId, { default_child_board: targetId }); } catch { defaultNotSet = true; }
    }
    onAdded({ boardName: targetName, title: title.trim(), ...(defaultNotSet && { defaultNotSet }) });
  };

  return (
    <ModalWrapper
      open
      onClose={onClose}
      dismissable={!submitting}
      title={targetName ? `Add child to ${targetName}` : "Add child"}
      labelId={titleId}
      subtitle={parentTitle ? `Parent: ${parentTitle}${parentColumn ? ` · ${parentColumn}` : ""}` : "Where should this child go?"}
      phoneBack
      maxWidth="max-w-md"
      panelClassName="max-sm:fixed max-sm:inset-0 max-sm:h-dvh max-sm:max-w-none max-sm:rounded-none max-sm:border-0"
    >
      {loadFailed ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-danger">Couldn't load the boards.</p>
          <button
            type="button"
            onClick={() => {
              // This button unmounts on click; focus would fall to <body> inside the modal.
              // The heading is the anchor that outlives it (frontend/CLAUDE.md, focus anchors).
              const heading = document.getElementById(titleId);
              heading?.setAttribute("tabindex", "-1");
              heading?.focus();
              setLoadFailed(false);
              setReload((n) => n + 1);
            }}
            className="max-sm:min-h-11 rounded border border-line-strong px-4 py-2 text-sm text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Retry
          </button>
        </div>
      ) : !options ? (
        <p role="status" className="text-sm text-fg-muted">Loading…</p>
      ) : (
        <form
          className="flex flex-col gap-4 max-sm:flex-1"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          {parentArchived ? (
            <p id={archivedReasonId} role="alert" className="text-sm text-fg-secondary">
              This card is archived. Restore it before adding children.
            </p>
          ) : fixedHidden ? (
            <p role="alert" className="text-sm text-fg-secondary">
              This card's children are on a board you can't open, so you can't add another from here.
            </p>
          ) : fixedBlocked ? (
            <p role="alert" className="text-sm text-fg-secondary">
              This card's children are on <span className="font-medium text-fg">{fixedVisible?.name}</span>, and you can't add cards there (you need member access, and its first column must allow new cards). Ask a board admin there.
            </p>
          ) : fixedVisible ? (
            <p className="text-sm text-fg-secondary">
              This card's children are on <span className="font-medium text-fg">{fixedVisible.name}</span>. New children go there too.
            </p>
          ) : options.boards.length === 0 ? (
            <p className="text-sm text-fg-secondary">
              No board can take new children from {boardName}. A child board needs a first column that allows card creation, and you need member access to it.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {!hasDefault && <p className="text-sm text-fg-muted">{boardName} has no default child board yet.</p>}
              <label htmlFor={selectId} className="text-sm text-fg-secondary">Child board</label>
              <SelectDropdown
                id={selectId}
                ariaDescribedBy={capLine ? capId : undefined}
                value={chosen}
                onChange={(v) => { setChosen(v); setMakeDefault(false); setUnassigned(false); }}
                placeholder="Choose a board"
                options={options.boards.map((b) => ({ value: String(b.id), label: b.name }))}
              />
              <p className="text-xs text-fg-muted">Only boards you can add cards to are listed.</p>
              {capLine && (
                <p id={capId} className="text-xs text-fg-muted" data-testid="child-board-options-cap">{capLine}</p>
              )}
            </div>
          )}

          {!fixedHidden && !parentArchived && (offerDefault ? (
            <label className="flex min-h-11 items-center gap-2 text-sm text-fg-secondary">
              <input type="checkbox" className="h-4 w-4 accent-primary focus:ring-2 focus:ring-primary-emphasis" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
              Use {chosenBoard?.name} as the default for {boardName}
            </label>
          ) : (!hasDefault && !fixedVisible && !offerDefault && options.boards.length > 0 && (
            <p className="text-xs text-fg-muted">A board admin can set one so this step is skipped.</p>
          )))}

          {!fixedHidden && !fixedBlocked && !parentArchived && (
            <div className="flex flex-col gap-1">
              <label htmlFor={titleFieldId} className="text-sm text-fg-secondary">Title</label>
              <input
                id={titleFieldId}
                type="text"
                value={title}
                maxLength={255}
                onChange={(e) => setTitle(e.target.value)}
                readOnly={submitting}
                aria-describedby={titleHintId}
                className="w-full bg-surface border border-line text-fg text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
              />
              {/* #2542: static hint at the point of choice between a child card and a checklist item. */}
              <p id={titleHintId} className="text-xs text-fg-muted" data-testid="child-title-hint">A child card has its own workflow on another board. For a simple to-do, use the checklist.</p>
              <HelpLink topic="work-breakdown" variant="text" className="self-start" />
            </div>
          )}

          {!fixedHidden && !fixedBlocked && !parentArchived && laterColumns && laterColumns.length > 0 && (
            <div className="flex flex-col gap-1">
              <label htmlFor={neededId} className="text-sm text-fg-secondary">Needed</label>
              <SelectDropdown
                id={neededId}
                // The lead-time hint appears with a planned choice; describedby carries it to assistive tech.
                ariaDescribedBy={needed !== "now" ? `${neededHelpId} ${neededHintId}` : neededHelpId}
                value={needed}
                onChange={setNeeded}
                options={[
                  { value: "now", label: "Now" },
                  ...laterColumns.map((c) => ({ value: String(c.id), label: `When the parent reaches ${c.name}` })),
                ]}
              />
              <p id={neededHelpId} className="text-xs text-fg-muted">Options: Now, then each later column on {boardName}.</p>
              <HelpLink topic="planned-children" variant="text" className="self-start" />
              {needed !== "now" && (
                <p id={neededHintId} className="text-xs text-fg-muted" data-testid="needed-lead-time-hint">Lead time without dates: split the work.</p>
              )}
            </div>
          )}

          {!fixedHidden && !fixedBlocked && team && teamAssignee && targetName && (
            <LaneTeamAssignee
              size="md"
              assignee={teamAssignee}
              assigned={!unassigned}
              others={teamOthers}
              caption={childCaption(team.swimlane.name, boardName, targetName)}
              onUnassign={() => setUnassigned(true)}
              onReassign={() => setUnassigned(false)}
            />
          )}

          {error && <p role="alert" className="text-sm text-danger">{error}</p>}

          <div className="flex gap-3 justify-end max-sm:mt-auto">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="text-fg-secondary text-sm hover:text-fg hover:bg-surface-hover px-3 py-1.5 max-sm:min-h-11 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!ready}
              aria-describedby={parentArchived ? archivedReasonId : undefined}
              className="bg-button-primary hover:bg-button-primary-hover disabled:opacity-40 disabled:cursor-not-allowed text-on-primary text-sm px-4 py-1.5 max-sm:min-h-11 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              {submitting ? "Adding…" : targetName ? `Add to ${targetName}` : "Add child"}
            </button>
          </div>
        </form>
      )}
    </ModalWrapper>
  );
}
