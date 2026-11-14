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
import { HealthListingPill } from "../components/Common/HealthStatusPill";
import MoveBoardModal from "../components/Board/MoveBoardModal";
import CreateBoardModal from "../components/Board/CreateBoardModal";
import ImportBoardModal from "../components/Board/ImportBoardModal";
import TrelloImportModal from "../components/Board/TrelloImportModal";
import { importBoard } from "../api/boards";
import type { Board, BoardEventPayload, Group, GroupMembership, HealthStatus, ImportOptions, Priority, User } from "../types";
import { hasImportSkips } from "../utils/importSummary";
import SelectDropdown from "../components/Common/SelectDropdown";
import Spinner from "../components/Common/Spinner";
import RoleInfoTooltip from "../components/Common/RoleInfoTooltip";
import ModalWrapper from "../components/shared/ModalWrapper";
import ColorSwatchPicker from "../components/Common/ColorSwatchPicker";
import { PALETTE_COLORS } from "../constants/colors";
import { isImeComposing } from "../utils/imeComposition";
import { LOCKED_MEMBERSHIP_NOTE } from "../constants/membership";
import ActiveMark from "../components/Common/ActiveMark";

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
    if (showTransferModal) { setShowTransferModal(false); return; }
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

  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferNewOwnerId, setTransferNewOwnerId] = useState<number | "">("");
  const [transferConfirmation, setTransferConfirmation] = useState("");
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);

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
    setCreatingBoard(false);
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // the board was already created and there is nothing to roll back.
    void navigate(`/boards/${board.id}`);
  };

  const handleImportBoard = async (file: File, name?: string, options?: ImportOptions) => {
    const board = options ? await importBoard(file, name, groupId, options) : await importBoard(file, name, groupId);
    setImportingBoard(false);
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // the board was already imported and there is nothing to roll back.
    // A selective import that left something out hands its summary to the
    // board page, which shows the skipped counts (#119) and any CSV import
    // warnings (#1526).
    if (hasImportSkips(board.import_summary)) {
      void navigate(`/boards/${board.id}`, { state: { importSummary: board.import_summary } });
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
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // the group was already deleted and there is nothing to roll back.
    void navigate("/");
  };

  const handleTransferOwnership = async () => {
    if (!group || transferNewOwnerId === "") return;
    setTransferError(null);
    setTransferring(true);
    try {
      const updated = await transferGroupOwnership(groupId, transferNewOwnerId, transferConfirmation);
      // Only the owner changes, so a replay over a newer answer cannot revert other fields.
      writeGroup((prev) => (prev ? { ...prev, owner: updated.owner } : prev));
      setShowTransferModal(false);
      setTransferNewOwnerId("");
      setTransferConfirmation("");
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setTransferError(detail ?? "Transfer failed. Please try again.");
    } finally {
      setTransferring(false);
    }
  };

  const handleAddGroupLabel = async () => {
    if (!newLabelName.trim()) return;
    setLabelError(null);
    setAddingLabel(true);
    try {
      const label = await createGroupLabel(groupId, { name: newLabelName.trim(), color: newLabelColor });
      writeGroup((prev) => prev ? { ...prev, shared_labels: prev.shared_labels.some((l) => l.id === label.id) ? prev.shared_labels : [...prev.shared_labels, label] } : prev);
      setNewLabelName("");
      setNewLabelColor(DEFAULT_LABEL_COLOR);
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
    } catch {
      setLabelError("Failed to remove label. Please try again.");
    } finally {
      removingLabelIds.current.delete(labelId);
    }
  };

  const handleTogglePriority = async (priority: Priority) => {
    // A navigation-only group's empty allowed_priorities is withheld, not "all
    // allowed", so it must not seed a toggle (#1681).
    if (!group || group.navigation_only) return;
    const current = group.allowed_priorities.length > 0 ? group.allowed_priorities : (["low", "medium", "high", "urgent"] as Priority[]);
    const next = current.includes(priority)
      ? current.filter((p) => p !== priority)
      : [...current, priority];
    // Keep at least one priority enabled
    if (next.length === 0) return;
    setDefaultsError(null);
    try {
      const updated = await updateGroupBoardDefaults(groupId, { allowed_priorities: next });
      writeGroup((prev) => prev ? { ...prev, allowed_priorities: updated.allowed_priorities } : prev);
    } catch {
      setDefaultsError("Failed to save allowed priorities.");
    }
  };

  const handleDefaultRoleChange = async (role: "admin" | "member" | "collaborator" | "viewer") => {
    if (!group) return;
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
    } : prev);
    // Also refetched by this save's own group.updated event; done here as
    // well so the actor's page converges even when the socket is down.
    refreshHealthListings();
    return updated;
  }, [groupId, refreshHealthListings, writeGroup]);
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

  // Delete is owner-or-all-content only, narrower than isAdmin (#2129).
  const userCanDeleteGroup = canDeleteGroup({
    ownerId: group?.owner.id,
    userId: user.id,
    hasAllContentAccess: user.can_access_all_content === true,
  });

  const activeTab = isAdmin && searchParams.get("tab") === "settings" ? "settings" : "boards";

  // Build Navbar breadcrumb from the ancestors array when available (full chain);
  // fall back to the single-level parent fields for list-endpoint group objects.
  const breadcrumb = group ? [
    ...(group.ancestors
      ? group.ancestors.map((a) => ({ label: a.name, href: `/groups/${a.id}` }))
      : group.parent ? [{ label: group.parent_name ?? "Group", href: `/groups/${group.parent}` }] : []),
    { label: group.name },
  ] : [];

  if (loading) {
    return (
      <div className="h-full bg-sunken flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (unavailable) {
    return <UnavailablePage kind="group" user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />;
  }

  if (error || !group) {
    return (
      <div className="h-full bg-sunken flex flex-col items-center justify-center gap-3">
        <span className="text-fg-tertiary">{error ?? "Group not found"}</span>
        <button onClick={() => navigate("/")} className="text-sm text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded px-2 py-1 transition">
          Return to dashboard
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="h-full bg-sunken flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} breadcrumb={breadcrumb} />

      <main className="flex-1 overflow-y-auto p-8 max-w-5xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="min-w-0 flex-1 mr-4">
            {/* Ancestor breadcrumb — only when the group has ancestors */}
            {group.ancestors && group.ancestors.length > 0 && (
              <nav aria-label="Group breadcrumb" className="flex flex-wrap items-center mb-1">
                {group.ancestors.map((ancestor, i) => (
                  <span key={ancestor.id} className="flex items-center">
                    {i > 0 && <span className="text-fg-faint mx-1.5 select-none" aria-hidden="true">/</span>}
                    <a
                      href={`/groups/${ancestor.id}`}
                      // void: navigate() can return a Promise in React Router v7; fire-and-forget.
                      onClick={(e) => { e.preventDefault(); void navigate(`/groups/${ancestor.id}`); }}
                      className="text-sm text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded transition max-w-[12rem] truncate"
                      title={ancestor.name}
                    >
                      {ancestor.name}
                    </a>
                  </span>
                ))}
                <span className="text-fg-faint mx-1.5 select-none" aria-hidden="true">/</span>
                <span className="text-sm text-fg-secondary max-w-[12rem] truncate" title={group.name}>{group.name}</span>
              </nav>
            )}

            {/* Group name — inline editable for admins */}
            {isAdmin ? (
              <div className="relative group/rename">
                {renaming ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    onBlur={() => { void handleRenameSave(); }}
                    className="text-fg text-2xl font-bold w-full bg-transparent border border-primary-emphasis rounded px-1 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <h1 className="text-fg text-2xl font-bold">
                      {/* Button inside the heading keeps heading semantics and gives keyboard users Tab + Enter/Space rename (#1376). */}
                      <button
                        ref={renameTriggerRef}
                        type="button"
                        onClick={handleRenameStart}
                        className="font-bold text-left cursor-text border border-transparent hover:border-line-emphasis rounded px-1 -mx-1 -my-px transition-colors focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                      >
                        {group.name}
                      </button>
                    </h1>
                    {/* Mouse-only shortcut: the name button above is the single keyboard tab stop (#1376). */}
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={handleRenameStart}
                      className="opacity-0 group-hover/rename:opacity-100 focus:opacity-100 text-fg-muted hover:text-fg-secondary transition-opacity text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
                      title="Rename group"
                      aria-label="Rename group"
                    >
                      ✎
                    </button>
                  </div>
                )}
                <p className="text-xs min-h-4 mt-0.5 -mx-1 px-1">
                  {renameError && <span role="alert" className="text-danger">{renameError}</span>}
                </p>
              </div>
            ) : (
              <h1 className="text-fg text-2xl font-bold">{group.name}</h1>
            )}

            {/* Group description — inline editable for admins */}
            <div className="mt-1 group/description">
              {editingDescription ? (
                <textarea
                  autoFocus
                  rows={3}
                  value={descriptionValue}
                  onChange={(e) => setDescriptionValue(e.target.value)}
                  onBlur={handleDescriptionSave}
                  className="w-full bg-sunken border border-primary-soft rounded px-2 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent resize-none placeholder-fg-muted"
                  placeholder="Add a description…"
                />
              ) : isAdmin ? (
                <div className="relative">
                  {/* Text region is a real button (Tab + Enter/Space) rather than a click handler on a div (#1376). */}
                  <button
                    type="button"
                    ref={descriptionTriggerRef}
                    onClick={handleDescriptionStart}
                    className="block w-[calc(100%+1rem)] pr-8 text-left cursor-text border border-transparent hover:border-line-emphasis rounded px-2 py-1.5 -mx-2 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    {group.description ? (
                      <span className="block text-sm text-fg-tertiary whitespace-pre-wrap">{group.description}</span>
                    ) : (
                      <span className="block text-sm text-fg-faint">Add a description…</span>
                    )}
                  </button>
                  {/* Overlay pencil: mouse-only shortcut, adds no height; the text button is the single tab stop (#1376). */}
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={handleDescriptionStart}
                    className="absolute top-1 right-1 opacity-0 group-hover/description:opacity-100 focus:opacity-100 text-fg-muted hover:text-fg-secondary transition-opacity text-xs focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
                    title="Edit description"
                    aria-label="Edit description"
                  >
                    ✎
                  </button>
                </div>
              ) : group.description ? (
                <p className="text-sm text-fg-tertiary whitespace-pre-wrap px-2 py-1.5 -mx-2">{group.description}</p>
              ) : null}
              <p className="text-xs h-4">
                {descriptionError && <span className="text-danger">{descriptionError}</span>}
              </p>
            </div>

            {/* Counts and health are withheld for a navigation-only group (#1681, #1133). */}
            {!group.navigation_only && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
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
                  onSave={handleHealthSave}
                  onConfirm={handleHealthSave}
                  fetchHistory={fetchGroupHealthHistory}
                  datePrefs={user}
                />
                <span>
                  {group.member_count} member{group.member_count !== 1 ? "s" : ""}
                  {" · "}
                  {group.board_count} board{group.board_count !== 1 ? "s" : ""}
                  {group.subgroup_count > 0 && ` · ${group.subgroup_count} subgroup${group.subgroup_count !== 1 ? "s" : ""}`}
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <ConnectionStatus
              status={socketStatus}
              lastEventAt={socketLastEventAt}
              reconnectAttempt={socketReconnectAttempt}
            />
            <button
              onClick={handleStarToggle}
              disabled={starLoading}
              className={`text-lg transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${isStarred ? "text-warning hover:text-warning" : "text-fg-muted hover:text-warning"}`}
              title={isStarred ? "Unstar group" : "Star group"}
              aria-label={isStarred ? "Unstar group" : "Star group"}
            >
              {isStarred ? "★" : "☆"}
            </button>
            {isAdmin && (
              <button
                onClick={() => setSearchParams({ tab: "settings" })}
                className="text-sm text-fg-tertiary hover:text-fg transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
              >
                Settings
              </button>
            )}
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-line mb-8">
          <button
            onClick={() => setSearchParams({})}
            className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
              activeTab === "boards"
                ? "text-fg border-primary-emphasis"
                : "text-fg-tertiary hover:text-fg border-transparent"
            }`}
          >
            Boards
          </button>
          {isAdmin && (
            <button
              onClick={() => setSearchParams({ tab: "settings" })}
              className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
                activeTab === "settings"
                  ? "text-fg border-primary-emphasis"
                  : "text-fg-tertiary hover:text-fg border-transparent"
              }`}
            >
              Settings
            </button>
          )}
        </div>

        {activeTab === "boards" && <div className="flex flex-col gap-8">

            {/* Subgroups */}
            <section>
              <div className="flex items-center gap-3 mb-3">
                <h2 className="text-fg font-semibold">Subgroups</h2>
                {isAdmin && (
                  <button
                    onClick={() => setShowCreateSubgroup(true)}
                    className="text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    + Create subgroup
                  </button>
                )}
              </div>
              {subgroups.length === 0 ? (
                <div className="flex flex-col items-center text-center py-6" data-testid="subgroups-empty">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-fg-faint mb-2" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                  </svg>
                  <p className="text-fg-tertiary text-sm">No subgroups yet</p>
                  <p className="text-fg-muted text-sm">
                    Subgroups let you organize boards and members into nested workspaces.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {subgroups.map((sg) => (
                    <button
                      key={sg.id}
                      onClick={() => navigate(`/groups/${sg.id}`)}
                      className="bg-surface hover:bg-surface-hover border border-line rounded p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        {/* Group/subgroup icon */}
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-fg-tertiary shrink-0" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                        </svg>
                        <p className="text-fg font-medium min-w-0 truncate">{sg.name}</p>
                        <HealthListingPill fields={sg} className="ml-auto" />
                      </div>
                      {/* Counts are withheld (0) for a navigation-only row (#1681). */}
                      {!sg.navigation_only && (
                        <p className="text-fg-muted text-xs">
                          {sg.board_count} board{sg.board_count !== 1 ? "s" : ""} · {sg.member_count} member{sg.member_count !== 1 ? "s" : ""}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* Boards */}
            <section>
              <div className="flex items-center gap-3 mb-3">
                <h2 className="text-fg font-semibold">Boards</h2>
                {canPlaceBoards && (
                  <button
                    onClick={() => setImportingBoard(true)}
                    className="text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    Import
                  </button>
                )}
                {subgroups.length > 0 && (
                  <label className="ml-auto flex items-center gap-2 cursor-pointer select-none">
                    <span className="text-xs text-fg-muted">Show subgroup boards</span>
                    <Toggle checked={showSubgroupBoards} onChange={setShowSubgroupBoards} />
                  </label>
                )}
              </div>
              <div className="flex flex-col gap-2">
                {boards.map((b) => (
                  <div
                    key={b.id}
                    className={`group/board relative flex items-center ${
                      animateBoardIds.has(b.id) ? "animate-fade-in motion-reduce:animate-none" : ""
                    }`}
                  >
                    <button
                      onClick={() => navigate(`/boards/${b.id}`)}
                      data-board-id={b.id}
                      data-starred={b.is_starred ? "true" : "false"}
                      className="flex-1 bg-surface hover:bg-surface-hover text-fg text-left px-4 py-3 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      <div className="flex items-center gap-2">
                        {/* Board icon */}
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-fg-tertiary shrink-0" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                        </svg>
                        <p className="font-medium min-w-0 truncate">{b.name}</p>
                        <HealthListingPill fields={b} />
                      </div>
                      {b.description && <p className="text-sm text-fg-tertiary mt-0.5 ml-6">{b.description}</p>}
                    </button>
                    <button type="button"
                      onClick={() => setMovingBoard(b)}
                      title="Move to another group"
                      aria-label={`Move ${b.name} to another group`}
                      className="absolute right-3 opacity-0 group-hover/board:opacity-100 focus:opacity-100 transition text-fg-muted hover:text-info p-1 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M8 5a1 1 0 000 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8z" />
                        <path d="M12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z" />
                      </svg>
                    </button>
                  </div>
                ))}
                {canPlaceBoards && (
                  <button
                    onClick={() => setCreatingBoard(true)}
                    className="w-full border-2 border-dashed border-line hover:border-line-emphasis hover:bg-surface/50 rounded px-4 py-3 text-left transition group focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    <p className="text-fg-muted group-hover:text-fg-secondary font-medium transition">+ New board</p>
                  </button>
                )}
                {!canPlaceBoards && boards.length === 0 && !showSubgroupBoards && (
                  <p className="text-fg-faint text-sm">No boards yet.</p>
                )}

                {/* Subgroup boards */}
                {showSubgroupBoards && (
                  loadingSubgroupBoards ? (
                    <Spinner />
                  ) : subgroupBoards.length === 0 ? (
                    <p className="text-fg-faint text-sm px-1">No boards in subgroups.</p>
                  ) : (
                    subgroupBoards.map((b) => (
                      <button
                        key={b.id}
                        onClick={() => navigate(`/boards/${b.id}`)}
                        className="w-full bg-surface hover:bg-surface-hover text-fg text-left px-4 py-3 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                      >
                        <div className="flex items-center gap-2">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-fg-tertiary shrink-0" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                          </svg>
                          <p className="font-medium flex-1 min-w-0 truncate">{b.name}</p>
                          <HealthListingPill fields={b} />
                          <BoardGroupPath
                            ancestors={b.group_detail?.ancestors ?? []}
                            currentGroupId={groupId}
                            directGroupName={b.group_name ?? ""}
                          />
                        </div>
                        {b.description && <p className="text-sm text-fg-tertiary mt-0.5 ml-6">{b.description}</p>}
                      </button>
                    ))
                  )
                )}
              </div>
            </section>
          </div>}

        {activeTab === "settings" && (
          <div className="max-w-2xl flex flex-col gap-8">

            {/* Members */}
            <section>
              <h2 className="text-fg font-semibold mb-1">Members</h2>
              <p className="text-fg-muted text-sm mb-4">Manage who has access to this group and their roles.</p>
              {memberError && <p role="alert" className="text-danger text-xs mb-2">{memberError}</p>}
              <div className="flex flex-col gap-2">
                {members.map((m) => {
                  // The server refuses to change or remove a site admin's
                  // membership unless the caller is a site admin too, so such a
                  // direct row gets no role picker and no Remove for anyone else,
                  // as on the board Members panel (#2164). The flag is sent to
                  // group admins only, the readers who would see those controls.
                  const isLocked = !m.is_inherited && m.is_site_admin === true && !user.is_site_admin && m.user.id !== group?.owner.id;
                  // The owner row has no controls for anyone, so it needs no lock note.
                  return (
                  <div key={m.user.id} className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 ${m.is_inherited ? "bg-surface/50" : "bg-surface"}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar user={m.user} size="sm" />
                      <div className="min-w-0">
                        <p className={`text-sm truncate ${m.is_inherited ? "text-fg-tertiary" : "text-fg"}`}>{m.user.display_name || m.user.username}</p>
                        {!m.is_inherited && m.has_all_content_access === true && GROUP_ROLES.includes(m.role) && (
                          <p className="text-xs text-fg-tertiary">
                            {groupRoleNote(m.role)}
                          </p>
                        )}
                        {isLocked && (
                          <p className="text-xs text-fg-tertiary">
                            {LOCKED_MEMBERSHIP_NOTE}
                          </p>
                        )}
                      </div>
                    </div>
                    {m.is_inherited ? (
                      <div className="flex items-center gap-2 shrink-0">
                        {m.has_all_content_access === true ? (
                          <GroupFullAccessChip userId={m.user.id} role={m.role} describeRole />
                        ) : (
                          <span className="text-xs text-fg-muted capitalize">{m.role}</span>
                        )}
                        <span className="text-xs bg-surface-hover text-fg-tertiary px-1.5 py-0.5 rounded whitespace-nowrap">
                          ↑ {m.inherited_from}
                        </span>
                      </div>
                    ) : isAdmin && !isLocked && m.user.id !== user.id && m.user.id !== group?.owner.id ? (
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
                          ariaLabel={`Group role for ${m.user.display_name || m.user.username}`}
                          size="xs"
                        />
                        )}
                        {m.role === "admin" && (
                          <RoleInfoTooltip label="Group Admin info">
                            <p className="text-xs font-semibold text-fg mb-1">Group Admin</p>
                            <p className="text-xs text-fg-tertiary">Group Admin automatically grants board-admin rights on every board in this group. This is the recommended role for team leads.</p>
                          </RoleInfoTooltip>
                        )}
                        {confirmRemoveMemberId === m.user.id ? (
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="text-fg-tertiary">
                              {m.has_all_content_access === true ? (
                                "Remove this group role? Full access is not affected."
                              ) : (
                                <>Remove <span className="text-fg font-medium">{m.user.display_name || m.user.username}</span> from this group?</>
                              )}
                            </span>
                            <button onClick={() => { void handleRemoveMember(m.user.id); }} className="text-danger hover:text-danger font-medium transition rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis">Confirm</button>
                            <button onClick={() => setConfirmRemoveMemberId(null)} className="text-fg-tertiary hover:text-fg transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
                          </div>
                        ) : (
                          <button
                            ref={removeMemberTriggerRef(m.user.id)}
                            onClick={() => setConfirmRemoveMemberId(m.user.id)}
                            aria-label={m.has_all_content_access === true ? `Remove group role for ${m.user.display_name || m.user.username}` : `Remove ${m.user.display_name || m.user.username} from group`}
                            className="text-fg-faint hover:text-danger transition text-xs focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
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
                          <p className="text-fg-muted text-xs capitalize" title={isLocked ? LOCKED_MEMBERSHIP_NOTE : undefined}>{m.role}</p>
                        )}
                        {m.user.id === group?.owner.id && (
                          <span className="text-xs bg-surface-hover text-fg-tertiary px-1.5 py-0.5 rounded whitespace-nowrap">Owner</span>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            </section>

            {/* Invite links */}
            <InviteLinkPanel scope={{ kind: "group", id: groupId }} reloadSignal={inviteReloadKey} isSiteAdmin={user.is_site_admin} />

            {/* Board defaults */}
            <section>
              <h2 className="text-fg font-semibold mb-1">Board defaults</h2>
              <p className="text-fg-muted text-sm mb-4">
                Defaults for boards created in this group. Settings marked "Deprecated" are saved but don't take effect.
              </p>

              {/* Default member role */}
              <div className="mb-5">
                <label htmlFor="group-default-member-role" className="text-fg-tertiary text-sm block mb-2">Default member role for new boards</label>
                <div className="flex items-center gap-3">
                  <SelectDropdown
                    id="group-default-member-role"
                    ariaDescribedBy="group-default-member-role-hint"
                    value={group.default_board_member_role ?? "member"}
                    onChange={(v) => handleDefaultRoleChange(v as "admin" | "member" | "collaborator" | "viewer")}
                    disabled={savingDefaults}
                    options={[
                      { value: "admin", label: "Admin" },
                      { value: "member", label: "Member" },
                      { value: "collaborator", label: "Collaborator" },
                      { value: "viewer", label: "Viewer" },
                    ]}
                  />
                  {defaultsSaved && <span className="text-success text-xs">Saved</span>}
                  {defaultsError && <span role="alert" className="text-danger text-xs">{defaultsError}</span>}
                </div>
                {/* #1430: deprecated; stored but never read. Access comes from GroupMembership.role via get_board_role(). Control kept for API compatibility. */}
                <p id="group-default-member-role-hint" className="text-fg-muted text-xs mt-2">
                  Deprecated. This setting has no effect: group members get their group role on every group board.
                </p>
              </div>

              {/* Allowed priorities — hidden for a navigation-only group, whose
                  empty list is withheld rather than "all allowed" (#1681). */}
              {!group.navigation_only && (
              <div className="mb-5">
                <label id="group-allowed-priorities-label" className="text-fg-tertiary text-sm block mb-2">Allowed priorities on new boards</label>
                <div className="flex flex-wrap gap-2" role="group" aria-labelledby="group-allowed-priorities-label" aria-describedby="group-allowed-priorities-hint">
                  {(["low", "medium", "high", "urgent"] as Priority[]).map((p) => {
                    const effectivePriorities = group.allowed_priorities.length > 0 ? group.allowed_priorities : (["low", "medium", "high", "urgent"] as Priority[]);
                    const active = effectivePriorities.includes(p);
                    // #1592: mirror the board's escalation (medium=orange, high=red, urgent=dark red).
                    // #1594: urgent has its own dark-red token pair (red-700 / on-tint), so it no
                    // longer needs a heavier border to differ from high.
                    const colorMap: Record<Priority, string> = {
                      low: "bg-info/20 border-info/60 text-info-on-tint",
                      medium: "bg-warning/20 border-warning/60 text-warning-on-tint",
                      high: "bg-danger/20 border-danger/60 text-danger-on-tint",
                      urgent: "bg-urgent/20 border-urgent/60 text-urgent-on-tint",
                    };
                    return (
                      <button
                        key={p}
                        onClick={() => { void handleTogglePriority(p); }}
                        aria-pressed={active}
                        className={`inline-flex items-center gap-1 px-3 py-1 rounded border text-xs font-medium transition capitalize focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                          active
                            ? colorMap[p]
                            : "bg-surface border-line-strong text-fg-muted hover:border-line-emphasis hover:text-fg-tertiary"
                        }`}
                        title={active ? `Disable ${p} priority` : `Enable ${p} priority`}
                      >
                        <ActiveMark active={active} />
                        {p}
                      </button>
                    );
                  })}
                </div>
                {/* #1429: deprecated; copied onto new boards but never enforced. Control kept for API compatibility. */}
                <p id="group-allowed-priorities-hint" className="text-fg-muted text-xs mt-2">
                  Deprecated. This setting has no effect: it is copied onto new boards, but card priorities are not restricted.
                </p>
                <p className="text-fg-faint text-xs mt-2">Click to toggle. At least one priority must remain enabled.</p>
              </div>
              )}

              {/* Shared label library */}
              <div>
                <label className="text-fg-tertiary text-sm block mb-2">Shared label library</label>
                <p className="text-fg-faint text-xs mb-3">Labels added here are copied to every new board created in this group.</p>
                <div className="flex flex-col gap-1.5 mb-3">
                  {(group.shared_labels ?? []).map((label) => (
                    <div key={label.id} className="flex items-center gap-2 bg-surface rounded-lg px-3 py-2">
                      <span
                        className="color-dot w-3 h-3 rounded-full shrink-0"
                        style={{ backgroundColor: label.color }}
                      />
                      <span className="text-fg text-sm flex-1">{label.name}</span>
                      {confirmRemoveLabelId === label.id ? (
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="text-fg-tertiary">
                            Remove <span className="text-fg font-medium">{label.name}</span> from this group?
                          </span>
                          <button onClick={() => { void handleDeleteGroupLabel(label.id); }} className="text-danger hover:text-danger font-medium transition rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis">Confirm</button>
                          <button onClick={() => setConfirmRemoveLabelId(null)} className="text-fg-tertiary hover:text-fg transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
                        </div>
                      ) : (
                        <button
                          ref={removeLabelTriggerRef(label.id)}
                          onClick={() => setConfirmRemoveLabelId(label.id)}
                          aria-label={`Remove ${label.name} from group`}
                          className="text-fg-faint hover:text-danger transition text-xs focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  {(group.shared_labels ?? []).length === 0 && (
                    <p className="text-fg-faint text-sm">No shared labels yet.</p>
                  )}
                </div>
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
                      value={newLabelName}
                      onChange={(e) => setNewLabelName(e.target.value)}
                      // void: handleAddGroupLabel manages its own try/catch and
                      // surfaces failures via labelError, nothing further to await here.
                      onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e)) void handleAddGroupLabel(); }}
                      placeholder="Label name…"
                      className="flex-1 bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                    />
                    <button
                      onClick={handleAddGroupLabel}
                      disabled={addingLabel || !newLabelName.trim()}
                      className="text-sm text-on-primary bg-button-primary hover:bg-button-primary-hover disabled:opacity-40 disabled:cursor-not-allowed px-3 py-2 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      Add
                    </button>
                  </div>
                </div>
                {labelError && <p role="alert" className="text-danger text-xs mt-1">{labelError}</p>}
              </div>
            </section>

            {/* Danger zone */}
            <section className="border border-danger/40 rounded-lg p-5">
              <h2 className="text-danger font-semibold mb-1">Danger zone</h2>
              <p className="text-fg-muted text-sm mb-4">These actions are permanent and cannot be undone.</p>
              <div className="flex flex-wrap gap-3">
                {group.owner.id === user.id && (
                  <button
                    onClick={() => { setTransferError(null); setShowTransferModal(true); }}
                    className="text-sm text-danger border border-danger/40 hover:bg-danger/20 hover:text-danger-on-tint px-4 py-2 rounded transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                  >
                    Transfer ownership
                  </button>
                )}
                {userCanDeleteGroup && (
                  <button
                    onClick={() => setConfirmDeleteGroup(true)}
                    className="text-sm text-danger border border-danger/40 hover:bg-danger/20 hover:text-danger-on-tint px-4 py-2 rounded transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                  >
                    Delete group
                  </button>
                )}
              </div>
              {/* Same wording shape as Board Settings' note (#2034): the server
                  allows only the owner or all-content access to delete. */}
              {!userCanDeleteGroup && (
                <p className="text-sm text-fg-tertiary">
                  Only the group owner ({group.owner.display_name || group.owner.username}) or a site administrator can delete this group.
                </p>
              )}
              {deleteError && <p role="alert" className="text-danger text-xs mt-2">{deleteError}</p>}
            </section>
          </div>
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
            // void: navigate() can return a Promise in React Router v7; fire-and-forget,
            // the board was already imported and there is nothing to roll back.
            void navigate(`/boards/${b.id}`);
          }}
        />
      )}

      {showCreateSubgroup && (
        <CreateGroupModal
          parentGroup={group}
          onCreated={(sg) => { writeSubgroups((prev) => (prev.some((g) => g.id === sg.id) ? prev : [...prev, sg])); }}
          onClose={() => setShowCreateSubgroup(false)}
        />
      )}

      <ModalWrapper
        open={showTransferModal}
        onClose={() => { setShowTransferModal(false); setTransferConfirmation(""); setTransferNewOwnerId(""); setTransferError(null); }}
        title="Transfer ownership"
        maxWidth="max-w-md"
      >
        <p className="text-fg-tertiary text-sm mb-5">
          Transfer ownership of <span className="text-fg font-medium">{group?.name}</span> to another admin.
          You will remain as an admin after the transfer.
        </p>

        <div className="flex flex-col gap-4">
          <div>
            <label className="text-fg-tertiary text-sm block mb-1">New owner</label>
            {adminMembers.length === 0 ? (
              <p className="text-fg-muted text-sm">No other admins found. Promote a member to admin first.</p>
            ) : (
              <SelectDropdown
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
          </div>

          <div>
            <label className="text-fg-tertiary text-sm block mb-1">
              Type the group name to confirm: <span className="text-fg font-medium">{group?.name}</span>
            </label>
            <input
              type="text"
              value={transferConfirmation}
              onChange={(e) => setTransferConfirmation(e.target.value)}
              placeholder={group?.name}
              className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
            />
          </div>

          {transferError && (
            <p className="text-danger text-sm">{transferError}</p>
          )}

          <div className="flex gap-3 justify-end pt-1">
            <button
              onClick={() => { setShowTransferModal(false); setTransferConfirmation(""); setTransferNewOwnerId(""); setTransferError(null); }}
              className="text-sm text-fg-tertiary hover:text-fg px-4 py-2 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Cancel
            </button>
            <button
              onClick={handleTransferOwnership}
              disabled={transferring || transferNewOwnerId === "" || transferConfirmation !== group?.name}
              className="text-sm text-on-danger bg-danger-bg hover:bg-danger-bg-hover disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
            >
              {transferring ? "Transferring…" : "Transfer ownership"}
            </button>
          </div>
        </div>
      </ModalWrapper>

      {/* Delete group confirmation modal */}
      <ModalWrapper
        open={confirmDeleteGroup && group !== null}
        onClose={() => setConfirmDeleteGroup(false)}
        title={`Delete "${group?.name}"?`}
        maxWidth="max-w-sm"
      >
        <p className="text-fg-tertiary text-sm mb-5">This will permanently delete the group and all its boards. This cannot be undone.</p>
        <div className="flex gap-3 justify-end">
          <button onClick={() => setConfirmDeleteGroup(false)} className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
          <button onClick={() => { void handleDeleteGroup(); }} className="bg-danger-bg hover:bg-danger-bg-hover text-on-danger text-sm px-4 py-1.5 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis">Delete group</button>
        </div>
      </ModalWrapper>
    </div>
  );
}
