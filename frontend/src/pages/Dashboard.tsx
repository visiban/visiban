import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listBoards, createBoard, deleteBoard, importBoard, starBoard, unstarBoard } from "../api/boards";
import { updateDefaultBoard } from "../api/auth";
import { listGroups } from "../api/groups";
import Navbar from "../components/Layout/Navbar";
import OverflowMenu from "../components/Layout/OverflowMenu";
import CreateGroupModal from "../components/Group/CreateGroupModal";
import MoveBoardModal from "../components/Board/MoveBoardModal";
import CreateBoardModal from "../components/Board/CreateBoardModal";
import ImportBoardModal, { type ImportMeta } from "../components/Board/ImportBoardModal";
import { canDeleteBoard } from "../utils/canDeleteBoard";
import BoardDeleteImpactNotice from "../components/Board/BoardDeleteImpact";
import TrelloImportModal from "../components/Board/TrelloImportModal";
import OnboardingEmptyState from "../components/Dashboard/OnboardingEmptyState";
import ModalWrapper from "../components/shared/ModalWrapper";
import Avatar from "../components/Common/Avatar";
import { Button, CardHeading, FilterPill, ListRow, ListWell, OverviewLayout, PageHeading, StatusPill } from "../components/Page";
import type { StatusTone } from "../components/Page";
import { HEALTH_STATUS_LABELS } from "../constants/healthStatus";
import type { Board, Group, ImportOptions, User } from "../types";
import { forSampleImport, hasImportSkips } from "../utils/importSummary";
import { DEMO_IMPORT_REASON, DEMO_NEW_BOARD_REASON, DEMO_NEW_GROUP_REASON, DEMO_STAR_REASON } from "../constants/demoCopy";
import { useInstanceFlags } from "../contexts/InstanceFlagsContext";
import { useShellNavData } from "../contexts/ShellNavContext";
import { healthReviewCue } from "../utils/healthStatus";
import { formatRelativeTime } from "../utils/date";
import { isImeComposing } from "../utils/imeComposition";
import StageBar from "../components/Dashboard/StageBar";
import {
  EMPTY_COPY, NO_DATA_TITLE, boardSignals, filterBoards, filterCounts, firstName, greeting, needsAttention, openedAgo,
  phoneSummary, recentTiles, sortBoards, summarize, summaryClauses, type BoardFilter,
  SIDE_LIST_CAP, capSideList, groupAvatarStack, sideListToggleLabel,
} from "../components/Dashboard/homeModel";

interface Props {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
  /** Tells the shell to reload its Starred list after a star toggle (#2473). */
  onStarToggled?: () => void;
}

/**
 * "Show all N" / "Show fewer" under a capped side list (#2487). Rendered only when the list is
 * longer than the cap. The toggle stays mounted in both states, so focus never drops.
 */
function SideListToggle({ total, expanded, onToggle, controls, headingId }: { total: number; expanded: boolean; onToggle: () => void; controls: string; headingId: string }) {
  if (total <= SIDE_LIST_CAP) return null;
  // The section heading is the description, so the two toggles are told apart ("Show all 7", Groups).
  return (
    <Button variant="quiet" className="mt-2 w-full" aria-expanded={expanded} aria-controls={controls} aria-describedby={headingId} onClick={onToggle}>
      {sideListToggleLabel(total, expanded)}
    </Button>
  );
}

const FILTERS: { id: BoardFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "starred", label: "Starred" },
  { id: "personal", label: "Personal" },
  { id: "at_risk", label: "At risk" },
];

/** A board's status as a pill, or nothing: listings never show "No status" (health rule 3). */
function BoardStatusPill({ board }: { board: Board }) {
  const status = board.effective_health_status;
  if (!status) return null;
  return <StatusPill tone={status as StatusTone} label={HEALTH_STATUS_LABELS[status]} />;
}

/** "5 stale · 3 blocked", or "Stale, blocked: no data" where auto health is off. Never 0 for no data. */
function SignalsText({ board, className = "" }: { board: Board; className?: string }) {
  const s = boardSignals(board);
  if (!s) {
    return <span className={`text-fg-tertiary ${className}`} title={NO_DATA_TITLE}>Stale, blocked: no data</span>;
  }
  return (
    <span className={`text-fg-secondary tabular-nums ${className}`}>
      {s.stale} stale<span aria-hidden="true"> · </span><span className="sr-only">, </span>{s.blocked} blocked
    </span>
  );
}

export default function Dashboard({ user, onLogout, onUserUpdated, onStarToggled }: Props) {
  const demoMode = useInstanceFlags().demo_mode;
  const { recentBoards, addBoard: shellAddBoard, removeBoard: shellRemoveBoard, addGroup: shellAddGroup } = useShellNavData();
  const navigate = useNavigate();
  const [boards, setBoards] = useState<Board[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loadingBoards, setLoadingBoards] = useState(true);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [movingBoard, setMovingBoard] = useState<Board | null>(null);
  const [importingBoard, setImportingBoard] = useState(false);
  const [trelloImporting, setTrelloImporting] = useState(false);
  const [joiningGroup, setJoiningGroup] = useState(false);
  const [joinToken, setJoinToken] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<BoardFilter>("all");
  // Side lists cap at SIDE_LIST_CAP rows until "Show all" (#2487).
  const [showAllGroups, setShowAllGroups] = useState(false);
  const [showAllAttention, setShowAllAttention] = useState(false);
  // Transient action failures (star, delete) never reuse the load-failure alert: they clear on the next action.
  const [actionError, setActionError] = useState<string | null>(null);

  // True when the initial boards or groups fetch rejected. Drives the error state
  // (with Retry) and keeps a failed load from masquerading as "no data" (#487).
  const [loadFailed, setLoadFailed] = useState(false);
  // True while a Retry round is in flight. The Retry button stays mounted (aria-disabled,
  // "Retrying…") so keyboard focus is not dropped to <body> (#1772, #1437).
  const [retrying, setRetrying] = useState(false);
  // Each load round takes the next generation; only the latest round may write state.
  // Retry is offered on the first rejection while the other fetch can still be pending, so
  // without this a late rejection or `finally` from round 1 could re-show the error or
  // clear a loading flag after the retry round succeeded (#487).
  const loadGenRef = useRef(0);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfterRecoveryRef = useRef(false);
  // The All boards section is the stable focus target after a retry recovers or a delete
  // confirms (#2204 class): the opener unmounts, so focus must not fall to <body>.
  const allBoardsRef = useRef<HTMLElement>(null);

  // The All boards section, or the first-run heading when nothing is listed (deleting the last
  // board lands there): focus always has somewhere stable to go.
  const focusAnchor = (): HTMLElement | null => allBoardsRef.current ?? document.getElementById("first-run-heading");

  const loadAll = useCallback((isRetry = false) => {
    const gen = ++loadGenRef.current;
    const isCurrent = () => gen === loadGenRef.current;
    // A retry keeps the Retry button (loadFailed) mounted until the new round settles, but
    // clears the alert text: a repeat failure then writes the same string back as a real text
    // change, which is what makes a screen reader announce it again. The first load starts clean.
    setLoadError(null);
    if (!isRetry) setLoadFailed(false);
    setRetrying(isRetry);
    setLoadingBoards(true);
    setLoadingGroups(true);
    let failed = false;
    const fail = (message: string) => {
      if (!isCurrent()) return;
      failed = true;
      setLoadFailed(true);
      setLoadError(message);
      setRetrying(false);
    };
    const boardsRound = listBoards()
      .then((b) => { if (isCurrent()) setBoards(b); })
      .catch(() => fail("Failed to load boards."))
      .finally(() => { if (isCurrent()) setLoadingBoards(false); });
    const groupsRound = listGroups()
      .then((g) => { if (isCurrent()) setGroups(g); })
      .catch(() => fail("Failed to load groups."))
      .finally(() => { if (isCurrent()) setLoadingGroups(false); });
    void Promise.all([boardsRound, groupsRound]).then(() => {
      if (!isCurrent() || failed || !isRetry) return;
      // The retry recovered: the error and its Retry button unmount, so move focus that was
      // on Retry to the first section instead of letting it fall to <body>.
      if (document.activeElement === retryButtonRef.current) focusAfterRecoveryRef.current = true;
      setLoadFailed(false);
      setLoadError(null);
      setRetrying(false);
    });
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Focus that was on Retry moves to the first section once the recovered page has rendered:
  // the section may not exist until the error state clears.
  useEffect(() => {
    if (focusAfterRecoveryRef.current && !loadFailed && !loadingBoards && !loadingGroups) {
      focusAfterRecoveryRef.current = false;
      focusAnchor()?.focus();
    }
  });

  const handleRetry = () => {
    if (retrying) return;
    loadAll(true);
  };

  const handleCreateBoard = async (name: string, template: string, swimlaneName: string, setAsDefault: boolean) => {
    const board = await createBoard({ name, template, swimlane_name: swimlaneName });
    setBoards((prev) => [board, ...prev]);
    shellAddBoard(board);
    setCreatingBoard(false);
    if (setAsDefault) {
      // Best-effort: patch the default board preference. Failure is non-fatal.
      updateDefaultBoard(board.id)
        .then((updatedUser) => onUserUpdated(updatedUser))
        .catch(() => undefined);
    }
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // the board was already created and there is nothing to roll back.
    void navigate(`/boards/${board.id}`);
  };

  const handleDeleteBoard = async (boardId: number) => {
    setActionError(null);
    const removedIndex = boards.findIndex((b) => b.id === boardId);
    const removedBoard = removedIndex === -1 ? undefined : boards[removedIndex];
    setBoards((prev) => prev.filter((b) => b.id !== boardId));
    setConfirmDeleteId(null);
    setDeleteConfirmInput("");
    try {
      await deleteBoard(boardId);
      shellRemoveBoard(boardId);
    } catch {
      // The delete failed after the board was optimistically removed from the
      // list — refetch to reconcile with the server, and if that also fails,
      // re-insert only the board that failed to delete. Restoring a whole-list
      // snapshot here would silently overwrite any other mutation (rename,
      // star, a second delete) that succeeded while this call was in flight.
      try {
        setBoards(await listBoards());
      } catch {
        if (removedBoard) {
          setBoards((prev) => {
            if (prev.some((b) => b.id === boardId)) return prev;
            const next = prev.slice();
            next.splice(Math.min(removedIndex, next.length), 0, removedBoard);
            return next;
          });
        }
      }
      setActionError("Failed to delete the board. Please try again.");
    }
  };

  // Optimistic star toggle; reverts just this board on failure so a concurrent change to
  // another row is never overwritten.
  const handleToggleStar = async (b: Board) => {
    const next = !b.is_starred;
    setActionError(null);
    setBoards((prev) => prev.map((x) => (x.id === b.id ? { ...x, is_starred: next } : x)));
    try {
      if (next) await starBoard(b.id); else await unstarBoard(b.id);
      onStarToggled?.();
    } catch {
      setBoards((prev) => prev.map((x) => (x.id === b.id ? { ...x, is_starred: !next } : x)));
      setActionError(`Failed to ${next ? "star" : "unstar"} the board. Please try again.`);
    }
  };

  const handleImportBoard = async (file: File, name?: string, options?: ImportOptions, meta?: ImportMeta) => {
    const board = options ? await importBoard(file, name, undefined, options) : await importBoard(file, name);
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

  const isLoaded = !loadingBoards && !loadingGroups;
  const isEmpty = isLoaded && !loadFailed && boards.length === 0 && groups.length === 0;
  const listedGroups = useMemo(
    () => groups.filter((g) => !g.navigation_only).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [groups],
  );
  const counts = useMemo(() => filterCounts(boards), [boards]);
  const visibleBoards = useMemo(() => sortBoards(filterBoards(boards, filter)), [boards, filter]);
  const attention = useMemo(() => needsAttention(boards, groups), [boards, groups]);
  const tiles = useMemo(() => recentTiles(recentBoards, boards), [recentBoards, boards]);
  const summary = useMemo(() => summarize(boards, groups), [boards, groups]);
  const clauses = summaryClauses(summary);
  const phone = phoneSummary(summary);

  const requestNewBoard = () => { if (!demoMode) setCreatingBoard(true); };
  const requestImport = () => { if (!demoMode) setImportingBoard(true); };
  const requestNewGroup = () => { if (!demoMode) setShowCreateGroup(true); };
  const demoNewGroup = demoMode ? { "aria-disabled": true as const, "aria-label": `New group. ${DEMO_NEW_GROUP_REASON}`, title: DEMO_NEW_GROUP_REASON, className: "opacity-40 cursor-not-allowed" } : {};
  const demoNew = demoMode ? { "aria-disabled": true as const, "aria-label": `New board. ${DEMO_NEW_BOARD_REASON}`, title: DEMO_NEW_BOARD_REASON, className: "opacity-40 cursor-not-allowed" } : {};
  const demoImport = demoMode ? { "aria-disabled": true as const, "aria-label": `Import. ${DEMO_IMPORT_REASON}`, title: DEMO_IMPORT_REASON, className: "opacity-40 cursor-not-allowed" } : {};

  const handleJoinSubmit = () => {
    const raw = joinToken.trim();
    // Use split instead of a regex to avoid catastrophic backtracking on
    // adversarial input (ReDoS). Takes whatever follows the last /join/ segment,
    // or the whole string if the user pasted a bare token.
    const token = raw.split("/join/").pop() ?? raw;
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // there is nothing to roll back if the navigation itself rejects.
    if (token) void navigate(`/join/${token}`);
  };

  const renderBoardRow = (b: Board) => {
    const cue = healthReviewCue(b);
    const canDelete = canDeleteBoard({ ownerId: b.owner.id, userId: user.id, hasAllContentAccess: user.can_access_all_content === true });
    const group = b.group_name ?? null;
    return (
      <ListRow key={b.id} as="li" interactive>
        <div className="flex items-center gap-2 min-w-0">
          {/* The star is a row control on desktop; on phones it moves into the ⋯ menu. */}
          <button
            type="button"
            aria-pressed={b.is_starred}
            aria-label={`${b.is_starred ? "Unstar" : "Star"} ${b.name}${demoMode ? `. ${DEMO_STAR_REASON}` : ""}`}
            aria-disabled={demoMode ? true : undefined}
            title={demoMode ? DEMO_STAR_REASON : undefined}
            onClick={() => { if (!demoMode) void handleToggleStar(b); }}
            className={`${demoMode ? "opacity-40 cursor-not-allowed " : ""}max-sm:hidden shrink-0 h-9 w-9 inline-flex items-center justify-center rounded text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
          >
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill={b.is_starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5">
              <path d="M10 2.5l2.3 4.7 5.2.8-3.8 3.6.9 5.1L10 14.2l-4.6 2.5.9-5.1L2.5 8l5.2-.8L10 2.5z" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => navigate(`/boards/${b.id}`)}
            className="flex-1 min-w-0 text-left rounded px-1 py-1 max-sm:min-h-11 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            <span className="block truncate text-sm font-medium text-fg">{b.name}</span>
            {group && <span className="block truncate text-xs text-fg-tertiary">{group}</span>}
            {b.description && <span className="block truncate text-xs text-fg-tertiary max-sm:hidden">{b.description}</span>}
            {cue && <span className="block text-xs text-warning-on-tint">{cue.text}</span>}
          </button>
          <SignalsText board={b} className="max-sm:hidden shrink-0 text-xs" />
          {/* Desktop only: phone rows show name, status and updated time (#2474 phone spec). */}
          <StageBar board={b} className="max-sm:hidden shrink-0 w-32" />
          <div className="flex flex-col items-end gap-1 shrink-0">
            <BoardStatusPill board={b} />
            <span className="text-xs text-fg-tertiary">Updated {formatRelativeTime(b.updated_at)}</span>
          </div>
          <OverflowMenu
            ariaLabel={`More actions for ${b.name}`}
            triggerClassName="shrink-0 h-9 w-9 max-sm:h-11 max-sm:w-11 inline-flex items-center justify-center rounded text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            items={[
              { id: "star", label: b.is_starred ? "Unstar" : "Star", onSelect: () => { if (!demoMode) void handleToggleStar(b); }, ...(demoMode ? { disabled: true, disabledReason: DEMO_STAR_REASON } : {}) },
              { id: "move", label: "Move to group", onSelect: () => setMovingBoard(b) },
              ...(canDelete
                ? [{ id: "delete", label: "Delete", danger: true, separatorBefore: true, onSelect: () => { setConfirmDeleteId(b.id); setDeleteConfirmInput(""); } }]
                : []),
            ]}
          />
        </div>
      </ListRow>
    );
  };

  const newBoardAction = (
    <Button variant="primary" onClick={requestNewBoard} {...demoNew} className={`max-sm:hidden ${demoMode ? demoNew.className : ""}`}>
      New board
    </Button>
  );

  const skeleton = (
    <div data-testid="home-skeleton" role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading boards</span>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => <div key={i} className="h-24 rounded-[10px] bg-surface-hover animate-pulse" />)}
      </div>
      {[0, 1, 2, 3].map((i) => <div key={i} className="h-16 rounded-lg bg-surface-hover animate-pulse" />)}
    </div>
  );

  const heading = isEmpty || !isLoaded ? undefined : (
    <PageHeading
      title={greeting(user)}
      description={
        isLoaded && !loadFailed ? (
          <>
            <span className="max-sm:hidden">
              {clauses.lead}
              {clauses.atRisk && <> <span className="text-warning-on-tint font-semibold">{clauses.atRisk}</span></>}
              {clauses.signals && <> {clauses.signals}</>}
            </span>
            <span className="sm:hidden">{phone ?? clauses.lead}</span>
          </>
        ) : undefined
      }
      actions={
        <>
          <Button variant="secondary" onClick={requestImport} {...demoImport}>Import</Button>
          <Button variant="secondary" onClick={requestNewGroup} {...demoNewGroup}>New group</Button>
        </>
      }
    />
  );

  const aside = isEmpty ? undefined : (
    <>
      <section aria-labelledby="home-groups-heading" className="bg-surface border border-line rounded-[10px] p-[18px] ">
        <CardHeading as="h2" id="home-groups-heading">Groups</CardHeading>
        {loadingGroups ? (
          <div className="mt-3 h-16 rounded-lg bg-surface-hover animate-pulse" aria-hidden="true" />
        ) : listedGroups.length === 0 ? (
          loadFailed ? <p className="mt-2 text-sm text-fg-secondary">Couldn't load groups.</p> : <p data-testid="groups-empty" className="mt-2 text-sm text-fg-secondary">No groups yet. Create one to collaborate with others.</p>
        ) : (
          <>
          <ul id="home-groups-list" className="mt-3 flex flex-col gap-2">
            {capSideList(listedGroups, showAllGroups).map((g) => {
              const stack = groupAvatarStack(g);
              return (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/groups/${g.id}`)}
                  className="w-full text-left rounded-lg border border-line bg-canvas px-3 py-2 hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  <span className="block truncate text-sm font-medium text-fg">{g.name}</span>
                  <span className="mt-0.5 flex items-center justify-between gap-2 text-xs text-fg-secondary">
                    <span>
                      {g.board_count} {g.board_count === 1 ? "board" : "boards"} · {g.member_count} {g.member_count === 1 ? "member" : "members"}
                    </span>
                    {/* Decorative: the member count in the meta line carries the words. */}
                    <span data-testid="group-avatar-stack" className="flex items-center -space-x-1" aria-hidden="true">
                      {stack.users.map((u) => <Avatar key={u.id} user={u} size="xs" className="ring-2 ring-canvas" />)}
                      {stack.more > 0 && (
                        <span className="h-6 min-w-6 px-1 rounded-full bg-surface-hover text-xs leading-6 text-center text-fg-secondary ring-2 ring-canvas">+{stack.more}</span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
              );
            })}
          </ul>
          <SideListToggle total={listedGroups.length} expanded={showAllGroups} onToggle={() => setShowAllGroups((v) => !v)} controls="home-groups-list" headingId="home-groups-heading" />
          </>
        )}
      </section>

      {isLoaded && !loadFailed && attention.length > 0 && (
        <section aria-labelledby="home-attention-heading" className="bg-surface border border-line rounded-[10px] p-[18px] ">
          <CardHeading as="h2" id="home-attention-heading">Needs attention</CardHeading>
          <p className="mt-1 text-xs text-fg-secondary">Boards and subgroups with stale or blocked cards, or overdue for review, worst first</p>
          <ul id="home-attention-list" className="mt-3 flex flex-col gap-1">
            {capSideList(attention, showAllAttention).map((a) => (
              <li key={`${a.kind}-${a.id}`}>
                <button
                  type="button"
                  onClick={() => navigate(a.kind === "board" ? `/boards/${a.id}` : `/groups/${a.id}`)}
                  className="w-full flex items-start gap-2 text-left rounded-lg px-2 py-2 hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  {/* Severity, not health status: decorative, the meta line carries the words. */}
                  <span aria-hidden="true" data-severity={a.severity} className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.severity === "danger" ? "bg-danger" : "bg-warning"}`} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-fg">{a.name}</span>
                    <span className="block text-xs text-fg-secondary">{a.meta}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <SideListToggle total={attention.length} expanded={showAllAttention} onToggle={() => setShowAllAttention((v) => !v)} controls="home-attention-list" headingId="home-attention-heading" />
        </section>
      )}
    </>
  );

  return (
    <div className="h-full bg-sunken flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} primaryAction={newBoardAction} />

      <main className="flex-1 overflow-y-auto max-sm:pb-24">
        <OverviewLayout heading={heading} aside={aside}>
          {/* The alert is always mounted and only its text changes: a region that mounts together
              with its text is not reliably announced (#1435, #1437). Empty, it takes no height. */}
          <div className={loadFailed ? "flex flex-wrap items-center gap-3" : undefined}>
            <p
              id="dashboard-load-error"
              role="alert"
              aria-atomic="true"
              className="text-sm text-danger"
              data-testid="dashboard-load-error"
            >
              {loadError}
            </p>
            {/* Retry sits beside the alert, never inside it, and stays mounted while retrying (#1772). */}
            {loadFailed && (
              <Button
                variant="quiet"
                buttonRef={retryButtonRef}
                onClick={handleRetry}
                aria-disabled={retrying || undefined}
                aria-describedby="dashboard-load-error"
                className="aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
              >
                {retrying ? "Retrying…" : "Retry"}
              </Button>
            )}
          </div>

          {/* Always mounted so a failed star or delete is announced (#1435). */}
          <p role="status" aria-live="assertive" aria-atomic="true" className="text-sm text-danger" data-testid="dashboard-action-error">{actionError}</p>

          {!isLoaded && skeleton}

          {isEmpty && (
            <OnboardingEmptyState
              name={firstName(user)}
              onCreateBoard={requestNewBoard}
              onJoinGroup={() => setJoiningGroup(true)}
              onImport={requestImport}
              disabledReason={demoMode ? DEMO_NEW_BOARD_REASON : null}
              importDisabledReason={demoMode ? DEMO_IMPORT_REASON : null}
            />
          )}

          {isLoaded && !isEmpty && tiles.length > 0 && (
            <section aria-labelledby="home-jump-heading">
              <CardHeading as="h2" id="home-jump-heading">Jump back in</CardHeading>
              <p className="mt-0.5 text-xs text-fg-secondary">Recently opened on this device</p>
              <ul className="mt-3 flex gap-3 overflow-x-auto sm:grid sm:grid-cols-3 sm:overflow-visible">
                {tiles.map(({ board: b, entry }) => (
                  <li key={b.id} className="min-w-[240px] sm:min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => navigate(`/boards/${b.id}`)}
                      className="w-full h-full text-left bg-surface border border-line rounded-[10px] p-3 hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      <span className="flex items-start justify-between gap-2">
                        <span className="min-w-0">
                          <span className="block truncate text-xs text-fg-tertiary">{b.group_name ?? entry.groupAncestors?.[0] ?? "Personal"}</span>
                          <span className="block truncate text-sm font-medium text-fg">{b.name}</span>
                        </span>
                        <BoardStatusPill board={b} />
                      </span>
                      <StageBar board={b} className="mt-2" />
                      <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-secondary">
                        <span className="tabular-nums">Cards {b.card_count}</span>
                        <SignalsText board={b} />
                      </span>
                      {openedAgo(entry.openedAt) && (
                        <span className="mt-1 block text-xs text-fg-tertiary">Opened {openedAgo(entry.openedAt)}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {isLoaded && !isEmpty && (
            <section ref={allBoardsRef} tabIndex={-1} aria-labelledby="home-boards-heading" className="focus:outline-none">
              <CardHeading as="h2" id="home-boards-heading">All boards</CardHeading>
              <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter boards">
                <div className="flex flex-wrap gap-2 max-sm:hidden">
                  {FILTERS.map((f) => (
                    <FilterPill key={f.id} label={f.label} count={counts[f.id]} selected={filter === f.id} onClick={() => setFilter(f.id)} />
                  ))}
                </div>
                <select
                  aria-label="Filter boards"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as BoardFilter)}
                  className="sm:hidden h-11 w-full rounded border border-line-strong bg-surface px-3 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  {FILTERS.map((f) => <option key={f.id} value={f.id}>{`${f.label} (${counts[f.id]})`}</option>)}
                </select>
              </div>
              <p role="status" className="sr-only">{`${visibleBoards.length} ${visibleBoards.length === 1 ? "board" : "boards"} shown`}</p>
              <div className="mt-3">
                {visibleBoards.length === 0 ? (
                  // A failed load never reads as "no boards" (#487): the error and Retry say so.
                  loadFailed && boards.length === 0 ? null : <p data-testid="boards-empty" className="rounded-[10px] border border-line bg-canvas px-4 py-8 text-center text-sm text-fg-secondary">
                    {EMPTY_COPY[filter]}
                  </p>
                ) : (
                  <ListWell as="ul">{visibleBoards.map((visibleBoard) => renderBoardRow(visibleBoard))}</ListWell>
                )}
              </div>
            </section>
          )}
        </OverviewLayout>
      </main>

      {!isEmpty && (
        <button
          type="button"
          onClick={requestNewBoard}
          {...(demoMode ? { "aria-disabled": true, "aria-label": `New board. ${DEMO_NEW_BOARD_REASON}`, title: DEMO_NEW_BOARD_REASON } : {})}
          className={`sm:hidden fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-30 h-12 px-5 rounded-full bg-button-primary text-on-primary text-sm font-medium shadow-xl focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${demoMode ? "opacity-40 cursor-not-allowed" : "hover:bg-button-primary-hover"}`}
        >
          New board
        </button>
      )}

      {creatingBoard && (
        <CreateBoardModal
          onConfirm={handleCreateBoard}
          onCancel={() => setCreatingBoard(false)}
          user={user}
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

      {trelloImporting && (
        <TrelloImportModal
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

      {movingBoard && (
        <MoveBoardModal
          board={movingBoard}
          onMoved={(updated) => {
            setBoards((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
            setMovingBoard(null);
          }}
          onClose={() => setMovingBoard(null)}
        />
      )}

      {showCreateGroup && (
        <CreateGroupModal
          onCreated={(g) => { setGroups((prev) => [g, ...prev]); shellAddGroup(g); }}
          onClose={() => setShowCreateGroup(false)}
        />
      )}

      <ModalWrapper
        open={joiningGroup}
        onClose={() => setJoiningGroup(false)}
        title="Join a group"
        maxWidth="max-w-sm"
        labelId="join-group-title"
      >
        <p className="text-fg-tertiary text-sm mb-4">Paste the invite link or token you received.</p>
        <input
          type="text"
          value={joinToken}
          onChange={(e) => setJoinToken(e.target.value)}
          placeholder="https://…/join/abc123 or abc123"
          className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted mb-4"
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e)) handleJoinSubmit(); }}
        />
        <div className="flex gap-3 justify-end">
          <button onClick={() => setJoiningGroup(false)} className="text-fg-secondary text-sm hover:text-fg hover:bg-surface-hover px-3 py-1.5 max-sm:min-h-11 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
          <button onClick={handleJoinSubmit} className="max-sm:min-h-11 bg-button-primary hover:bg-button-primary-hover text-on-primary text-sm font-medium px-4 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Join</button>
        </div>
      </ModalWrapper>

      {confirmDeleteId !== null && (() => {
        const board = boards.find((b) => b.id === confirmDeleteId);
        // Card.board cascades, so archived cards are deleted with the board
        // even though card_count (#693) leaves them out. Gate typed-name
        // confirmation on both counts so a board holding only archived cards
        // cannot be deleted with a single click (#1289).
        const activeCount = board?.card_count ?? 0;
        const archivedCount = board?.archived_card_count ?? 0;
        const hasCards = activeCount + archivedCount > 0;
        const nameMatches = deleteConfirmInput === board?.name;
        const canDelete = !hasCards || nameMatches;
        return (
          <ModalWrapper
            open={true}
            onClose={() => { setConfirmDeleteId(null); setDeleteConfirmInput(""); }}
            title="Delete board?"
            maxWidth="max-w-sm"
            labelId="delete-board-title"
            restoreFocusTo={focusAnchor}
          >
            <p className="text-fg-tertiary text-sm mb-1">
              <span className="text-fg font-medium">{board?.name}</span> and all its data, including archived cards, will be permanently deleted.
            </p>
            <p className="text-danger text-sm mb-4">This cannot be undone.</p>
            <BoardDeleteImpactNotice boardId={confirmDeleteId} />
            {hasCards && (
              <div className="mb-4">
                <p className="text-fg-tertiary text-xs mb-2">
                  This board has{" "}
                  {activeCount > 0 && (
                    <span className="text-fg font-medium">{activeCount} card{activeCount !== 1 ? "s" : ""}</span>
                  )}
                  {activeCount > 0 && archivedCount > 0 && " and "}
                  {archivedCount > 0 && (
                    <span className="text-fg font-medium">{archivedCount} archived card{archivedCount !== 1 ? "s" : ""}</span>
                  )}
                  . Type the board name to confirm deletion.
                </p>
                <input
                  type="text"
                  value={deleteConfirmInput}
                  onChange={(e) => setDeleteConfirmInput(e.target.value)}
                  placeholder={`Type "${board?.name}" to confirm`}
                  className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                  autoFocus
                />
              </div>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setConfirmDeleteId(null); setDeleteConfirmInput(""); }}
                className="text-fg-secondary text-sm hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteBoard(confirmDeleteId)}
                disabled={!canDelete}
                className="bg-danger-bg hover:bg-danger-bg-hover disabled:opacity-40 disabled:cursor-not-allowed text-on-danger text-sm font-medium px-4 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
              >
                Delete
              </button>
            </div>
          </ModalWrapper>
        );
      })()}
    </div>
  );
}
