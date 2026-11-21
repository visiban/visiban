import { useCallback, useEffect, useRef, useState } from "react";
import { useResyncedState } from "../hooks/useResyncedState";
import { canDeleteGroup } from "../utils/canDeleteGroup";
import { neutralizePerUserBoardFields, stripPerUserBoardFields } from "../utils/boardEventPayload";
import { useParams, useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { useEscapeStack } from "../hooks/useEscapeStack";
import { useConfirmFocusReturn } from "../hooks/useConfirmFocusReturn";
import { useConfirmAnnouncement } from "../hooks/useConfirmAnnouncement";
import { useGroupSocket } from "../hooks/useGroupSocket";
import type { BoardEvent } from "../hooks/useBoardSocket";
import ConnectionStatus from "../components/Common/ConnectionStatus";
import Avatar from "../components/Common/Avatar";
import { Toggle } from "../components/Common/Toggle";
import {
  getGroup, getGroupMembers, getSubgroups, getGroupBoards, getGroupDescendantBoards,
  createGroupBoard, removeGroupMember, updateGroupMemberRole, deleteGroup,
  transferGroupOwnership, createGroupLabel, deleteGroupLabel, updateGroupBoardDefaults,
  starGroup, unstarGroup, updateGroup, setGroupHealthStatus, getGroupHealthHistory,
} from "../api/groups";
import Navbar from "../components/Layout/Navbar";
import UnavailablePage from "./UnavailablePage";
import CreateGroupModal from "../components/Group/CreateGroupModal";
import InviteLinkPanel from "../components/Group/InviteLinkPanel";
import { useJoinedToast } from "../components/Common/useJoinedToast";
import BoardGroupPath from "../components/Group/BoardGroupPath";
import HealthStatusControl from "../components/Common/HealthStatusControl";
import { healthSetLine } from "../utils/healthStatus";
import { HealthListingPill } from "../components/Common/HealthStatusPill";
import HealthReviewDaysInput from "../components/Common/HealthReviewDaysInput";
import MoveBoardModal from "../components/Board/MoveBoardModal";
import CreateBoardModal from "../components/Board/CreateBoardModal";
import ImportBoardModal, { type ImportMeta } from "../components/Board/ImportBoardModal";
import TrelloImportModal from "../components/Board/TrelloImportModal";
import { importBoard, deleteBoard } from "../api/boards";
import type { Board, BoardEventPayload, Group, GroupMembership, HealthStatus, ImportOptions, User } from "../types";
import SectionEmptyState from "../components/Common/SectionEmptyState";
import { forSampleImport, hasImportSkips } from "../utils/importSummary";
import SelectDropdown from "../components/Common/SelectDropdown";
import Spinner from "../components/Common/Spinner";
import RoleInfoTooltip from "../components/Common/RoleInfoTooltip";
import ModalWrapper from "../components/shared/ModalWrapper";
import ColorSwatchPicker from "../components/Common/ColorSwatchPicker";
import { PALETTE_COLORS } from "../constants/colors";
import { isImeComposing } from "../utils/imeComposition";
import { LOCKED_MEMBERSHIP_NOTE } from "../constants/membership";
import OverflowMenu from "../components/Layout/OverflowMenu";
import BoardDeleteImpactNotice from "../components/Board/BoardDeleteImpact";
import { Button, CardHeading, InlineConfirm, ListRow, ListWell, OverviewLayout, PageHeading, SettingsCard, SettingsLayout } from "../components/Page";
import type { SettingsSection } from "../components/Page";
import { useShellNavData } from "../contexts/ShellNavContext";
import { canDeleteBoard } from "../utils/canDeleteBoard";
import { colorChipStyle } from "../utils/colorContrast";

interface Props {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
  onStarToggled?: () => void;
}

/** The new-label row starts on a palette color, so a swatch reads selected from the start. */
const DEFAULT_LABEL_COLOR = "#F59E0B";

// First-open resync threshold (#2088); see handleFirstConnected. Same value and
// reasoning as the board's FIRST_OPEN_RESYNC_MS (#1968).
const FIRST_OPEN_RESYNC_MS = 1000;

/**
 * A pure write to the direct boards list (#2139): a socket frame, or this
 * session's own create or move-out. It must not mutate its argument, and
 * applying it to a list that already reflects it must change nothing, so that
 * replaying it over a boards re-read is safe (see refetchBoardsList).
 */
type BoardsWrite = (boards: Board[]) => Board[];

/** Append `incoming` unless a row with its id is already listed. */
function addBoardRow(incoming: Board): BoardsWrite {
  return (prev) => (prev.some((b) => b.id === incoming.id) ? prev : [...prev, incoming]);
}

/**
 * Patch the listed row with `incoming.id`. A board moved *into* this group
 * arrives as board.updated on the per-board channel but board.created on the
 * group channel, so an update for an unlisted id is not an insert.
 */
function patchBoardRow(incoming: Partial<Board> & { id: number }): BoardsWrite {
  return (prev) => (prev.some((b) => b.id === incoming.id)
    ? prev.map((b) => (b.id === incoming.id ? { ...b, ...incoming } : b))
    : prev);
}

/** Drop every row `matches` selects. */
function removeBoardRows(matches: (b: Board) => boolean): BoardsWrite {
  return (prev) => {
    const next = prev.filter((b) => !matches(b));
    return next.length === prev.length ? prev : next;
  };
}

const GROUP_FULL_ACCESS_DESCRIPTION = "Full access to all groups and boards. This account's group role doesn't apply.";

const GROUP_ROLES = ["admin", "member", "collaborator", "viewer"];
const GROUP_ROLE_OPTIONS: { value: "admin" | "member" | "collaborator" | "viewer"; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
  { value: "collaborator", label: "Collaborator" },
  { value: "viewer", label: "Viewer" },
];

// A stored role outside the known set is not named in the "not in effect" text:
// the chip alone says what the member can do (same guard as the board panel).
// An admin-role row still counts as a group admin (it counts toward the group's admin
// minimum and ownership transfer), so its stored role is not "not in effect";
// every other stored role is overridden by the all-content access.
function groupRoleNote(role: string): string {
  const label = role.charAt(0).toUpperCase() + role.slice(1);
  return role === "admin"
    ? `Group role: ${label} — doesn't limit this account's access, and still counts as a group admin.`
    : `Group role: ${label} — not in effect while this account has all-content access.`;
}

// `describeRole` adds the stored-role note to the description; rows that print
// the note as a visible line leave it off so it is not read twice.
function GroupFullAccessChip({ userId, role, describeRole = false }: { userId: number; role: string; describeRole?: boolean }) {
  const known = describeRole && GROUP_ROLES.includes(role);
  const descId = `group-member-fullaccess-${userId}`;
  return (
    <>
      <span
        tabIndex={0}
        aria-disabled="true"
        aria-describedby={descId}
        title={GROUP_FULL_ACCESS_DESCRIPTION}
        className="inline-flex items-center gap-1 text-xs text-fg-secondary px-2 py-1 bg-surface-hover rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="5" cy="8" r="2.5" />
          <path d="M7.5 8H14M12 8v2.5M10 8v1.5" />
        </svg>
        Full access
      </span>
      <span id={descId} className="sr-only">
        {GROUP_FULL_ACCESS_DESCRIPTION}
        {known ? ` ${groupRoleNote(role)}` : ""}
      </span>
    </>
  );
}

// A 403/404 on a read means the group was deleted or access to it was lost.
function isAccessLoss(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || status === 403;
}

export default function GroupDetail({ user, onLogout, onUserUpdated, onStarToggled }: Props) {
  const { id } = useParams<{ id: string }>();
  const groupId = Number(id);
  const { addBoard: shellAddBoard, removeBoard: shellRemoveBoard, addGroup: shellAddGroup, removeGroup: shellRemoveGroup } = useShellNavData();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  // Captured once: a tab click (setSearchParams) navigates without location.state,
  // and a title rebuilt each render would become null and dismiss the toast (#2107).
  const [joinedTitle] = useState<string | null>(() => {
    const name = (location.state as { joinedGroup?: string } | null)?.joinedGroup;
    return name ? `You've joined ${name}. Welcome!` : null;
  });
  // A persistent `success` toast in the shared region (#2107).
  useJoinedToast(joinedTitle);

  useEscapeStack(() => {
    if (showTransfer) { closeTransfer(); return; }
    if (confirmDeleteGroup) { setConfirmDeleteGroup(false); return; }
    // Inline confirms (#1238): Escape cancels the prompt instead of reaching the
    // priority-0 handler below, which would navigate away from the page.
    if (confirmRemoveMemberId !== null) { setConfirmRemoveMemberId(null); return; }
    if (confirmRemoveLabelId !== null) { setConfirmRemoveLabelId(null); return; }
    // Inline rename / description editors (#2170): handled here, not in the
    // input's onKeyDown. The stack listens on `document` and runs after React's
    // handler; once that handler's state change commits and focus moves to the
    // trigger button, the priority-0 navigate handler below would no longer see
    // an INPUT/TEXTAREA as the active element and would leave the page.
    if (renaming) { handleRenameCancel(); return; }
    if (editingDescription) { handleDescriptionCancel(); return; }
    return false;
  }, 40);

  useEscapeStack(() => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // there is nothing to roll back if the navigation itself rejects.
    if (window.history.length > 1) { void navigate(-1); return; }
    void navigate("/");
  }, 0);

  const [group, setGroup] = useState<Group | null>(null);
  const [subgroups, setSubgroups] = useState<Group[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [members, setMembers] = useState<GroupMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Incremented on an invite_link.revoked/created socket event so InviteLinkPanel
  // (which owns its own link state) refetches in real time (#1051).
  const [inviteReloadKey, setInviteReloadKey] = useState(0);

  const [movingBoard, setMovingBoard] = useState<Board | null>(null);
  const [showCreateSubgroup, setShowCreateSubgroup] = useState(false);
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [importingBoard, setImportingBoard] = useState(false);
  const [trelloImporting, setTrelloImporting] = useState(false);
  const [showSubgroupBoards, setShowSubgroupBoards] = useState(false);
  const [subgroupBoards, setSubgroupBoards] = useState<Board[]>([]);
  const [loadingSubgroupBoards, setLoadingSubgroupBoards] = useState(false);

  // Set of board ids flagged for fade-in animation after a live insertion.
  // Cleared 200ms after mount so re-renders don't replay the animation.
  const [animateBoardIds, setAnimateBoardIds] = useState<Set<number>>(new Set());

  const [showTransfer, setShowTransfer] = useState(false);
  const [transferNewOwnerId, setTransferNewOwnerId] = useState<number | "">("");
  const [transferConfirmation, setTransferConfirmation] = useState("");
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);
  // Phone: the Members list below the content starts collapsed (#2478); from `sm` it is always open.
  const [membersOpenPhone, setMembersOpenPhone] = useState(false);
  const transferTriggerRef = useRef<HTMLButtonElement>(null);
  // Cancel, Escape and a finished transfer all collapse the inline panel and give focus back to
  // the button that opened it (the panel's controls unmount with it, #2478).
  const closeTransfer = () => {
    setShowTransfer(false);
    setTransferConfirmation("");
    setTransferNewOwnerId("");
    setTransferError(null);
    transferTriggerRef.current?.focus();
  };

  const [isStarred, setIsStarredState] = useState(false);
  // Bumped on every star write (frame, toggle, rollback) so a group re-read that
  // started before one does not revert it with an older is_starred (#2136).
  const starSeqRef = useRef(0);
  const setIsStarred = useCallback((v: boolean) => { ++starSeqRef.current; setIsStarredState(v); }, []);
  const [starLoading, setStarLoading] = useState(false);

  // Inline rename state
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  // Inline description edit state
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionValue, setDescriptionValue] = useState("");
  const [descriptionError, setDescriptionError] = useState<string | null>(null);

  // Inline confirmation state — replaces window.confirm() for destructive actions
  const [confirmRemoveMemberId, setConfirmRemoveMemberId] = useState<number | null>(null);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState(false);
  const [deleteGroupInput, setDeleteGroupInput] = useState("");
  const [confirmDeleteBoardId, setConfirmDeleteBoardId] = useState<number | null>(null);
  const [deleteBoardInput, setDeleteBoardInput] = useState("");
  // A failed board delete has its own always-mounted live region on the overview (not the Danger zone's).
  const [boardActionError, setBoardActionError] = useState<string | null>(null);
  const [confirmRemoveLabelId, setConfirmRemoveLabelId] = useState<number | null>(null);
  const removingMemberIds = useRef(new Set<number>());
  const removingLabelIds = useRef(new Set<number>());
  const removeMemberTriggerRef = useConfirmFocusReturn(confirmRemoveMemberId);
  const removeLabelTriggerRef = useConfirmFocusReturn(confirmRemoveLabelId);
  const confirmingMember = confirmRemoveMemberId === null ? undefined : members.find((m) => m.user.id === confirmRemoveMemberId);
  const confirmingLabel = confirmRemoveLabelId === null ? undefined : group?.shared_labels?.find((l) => l.id === confirmRemoveLabelId);
  useConfirmAnnouncement(
    confirmingMember
      ? confirmingMember.has_all_content_access === true
        ? "Remove this group role? Full access is not affected."
        : `Remove ${confirmingMember.user.display_name || confirmingMember.user.username} from this group?`
      : confirmingLabel
        ? `Remove ${confirmingLabel.name} from this group?`
        : null,
  );

  // Board defaults state
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState(DEFAULT_LABEL_COLOR);
  const [addingLabel, setAddingLabel] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [defaultsSaved, setDefaultsSaved] = useState(false);

  // Track transient-state timers so we can clear them on unmount (#870).
  // `animateTimersRef` holds the multiple fade-out timers (one per recently-added
  // board); `defaultsSavedTimerRef` holds the single "Defaults saved" flash timer.
  const animateTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const defaultsSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const animateTimers = animateTimersRef.current;
    return () => {
      animateTimers.forEach((t) => clearTimeout(t));
      animateTimers.clear();
      if (defaultsSavedTimerRef.current !== null) {
        clearTimeout(defaultsSavedTimerRef.current);
        defaultsSavedTimerRef.current = null;
      }
    };
  }, []);

  // When the initial list load was applied (Date.now()), or null while it is in
  // flight. The socket's first open is compared with it (#2088). A ref, not
  // state: only that open reads it.
  const loadedAtRef = useRef<number | null>(null);
  // Sequence for writes of the direct boards list: only the most recently
  // STARTED fetch may apply (#2088), like useBoard's silentReload. Without it the
  // initial load, which also waits on getGroup/getSubgroups/getGroupMembers,
  // can land after a first-open or reconnect re-read and overwrite it with an
  // older list. A group change bumps it too, so a re-read answered for the
  // previous group never lands on the next group's page.
  const boardsSeqRef = useRef(0);
  // True once a boards re-read has applied its answer for the current group
  // (#2150). The initial load yields only to an answer that actually landed: a
  // re-read that was started first but failed must not discard the load's list,
  // which would leave the page with no boards until the next reconnect.
  const boardsRereadAppliedRef = useRef(false);
  // Set when the latest re-read failed while the initial load was still pending,
  // leaving its replay array open for the load to consume (#2150); the load
  // closes the array after replaying it.
  const boardsReplayOrphanedRef = useRef(false);
  // The list writes applied while the latest boards re-read is in flight, in
  // order, or null when none is (#2139); see refetchBoardsList. One array per
  // re-read, created when it starts and closed when its answer arrives, so it
  // holds only what happened after the start and a later re-read never sees an
  // earlier one's writes.
  const boardsReplayRef = useRef<BoardsWrite[] | null>(null);
  // Applies a write to the direct boards list and records it for the in-flight
  // re-read, if any. The array is read at call time: an updater queued before
  // the answer arrived runs before the answer's own write, so recording it now
  // puts it in the array that answer replays; a write made after the answer
  // finds the array closed and its updater lands on top of the answer.
  const writeBoards = useCallback((write: BoardsWrite) => {
    boardsReplayRef.current?.push(write);
    setBoards(write);
  }, []);

  // The other lists and the group re-read on a reconnect or late first open
  // (#2136) follow the same record-and-replay rule as the boards list; see
  // useResyncedState. Every write after the initial load goes through `write`.
  const groupState = useResyncedState<Group | null>(setGroup);
  const subgroupsState = useResyncedState<Group[]>(setSubgroups);
  const membersState = useResyncedState<GroupMembership[]>(setMembers);
  const subgroupBoardsState = useResyncedState<Board[]>(setSubgroupBoards);
  const writeGroup = groupState.write;
  const writeSubgroups = subgroupsState.write;
  const writeMembers = membersState.write;
  const writeSubgroupBoards = subgroupBoardsState.write;
  const resetSubgroupBoards = subgroupBoardsState.reset;
  const applyLoadSubgroupBoards = subgroupBoardsState.applyLoad;

  useEffect(() => {
    setLoading(true);
    setUnavailable(false);
    setError(null);
    loadedAtRef.current = null;
    // The bump below drops a re-read still in flight for the previous group;
    // close its array too, so the next group's writes are not collected into it.
    boardsReplayRef.current = null;
    boardsRereadAppliedRef.current = false;
    boardsReplayOrphanedRef.current = false;
    ++boardsSeqRef.current;
    groupState.reset();
    subgroupsState.reset();
    membersState.reset();
    subgroupBoardsState.reset(false);
    // Set by cleanup when the route moves to another group: a late answer for
    // the previous group must not write into, or mark unavailable, the new one.
    let stale = false;
    // A star write (frame or toggle) before the load answers is newer than it.
    const loadStarSeq = starSeqRef.current;
    Promise.all([
      getGroup(groupId),
      getSubgroups(groupId),
      getGroupBoards(groupId),
      getGroupMembers(groupId),
    ]).then(([g, sg, b, m]) => {
      if (stale) return;
      loadedAtRef.current = Date.now();
      // is_starred follows the group value: skipped when a re-read already applied
      // a newer group, or a star write landed since the load started.
      if (groupState.applyLoad(g) && loadStarSeq === starSeqRef.current) setIsStarredState(g.is_starred);
      subgroupsState.applyLoad(sg);
      if (!boardsRereadAppliedRef.current) {
        // A re-read still in flight (socket opened before this load answered)
        // recorded the frames applied meanwhile; carry them over this list too,
        // in case that re-read fails and never replays them (#2150).
        const pending = boardsReplayRef.current;
        setBoards(pending ? pending.reduce((list, write) => write(list), b) : b);
        // A failed re-read left its array open only for this load; close it.
        if (boardsReplayOrphanedRef.current) {
          boardsReplayRef.current = null;
          boardsReplayOrphanedRef.current = false;
        }
      }
      membersState.applyLoad(m);
    }).catch((err: unknown) => {
        if (stale) return;
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 404 || status === 403) {
          // Deleted or no access: the API answers both alike, so one page (#2041).
          setUnavailable(true);
        } else {
          setError("Failed to load group");
        }
      })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
    // The state hooks' members are stable callbacks; groupId is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [groupId]);

  const flagAnimate = useCallback((id: number) => {
    setAnimateBoardIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    const t = setTimeout(() => {
      animateTimersRef.current.delete(t);
      setAnimateBoardIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 200);
    animateTimersRef.current.add(t);
  }, []);

  // Capture focus before a list mutation so we can restore it afterwards (#753).
  // We key on the rendered button's `data-board-id`; any non-board focus is left
  // alone.
  const pendingRefocusRef = useRef<number | null>(null);
  // Scope focus-restoration queries to this component's own subtree rather than
  // the global document. A bare document.querySelector can match a detached
  // [data-board-id] node left behind by another (unmounted) GroupDetail instance
  // — e.g. a prior test render whose cleanup has not flushed — and focusing a
  // detached node is a no-op, leaving focus stranded on <body> (#753 flake).
  const rootRef = useRef<HTMLDivElement>(null);
  // Focus anchors that outlive what had focus (#2478): the current view's h2 (a view switch
  // unmounts the button that was pressed), the open settings section's h3 (a confirmed Remove
  // unmounts its row) and the new-label input (its Add button must not take focus with it).
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const captureFocusedBoardId = useCallback(() => {
    const el = document.activeElement as HTMLElement | null;
    const raw = el?.getAttribute?.("data-board-id");
    if (raw) pendingRefocusRef.current = Number(raw);
  }, []);

  // Set while this session is deleting the group, so its own socket echo of
  // group.deleted does not flash the unavailable page before it navigates away.
  const selfDeletingRef = useRef(false);
  // Latest route group, so late responses for a previous group can be dropped.
  const groupIdRef = useRef(groupId);
  groupIdRef.current = groupId;

  // Re-read the group to find out whether it is still reachable (#2041): used
  // when the socket reports lost access or the group was deleted elsewhere. A
  // 404/403 swaps in the unavailable page; any other outcome changes nothing.
  const refetchForAccess = useCallback(() => {
    getGroup(groupId).catch((err: unknown) => {
      // A late answer for a group we have since left must not mark this one.
      if (groupIdRef.current !== groupId) return;
      if (isAccessLoss(err)) setUnavailable(true);
    });
  }, [groupId]);
  // A reconnect or late-first-open re-read that answers 403/404 goes through the
  // same handling as a frame-driven one (#2162). The group's own re-read is the
  // answer; any other list may 403/404 for its own reasons, so it re-confirms
  // through the group before the page is swapped.
  const handleGroupReadError = useCallback((err: unknown) => {
    if (groupIdRef.current !== groupId || selfDeletingRef.current) return;
    if (isAccessLoss(err)) refetchForAccess();
  }, [groupId, refetchForAccess]);

  // A ref, so the socket handler does not re-subscribe when the toggle flips.
  const showSubgroupBoardsRef = useRef(false);
  const directBoardIdsRef = useRef<Set<number>>(new Set());
  // Re-read the direct boards list (reconnect, late first open, health change)
  // and apply it over the list on screen (#2139), like useBoard's
  // mergeFullSnapshot does for a board's columns and labels (#2130).
  //
  // The server reads the list at some point while the request is in flight, so
  // a frame applied meanwhile may be newer than the answer. Replacing the list
  // wholesale would undo it: a board.deleted brings the row back and no later
  // frame removes it again, a board.created is dropped, and a board.updated or
  // star change reverts until the next frame for that board. So every list
  // write applied during the re-read is replayed, in order, over the answer.
  // Each write is idempotent, so replaying one the answer already reflects
  // changes nothing; a later change the answer holds sends a later frame, which
  // lands on top. A delete replayed over an answer that still lists the board is
  // the tombstone; a create replayed over one that lacks it keeps the row; a
  // create then delete during the same re-read leaves it gone. Rows no write
  // touched come from the answer as they are: recovering a frame missed while
  // the socket was down is what the re-read is for.
  //
  // Only the most recently started read applies (boardsSeqRef). A superseded
  // read's writes need no carrying over: the newer read was sent after they were
  // applied, so after the server committed them, and its answer includes them.
  //
  // The initial load (the effect above) yields only to a re-read that has
  // applied (boardsRereadAppliedRef), not to one that merely started: if that
  // re-read fails, the load's list stands (#2150). When a re-read is still in
  // flight as the load answers, the load carries the re-read's recorded frames
  // over its own list; the re-read's answer, if it comes, replays them again
  // over a newer list, which is idempotent.
  const refetchBoardsList = useCallback(() => {
    const seq = ++boardsSeqRef.current;
    // While the initial load is pending, a newer re-read inherits the writes
    // recorded since the earlier one started: if it fails, the load still needs
    // them, and the earlier read's answer was superseded so cannot restore them
    // (#2150). Once the load has applied, each re-read starts empty (#2139).
    const replay: BoardsWrite[] = loadedAtRef.current === null ? [...(boardsReplayRef.current ?? [])] : [];
    boardsReplayRef.current = replay;
    boardsReplayOrphanedRef.current = false;
    getGroupBoards(groupId)
      .then((b) => {
        if (seq !== boardsSeqRef.current) return;
        // Still the latest read, so the open array is this one; close it so
        // later writes land on top of the answer instead of in it.
        boardsReplayRef.current = null;
        boardsRereadAppliedRef.current = true;
        setBoards(replay.reduce((list, write) => write(list), b));
      })
      .catch((err: unknown) => {
        // Stay with the current list.
        if (seq !== boardsSeqRef.current) return;
        handleGroupReadError(err);
        if (loadedAtRef.current === null) {
          // The initial load is still pending and will replace the list: keep
          // the frames recorded so far so it can carry them over (#2150).
          boardsReplayOrphanedRef.current = true;
        } else {
          boardsReplayRef.current = null;
        }
      });
  }, [groupId, handleGroupReadError]);
  const readGroup = groupState.read;
  const readSubgroups = subgroupsState.read;
  const readMembers = membersState.read;
  const readSubgroupBoards = subgroupBoardsState.read;
  // The group's is_starred lives in separate state, so a re-read applies it too,
  // unless a star write landed since the read started. A failed re-read is
  // swallowed, except a 403/404 (a group deleted or lost meanwhile), which
  // swaps in the unavailable page (#2162).
  const refetchGroup = useCallback(() => {
    const starSeq = starSeqRef.current;
    readGroup(() => getGroup(groupId), {
      onError: handleGroupReadError,
      onApplied: (g) => { if (g && starSeq === starSeqRef.current) setIsStarredState(g.is_starred); },
    });
  }, [readGroup, groupId, handleGroupReadError]);
  const refetchSubgroups = useCallback(() => readSubgroups(() => getSubgroups(groupId), { onError: handleGroupReadError }), [readSubgroups, groupId, handleGroupReadError]);
  const refetchMembers = useCallback(() => readMembers(() => getGroupMembers(groupId), { onError: handleGroupReadError }), [readMembers, groupId, handleGroupReadError]);
  // The descendant endpoint also returns the direct boards; drop those, as the
  // toggle's own load does.
  const refetchSubgroupBoards = useCallback(() => readSubgroupBoards(
    () => getGroupDescendantBoards(groupId).then((bs) => bs.filter((b) => !directBoardIdsRef.current.has(b.id))),
    { onError: handleGroupReadError, onSettled: () => setLoadingSubgroupBoards(false) },
  ), [readSubgroupBoards, groupId, handleGroupReadError]);
  // Refetch every list on this page whose rows carry an inherited health
  // status (#1133): subgroups, direct boards, and subgroup boards when shown.
  const refreshHealthListings = useCallback(() => {
    refetchSubgroups();
    refetchBoardsList();
    if (showSubgroupBoardsRef.current) refetchSubgroupBoards();
  }, [refetchSubgroups, refetchBoardsList, refetchSubgroupBoards]);

  const handleGroupEvent = useCallback((evt: BoardEvent) => {
    const data = evt.data as { id?: number; board_id?: number; board_uid?: string } & Record<string, unknown>;
    if (evt.event === "board.created") {
      // is_starred is the creator's value (#1559); this subscriber has not starred it.
      const incoming = neutralizePerUserBoardFields(data as unknown as BoardEventPayload);
      if (typeof incoming.id !== "number") return;
      writeBoards(addBoardRow(incoming));
      flagAnimate(incoming.id);
    } else if (evt.event === "board.updated") {
      // is_starred is the acting user's value (#1559); keep the local one.
      const incoming = stripPerUserBoardFields(data as unknown as BoardEventPayload) as Partial<Board> & { id: number };
      if (typeof incoming.id !== "number") return;
      writeBoards(patchBoardRow(incoming));
    } else if (evt.event === "board.deleted") {
      // board_uid is the canonical key on delete (always present); the legacy
      // integer board_id only appears on move-out. Evict on EITHER match so an
      // outright delete (uid-only payload) removes the row, while a move-out
      // (uid + legacy id) stays covered too (#998).
      const uid = typeof data.board_uid === "string" ? data.board_uid : undefined;
      const id = typeof data.id === "number"
        ? data.id
        : (typeof data.board_id === "number" ? data.board_id : undefined);
      if (uid === undefined && id === undefined) return;
      captureFocusedBoardId();
      const matches = (b: Board) =>
        (uid !== undefined && b.uid === uid) || (id !== undefined && b.id === id);
      writeBoards(removeBoardRows(matches));
      writeSubgroupBoards((prev) => prev.filter((b) => !matches(b)));
    } else if (evt.event === "group.updated") {
      // Ownership transfer — refetch the group to get the updated owner object.
      refetchGroup();
      // A health status change (#1133) also changes what the subgroups and
      // boards listed here inherit; their effective values come from the server.
      refreshHealthListings();
    } else if (evt.event === "group.created") {
      // A subgroup was created under this group (the parent channel also
      // receives this event). Refetch the subgroup list so it appears live.
      refetchSubgroups();
    } else if (evt.event === "group.deleted") {
      // This group itself was deleted by someone else: re-read it so the 404
      // swaps in the "isn't available" page (#2041). The deleter's own session
      // navigates away in handleDeleteGroup, so it skips this to avoid a flash.
      if (data.id === groupId) {
        if (!selfDeletingRef.current) refetchForAccess();
      } else if (typeof data.id === "number") {
        // A direct subgroup was deleted — drop it from the subgroup list.
        const deletedId = data.id;
        writeSubgroups((prev) => prev.filter((g) => g.id !== deletedId));
        // "Show subgroup boards" lists the deleted subtree's boards too (#1742).
        if (showSubgroupBoardsRef.current) refetchSubgroupBoards();
      }
    } else if (
      evt.event === "member.added" ||
      evt.event === "member.updated" ||
      evt.event === "member.removed"
    ) {
      // Refetch the members list rather than splicing the payload: the list
      // includes inherited rows and nearest-ancestor dedup, so a full refetch
      // is the only way to keep direct/inherited precedence correct (#998).
      // member.removed is emitted on the group channel when an admin removes a
      // member, so the panel converges in real time for other admins (#1051).
      refetchMembers();
    } else if (evt.event === "invite_link.revoked" || evt.event === "invite_link.created") {
      // invite_link.created ({id}) is emitted when another admin emails an
      // invite (#731); like revoked, it only needs the panel to refetch.
      // An admin revoked an invite link in another session — bump the reload
      // signal so the InviteLinkPanel (which owns its own link state) refetches
      // and drops the link to revoked without a manual reload (#1051).
      setInviteReloadKey((k) => k + 1);
    } else if (
      evt.event === "group.label.created" ||
      evt.event === "group.label.updated" ||
      evt.event === "group.label.deleted"
    ) {
      // Group shared labels live on the group object — refetch it to converge,
      // matching the group.updated pattern above.
      refetchGroup();
    } else if (evt.event === "board.star_changed") {
      // Star is per-user state (#952); ignore events for other users so a
      // colleague starring a board on the same group page does not flip our
      // star indicator.  The boards list is patched in place to avoid a
      // refetch on every star toggle.
      const payload = data as { uid?: string; user_id?: number; is_starred?: boolean };
      if (typeof payload.user_id === "number" && payload.user_id === user.id && typeof payload.uid === "string") {
        const targetUid = payload.uid;
        const nextStarred = !!payload.is_starred;
        writeBoards((prev) => prev.map((b) => (b.uid === targetUid ? { ...b, is_starred: nextStarred } : b)));
        writeSubgroupBoards((prev) => prev.map((b) => (b.uid === targetUid ? { ...b, is_starred: nextStarred } : b)));
      }
    } else if (evt.event === "group.star_changed") {
      // Mirror board.star_changed pattern — only apply the event for the current user.
      const payload = data as { id?: number; user_id?: number; is_starred?: boolean };
      if (typeof payload.user_id === "number" && payload.user_id === user.id && payload.id === groupId) {
        setIsStarred(!!payload.is_starred);
      }
    }
  }, [captureFocusedBoardId, flagAnimate, groupId, user.id, refreshHealthListings, refetchForAccess, writeBoards, writeSubgroups, writeSubgroupBoards, refetchGroup, refetchSubgroups, refetchMembers, refetchSubgroupBoards, setIsStarred]);

  // Events fired while the socket was disconnected are not replayed. Re-read
  // everything the page shows that a frame can change after a reconnect so the
  // UI converges with server state (#2136): the group (owner, labels, defaults),
  // subgroups, members, boards, and the subgroup boards when shown. Frames
  // applied while a re-read is in flight are replayed over its answer.
  const handleReconnected = useCallback(() => {
    refetchGroup();
    refetchSubgroups();
    refetchMembers();
    refetchBoardsList();
    if (showSubgroupBoardsRef.current) refetchSubgroupBoards();
  }, [refetchGroup, refetchSubgroups, refetchMembers, refetchBoardsList, refetchSubgroupBoards]);

  // First open (#2088): the socket joins the group's broadcast group only during
  // its handshake, after the lists loaded, so a frame committed in between is in
  // neither. Reuses handleReconnected when that gap was long enough to have lost
  // frames (a slow handshake, or a first connect that failed and retried); a
  // prompt open does not re-read, so every group open does not pay twice. An
  // unknown load time (load still in flight) counts as a long gap.
  //
  // It re-reads what a reconnect does (#2136); frames applied while a re-read is
  // in flight are replayed over its answer (#2139; see refetchBoardsList).
  const handleFirstConnected = useCallback(() => {
    const loadedAt = loadedAtRef.current;
    if (loadedAt === null || Date.now() - loadedAt > FIRST_OPEN_RESYNC_MS) handleReconnected();
  }, [handleReconnected]);

  const onServerClose = useCallback(() => {
    if (!selfDeletingRef.current) refetchForAccess();
  }, [refetchForAccess]);

  const { status: socketStatus, lastEventAt: socketLastEventAt, reconnectAttempt: socketReconnectAttempt } = useGroupSocket(
    Number.isFinite(groupId) ? groupId : null,
    handleGroupEvent,
    { onReconnected: handleReconnected, onFirstConnected: handleFirstConnected, onServerClose },
  );

  // Access loss reaches the client as a 4001/4003 close (status "failed") or,
  // for a direct member removal, a server-sent 1000 (onServerClose). Find out
  // whether the group is still reachable (#2041), unless this session is
  // deleting the group itself.
  useEffect(() => {
    if (socketStatus === "failed" && !selfDeletingRef.current) refetchForAccess();
  }, [socketStatus, refetchForAccess]);

  // After a list mutation, if the previously focused board still exists, restore
  // focus to its row; otherwise focus the "+ New board" affordance (admins) or
  // the first board row. Keyboard navigation stays on the list even when a
  // remote delete removes the focused row.
  useEffect(() => {
    const pending = pendingRefocusRef.current;
    if (pending === null) return;
    pendingRefocusRef.current = null;
    const root = rootRef.current;
    if (!root) return;
    const existing = boards.find((b) => b.id === pending);
    if (existing) {
      root
        .querySelector<HTMLElement>(`[data-board-id="${pending}"]`)
        ?.focus({ preventScroll: true });
    } else {
      const firstBoard = boards[0];
      if (firstBoard) {
        root
          .querySelector<HTMLElement>(`[data-board-id="${firstBoard.id}"]`)
          ?.focus({ preventScroll: true });
      } else {
        // The last board went: the Boards section is the stable anchor.
        root.querySelector<HTMLElement>("#group-boards-section")?.focus({ preventScroll: true });
      }
    }
  }, [boards]);

  useEffect(() => { showSubgroupBoardsRef.current = showSubgroupBoards; }, [showSubgroupBoards]);
  useEffect(() => { directBoardIdsRef.current = new Set(boards.map((b) => b.id)); }, [boards]);

  useEffect(() => {
    // A single request for all boards in the group subtree avoids the previous N+1
    // pattern (one getGroupBoards call per direct subgroup) and correctly surfaces
    // boards in groups nested 3+ levels deep.
    if (!showSubgroupBoards) return;
    setLoadingSubgroupBoards(true);
    // This is a load, like the initial one (#2150): it yields only to a re-read
    // that applied, and carries the frames recorded meanwhile over its own answer,
    // so a re-read that supersedes it and then fails does not discard it (#2136).
    resetSubgroupBoards(true);
    let stale = false;
    // Exclude boards already shown in the direct boards list; the descendant
    // endpoint returns boards from the root group too.
    getGroupDescendantBoards(groupId)
      .then((bs) => {
        if (stale) return;
        const directIds = new Set(boards.map((b) => b.id));
        applyLoadSubgroupBoards(bs.filter((b) => !directIds.has(b.id)));
      })
      .catch(() => { if (!stale) applyLoadSubgroupBoards([]); })
      .finally(() => { if (!stale) setLoadingSubgroupBoards(false); });
    return () => { stale = true; };
  // boards is intentionally not listed here — we only want to re-fetch when the
  // toggle turns on or the group changes, not on every boards state update.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- boards intentionally excluded, see comment above
  }, [showSubgroupBoards, groupId, resetSubgroupBoards, applyLoadSubgroupBoards]);

  const handleStarToggle = async () => {
    if (starLoading) return;
    const prev = isStarred;
    setIsStarred(!prev);
    setStarLoading(true);
    try {
      if (prev) {
        await unstarGroup(groupId);
      } else {
        await starGroup(groupId);
      }
      onStarToggled?.();
    } catch {
      setIsStarred(prev);
    } finally {
      setStarLoading(false);
    }
  };

  const handleRenameStart = () => {
    if (!group) return;
    setRenameValue(group.name);
    setRenameError(null);
    setRenaming(true);
  };

  // Focus returns to the name button on Escape and committed Enter (#2170); a
  // blur-commit never steals focus back from wherever the user went.
  const renameTriggerRef = useRef<HTMLButtonElement>(null);
  const focusRenameTriggerRef = useRef(false);
  useEffect(() => {
    if (!renaming && focusRenameTriggerRef.current) {
      focusRenameTriggerRef.current = false;
      renameTriggerRef.current?.focus();
    }
  }, [renaming]);

  const handleRenameCancel = () => {
    focusRenameTriggerRef.current = true;
    setRenaming(false);
    setRenameError(null);
  };

  const handleRenameSave = async (restoreFocus = false) => {
    if (!group) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenameError("Group name cannot be empty.");
      return;
    }
    // Set only once the editor is certain to close: an empty-name Enter keeps it open.
    if (restoreFocus) focusRenameTriggerRef.current = true;
    if (trimmed === group.name) {
      setRenaming(false);
      return;
    }
    const prev = group.name;
    writeGroup((g) => (g ? { ...g, name: trimmed } : g));
    setRenaming(false);
    setRenameError(null);
    try {
      await updateGroup(groupId, { name: trimmed });
      shellAddGroup({ ...group, name: trimmed });
    } catch {
      writeGroup((g) => (g ? { ...g, name: prev } : g));
      setRenameError("Failed to rename group. Please try again.");
    }
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // void: handleRenameSave manages its own try/catch and reverts optimistic
    // state on failure, so there is nothing further to await here.
    if (e.key === "Enter" && !isImeComposing(e)) { e.preventDefault(); void handleRenameSave(true); }
    // Escape is handled by the priority-40 useEscapeStack entry (#2170).
  };

  const handleDescriptionStart = () => {
    if (!group) return;
    setDescriptionValue(group.description);
    setDescriptionError(null);
    setEditingDescription(true);
  };

  // Escape returns focus to the description button (#2170); Enter inserts a
  // newline and a blur-commit never steals focus back from where the user went.
  const descriptionTriggerRef = useRef<HTMLButtonElement>(null);
  const focusDescriptionTriggerRef = useRef(false);
  useEffect(() => {
    if (!editingDescription && focusDescriptionTriggerRef.current) {
      focusDescriptionTriggerRef.current = false;
      descriptionTriggerRef.current?.focus();
    }
  }, [editingDescription]);

  const handleDescriptionCancel = () => {
    focusDescriptionTriggerRef.current = true;
    setEditingDescription(false);
    setDescriptionError(null);
  };

  const handleDescriptionSave = async () => {
    if (!group) return;
    const trimmed = descriptionValue.trimEnd();
    if (trimmed === group.description) {
      setEditingDescription(false);
      return;
    }
    const prev = group.description;
    writeGroup((g) => (g ? { ...g, description: trimmed } : g));
    setEditingDescription(false);
    setDescriptionError(null);
    try {
      await updateGroup(groupId, { description: trimmed });
    } catch {
      writeGroup((g) => (g ? { ...g, description: prev } : g));
      setDescriptionError("Failed to save description. Please try again.");
    }
  };

  const handleCreateBoard = async (name: string, template: string, swimlaneName: string, _setAsDefault: boolean) => {
    const board = await createGroupBoard(groupId, { name, template, swimlane_name: swimlaneName });
    // Through writeBoards, like a frame: a re-read in flight may predate the create (#2139).
    writeBoards(addBoardRow(board));
    shellAddBoard(board);
    setCreatingBoard(false);
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // the board was already created and there is nothing to roll back.
    void navigate(`/boards/${board.id}`);
  };

  const handleImportBoard = async (file: File, name?: string, options?: ImportOptions, meta?: ImportMeta) => {
    const board = options ? await importBoard(file, name, groupId, options) : await importBoard(file, name, groupId);
    shellAddBoard(board);
    setImportingBoard(false);
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // the board was already imported and there is nothing to roll back.
    // A selective import that left something out hands its summary to the
    // board page, which shows the skipped counts (#119) and any CSV import
    // warnings (#1526).
    const importSummary = meta?.sample ? forSampleImport(board.import_summary) : board.import_summary;
    if (hasImportSkips(importSummary)) {
      void navigate(`/boards/${board.id}`, { state: { importSummary } });
    } else {
      void navigate(`/boards/${board.id}`);
    }
  };

  // The server refuses owner / last-admin changes with a 400 whose `detail`
  // says why; show that instead of a generic message. Network errors and 5xx
  // carry no usable detail, so they fall back to the generic text.
  const memberErrorMessage = (err: unknown, fallback: string): string => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    return typeof detail === "string" && detail.trim() !== "" ? detail : fallback;
  };

  const handleRemoveMember = async (userId: number) => {
    // The prompt closes on Confirm, so the trigger is back while the DELETE is
    // pending; a second Confirm must not send a second DELETE.
    if (removingMemberIds.current.has(userId)) return;
    removingMemberIds.current.add(userId);
    setConfirmRemoveMemberId(null);
    setMemberError(null);
    try {
      await removeGroupMember(groupId, userId);
      // Local state only changes after the server confirms, so a failure leaves
      // the member listed and there is nothing to roll back.
      writeMembers((prev) => prev.filter((m) => m.user.id !== userId));
      // The row that held the confirm is gone: focus goes to the section heading, not <body>.
      sectionHeadingRef.current?.focus();
    } catch (err: unknown) {
      setMemberError(memberErrorMessage(err, "Failed to remove member. Please try again."));
    } finally {
      removingMemberIds.current.delete(userId);
    }
  };

  const handleRoleChange = async (userId: number, role: "admin" | "member" | "collaborator" | "viewer") => {
    setMemberError(null);
    try {
      const updated = await updateGroupMemberRole(groupId, userId, role);
      writeMembers((prev) => prev.map((m) => m.user.id === userId ? { ...m, role: updated.role } : m));
    } catch (err: unknown) {
      // The role selector is driven by the stored role, so it snaps back to the
      // previous value on its own; only the error needs surfacing.
      setMemberError(memberErrorMessage(err, "Failed to change member role. Please try again."));
    }
  };

  const handleDeleteGroup = async () => {
    setConfirmDeleteGroup(false);
    setDeleteError(null);
    selfDeletingRef.current = true;
    try {
      await deleteGroup(groupId);
    } catch {
      selfDeletingRef.current = false;
      // Nothing local changed before the call, so only the error needs surfacing.
      setDeleteError("Failed to delete group. Please try again.");
      return;
    }
    shellRemoveGroup(groupId);
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // the group was already deleted and there is nothing to roll back.
    void navigate("/");
  };

  const handleDeleteBoard = async (boardId: number) => {
    setConfirmDeleteBoardId(null);
    setDeleteBoardInput("");
    setBoardActionError(null);
    // pendingRefocusRef was set when the ⋯ menu item was chosen (the row's button is the anchor).
    try {
      await deleteBoard(boardId);
    } catch {
      pendingRefocusRef.current = null;
      setBoardActionError("Failed to delete the board. Please try again.");
      rootRef.current?.querySelector<HTMLElement>(`[data-board-id="${boardId}"]`)?.focus({ preventScroll: true });
      return;
    }
    // Through writeBoards, like the board.deleted frame it also produces (#2139).
    writeBoards(removeBoardRows((b) => b.id === boardId));
    writeSubgroupBoards((prev) => prev.filter((b) => b.id !== boardId));
    shellRemoveBoard(boardId);
  };

  const handleTransferOwnership = async () => {
    if (!group || transferNewOwnerId === "" || transferring) return;
    setTransferError(null);
    setTransferring(true);
    try {
      const updated = await transferGroupOwnership(groupId, transferNewOwnerId, transferConfirmation);
      // Only the owner changes, so a replay over a newer answer cannot revert other fields.
      writeGroup((prev) => (prev ? { ...prev, owner: updated.owner } : prev));
      // The owner now is someone else, so the opener button is gone: land on the section heading.
      setShowTransfer(false);
      setTransferNewOwnerId("");
      setTransferConfirmation("");
      sectionHeadingRef.current?.focus();
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setTransferError(detail ?? "Transfer failed. Please try again.");
    } finally {
      setTransferring(false);
    }
  };

  const handleAddGroupLabel = async () => {
    if (!newLabelName.trim() || addingLabel) return;
    setLabelError(null);
    setAddingLabel(true);
    try {
      const label = await createGroupLabel(groupId, { name: newLabelName.trim(), color: newLabelColor });
      writeGroup((prev) => prev ? { ...prev, shared_labels: prev.shared_labels.some((l) => l.id === label.id) ? prev.shared_labels : [...prev.shared_labels, label] } : prev);
      setNewLabelName("");
      setNewLabelColor(DEFAULT_LABEL_COLOR);
      labelInputRef.current?.focus();
    } catch {
      setLabelError("Failed to add label. The name may already exist.");
    } finally {
      setAddingLabel(false);
    }
  };

  const handleDeleteGroupLabel = async (labelId: number) => {
    if (removingLabelIds.current.has(labelId)) return;
    removingLabelIds.current.add(labelId);
    setConfirmRemoveLabelId(null);
    setLabelError(null);
    try {
      await deleteGroupLabel(groupId, labelId);
      writeGroup((prev) => prev ? { ...prev, shared_labels: prev.shared_labels.filter((l) => l.id !== labelId) } : prev);
      sectionHeadingRef.current?.focus();
    } catch {
      setLabelError("Failed to remove label. Please try again.");
    } finally {
      removingLabelIds.current.delete(labelId);
    }
  };

  const handleDefaultRoleChange = async (role: "admin" | "member" | "collaborator" | "viewer") => {
    if (!group || savingDefaults) return;
    setDefaultsError(null);
    setSavingDefaults(true);
    try {
      const updated = await updateGroupBoardDefaults(groupId, { default_board_member_role: role });
      writeGroup((prev) => prev ? { ...prev, default_board_member_role: updated.default_board_member_role } : prev);
      setDefaultsSaved(true);
      if (defaultsSavedTimerRef.current !== null) {
        clearTimeout(defaultsSavedTimerRef.current);
      }
      defaultsSavedTimerRef.current = setTimeout(() => {
        setDefaultsSaved(false);
        defaultsSavedTimerRef.current = null;
      }, 2000);
    } catch {
      setDefaultsError("Failed to save default member role.");
    } finally {
      setSavingDefaults(false);
    }
  };

  // Health status (#1133). Not optimistic: the response carries the effective
  // value and its source, which only the server resolves. Children inherit
  // the new value, so their lists are refetched too.
  // Save and Confirm both use the explicit POST health-status/ action (#2242).
  const handleHealthSave = useCallback(async (next: HealthStatus | null, note?: string | null) => {
    const updated = await setGroupHealthStatus(groupId, { status: next, note: note ?? null });
    writeGroup((prev) => prev ? {
      ...prev,
      health_status: updated.health_status,
      effective_health_status: updated.effective_health_status,
      health_status_source: updated.health_status_source,
      health_status_changed_at: updated.health_status_changed_at,
      health_status_changed_by: updated.health_status_changed_by,
      health_status_note: updated.health_status_note,
      health_review_days: updated.health_review_days,
      health_review_due_at: updated.health_review_due_at,
    } : prev);
    // Also refetched by this save's own group.updated event; done here as
    // well so the actor's page converges even when the socket is down.
    refreshHealthListings();
    return updated;
  }, [groupId, refreshHealthListings, writeGroup]);

  // #2244: "Review status every N days". Not optimistic: the server resolves
  // health_review_due_at, and the subgroups and boards that inherit this
  // group's status get a new due time too, so the listings are refetched.
  const handleHealthReviewDaysSave = useCallback(async (next: number | null) => {
    const updated = await updateGroup(groupId, { health_review_days: next });
    writeGroup((prev) => prev ? {
      ...prev,
      health_review_days: updated.health_review_days,
      health_review_due_at: updated.health_review_due_at,
    } : prev);
    refreshHealthListings();
  }, [groupId, writeGroup, refreshHealthListings]);
  const fetchGroupHealthHistory = useCallback(() => getGroupHealthHistory(groupId), [groupId]);

  const adminMembers = members.filter(
    (m) => m.role === "admin" && m.user.id !== user.id
  );

  const isAdmin = user.is_site_admin ||
    group?.owner.id === user.id ||
    members.find((m) => m.user.id === user.id)?.role === "admin";

  // Creating or importing a board here is board placement, which the server
  // allows only for a group admin of this group or an ancestor (or a user with
  // access to all content). Follow its answer rather than isAdmin, which looks
  // only at this group's direct roles (#1692).
  const canPlaceBoards = group?.can_place_boards === true;

  // #2324 — `?import=1` (the empty board's Import cards) opens the import dialog
  // once the group has loaded, only for a viewer who may place boards here; the
  // param is then dropped so a refresh or Back does not reopen it. The server
  // enforces placement again on import, so this gate is presentation only.
  const wantsImport = searchParams.get("import") === "1";
  useEffect(() => {
    if (!wantsImport || !group) return;
    if (group.can_place_boards === true) setImportingBoard(true);
    setSearchParams((prev) => { prev.delete("import"); return prev; }, { replace: true });
  }, [wantsImport, group, setSearchParams]);

  // Delete is owner-or-all-content only, narrower than isAdmin (#2129).
  const userCanDeleteGroup = canDeleteGroup({
    ownerId: group?.owner.id,
    userId: user.id,
    hasAllContentAccess: user.can_access_all_content === true,
  });


  // Group settings (#2478) holds what used to be the page's admin-only Settings tab. It keeps the
  // `?tab=settings` deep link; the section is `?section=` (the layout's own `?tab=` would clash).
  const view = isAdmin && searchParams.get("tab") === "settings" ? "settings" : "overview";
  // A view switch unmounts the control that was pressed; the new view's h2 takes focus (#2478).
  const firstViewRef = useRef(true);
  useEffect(() => {
    if (firstViewRef.current) { firstViewRef.current = false; return; }
    viewHeadingRef.current?.focus();
  }, [view]);
  const openSettings = (section?: string) => {
    setSearchParams(section ? { tab: "settings", section } : { tab: "settings" });
  };

  // Build Navbar breadcrumb from the ancestors array when available (full chain);
  // fall back to the single-level parent fields for list-endpoint group objects.
  // A navigation-only ancestor carries only its name, as everywhere else.
  const breadcrumb = group ? [
    ...(group.ancestors
      ? group.ancestors.map((a) => ({ label: a.name, href: `/groups/${a.id}` }))
      : group.parent ? [{ label: group.parent_name ?? "Group", href: `/groups/${group.parent}` }] : []),
    { label: group.name },
  ] : [];

  // The loading and error states keep the shell header (breadcrumb h1, search,
  // notifications, account menu) so the page never loses its navigation (#2473).
  const placeholderBreadcrumb = [{ label: "Group" }];

  if (loading) {
    return (
      <div className="h-full bg-sunken flex flex-col">
        <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} breadcrumb={placeholderBreadcrumb} />
        <main className="flex-1 flex items-center justify-center">
          <Spinner size="lg" />
        </main>
      </div>
    );
  }

  if (unavailable) {
    return <UnavailablePage kind="group" user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />;
  }

  if (error || !group) {
    return (
      <div className="h-full bg-sunken flex flex-col">
        <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} breadcrumb={placeholderBreadcrumb} />
        <main className="flex-1 flex flex-col items-center justify-center gap-3">
          <span className="text-fg-tertiary">{error ?? "Group not found"}</span>
          <button onClick={() => navigate("/")} className="text-sm text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded px-2 py-1 transition">
            Back to Home
          </button>
        </main>
      </div>
    );
  }

  const memberName = (m: GroupMembership) => m.user.display_name || m.user.username;
  const groupIcon = (
    <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-fg-tertiary shrink-0" viewBox="0 0 20 20" fill="currentColor">
      <path d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  );

  // ----- Overview ---------------------------------------------------------------------------

  const starButton = (
    <button
      type="button"
      onClick={handleStarToggle}
      aria-disabled={starLoading || undefined}
      className={`h-9 w-9 max-sm:h-11 max-sm:w-11 inline-flex items-center justify-center text-lg transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${isStarred ? "text-warning hover:text-warning" : "text-fg-muted hover:text-warning"}`}
      title={isStarred ? "Unstar group" : "Star group"}
      aria-label={isStarred ? "Unstar group" : "Star group"}
    >
      {isStarred ? "★" : "☆"}
    </button>
  );

  // Phone: the header actions fold into one menu (New board, Import, Invite, Group settings).
  const phoneItems = [
    ...(canPlaceBoards ? [
      { id: "new-board", label: "New board", onSelect: () => setCreatingBoard(true) },
      { id: "import", label: "Import", onSelect: () => setImportingBoard(true) },
    ] : []),
    ...(isAdmin ? [
      { id: "invite", label: "Invite", onSelect: () => openSettings("invite-links") },
      { id: "group-settings", label: "Group settings", onSelect: () => openSettings() },
    ] : []),
  ];

  const statusSetLine = group.health_status !== null && group.health_status !== undefined
    ? healthSetLine(group.health_status_changed_at ?? null, group.health_status_changed_by ?? null)
    : "";
  const statusMeta = statusSetLine ? `Status ${statusSetLine.charAt(0).toLowerCase()}${statusSetLine.slice(1)}` : "";

  const nameNode = isAdmin && renaming ? (
    <input
      autoFocus
      aria-label="Group name"
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onKeyDown={handleRenameKeyDown}
      onBlur={() => { void handleRenameSave(); }}
      className="text-fg text-2xl font-semibold w-full bg-transparent border border-primary-emphasis rounded px-1 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
    />
  ) : isAdmin ? (
    // Button inside the heading keeps heading semantics and gives keyboard users Tab + Enter/Space rename (#1376).
    <button
      ref={renameTriggerRef}
      type="button"
      onClick={handleRenameStart}
      className="font-semibold text-left cursor-text border border-transparent hover:border-line-emphasis rounded px-1 -mx-1 -my-px max-sm:min-h-11 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
    >
      {group.name}
    </button>
  ) : group.name;

  const overviewHeading = (
    <div>
      <PageHeading
        headingRef={viewHeadingRef}
        title={<span className="inline-flex items-center gap-2 min-w-0">{groupIcon}{nameNode}</span>}
        accessory={
          <>
            {/* Mouse-only shortcut: the name button is the single keyboard tab stop (#1376). */}
            {isAdmin && !renaming && (
              <button
                type="button"
                tabIndex={-1}
                onClick={handleRenameStart}
                className="h-9 w-9 inline-flex items-center justify-center text-fg-muted hover:text-fg-secondary text-sm rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis max-sm:hidden"
                title="Rename group"
                aria-label="Rename group"
              >
                ✎
              </button>
            )}
            {/* Health is withheld for a navigation-only group (#1681, #1133). */}
            {!group.navigation_only && (
              <HealthStatusControl
                entityKind="group"
                entityName={group.name}
                parentName={group.parent_name}
                canEdit={isAdmin}
                showCaption
                health_status={group.health_status}
                effective_health_status={group.effective_health_status}
                health_status_source={group.health_status_source}
                health_status_changed_at={group.health_status_changed_at}
                health_status_changed_by={group.health_status_changed_by}
                health_status_note={group.health_status_note}
                health_review_due_at={group.health_review_due_at}
                onSave={handleHealthSave}
                onConfirm={handleHealthSave}
                fetchHistory={fetchGroupHealthHistory}
                datePrefs={user}
              />
            )}
            {starButton}
          </>
        }
        actions={
          <>
            {isAdmin && (
              <div className="flex items-center gap-2 max-sm:hidden">
                <Button variant="secondary" onClick={() => openSettings("invite-links")}>Invite</Button>
                <Button variant="secondary" onClick={() => openSettings()}>Group settings</Button>
              </div>
            )}
            {phoneItems.length > 0 && (
              <div className="sm:hidden">
                <OverflowMenu
                  ariaLabel="Group actions"
                  triggerClassName="shrink-0 h-11 w-11 inline-flex items-center justify-center rounded text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  items={phoneItems}
                />
              </div>
            )}
          </>
        }
      />
      <p role="status" aria-live="polite" aria-atomic="true" className="text-xs text-danger min-h-4 mt-0.5" data-testid="group-rename-error">
        {renameError}
      </p>

      {/* Group description — inline editable for admins */}
      <div className="mt-1 group/description max-w-3xl">
        {editingDescription ? (
          <textarea
            autoFocus
            rows={3}
            aria-label="Group description"
            value={descriptionValue}
            onChange={(e) => setDescriptionValue(e.target.value)}
            onBlur={handleDescriptionSave}
            className="w-full bg-surface border border-primary-soft rounded px-2 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent resize-none placeholder-fg-muted"
            placeholder="Add a description…"
          />
        ) : isAdmin ? (
          <div className="relative">
            {/* Text region is a real button (Tab + Enter/Space) rather than a click handler on a div (#1376). */}
            <button
              type="button"
              ref={descriptionTriggerRef}
              onClick={handleDescriptionStart}
              className="block w-[calc(100%+1rem)] pr-8 max-sm:min-h-11 text-left cursor-text border border-transparent hover:border-line-emphasis rounded px-2 py-1.5 -mx-2 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              {group.description ? (
                <span className="block text-sm text-fg-secondary whitespace-pre-wrap">{group.description}</span>
              ) : (
                <span className="block text-sm text-fg-muted">Add a description…</span>
              )}
            </button>
            {/* Overlay pencil: mouse-only shortcut, adds no height; the text button is the single tab stop (#1376). */}
            <button
              type="button"
              tabIndex={-1}
              onClick={handleDescriptionStart}
              className="absolute top-1 right-1 opacity-0 group-hover/description:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 text-fg-muted hover:text-fg-secondary transition-opacity text-xs focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
              title="Edit description"
              aria-label="Edit description"
            >
              ✎
            </button>
          </div>
        ) : group.description ? (
          <p className="text-sm text-fg-secondary whitespace-pre-wrap px-2 py-1.5 -mx-2">{group.description}</p>
        ) : null}
        <p role="status" aria-live="polite" aria-atomic="true" className="text-xs min-h-4 text-danger">{descriptionError}</p>
      </div>

      {/* Counts are withheld for a navigation-only group (#1681). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-secondary">
        {!group.navigation_only && (
          <span>
            {group.member_count} member{group.member_count !== 1 ? "s" : ""}
            {" · "}
            {group.board_count} board{group.board_count !== 1 ? "s" : ""}
            {group.subgroup_count > 0 && ` · ${group.subgroup_count} subgroup${group.subgroup_count !== 1 ? "s" : ""}`}
          </span>
        )}
        {/* "Status set <time> by <name>" (#2242). Only for a status set on this group: an inherited
            one is attributed to its source group in the control's caption. */}
        {!group.navigation_only && statusMeta && (
          <span data-testid="group-status-set-line">{statusMeta}</span>
        )}
        <ConnectionStatus
          status={socketStatus}
          lastEventAt={socketLastEventAt}
          reconnectAttempt={socketReconnectAttempt}
        />
      </div>
    </div>
  );

  const boardIcon = (
    <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-fg-tertiary shrink-0" viewBox="0 0 20 20" fill="currentColor">
      <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
    </svg>
  );

  const renderBoardRow = (b: Board) => {
    // Move is the group admin's; Delete is the owner's or an all-content user's, as on Home (#2034).
    // The menu shows when either applies (#2478).
    const canDeleteThis = canDeleteBoard({ ownerId: b.owner?.id, userId: user.id, hasAllContentAccess: user.can_access_all_content === true });
    const items = [
      ...(isAdmin ? [{ id: "move", label: "Move to another group", onSelect: () => setMovingBoard(b) }] : []),
      ...(canDeleteThis
        ? [{ id: "delete", label: "Delete", danger: true, separatorBefore: true, onSelect: () => { pendingRefocusRef.current = b.id; setConfirmDeleteBoardId(b.id); setDeleteBoardInput(""); } }]
        : []),
    ];
    return (
      <li
        key={b.id}
        className={animateBoardIds.has(b.id) ? "animate-fade-in motion-reduce:animate-none" : undefined}
      >
        <ListRow>
          <button
            type="button"
            onClick={() => navigate(`/boards/${b.id}`)}
            data-board-id={b.id}
            data-starred={b.is_starred ? "true" : "false"}
            className="flex-1 min-w-0 text-left rounded px-1 py-1 max-sm:min-h-11 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            <span className="flex items-center gap-2 min-w-0">
              {boardIcon}
              <span className="font-medium min-w-0 truncate">{b.name}</span>
            </span>
            {b.description && <span className="block truncate text-xs text-fg-tertiary mt-0.5 ml-6">{b.description}</span>}
          </button>
          <span className="shrink-0 text-xs text-fg-secondary tabular-nums max-sm:hidden">{b.card_count} {b.card_count === 1 ? "card" : "cards"}</span>
          <HealthListingPill fields={b} />
          {(isAdmin || canDeleteThis) && (
            <OverflowMenu
              ariaLabel={`More actions for ${b.name}`}
              triggerClassName="shrink-0 h-9 w-9 max-sm:h-11 max-sm:w-11 inline-flex items-center justify-center rounded text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              items={items}
            />
          )}
        </ListRow>
      </li>
    );
  };

  const boardsSection = group.navigation_only ? null : (
    <section id="group-boards-section" tabIndex={-1} aria-labelledby="group-boards-heading" className="focus:outline-none">
      <div className="flex items-center gap-3 mb-3">
        <CardHeading as="h3" id="group-boards-heading">Boards</CardHeading>
        {subgroups.length > 0 && (
          <label className="ml-auto flex items-center gap-2 cursor-pointer select-none max-sm:min-h-11">
            <span className="text-xs text-fg-secondary">Show subgroup boards</span>
            <Toggle checked={showSubgroupBoards} onChange={setShowSubgroupBoards} />
          </label>
        )}
      </div>
      <p role="status" aria-live="assertive" aria-atomic="true" className="text-danger text-xs min-h-4 mb-1" data-testid="group-board-error">{boardActionError}</p>
      {boards.length === 0 && !showSubgroupBoards ? (
        <p className="rounded-[10px] border border-line bg-canvas px-4 py-8 text-center text-fg-secondary text-sm">No boards yet.</p>
      ) : (
        <ListWell as="ul" label="Boards">
          {boards.map(renderBoardRow)}
          {/* Subgroup boards */}
          {showSubgroupBoards && (
            loadingSubgroupBoards ? (
              <li><Spinner /></li>
            ) : subgroupBoards.length === 0 ? (
              <li className="text-fg-secondary text-sm px-3 py-2">No boards in subgroups.</li>
            ) : (
              subgroupBoards.map((b) => (
                <li key={b.id}>
                  <ListRow>
                    <button
                      type="button"
                      onClick={() => navigate(`/boards/${b.id}`)}
                      className="flex-1 min-w-0 text-left rounded px-1 py-1 max-sm:min-h-11 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        {boardIcon}
                        <span className="font-medium flex-1 min-w-0 truncate">{b.name}</span>
                        <BoardGroupPath
                          ancestors={b.group_detail?.ancestors ?? []}
                          currentGroupId={groupId}
                          directGroupName={b.group_name ?? ""}
                        />
                      </span>
                      {b.description && <span className="block truncate text-xs text-fg-tertiary mt-0.5 ml-6">{b.description}</span>}
                    </button>
                    <HealthListingPill fields={b} />
                  </ListRow>
                </li>
              ))
            )
          )}
        </ListWell>
      )}
    </section>
  );

  const subgroupsSection = (
    <section aria-labelledby="group-subgroups-heading">
      <div className="flex items-center gap-3 mb-3">
        <CardHeading as="h3" id="group-subgroups-heading">Subgroups</CardHeading>
        {isAdmin && (
          <Button variant="quiet" onClick={() => setShowCreateSubgroup(true)}>+ New subgroup</Button>
        )}
      </div>
      {subgroups.length === 0 ? (
        group.navigation_only ? null : <SectionEmptyState
          testId="subgroups-empty"
          icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" viewBox="0 0 20 20" fill="currentColor"><path d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" /></svg>}
          heading="No subgroups yet"
          description="Subgroups let you organize boards and members into nested workspaces."
        />
      ) : (
        <ul className="flex gap-3 overflow-x-auto sm:grid sm:grid-cols-2 sm:overflow-visible">
          {subgroups.map((sg) => {
            // The "Not reviewed in N days" cue (#2244) is part of HealthListingPill; a
            // navigation-only row carries no due date, so it shows none (#1681).
            return (
              <li key={sg.id} className="min-w-[240px] sm:min-w-0">
                <button
                  type="button"
                  onClick={() => navigate(`/groups/${sg.id}`)}
                  className="w-full h-full bg-surface hover:bg-surface-hover border border-line rounded-[10px] p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  <span className="flex items-center gap-2 mb-1">
                    <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-fg-tertiary shrink-0" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                    </svg>
                    <span className="text-fg font-medium min-w-0 truncate">{sg.name}</span>
                    <HealthListingPill fields={sg} className="ml-auto" />
                  </span>
                  {/* Counts are withheld (0) for a navigation-only row (#1681). */}
                  {!sg.navigation_only && (
                    <span className="block text-fg-secondary text-xs">
                      {sg.board_count} board{sg.board_count !== 1 ? "s" : ""} · {sg.member_count} member{sg.member_count !== 1 ? "s" : ""}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  // Members are visible to everyone in the group; managing them is admin-only (#2478).
  // Withheld with the rest of a navigation-only group.
  const membersAside = group.navigation_only ? undefined : (
    <section aria-labelledby="group-members-heading" className="bg-surface border border-line rounded-[10px] p-[18px]" data-testid="group-members-card">
      <div className="flex items-center justify-between gap-2">
        <CardHeading as="h3" id="group-members-heading">Members · {members.length}</CardHeading>
        <div className="flex items-center gap-1">
          {isAdmin && <Button variant="quiet" onClick={() => openSettings("members")}>Manage</Button>}
          <button
            type="button"
            onClick={() => setMembersOpenPhone((v) => !v)}
            aria-expanded={membersOpenPhone}
            aria-controls="group-members-list"
            aria-label={membersOpenPhone ? "Hide members" : "Show members"}
            data-testid="group-members-disclosure"
            className="sm:hidden h-11 w-11 inline-flex items-center justify-center rounded text-fg-secondary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className={`h-4 w-4 transition-transform ${membersOpenPhone ? "rotate-180" : ""}`}>
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </div>
      {members.length === 0 ? (
        <p id="group-members-list" className={`mt-2 text-sm text-fg-secondary ${membersOpenPhone ? "" : "max-sm:hidden"}`}>No members yet.</p>
      ) : (
        <ul id="group-members-list" className={`mt-3 flex flex-col gap-2 ${membersOpenPhone ? "" : "max-sm:hidden"}`}>
          {members.map((m) => (
            <li key={m.user.id} className="flex items-center gap-2 min-w-0">
              <Avatar user={m.user} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{memberName(m)}</span>
              <span className="shrink-0 text-xs bg-surface-hover text-fg-secondary px-1.5 py-0.5 rounded whitespace-nowrap capitalize">
                {m.user.id === group.owner.id ? "Owner" : m.role}
              </span>
              {m.is_inherited && m.inherited_from && (
                <span className="shrink-0 text-xs bg-surface-hover text-fg-secondary px-1.5 py-0.5 rounded whitespace-nowrap">↑ {m.inherited_from}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  // ----- Group settings ---------------------------------------------------------------------

  const sectionHead = (title: string, description: string) => (
    <PageHeading level="h3" title={title} description={description} headingRef={sectionHeadingRef} />
  );

  const membersSection = () => (
    <>
      {sectionHead("Members", "Manage who has access to this group and their roles.")}
      <div>
        <Button variant="secondary" onClick={() => openSettings("invite-links")}>Invite by email</Button>
      </div>
      {/* Always-mounted live slot (#1437, #487): only the text changes, so the error is
          announced and the member list does not shift when it appears. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="text-danger text-xs min-h-4" data-testid="group-member-error">{memberError}</p>
      <ListWell as="ul" label="Group members">
        {members.map((m) => {
          // The server refuses to change or remove a site admin's
          // membership unless the caller is a site admin too, so such a
          // direct row gets no role picker and no Remove for anyone else,
          // as on the board Members panel (#2164). The flag is sent to
          // group admins only, the readers who would see those controls.
          const isLocked = !m.is_inherited && m.is_site_admin === true && !user.is_site_admin && m.user.id !== group.owner.id;
          const canManage = !m.is_inherited && isAdmin && !isLocked && m.user.id !== user.id && m.user.id !== group.owner.id;
          return (
            <li key={m.user.id}>
              <ListRow>
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Avatar user={m.user} size="sm" />
                  <div className="min-w-0">
                    <p className={`text-sm truncate ${m.is_inherited ? "text-fg-secondary" : "text-fg"}`}>{memberName(m)}</p>
                    {!m.is_inherited && m.has_all_content_access === true && GROUP_ROLES.includes(m.role) && (
                      <p className="text-xs text-fg-secondary">{groupRoleNote(m.role)}</p>
                    )}
                    {isLocked && <p className="text-xs text-fg-secondary">{LOCKED_MEMBERSHIP_NOTE}</p>}
                  </div>
                </div>
                {m.is_inherited ? (
                  <div className="flex items-center gap-2 shrink-0">
                    {m.has_all_content_access === true ? (
                      <GroupFullAccessChip userId={m.user.id} role={m.role} describeRole />
                    ) : (
                      <span className="text-xs text-fg-secondary capitalize">{m.role}</span>
                    )}
                    <span className="text-xs bg-surface-hover text-fg-secondary px-1.5 py-0.5 rounded whitespace-nowrap">↑ {m.inherited_from}</span>
                  </div>
                ) : canManage ? (
                  <div className="flex items-center gap-2 shrink-0">
                    {m.has_all_content_access === true && (
                      // All-content access resolves to full access before any
                      // membership is consulted, so the chip states the
                      // effective access. The stored role is kept (#2075).
                      <GroupFullAccessChip userId={m.user.id} role={m.role} />
                    )}
                    {/* An all-content row below admin offers only the roles that have an
                        effect: its stored role (it applies again if the access is revoked)
                        and Admin, which counts toward the admin minimum and ownership
                        transfer (#2165). Admin rows and rows without the flag keep the full picker. */}
                    {(m.has_all_content_access !== true || GROUP_ROLES.includes(m.role)) && (
                      <SelectDropdown
                        value={m.role}
                        onChange={(v) => { void handleRoleChange(m.user.id, v as "admin" | "member" | "collaborator" | "viewer"); }}
                        options={GROUP_ROLE_OPTIONS.filter(
                          (o) => m.has_all_content_access !== true || m.role === "admin" || o.value === "admin" || o.value === m.role,
                        )}
                        ariaLabel={`Group role for ${memberName(m)}`}
                        size="xs"
                      />
                    )}
                    {m.role === "admin" && (
                      <RoleInfoTooltip label="Group Admin info">
                        <p className="text-xs font-semibold text-fg mb-1">Group Admin</p>
                        <p className="text-xs text-fg-tertiary">Group Admin automatically grants board-admin rights on every board in this group. This is the recommended role for team leads.</p>
                      </RoleInfoTooltip>
                    )}
                    {confirmRemoveMemberId !== m.user.id && (
                      <button
                        ref={removeMemberTriggerRef(m.user.id)}
                        onClick={() => setConfirmRemoveMemberId(m.user.id)}
                        aria-label={m.has_all_content_access === true ? `Remove group role for ${memberName(m)}` : `Remove ${memberName(m)} from group`}
                        className="text-fg-secondary hover:text-danger transition text-xs px-1 max-sm:min-h-11 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 shrink-0">
                    {m.has_all_content_access === true ? (
                      <GroupFullAccessChip userId={m.user.id} role={m.role} />
                    ) : (
                      <p className="text-fg-secondary text-xs capitalize" title={isLocked ? LOCKED_MEMBERSHIP_NOTE : undefined}>{m.role}</p>
                    )}
                    {m.user.id === group.owner.id && (
                      <span className="text-xs bg-surface-hover text-fg-secondary px-1.5 py-0.5 rounded whitespace-nowrap">Owner</span>
                    )}
                  </div>
                )}
              </ListRow>
              {canManage && confirmRemoveMemberId === m.user.id && (
                <div className="px-3 pb-2">
                  <InlineConfirm
                    message={m.has_all_content_access === true
                      ? "Remove this group role? Full access is not affected."
                      : <>Remove <span className="font-medium">{memberName(m)}</span> from this group? They lose access to its boards.</>}
                    actionLabel="Remove"
                    onConfirm={() => { void handleRemoveMember(m.user.id); }}
                    onCancel={() => setConfirmRemoveMemberId(null)}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ListWell>
    </>
  );

  const inviteSection = () => (
    <>
      {/* The panel's own "Invite links" h3 is the section heading; restyling the panel to the Site admin invite layout is tracked separately. */}
      <InviteLinkPanel scope={{ kind: "group", id: groupId }} reloadSignal={inviteReloadKey} isSiteAdmin={user.is_site_admin} />
    </>
  );

  const healthSection = () => (
    <>
      {sectionHead("Health status review", "Ask for this group’s health status to be confirmed or changed regularly.")}
      <SettingsCard>
        <HealthReviewDaysInput
          entityKind="group"
          value={group.health_review_days}
          onSave={handleHealthReviewDaysSave}
        />
      </SettingsCard>
    </>
  );

  // "Allowed priorities on new boards" (#1429) is not drawn: it is deprecated and has no effect.
  const defaultsSection = () => (
    <>
      {sectionHead("Board defaults", "Defaults for boards created in this group. Settings marked “Deprecated” are saved but don't take effect.")}
      <SettingsCard>
        <label htmlFor="group-default-member-role" className="text-fg-secondary text-sm font-medium block mb-2">Default member role for new boards</label>
        <div className="flex items-center gap-3">
          <SelectDropdown
            id="group-default-member-role"
            ariaDescribedBy="group-default-member-role-hint"
            value={group.default_board_member_role ?? "member"}
            onChange={(v) => handleDefaultRoleChange(v as "admin" | "member" | "collaborator" | "viewer")}
            options={GROUP_ROLE_OPTIONS}
          />
          {/* Reserved status slot: always mounted so Saved/error does not shift the row. The
              live region is the slot itself (#1437), so "Saved" is announced too. */}
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={`text-xs min-w-[4rem] inline-block ${defaultsError ? "text-danger" : "text-success"}`}
            data-testid="group-defaults-status"
          >
            {defaultsError ?? (defaultsSaved ? "Saved" : "")}
          </span>
        </div>
        {/* #1430: deprecated; stored but never read. Access comes from GroupMembership.role via get_board_role(). Control kept for API compatibility. */}
        <p id="group-default-member-role-hint" className="text-fg-secondary text-xs mt-2">
          Deprecated. This setting has no effect: group members get their group role on every group board.
        </p>
      </SettingsCard>
    </>
  );

  const labelsSection = () => (
    <>
      {sectionHead("Shared labels", "Labels added here are copied to every new board created in this group.")}
      <SettingsCard>
        <ul className="flex flex-col gap-1.5 mb-3" aria-label="Shared labels">
          {(group.shared_labels ?? []).map((label) => (
            <li key={label.id} className="rounded-lg bg-canvas px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className="cf-choice-badge inline-flex items-center text-xs px-2.5 py-1 rounded-full border font-medium"
                  style={colorChipStyle(label.color)}
                >
                  {label.name}
                </span>
                <span className="flex-1" />
                {confirmRemoveLabelId !== label.id && (
                  <button
                    ref={removeLabelTriggerRef(label.id)}
                    onClick={() => setConfirmRemoveLabelId(label.id)}
                    aria-label={`Remove ${label.name} from group`}
                    className="text-fg-secondary hover:text-danger transition text-xs px-1 max-sm:min-h-11 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
                  >
                    Remove
                  </button>
                )}
              </div>
              {confirmRemoveLabelId === label.id && (
                <div className="mt-2">
                  <InlineConfirm
                    message={<>Remove <span className="font-medium">{label.name}</span> from this group? Boards that already copied it keep it.</>}
                    actionLabel="Remove"
                    onConfirm={() => { void handleDeleteGroupLabel(label.id); }}
                    onCancel={() => setConfirmRemoveLabelId(null)}
                  />
                </div>
              )}
            </li>
          ))}
          {(group.shared_labels ?? []).length === 0 && (
            <li className="text-fg-secondary text-sm">No shared labels yet.</li>
          )}
        </ul>
        <div className="flex flex-col gap-2">
          <ColorSwatchPicker
            colors={PALETTE_COLORS}
            value={newLabelColor}
            onChange={setNewLabelColor}
            size="md"
            allowCustom
            groupLabel="Label color"
          />
          <div className="flex items-center gap-2">
            <input
              type="text"
              aria-label="New label name"
              ref={labelInputRef}
              value={newLabelName}
              onChange={(e) => setNewLabelName(e.target.value)}
              // void: handleAddGroupLabel manages its own try/catch and
              // surfaces failures via labelError, nothing further to await here.
              onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e)) void handleAddGroupLabel(); }}
              placeholder="Label name…"
              className="flex-1 h-9 max-sm:h-11 bg-surface border border-line-strong text-fg-secondary text-sm rounded px-3 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
            />
            <Button
              variant="primary"
              onClick={() => { void handleAddGroupLabel(); }}
              aria-disabled={addingLabel || !newLabelName.trim() || undefined}
              className="aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
            >
              New label
            </Button>
          </div>
        </div>
        <p role="status" aria-live="polite" aria-atomic="true" className="text-danger text-xs min-h-4 mt-1" data-testid="group-label-error">{labelError}</p>
      </SettingsCard>
    </>
  );

  const dangerSection = () => (
    <>
      {sectionHead("Danger zone", "These actions are permanent and cannot be undone.")}
      <section aria-label="Danger zone actions" className="border border-danger/40 rounded-[10px] p-[18px] bg-surface">
        <div className="flex flex-wrap gap-3">
          {group.owner.id === user.id && (
            <div className="flex flex-col gap-1">
              <Button
                variant="secondary"
                buttonRef={transferTriggerRef}
                aria-expanded={showTransfer}
                className="text-danger border-danger/40 hover:bg-danger/20 hover:text-danger-on-tint"
                onClick={() => { setTransferError(null); setShowTransfer((v) => !v); }}
              >
                Transfer ownership
              </Button>
              <p className="text-xs text-fg-secondary">The new owner must already be a group admin.</p>
            </div>
          )}
          {userCanDeleteGroup && (
            <Button
              variant="secondary"
              className="text-danger border-danger/40 hover:bg-danger/20 hover:text-danger-on-tint"
              onClick={() => { setDeleteGroupInput(""); setConfirmDeleteGroup(true); }}
            >
              Delete group
            </Button>
          )}
        </div>
        {showTransfer && group.owner.id === user.id && (
          <div role="group" aria-label="Transfer ownership details" className="mt-4 flex flex-col gap-4 max-w-md rounded-[10px] border border-danger/40 bg-danger/10 p-3">
            <p className="text-sm text-fg">
              Transfer ownership of <span className="font-medium">{group.name}</span> to another admin.
              You will remain as an admin after the transfer.
            </p>
            <div>
              <label htmlFor="group-transfer-owner" className="text-sm font-medium text-fg-secondary block mb-1">New owner</label>
              {adminMembers.length === 0 ? (
                <p className="text-fg-secondary text-sm">No other admins found. Promote a member to admin first.</p>
              ) : (
                <SelectDropdown
                  id="group-transfer-owner"
                  ariaLabel="New owner"
                  value={String(transferNewOwnerId)}
                  onChange={(v) => setTransferNewOwnerId(v === "" ? "" : Number(v))}
                  options={[
                    { value: "", label: "Select an admin…" },
                    ...adminMembers.map((m) => ({
                      value: String(m.user.id),
                      label: m.user.display_name || m.user.username,
                    })),
                  ]}
                  className="w-full"
                />
              )}
              <p className="text-fg-secondary text-xs mt-1">The new owner must already be a group admin.</p>
            </div>
            <div>
              <label htmlFor="group-transfer-confirm" className="text-sm font-medium text-fg-secondary block mb-1">
                Type the group name to confirm: <span className="text-fg font-medium">{group.name}</span>
              </label>
              <input
                id="group-transfer-confirm"
                type="text"
                autoComplete="off"
                value={transferConfirmation}
                onChange={(e) => setTransferConfirmation(e.target.value)}
                placeholder={group.name}
                className="w-full h-9 max-sm:h-11 bg-surface border border-line-strong text-fg text-sm rounded px-3 focus:outline-none focus:ring-2 focus:ring-primary-emphasis placeholder-fg-muted"
              />
            </div>
            {/* Reserved error slot: always rendered so an error does not shift the buttons, and the
                alert is the slot itself so the failure is announced (#1437). */}
            <p role="alert" aria-atomic="true" className="text-sm text-danger min-h-5" data-testid="group-transfer-error">
              {transferError}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="quiet" onClick={closeTransfer}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => { void handleTransferOwnership(); }}
                aria-disabled={transferring || transferNewOwnerId === "" || transferConfirmation !== group.name || undefined}
                className="aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
              >
                {transferring ? "Transferring…" : "Transfer ownership"}
              </Button>
            </div>
          </div>
        )}
        {/* Same wording shape as Board Settings' note (#2034): the server
            allows only the owner or all-content access to delete. */}
        {!userCanDeleteGroup && (
          <p className="text-sm text-fg-secondary">
            Only the group owner ({group.owner.display_name || group.owner.username}) or a site administrator can delete this group.
          </p>
        )}
        <p role="status" aria-live="polite" aria-atomic="true" className="text-danger text-xs min-h-4 mt-2" data-testid="group-delete-error">{deleteError}</p>
      </section>
    </>
  );

  const settingsSections: SettingsSection[] = [
    { id: "members", label: "Members", count: members.length, keywords: ["roles", "admin", "remove", "access"], render: membersSection },
    { id: "invite-links", label: "Invite links", keywords: ["invite", "email", "link", "expires"], render: inviteSection },
    { id: "health-review", label: "Health status review", keywords: ["status", "review", "days"], render: healthSection },
    { id: "board-defaults", label: "Board defaults", keywords: ["default", "role", "boards"], render: defaultsSection },
    { id: "shared-labels", label: "Shared labels", keywords: ["labels", "library"], render: labelsSection },
    { id: "danger-zone", label: "Danger zone", keywords: ["delete", "transfer", "ownership"], render: dangerSection },
  ];

  const boardToDelete = confirmDeleteBoardId === null ? undefined : boards.find((b) => b.id === confirmDeleteBoardId);
  const boardHasCards = (boardToDelete?.card_count ?? 0) + (boardToDelete?.archived_card_count ?? 0) > 0;

  return (
    <div ref={rootRef} className="h-full bg-sunken flex flex-col">
      <Navbar
        user={user}
        onLogout={onLogout}
        onUserUpdated={onUserUpdated}
        breadcrumb={breadcrumb}
        primaryAction={view === "overview" && canPlaceBoards ? (
          <div className="flex items-center gap-2 max-sm:hidden">
            <Button variant="secondary" onClick={() => setImportingBoard(true)}>Import</Button>
            <Button variant="primary" onClick={() => setCreatingBoard(true)}>New board</Button>
          </div>
        ) : undefined}
      />

      <main className="flex-1 overflow-y-auto">
        {view === "settings" ? (
          <SettingsLayout
            param="section"
            navLabel="Group settings sections"
            sections={settingsSections}
            title={
              <PageHeading
                headingRef={viewHeadingRef}
                title="Group settings"
                description={`Manage ${group.name}'s members, invites, defaults and labels.`}
                actions={<Button variant="quiet" onClick={() => setSearchParams({})}>Back to group</Button>}
              />
            }
          />
        ) : (
          <OverviewLayout heading={overviewHeading} aside={membersAside}>
            {boardsSection}
            {subgroupsSection}
          </OverviewLayout>
        )}
      </main>

      {creatingBoard && (
        <CreateBoardModal
          onConfirm={handleCreateBoard}
          onCancel={() => setCreatingBoard(false)}
        />
      )}

      {movingBoard && (
        <MoveBoardModal
          board={movingBoard}
          onMoved={(updated) => {
            // Remove from this group's list if moved elsewhere
            if (updated.group !== groupId) {
              writeBoards(removeBoardRows((b) => b.id === updated.id));
            }
            setMovingBoard(null);
          }}
          onClose={() => setMovingBoard(null)}
        />
      )}

      {importingBoard && (
        <ImportBoardModal
          onImport={handleImportBoard}
          onCancel={() => setImportingBoard(false)}
          dateFormat={user.date_format}
          onSwitchToTrello={() => {
            setImportingBoard(false);
            setTrelloImporting(true);
          }}
        />
      )}

      {trelloImporting && group && (
        <TrelloImportModal
          groupId={groupId}
          groupName={group.name}
          onCancel={() => setTrelloImporting(false)}
          onImported={(b) => {
            setTrelloImporting(false);
            shellAddBoard(b);
            // void: navigate() can return a Promise in React Router v7; fire-and-forget,
            // the board was already imported and there is nothing to roll back.
            void navigate(`/boards/${b.id}`);
          }}
        />
      )}

      {showCreateSubgroup && (
        <CreateGroupModal
          parentGroup={group}
          onCreated={(sg) => {
            writeSubgroups((prev) => (prev.some((g) => g.id === sg.id) ? prev : [...prev, sg]));
            shellAddGroup(sg);
          }}
          onClose={() => setShowCreateSubgroup(false)}
        />
      )}

      <ModalWrapper
        open={confirmDeleteBoardId !== null && boardToDelete !== undefined}
        onClose={() => { setConfirmDeleteBoardId(null); setDeleteBoardInput(""); }}
        title="Delete board?"
        maxWidth="max-w-sm"
      >
        <p className="text-fg-tertiary text-sm mb-1">
          <span className="text-fg font-medium">{boardToDelete?.name}</span> and all its data, including archived cards, will be permanently deleted.
        </p>
        <p className="text-danger text-sm mb-4">This cannot be undone.</p>
        {confirmDeleteBoardId !== null && <BoardDeleteImpactNotice boardId={confirmDeleteBoardId} />}
        {boardHasCards && (
          <div className="mb-4">
            <p className="text-fg-tertiary text-xs mb-2">This board has cards. Type the board name to confirm deletion.</p>
            <input
              type="text"
              aria-label="Board name to confirm"
              value={deleteBoardInput}
              onChange={(e) => setDeleteBoardInput(e.target.value)}
              placeholder={`Type "${boardToDelete?.name}" to confirm`}
              className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
              autoFocus
            />
          </div>
        )}
        <div className="flex gap-3 justify-end">
          <Button variant="quiet" onClick={() => { setConfirmDeleteBoardId(null); setDeleteBoardInput(""); }}>Cancel</Button>
          <Button
            variant="danger"
            disabled={boardHasCards && deleteBoardInput !== boardToDelete?.name}
            onClick={() => { if (confirmDeleteBoardId !== null) void handleDeleteBoard(confirmDeleteBoardId); }}
          >
            Delete
          </Button>
        </div>
      </ModalWrapper>

      {/* Delete group confirmation modal */}
      <ModalWrapper
        open={confirmDeleteGroup && group !== null}
        onClose={() => setConfirmDeleteGroup(false)}
        title={`Delete "${group?.name}"?`}
        maxWidth="max-w-sm"
      >
        <p className="text-fg-tertiary text-sm mb-4">This will permanently delete the group and all its boards. This cannot be undone.</p>
        <div className="mb-5">
          <label htmlFor="group-delete-confirm" className="text-fg-tertiary text-sm block mb-1">Type the group&apos;s name to confirm.</label>
          <input
            id="group-delete-confirm"
            type="text"
            autoComplete="off"
            value={deleteGroupInput}
            onChange={(e) => setDeleteGroupInput(e.target.value)}
            placeholder={group?.name}
            className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
          />
        </div>
        <div className="flex gap-3 justify-end">
          <Button variant="quiet" onClick={() => setConfirmDeleteGroup(false)}>Cancel</Button>
          <Button variant="danger" disabled={deleteGroupInput !== group?.name} onClick={() => { void handleDeleteGroup(); }}>Delete group</Button>
        </div>
      </ModalWrapper>
    </div>
  );
}
