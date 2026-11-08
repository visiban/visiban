import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import ModalWrapper from "../shared/ModalWrapper";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useToast } from "../../contexts/useToast";
import { canDeleteBoard } from "../../utils/canDeleteBoard";
import { POPOVER_VIEWPORT_MARGIN, useAnchoredPlacement } from "../../hooks/useAnchoredPlacement";
import SelectDropdown from "../Common/SelectDropdown";
import RoleInfoTooltip from "../Common/RoleInfoTooltip";
import type { BoardFull, BoardPresetId, CardDensity, CustomFieldDefinition, EffectiveBoardMember, LensConnection, SwimlaneCustomFieldDefinition, User } from "../../types";
import BoardSettingsFieldsTab from "./BoardSettingsFieldsTab";
import BoardSettingsSwimlaneFieldsTab from "./BoardSettingsSwimlaneFieldsTab";
import BoardSettingsWebhooksTab, { type WebhookCloseGuard } from "./BoardSettingsWebhooksTab";
import { userDisplayName } from "../../types";
import { exportBoardCsv, exportBoardJson, setBoardMember, removeBoardMember, deleteBoard, patchBoard, enableBoardSharing, disableBoardSharing, getBoardExportHistory } from "../../api/boards";
import type { BoardExportLogEntry, BoardExportMinRole, BoardMembership } from "../../types";
import type { BoardRole } from "../../api/boards";
import { searchUsers } from "../../api/auth";
import type { ViewPrefs } from "../../hooks/useViewPrefs";
import Avatar from "../Common/Avatar";
import { Toggle, ToggleField } from "../Common/Toggle";
import DemoInert from "../Common/DemoInert";
import { getBoardPreset, listBoardPresets } from "../../boardPresets/registry";
import type { PresetDensitySource } from "../../hooks/useBoardPreset";
import InviteLinkPanel from "../Group/InviteLinkPanel";
import { EMAIL_RE } from "../../constants/inviteEmail";
import type { EmailInviteFormHandle } from "../Common/EmailInviteForm";
import { DEMO_SETTINGS_REASON } from "../../constants/demoCopy";
import { formatExportFormatLabel, formatExportRowCount } from "../../utils/exportHistory";

// Chip tooltip and accessible description for a member whose all-content access
// overrides their board role (#1301).
const FULL_ACCESS_DESCRIPTION = "Full access to all boards. This account's board role doesn't apply.";

// Why a site admin's membership offers no remove action to a board admin (#1706).
const LOCKED_MEMBERSHIP_NOTE = "This membership is managed at the instance level and cannot be removed here.";

const ROLES: { value: BoardRole; label: string; description: string }[] = [
  { value: "admin",        label: "Admin",        description: "Full access — manage members, columns, swimlanes, and board settings" },
  { value: "member",       label: "Member",        description: "Create, edit, and move cards" },
  { value: "collaborator", label: "Collaborator",  description: "Can comment and upload files — cannot create or move cards" },
  { value: "viewer",       label: "Viewer",        description: "Read-only — cannot comment or upload" },
];

const ROLE_OPTIONS = ROLES.map((r) => ({
  value: r.value,
  label: r.label,
}));

interface Props {
  board: BoardFull;
  isAdmin: boolean;
  onClose: () => void;
  initialTab?: "members" | "display" | "rules" | "fields" | "swimlane-fields" | "sharing" | "webhooks" | "data";
  /** #863 — opened from a `webhook_disabled` notification: the Webhooks tab focuses the first webhook that was turned off automatically. */
  focusFirstStoppedWebhook?: boolean;
  /** #863 — false for an SSO-only account: a webhook take-over then needs a recent provider sign-in, not a password. */
  currentUserHasPassword?: boolean;
  onBoardDeleted?: () => void;
  /** Fired just before the delete request, so the owner can tell its own deletion's socket echo from another user's (#2041). */
  onBoardDeleting?: () => void;
  /** Fired if the delete request fails, undoing onBoardDeleting. */
  onBoardDeleteFailed?: () => void;
  /** Signed-in user's id, for the owner half of the delete gate (#2034). */
  currentUserId: number | null;
  /** A 403 on delete: the viewer's role is stale, so the host refetches the board (#2034). */
  onDeleteForbidden?: () => void;
  viewPrefs?: ViewPrefs;
  onToggleHiddenColumn?: (columnId: number) => void;
  onToggleHiddenSwimlane?: (swimlaneId: number) => void;
  onUpdateBoardSettings?: (patch: Record<string, unknown>) => void;
  /** #974 — the current user's personal card-density override for this
   *  board, or null when following the board admin's default. Gated
   *  independently of `viewPrefs`/onToggleHidden* — density override and
   *  column/swimlane visibility are unrelated personal-settings concerns
   *  that happen to share this tab. */
  cardDensityOverride?: CardDensity | null;
  onSetCardDensityOverride?: (value: CardDensity | null) => void;
  /** #1146 — which preset supplies the density this user sees, and how: `own-key`
   *  when a preset they applied wrote their personal density key (a preset and
   *  "Use my own density" write the same key, so the toggle names the writer),
   *  `board-default` when the board's default preset sets it and they have no
   *  key. Null when the density is their own setting or the board's own. */
  densityPresetSource?: PresetDensitySource;
  /** #1146 — the density the board actually renders for this user, for the
   *  "Set by preset" line. */
  effectiveCardDensity?: CardDensity;
  /** Whether the issue board lens feature is enabled instance-wide. */
  gitLensEnabled?: boolean;
  /** The board's current lens connection, or null when none is configured. */
  lensConnection?: LensConnection | null;
  /** Opens the LensConnectionModal (owned by BoardView). Admins only. */
  onManageLens?: () => void;
  /** #371 — the Fields tab's full, current definitions array after any local
   *  mutation (create/update/delete/reorder/pin). The caller (BoardView)
   *  owns syncing this into board state, the same role it plays for every
   *  other board sub-resource. */
  onFieldsUpdated?: (definitions: CustomFieldDefinition[]) => void;
  onSwimlaneFieldsUpdated?: (definitions: SwimlaneCustomFieldDefinition[]) => void;
  /** Hosted demo (#1179): board settings writes are refused by the server
   *  fence for every caller, a site admin included — admin controls render
   *  inert with one shared reason. */
  demoMode?: boolean;
  /** The requesting user's own `is_site_admin` (#1290). The member endpoints
   *  let only a site admin change or remove a member who is a site admin, so
   *  the Members tab locks those rows for everyone else. */
  currentUserIsSiteAdmin?: boolean;
  /** #1444 — bumped by BoardView on invite_link.created / invite_link.revoked
   *  and on a member.added that came from an invite, so the Members tab's
   *  invite list refetches. */
  inviteReloadSignal?: number;
  /** #1706 — called after members were added. The add response no longer
   *  carries the member's site-admin flag for a caller who is not a site
   *  admin, so BoardView re-reads the board and the Members tab picks the
   *  flag up from it. */
  onMembersAdded?: (userIds: number[]) => void;
  /** #1935 — called after the Sharing tab enables, rotates or disables the
   *  share link, with the board fields that changed. The caller (BoardView)
   *  merges them into board state, because board.updated frames never carry
   *  share fields, so a reopened modal would otherwise seed itself from the
   *  stale load-time values. Never carries the token: the link stays in this
   *  component's state only. */
  onShareChanged?: (patch: Pick<BoardFull, "share_link_active" | "share_token_expires_at">) => void;
  /** #1967 — `issued_at` of the latest share_link.updated frame that issued a
   *  link (an enable or rotate, by anyone). When it differs from the value this
   *  tab's own enable/rotate response returned, the link this tab is revealing
   *  was replaced and no longer works, so the reveal is withdrawn. Null until
   *  such a frame arrives. */
  shareLinkIssuedAt?: string | null;
}

const DEMO_SETTINGS_NOTICE_ID = "board-settings-demo-notice";
// #1146 — the two places Display names a preset as the density's source. Each is
// referenced with aria-describedby by the control it explains.
const DENSITY_SET_BY_PRESET_ID = "density-set-by-preset";
const DENSITY_OVERRIDE_DESCRIPTION_ID = "density-override-description";

/** #1967 — true when share link issue time `a` is later than `b`. Falls back
 *  to "different" when either value does not parse, so a malformed value can
 *  only withdraw a reveal, never keep a dead link on screen. */
function isLaterShareIssue(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a !== b;
  return ta > tb;
}

type Tab = "members" | "display" | "rules" | "fields" | "swimlane-fields" | "sharing" | "webhooks" | "data";

interface StagedInvite {
  user: User;
  role: BoardRole;
}

const ADD_FALLBACK_ERROR = "Couldn't add this member.";

/** One line of copy for a refused add: the server's `detail` when it sent one. */
function addMemberErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: { detail?: unknown } } })?.response?.data;
  return typeof data?.detail === "string" && data.detail ? data.detail : ADD_FALLBACK_ERROR;
}

function RoleTooltip() {
  return (
    <RoleInfoTooltip label="Role descriptions">
      <p className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">Role permissions</p>
      {ROLES.map((r) => (
        <Fragment key={r.value}>
          <div className={`py-1 ${r.value !== 'viewer' && r.value !== 'member' ? 'border-b border-line' : ''}`}>
            <span className="text-xs font-semibold text-fg capitalize">{r.label}</span>
            <span className="text-xs text-fg-tertiary"> — {r.description}</span>
          </div>
          {r.value === 'member' && (
            <div className="py-1 pl-3 border-l-2 border-line border-b border-line">
              <span className="text-xs font-semibold text-fg-secondary">Member (moderator flag)</span>
              <span className="text-xs text-fg-muted"> — Assign, edit, delete, and archive others' cards — ask an admin to enable</span>
            </div>
          )}
        </Fragment>
      ))}
    </RoleInfoTooltip>
  );
}

export default function BoardSettingsModal({ board, isAdmin, onClose, initialTab, onBoardDeleted, onBoardDeleting, onBoardDeleteFailed, currentUserId, onDeleteForbidden, viewPrefs, onToggleHiddenColumn, onToggleHiddenSwimlane, onUpdateBoardSettings, cardDensityOverride = null, onSetCardDensityOverride, densityPresetSource = null, effectiveCardDensity, gitLensEnabled = false, lensConnection = null, onManageLens, onFieldsUpdated, onSwimlaneFieldsUpdated, demoMode = false, currentUserIsSiteAdmin = false, inviteReloadSignal, onMembersAdded, onShareChanged, shareLinkIssuedAt = null, focusFirstStoppedWebhook = false, currentUserHasPassword = true }: Props) {
  const settingsInert = demoMode && isAdmin;
  const [tab, setTab] = useState<Tab>(initialTab ?? "members");
  // #863: the Webhooks tab can hold a one-time secret that is lost if Board
  // settings closes or switches tabs before the admin acknowledges it. The tab
  // registers a guard; Close, the backdrop and every tab button ask it first.
  const webhookCloseGuardRef = useRef<WebhookCloseGuard | null>(null);
  const registerWebhookCloseGuard = useCallback((guard: WebhookCloseGuard | null) => {
    webhookCloseGuardRef.current = guard;
  }, []);
  const guardedClose = useCallback(() => {
    if (webhookCloseGuardRef.current?.(onClose)) return;
    onClose();
  }, [onClose]);
  const selectTab = (next: Tab) => {
    if (next === tab) return;
    const go = () => {
      setTab(next);
      // The notification deep link is one-shot: leaving the tab spends it.
      if (tab === "webhooks") setWebhookDeepLinkLive(false);
    };
    if (tab === "webhooks" && webhookCloseGuardRef.current?.(go)) return;
    go();
  };
  const [webhookDeepLinkLive, setWebhookDeepLinkLive] = useState(focusFirstStoppedWebhook);
  // Focus the selected tab button only when a caller deep-linked a tab (#1458);
  // the default Members open keeps its existing focus behavior.
  const activeTabRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!initialTab) return;
    const id = requestAnimationFrame(() => {
      const btn = activeTabRef.current;
      if (!btn) return;
      // Only claim focus while it is still where ModalWrapper left it (the
      // panel, body, or nothing). A control deeper in the modal that already
      // took focus must keep it.
      const active = document.activeElement;
      if (!active || active === document.body || (active !== btn && active.contains(btn))) btn.focus();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: initialTab is read once, like the tab state
  }, []);
  const [members, setMembers] = useState<EffectiveBoardMember[]>(board.members);
  // #1444 — someone who joins from an invite while the modal is open arrives
  // through BoardView's member.added handler as a new board.members entry.
  // Append only ids not already listed: never replace, so a role edit in
  // flight here is not clobbered by the incoming prop.
  useEffect(() => {
    setMembers((prev) => {
      const known = new Set(prev.map((m) => m.user.id));
      const added = board.members.filter((m) => !known.has(m.user.id));
      // Fill in a site-admin flag a row lacks (#1706): the add response and
      // the member events omit it, the re-read board has it. Only that field
      // is copied, so a role edit in flight is still not clobbered.
      const flags = new Map(
        board.members.filter((m) => m.is_site_admin !== undefined).map((m) => [m.user.id, m.is_site_admin]),
      );
      // Same for the all-content signal (#1301): a row added from the invite
      // response lacks it, and without it the row would offer a role picker.
      const allContent = new Map(
        board.members
          .filter((m) => m.has_all_content_access !== undefined)
          .map((m) => [m.user.id, m.has_all_content_access]),
      );
      let changed = added.length > 0;
      const patched = prev.map((m) => {
        const flag = flags.get(m.user.id);
        const ac = allContent.get(m.user.id);
        const flagStale = flag !== undefined && m.is_site_admin !== flag;
        const acStale = ac !== undefined && m.has_all_content_access !== ac;
        if (!flagStale && !acStale) return m;
        changed = true;
        return {
          ...m,
          ...(flagStale ? { is_site_admin: flag } : {}),
          ...(acStale ? { has_all_content_access: ac } : {}),
        };
      });
      return changed ? [...patched, ...added] : prev;
    });
  }, [board.members]);
  const [saving, setSaving] = useState<number | null>(null);
  const [pendingRemove, setPendingRemove] = useState<number | null>(null);
  const removeTriggerRef = useConfirmFocusReturn(pendingRemove);
  // The "Full access" chip of each all-content row, by user id. Removing the
  // explicit board role unmounts the row's trigger, so focus lands on the chip
  // instead of falling to the page (#1301).
  const fullAccessChips = useRef(new Map<number, HTMLElement>());
  const [chipFocusUser, setChipFocusUser] = useState<number | null>(null);
  const [deleteInput, setDeleteInput] = useState("");
  // #2034 — Danger Zone delete: in-flight flag (ref mirrors it for the Escape
  // handler and the re-entry guard) and the inline failure text.
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { notify } = useToast();
  // #1373 — role/moderator/remove mutations used to have no catch at all (not
  // just an unsurfaced error — a genuine unhandled promise rejection). Shared
  // across the three Members-tab row actions since they all mutate the same
  // list and only one can be in flight per row (gated by `saving`).
  const [memberActionError, setMemberActionError] = useState<string | null>(null);

  const [inviteQuery, setInviteQuery] = useState("");
  const [suggestions, setSuggestions] = useState<User[]>([]);
  const [staged, setStaged] = useState<StagedInvite[]>([]);
  const [inviting, setInviting] = useState(false);
  // #1299 — per-user reason a staged add was refused, keyed by user id. Adds
  // are sent independently, so one refusal must not discard the others.
  const [stagedErrors, setStagedErrors] = useState<Record<number, string>>({});
  // Latest staged list, read after the adds settle: people staged or edited
  // while the requests were in flight must survive the reconcile.
  const stagedRef = useRef<StagedInvite[]>([]);
  stagedRef.current = staged;
  const [exportFormat, setExportFormat] = useState<"json" | "csv">("json");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  const [dropdownAnchor, setDropdownAnchor] = useState<{ top: number; bottom: number; left: number; width: number } | null>(null);
  // #1444 — the search → "Invite by email" bridge. `settledSearch` is the
  // query the last debounced search finished for and how many accounts it
  // matched at all (members and staged people included); the bridge shows
  // only once that search has settled with none.
  const [settledSearch, setSettledSearch] = useState<{ query: string; count: number } | null>(null);
  const [emailInviteAvailable, setEmailInviteAvailable] = useState(false);
  const emailFormRef = useRef<EmailInviteFormHandle>(null);

  const [stalenessThreshold, setStalenessThreshold] = useState(board.staleness_threshold_days ?? 14);
  const [stalenessWarningPct, setStalenessWarningPct] = useState(board.stale_warning_pct ?? 50);
  const [cardAgingError, setCardAgingError] = useState<string | null>(null);
  // Tracks the last value actually persisted to the server, independent of the
  // (already-updated-on-keystroke) state above, so a failed save can revert to
  // the right value instead of the just-typed one.
  const syncedStalenessThresholdRef = useRef(board.staleness_threshold_days ?? 14);
  const syncedStalenessWarningPctRef = useRef(board.stale_warning_pct ?? 50);
  // Inline confirmation before enabling hard WIP mode — mirrors the member-removal confirm pattern.
  const [pendingHardWip, setPendingHardWip] = useState(false);
  const hardWipTriggerRef = useConfirmFocusReturn(pendingHardWip ? "hard-wip" : null);

  // #974 — remembers the last personal density the user picked, for this
  // modal session only (NOT a separate persisted value from
  // cardDensityOverride). Lets "Use my own" restore the prior selection if
  // toggled off then back on without closing the modal, instead of
  // resetting to the board default every time. Deliberately does not
  // re-sync if cardDensityOverride changes from outside the modal while open.
  const [lastPickedDensity, setLastPickedDensity] = useState<CardDensity | null>(cardDensityOverride);

  // #843 — per-board export threshold. Plain-English labels per UX spec; the
  // server validates on write and may reject unknown values.
  // A blank value means the default (viewer); a value outside the known set
  // is shown as the admin-only setting the server applies (#1725).
  const [exportMinRole, setExportMinRole] = useState<BoardExportMinRole>(() => {
    const stored = board.export_min_role || "viewer";
    return (["viewer", "collaborator", "member", "admin"].includes(stored) ? stored : "admin") as BoardExportMinRole;
  });
  const [exportRoleError, setExportRoleError] = useState<string | null>(null);

  // #842 — export audit history. Lazy-loaded when an admin opens the Data tab
  // for the first time so viewers and collaborators never pay the request.
  const [exportHistory, setExportHistory] = useState<BoardExportLogEntry[] | null>(null);
  const [exportHistoryLoading, setExportHistoryLoading] = useState(false);
  const [exportHistoryError, setExportHistoryError] = useState<string | null>(null);

  // #843 — client-side mirror of the backend threshold gate for UI hiding.
  // Owner and site_admin always bypass (captured through current_user_role).
  // An unrecognized threshold is treated as admin-only, as on the server (#1725).
  const EXPORT_ROLE_RANK: Record<string, number> = { viewer: 0, collaborator: 1, member: 2, admin: 3 };
  const currentRole = board.current_user_role;
  const canExport =
    currentRole === "site_admin" ||
    currentRole === "admin" ||
    (currentRole != null &&
      EXPORT_ROLE_RANK[currentRole] >= (EXPORT_ROLE_RANK[exportMinRole] ?? EXPORT_ROLE_RANK.admin));

  // Sharing tab state (#1935). Whether a link is set comes from the board
  // payload's admin-only `share_link_active`; the link itself is never read
  // from the board (its `share_token` field is deprecated). The full token
  // exists only in `revealedShareToken`, set from the enable/rotate response
  // and cleared when the admin clicks Done, disables the link, or closes the
  // modal — the one-time reveal pattern in frontend/CLAUDE.md.
  const [shareActive, setShareActive] = useState<boolean>(board.share_link_active === true);
  const [revealedShareToken, setRevealedShareToken] = useState<string | null>(null);
  const [shareExpiresAt, setShareExpiresAt] = useState<string | null>(board.share_token_expires_at ?? null);
  // Selected TTL for the *next* enable action. Null = "never expires".
  // Pre-selects 30 days (#1865) so a link expires unless the admin
  // deliberately picks "Never". The API's own default stays "never" for
  // backward compatibility, so the UI sends the choice explicitly.
  const [shareTtl, setShareTtl] = useState<7 | 30 | 90 | null>(30);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  // Neutral (non-error) announcement for the status slot (#1967): set when a
  // change made elsewhere withdraws this tab's one-time reveal.
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  // Mirrors for effects that must not re-run when these change (#1967).
  const revealedShareTokenRef = useRef<string | null>(null);
  revealedShareTokenRef.current = revealedShareToken;
  // `share_token_issued_at` from the response that created the current
  // reveal; null when nothing is revealed (or an older server sent none).
  const revealIssuedAtRef = useRef<string | null>(null);
  // The latest issued_at BoardView has seen, for the handler below, which runs
  // after an await and must not read a stale closure value.
  const latestShareLinkIssuedAtRef = useRef<string | null>(shareLinkIssuedAt);
  latestShareLinkIssuedAtRef.current = shareLinkIssuedAt;
  const shareRevealRef = useRef<HTMLDivElement>(null);
  const shareHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusHeadingAfterWithdrawRef = useRef(false);
  // Focus follows the reveal so it never drops to <body>: when the reveal
  // mounts (enable or rotate; Rotate link itself unmounts), focus goes to
  // Copy, whose aria-describedby announces the one-time warning; when Done
  // unmounts it, focus goes to Rotate link.
  const rotateShareButtonRef = useRef<HTMLButtonElement>(null);
  const copyShareButtonRef = useRef<HTMLButtonElement>(null);
  const focusRotateAfterDismissRef = useRef(false);
  const focusCopyAfterRevealRef = useRef(false);

  // #1967 — a change made elsewhere (another admin, another tab, or the
  // server) ended the link this tab is revealing. Withdraw the reveal, clear
  // any stale error about it (a failed copy), say why in the status slot,
  // and, if focus was inside the reveal, move it to the "Public sharing"
  // heading so it never drops to <body>. The heading, not Rotate link or
  // the toggle: both of those would destroy the link another admin just
  // made on a reflexive Enter. A no-op when nothing is revealed, which also
  // covers this tab's own revoke (it clears the reveal itself before its
  // patch reaches `board`).
  const withdrawShareReveal = useCallback((reason: "revoked" | "rotated") => {
    if (revealedShareTokenRef.current === null) return;
    if (shareRevealRef.current?.contains(document.activeElement)) {
      focusHeadingAfterWithdrawRef.current = true;
    }
    revealIssuedAtRef.current = null;
    setRevealedShareToken(null);
    setShareCopied(false);
    setShareStatus(null);
    setShareNotice(
      reason === "rotated"
        ? "The link shown here was replaced elsewhere and no longer works. Rotate the link to get a new one."
        : "Sharing was turned off elsewhere, so the link shown here no longer works.",
    );
  }, []);

  // #1967 — follow the board's share state after mount, not just at it.
  // BoardView merges the admin-only share_link.updated frame (another admin
  // revoking or rotating the link, or the server clearing it when its enabler
  // lost admin rights) and this tab's own onShareChanged patch into `board`.
  // Seeding once at mount left an open modal showing a revoked link as active.
  // A link that is gone also takes its one-time reveal with it: that URL no
  // longer works.
  const boardShareActive = board.share_link_active === true;
  const boardShareExpiresAt = board.share_token_expires_at ?? null;
  useEffect(() => {
    setShareActive(boardShareActive);
    setShareExpiresAt(boardShareExpiresAt);
    // A notice about an earlier change elsewhere is stale once the share
    // state changes again (for example sharing turned back on).
    setShareNotice(null);
    if (!boardShareActive) withdrawShareReveal("revoked");
  }, [boardShareActive, boardShareExpiresAt, withdrawShareReveal]);

  // #1967 — a rotation leaves the link active, so it is told apart by
  // `issued_at`. This tab's own enable/rotate echo carries the same value its
  // response returned (kept in revealIssuedAtRef), so it never withdraws its
  // own reveal. Only a LATER issue replaces the link: links on one board are
  // issued under its row lock, so a newer link has a later issued_at, and an
  // older frame arriving late must not withdraw a newer reveal. The reverse
  // order (another admin's frame before this tab's response) is handled in
  // handleEnableShare, since this effect runs only when the prop changes.
  useEffect(() => {
    const mine = revealIssuedAtRef.current;
    if (shareLinkIssuedAt !== null && mine !== null && isLaterShareIssue(shareLinkIssuedAt, mine)) {
      withdrawShareReveal("rotated");
    }
  }, [shareLinkIssuedAt, withdrawShareReveal]);

  const shareUrl = revealedShareToken ? `${window.location.origin}/share/${revealedShareToken}` : null;
  // A link past its expiry is still set (the public page answers 410 Gone)
  // until it is rotated or disabled, so say "Expired" rather than "Expires".
  const shareExpired = shareExpiresAt !== null && new Date(shareExpiresAt).getTime() <= Date.now();
  const shareExpiryLabel = shareExpiresAt
    ? `${shareExpired ? "Expired" : "Expires"} ${new Date(shareExpiresAt).toLocaleString()}`
    : "Never expires";
  // The TTL picker: the expiry of the link about to be created (sharing off)
  // or of the replacement Rotate link issues (link active, not on screen).
  // Only one of the two renders at a time, so the id stays unique.
  const renderShareTtlRow = (label: string, describedBy: string) => (
    <div className="flex items-center justify-between gap-3 py-2 mb-3 self-stretch">
      <label htmlFor="share-ttl-select" className="text-sm text-fg-secondary">
        {label}
      </label>
      <SelectDropdown
        id="share-ttl-select"
        ariaDescribedBy={describedBy}
        value={shareTtl === null ? "never" : String(shareTtl)}
        onChange={(v) => setShareTtl(v === "never" ? null : (Number(v) as 7 | 30 | 90))}
        options={[
          { value: "never", label: "Never" },
          { value: "7",     label: "7 days" },
          { value: "30",    label: "30 days" },
          { value: "90",    label: "90 days" },
        ]}
        disabled={shareLoading}
        disabledReason="Updating sharing…"
      />
    </div>
  );
  useEffect(() => {
    if (focusRotateAfterDismissRef.current && revealedShareToken === null) {
      focusRotateAfterDismissRef.current = false;
      rotateShareButtonRef.current?.focus();
    }
    if (focusHeadingAfterWithdrawRef.current && revealedShareToken === null) {
      focusHeadingAfterWithdrawRef.current = false;
      shareHeadingRef.current?.focus();
    }
    if (focusCopyAfterRevealRef.current && revealedShareToken !== null) {
      focusCopyAfterRevealRef.current = false;
      copyShareButtonRef.current?.focus();
    }
  }, [revealedShareToken]);

  // Enable and rotate are the same request: POST /share/ always issues a new
  // token and the previous link stops working.
  const handleEnableShare = async (failureMessage = "Failed to enable sharing. Please try again.") => {
    setShareLoading(true);
    setShareStatus(null);
    setShareNotice(null);
    try {
      const data = await enableBoardSharing(board.id, shareTtl);
      const mine = data.share_token_issued_at ?? null;
      const latest = latestShareLinkIssuedAtRef.current;
      if (mine !== null && latest !== null && isLaterShareIssue(latest, mine)) {
        // #1967 — another admin's rotation landed (its frame arrived first)
        // after this request issued its link, so the link in this response
        // already no longer works. Don't reveal it, and don't merge its state
        // over the newer link's: `board` already holds that.
        setShareNotice("The new link was replaced elsewhere before it could be shown. Rotate the link to get a new one.");
        return;
      }
      focusCopyAfterRevealRef.current = true;
      revealIssuedAtRef.current = mine;
      setShareActive(true);
      setRevealedShareToken(data.share_token);
      setShareExpiresAt(data.share_token_expires_at);
      setShareCopied(false);
      setShareStatus(null);
      // Board state must learn the link is on now, not only when this tab's
      // share_link.updated echo arrives (#1967; it can be lost, and board.updated
      // never carries share fields), or a reopened modal could show sharing off
      // and a second enable would silently replace the link just handed out.
      // The token is not passed.
      onShareChanged?.({ share_link_active: true, share_token_expires_at: data.share_token_expires_at });
    } catch {
      setShareStatus(failureMessage);
    } finally {
      setShareLoading(false);
    }
  };

  const handleDismissShareReveal = () => {
    focusRotateAfterDismissRef.current = true;
    revealIssuedAtRef.current = null;
    setRevealedShareToken(null);
    setShareCopied(false);
  };

  const handleDisableShare = async () => {
    setShareLoading(true);
    setShareStatus(null);
    setShareNotice(null);
    try {
      await disableBoardSharing(board.id);
      setShareActive(false);
      revealIssuedAtRef.current = null;
      setRevealedShareToken(null);
      setShareExpiresAt(null);
      setShareStatus(null);
      onShareChanged?.({ share_link_active: false, share_token_expires_at: null });
    } catch {
      setShareStatus("Failed to disable sharing. Please try again.");
    } finally {
      setShareLoading(false);
    }
  };

  // Share-URL "Copied!" feedback timer — cleaned up on unmount (#870).
  const shareCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (shareCopiedTimerRef.current !== null) {
        clearTimeout(shareCopiedTimerRef.current);
        shareCopiedTimerRef.current = null;
      }
    };
  }, []);

  const handleCopyShareUrl = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      setShareStatus("Failed to copy link. Please copy it manually.");
      return;
    }
    // The reveal may have been withdrawn while the copy was pending (#1967):
    // don't report a dead link as copied.
    if (revealedShareTokenRef.current === null) return;
    setShareCopied(true);
    if (shareCopiedTimerRef.current !== null) {
      clearTimeout(shareCopiedTimerRef.current);
    }
    shareCopiedTimerRef.current = setTimeout(() => {
      setShareCopied(false);
      shareCopiedTimerRef.current = null;
    }, 2000);
  };

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // #1305 — found via the timer-ref audit: the invite-search debounce below
  // had no unmount cleanup, so closing the modal mid-debounce (or mid-flight
  // on the async searchUsers() call it schedules) could run setSuggestions /
  // setDropdownAnchor after teardown.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Strip a leading @ so users can type "@alice" and get the same results as "alice"
    const q = inviteQuery.trim().replace(/^@/, "");
    if (q.length < 2) { setSuggestions([]); setSettledSearch(null); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await searchUsers(q);
        const memberIds = new Set(members.map((m) => m.user.id));
        const stagedIds = new Set(staged.map((s) => s.user.id));
        const filtered = results.filter((u) => !memberIds.has(u.id) && !stagedIds.has(u.id));
        // The RAW count: a query matching only existing members or staged
        // people means they are already here, not that an invite is needed.
        setSettledSearch({ query: q, count: results.length });
        if (filtered.length > 0 && searchInputRef.current) {
          const rect = searchInputRef.current.getBoundingClientRect();
          setDropdownAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width });
        } else {
          setDropdownAnchor(null);
        }
        setSuggestions(filtered);
      } catch {
        setSuggestions([]);
        setDropdownAnchor(null);
        setSettledSearch(null);
      }
    }, 300);
  }, [inviteQuery, members, staged]);

  // The member-search suggestions are an anchored `fixed` popover of user
  // data (up to a page of results), so they follow the #1455 rules (#1457):
  // placed from the measured height (below the search, else above, else
  // bottom-pinned, keeping that side while the query changes), capped at the
  // viewport, hidden until placed, and dismissed on resize or outside scroll.
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const dismissSuggestions = useCallback(() => {
    setSuggestions([]);
    setDropdownAnchor(null);
  }, []);
  const suggestionsTop = useAnchoredPlacement(suggestionsRef, {
    anchor: suggestions.length > 0 && dropdownAnchor
      ? { top: dropdownAnchor.top, bottom: dropdownAnchor.bottom }
      : null,
    deps: [suggestions.length],
    onResize: dismissSuggestions,
    onOutsideScroll: dismissSuggestions,
  });

  const handleRoleChange = async (userId: number, role: BoardRole) => {
    setSaving(userId);
    setMemberActionError(null);
    try {
      const updated = await setBoardMember(board.id, userId, role);
      setMembers((prev) => {
        const next = prev.map((m) => m.user.id === userId ? { ...m, id: updated.id ?? m.id, role: updated.role, is_moderator: updated.is_moderator } : m);
        if (!next.find((m) => m.user.id === userId)) next.push(updated);
        return next;
      });
    } catch {
      setMemberActionError("Failed to update role. Please try again.");
    } finally {
      setSaving(null);
    }
  };

  const handleModeratorToggle = async (userId: number, currentRole: BoardRole, isModerator: boolean) => {
    setSaving(userId);
    setMemberActionError(null);
    try {
      const updated = await setBoardMember(board.id, userId, currentRole, !isModerator);
      setMembers((prev) => prev.map((m) => m.user.id === userId ? { ...m, id: updated.id ?? m.id, is_moderator: updated.is_moderator } : m));
    } catch {
      setMemberActionError("Failed to update moderator status. Please try again.");
    } finally {
      setSaving(null);
    }
  };

  // #2034 — Danger Zone delete. Offered only to the owner or a site
  // administrator, the same predicate the Dashboard and BoardSelector use; the server
  // (BoardViewSet.destroy) is still the authority. The role comes from the
  // board, so a 403's refetch (onDeleteForbidden) flips a stale owner into the
  // non-owner note without any local bookkeeping.
  const userCanDeleteBoard = canDeleteBoard({
    ownerId: board.owner?.id,
    userId: currentUserId,
    hasAllContentAccess: board.current_user_role === "site_admin",
  });
  const deleteArmed = board.cards.length > 0 || (board.archived_card_count ?? 0) > 0;
  const deleteReady = !deleteArmed || deleteInput === board.name;
  const deleteInputRef = useRef<HTMLInputElement>(null);
  const deleteNoteRef = useRef<HTMLParagraphElement>(null);
  // A 403 refetch can flip the delete control into the non-owner note while the
  // failure text is showing; the focused button unmounts, so land on the note.
  useEffect(() => {
    if (!userCanDeleteBoard && deleteError !== null) deleteNoteRef.current?.focus();
  }, [userCanDeleteBoard, deleteError]);
  const deleteBoardNow = async () => {
    if (!deleteReady) { deleteInputRef.current?.focus(); return; }
    if (deletingRef.current || !onBoardDeleted) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError(null);
    onBoardDeleting?.();
    try {
      await deleteBoard(board.id);
    } catch (err) {
      // A failed delete leaves the board in place; undo the announcement.
      onBoardDeleteFailed?.();
      const status = (err as { response?: { status?: number } })?.response?.status;
      // 403 copy is the 1.3 UI spec's (Part 9) for every cause; demo or
      // maintenance gating could also 403 and gets the same words by design.
      const forbidden = status === 403;
      const offline = (err as { response?: unknown })?.response == null;
      const title = forbidden ? "You can't delete this board" : "Couldn't delete the board";
      const message = forbidden
        ? "Only its owner or a site administrator can."
        : offline
          ? "Check your connection and try again."
          : "Try again.";
      // Inline first (this modal traps focus), then a toast that does not
      // announce a second time (frontend/CLAUDE.md § Toasts, #1732).
      setDeleteError(`${title}. ${message}`);
      notify({ key: "board-delete", variant: "danger", title, message, announce: false });
      deletingRef.current = false;
      setDeleting(false);
      if (forbidden) onDeleteForbidden?.();
      return;
    }
    onBoardDeleted();
  };
  // Escape: swallowed while the request runs; otherwise collapses a typed
  // confirmation (priority 40.5, above the modal's 40) before it can close the modal.
  useEscapeStack(() => {
    if (deletingRef.current) return true;
    if (tab !== "data" || !userCanDeleteBoard || (deleteInput === "" && deleteError === null)) return false;
    setDeleteInput("");
    setDeleteError(null);
    deleteInputRef.current?.focus();
  }, 40.5);

  // Escape 57 (frontend/CLAUDE.md): dismisses only the all-content row's
  // "Remove this board role?" prompt, above ModalWrapper's 40, and returns false
  // otherwise so Escape still closes the modal or reaches other handlers.
  useEscapeStack(() => {
    const target = pendingRemove === null ? undefined : members.find((m) => m.user.id === pendingRemove);
    if (!target || !(target.role === "site_admin" || target.has_all_content_access === true)) return false;
    // Swallow Escape while the removal is in flight (#1437): closing the prompt
    // would drop focus while the request still completes.
    if (saving === target.user.id) return true;
    setPendingRemove(null);
  }, 57);

  // Escape 58 (frontend/CLAUDE.md): clears the Add member search (query and suggestion list) above
  // ModalWrapper's 40, and returns false with nothing to clear so Escape still closes the modal (#2036).
  useEscapeStack(() => {
    // Focus-gated so a lingering query never outranks the 57 remove-role prompt (focus is on it).
    if (document.activeElement !== searchInputRef.current) return false;
    if (inviteQuery === "" && suggestions.length === 0) return false;
    setSuggestions([]);
    setDropdownAnchor(null);
    setInviteQuery("");
  }, 58);

  useEffect(() => {
    if (chipFocusUser === null) return;
    fullAccessChips.current.get(chipFocusUser)?.focus();
    setChipFocusUser(null);
  }, [chipFocusUser, members]);

  const handleRemoveConfirm = async (userId: number) => {
    if (saving !== null) return;
    const roleOnly = members.some((m) => m.user.id === userId && (m.role === "site_admin" || m.has_all_content_access === true));
    setSaving(userId);
    setMemberActionError(null);
    try {
      await removeBoardMember(board.id, userId);
      setMembers((prev) =>
        prev.flatMap((m) => {
          if (m.user.id !== userId) return [m];
          // Removing the explicit membership of an all-content user does not
          // remove their access (#1301), so keep the row, now with no
          // membership. This is the local view only: a later re-read lists
          // them again only if the reader sees the all-content roster, or the
          // user is also inherited from the board's group or the owner.
          if (m.has_all_content_access) return [{ ...m, id: null, role: "site_admin" as const }];
          return [];
        }),
      );
      if (members.some((m) => m.user.id === userId && m.has_all_content_access)) setChipFocusUser(userId);
    } catch {
      setMemberActionError(roleOnly ? "Failed to remove the board role. Please try again." : "Failed to remove member. Please try again.");
    } finally {
      setSaving(null);
      setPendingRemove(null);
    }
  };

  const addToStaged = (user: User) => {
    setStaged((prev) => [...prev, { user, role: "member" }]);
    setSuggestions([]);
    setDropdownAnchor(null);
    setInviteQuery("");
    searchInputRef.current?.focus();
  };

  const clearStagedError = (userId: number) => {
    // The failure summary describes the refused rows; once the last one is
    // edited or removed it would be stale, so clear it with them.
    if (userId in stagedErrors && Object.keys(stagedErrors).length === 1) setInviteError(null);
    setStagedErrors((prev) => {
      if (!(userId in prev)) return prev;
      const { [userId]: _dropped, ...rest } = prev;
      return rest;
    });
  };

  const handleInviteSubmit = async () => {
    if (staged.length === 0) return;
    setInviting(true);
    setInviteError(null);
    setInviteSuccess(null);
    setStagedErrors({});
    const sent = staged;
    try {
      const outcomes = await Promise.allSettled(
        sent.map((s) => setBoardMember(board.id, s.user.id, s.role)),
      );
      const results: BoardMembership[] = [];
      const errors: Record<number, string> = {};
      outcomes.forEach((o, i) => {
        if (o.status === "fulfilled") results.push(o.value);
        else errors[sent[i].user.id] = addMemberErrorMessage(o.reason);
      });
      if (results.length > 0) {
        setMembers((prev) => {
          const next = [...prev];
          for (const updated of results) {
            const idx = next.findIndex((m) => m.user.id === updated.user.id);
            if (idx >= 0) next[idx] = { ...next[idx], role: updated.role };
            else next.push(updated);
          }
          return next;
        });
        onMembersAdded?.(results.map((r) => r.user.id));
      }
      // Only the rows that were added leave the staged list. Refused rows
      // stay for retry/removal, and anyone staged while the requests were in
      // flight is untouched.
      const failedIds = new Set(Object.keys(errors).map(Number));
      const addedIds = new Set(results.map((r) => r.user.id));
      setStaged((prev) => prev.filter((s) => !addedIds.has(s.user.id)));
      // Roles are locked while the requests are in flight, so a reason always
      // describes the role on the row. A row removed mid-flight has no place
      // to show one, so its reason is dropped.
      const liveErrors: Record<number, string> = {};
      for (const [id, msg] of Object.entries(errors)) {
        if (stagedRef.current.some((x) => x.user.id === Number(id))) liveErrors[Number(id)] = msg;
      }
      setStagedErrors(liveErrors);
      const failed = failedIds.size;
      if (failed === 0) {
        setInviteSuccess(`Added ${results.length} member${results.length !== 1 ? "s" : ""} to the board.`);
      } else if (results.length > 0) {
        setInviteError(
          `Added ${results.length} member${results.length !== 1 ? "s" : ""}. ${failed} could not be added.`,
        );
      } else {
        setInviteError(failed === 1 ? "That member could not be added." : "None of those members could be added.");
      }
    } finally {
      setInviting(false);
    }
  };


  const handleStalenessBlur = async () => {
    const previous = syncedStalenessThresholdRef.current;
    if (stalenessThreshold === previous) return;
    setCardAgingError(null);
    try {
      await patchBoard(board.id, { staleness_threshold_days: stalenessThreshold });
      syncedStalenessThresholdRef.current = stalenessThreshold;
    } catch {
      setStalenessThreshold(previous);
      setCardAgingError("Failed to save stale card threshold. Please try again.");
    }
  };

  const handleStalenessWarningPctBlur = async () => {
    const clamped = Math.max(0, Math.min(100, stalenessWarningPct));
    const previous = syncedStalenessWarningPctRef.current;
    setStalenessWarningPct(clamped);
    if (clamped === previous) return;
    setCardAgingError(null);
    try {
      await patchBoard(board.id, { stale_warning_pct: clamped });
      syncedStalenessWarningPctRef.current = clamped;
    } catch {
      setStalenessWarningPct(previous);
      setCardAgingError("Failed to save warning percentage. Please try again.");
    }
  };

  // #843 — save export_min_role immediately on change. Admins only; non-admins
  // never see the control (see Data tab render). On a server rejection we
  // revert the local state so the UI does not drift from persisted state.
  const handleExportMinRoleChange = async (value: BoardExportMinRole) => {
    const previous = exportMinRole;
    setExportMinRole(value);
    setExportRoleError(null);
    try {
      await patchBoard(board.id, { export_min_role: value });
    } catch {
      setExportMinRole(previous);
      setExportRoleError("Failed to update export permission. Please try again.");
    }
  };

  // #842 — load the audit history the first time an admin opens the Data tab.
  // The endpoint is admin-only server-side; we mirror that gate here so we
  // don't issue a request that would 403 for viewers/collaborators.
  useEffect(() => {
    if (tab !== "data" || !isAdmin) return;
    if (exportHistory !== null || exportHistoryLoading) return;
    setExportHistoryLoading(true);
    setExportHistoryError(null);
    getBoardExportHistory(board.id, { page_size: 10 })
      .then((resp) => setExportHistory(resp.results))
      .catch(() => setExportHistoryError("Could not load export history."))
      .finally(() => setExportHistoryLoading(false));
  }, [tab, isAdmin, board.id, exportHistory, exportHistoryLoading]);

  return (
    <ModalWrapper
      open={true}
      onClose={guardedClose}
      title="Board Settings"
      maxWidth="max-w-2xl"
      noPadding
      labelId="board-settings-title"
      panelClassName="h-[85vh] max-h-[640px] min-h-0"
      headerBorder
    >

        {/* Tabs */}
        <div className="flex border-b border-line px-6 gap-1 overflow-x-auto">
          {/* #863: Webhooks is omitted from the DOM in demo mode and for non-admins, never DemoInert. */}
          {(["members", "display", "rules", "fields", "swimlane-fields", ...(isAdmin ? ["sharing"] : []), ...(isAdmin && !demoMode ? ["webhooks"] : []), "data"] as Tab[]).map((t) => {
            const label =
              t === "members" ? `Members (${members.length})`
              : t === "display" ? "Display"
              : t === "rules" ? "Rules"
              : t === "fields" ? "Card fields"
              : t === "swimlane-fields" ? "Swimlane fields"
              : t === "sharing" ? "Sharing"
              : t === "webhooks" ? "Webhooks"
              : "Data";
            return (
              <button
                key={t}
                ref={tab === t ? activeTabRef : undefined}
                aria-current={tab === t ? "true" : undefined}
                onClick={() => selectTab(t)}
                className={`py-2.5 px-1 mr-3 text-sm font-medium border-b-2 transition -mb-px rounded shrink-0 whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                  tab === t ? "border-primary-emphasis text-fg" : "border-transparent text-fg-tertiary hover:text-fg"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 px-6 py-4">
          {/* Hosted demo (#1179): ONE shared notice for the whole modal. Every
              admin control below sits in a DemoInert region that points its
              aria-describedby here, rather than repeating the reason per
              control. Shown only when there is something inert to explain —
              a non-admin visitor sees no admin controls, and their personal,
              browser-local view prefs keep working. */}
          {settingsInert && (
            <p
              id={DEMO_SETTINGS_NOTICE_ID}
              role="note"
              className="mb-4 rounded border border-primary-emphasis/30 bg-primary-emphasis/10 px-3 py-2.5 text-sm text-fg-secondary"
            >
              {DEMO_SETTINGS_REASON}
            </p>
          )}

          {/* ── Fields tab (#371) ── */}
          {tab === "fields" && (
            <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
            <BoardSettingsFieldsTab
              board={board}
              isAdmin={isAdmin}
              onFieldsUpdated={(definitions) => onFieldsUpdated?.(definitions)}
            />
            </DemoInert>
          )}

          {/* ── Swimlane fields tab (#1140) ── */}
          {tab === "swimlane-fields" && (
            <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
            <BoardSettingsSwimlaneFieldsTab
              board={board}
              isAdmin={isAdmin}
              onFieldsUpdated={(definitions) => onSwimlaneFieldsUpdated?.(definitions)}
              onUpdateBoardSettings={onUpdateBoardSettings}
            />
            </DemoInert>
          )}

          {/* ── Members tab ── */}
          {tab === "members" && (
            <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
            <div className="flex flex-col gap-0">
              <div className="flex items-center justify-between text-xs font-semibold text-fg-muted uppercase tracking-wide pb-2 mb-1 border-b border-line">
                <span>Member</span>
                <div className="flex items-center gap-1.5">
                  <span>Role</span>
                  <RoleTooltip />
                </div>
              </div>

              {members.map((m) => {
                const isRemoving = pendingRemove === m.user.id;
                const isDisabled = saving === m.user.id;
                // Lock only a membership-backed row (id !== null) that carries the
                // site-admin signal: the member endpoints refuse a change to an
                // existing site-admin membership, but accept one for a row with
                // no membership here (group-inherited, owner, or instance-wide
                // access) and create the membership (#1717). The signal is the
                // member's real flag, not `role`, whose "site_admin" value
                // reflects all-content access (#1290). When a row lacks the
                // field (e.g. a frame received before the viewer became an
                // admin), fall back to the role so a membership-backed row
                // fails closed rather than offering an edit that is refused.
                const isLocked =
                  m.id !== null && (m.is_site_admin ?? m.role === "site_admin") && !currentUserIsSiteAdmin;
                // All-content access resolves to full access before any
                // membership is consulted, so such a row shows the resolved
                // access (the "Full access" chip) instead of the stored role,
                // and says what the stored role is (#1301). A stored membership
                // can still be removed, unless the member is also a site admin
                // the server refuses to change (isLocked).
                const allContent = m.role === "site_admin" || m.has_all_content_access === true;
                const fullAccessDescId = `member-fullaccess-desc-${m.user.id}`;
                const storedRoleLabel = ROLES.find((r) => r.value === m.role)?.label;
                const canManage = isAdmin && !isLocked;
                const canRemove = canManage && m.id !== null;

                return (
                  <div key={m.user.id} className="py-2.5 border-b border-line/60 last:border-0">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Avatar user={m.user} size="sm" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-fg truncate">{userDisplayName(m.user)}</p>
                          {allContent && m.id !== null && storedRoleLabel && (
                            <p className="text-xs text-fg-tertiary">
                              Board role: {storedRoleLabel} — not in effect while this account has all-content access.
                            </p>
                          )}
                          {allContent && isLocked && (
                            <p className="text-xs text-fg-tertiary">
                              {LOCKED_MEMBERSHIP_NOTE}
                            </p>
                          )}
                          {allContent && currentUserIsSiteAdmin && (
                            <a
                              href="/admin?tab=users"
                              className="text-xs text-info underline hover:text-fg rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                            >
                              Manage in Admin → Users
                            </a>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {allContent ? (
                          <>
                            <span
                              ref={(el) => {
                                if (el) fullAccessChips.current.set(m.user.id, el);
                                else fullAccessChips.current.delete(m.user.id);
                              }}
                              tabIndex={0}
                              aria-disabled="true"
                              aria-describedby={fullAccessDescId}
                              title={isLocked ? `${FULL_ACCESS_DESCRIPTION} ${LOCKED_MEMBERSHIP_NOTE}` : FULL_ACCESS_DESCRIPTION}
                              className="inline-flex items-center gap-1 text-xs text-fg-secondary px-2 py-1 bg-surface-hover rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                            >
                              <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="5" cy="8" r="2.5" />
                                <path d="M7.5 8H14M12 8v2.5M10 8v1.5" />
                              </svg>
                              Full access
                            </span>
                            <span id={fullAccessDescId} className="sr-only">{isLocked ? `${FULL_ACCESS_DESCRIPTION} ${LOCKED_MEMBERSHIP_NOTE}` : FULL_ACCESS_DESCRIPTION}</span>
                          </>
                        ) : isLocked ? (
                          <span className="text-xs text-fg-secondary capitalize px-2 py-1 bg-surface-hover rounded" title="Site administrator — role managed at the instance level">
                            {m.role}
                          </span>
                        ) : canManage ? (
                          <SelectDropdown
                            value={m.role as BoardRole}
                            disabled={isDisabled}
                            onChange={(v) => handleRoleChange(m.user.id, v)}
                            options={ROLE_OPTIONS}
                            size="xs"
                          />
                        ) : (
                          <span
                            className="text-xs text-fg-secondary capitalize px-2 py-1 bg-surface-hover rounded"
                            title={ROLES.find((r) => r.value === m.role)?.description}
                          >
                            {m.role}
                          </span>
                        )}
                        {canRemove && !isRemoving && allContent && (
                          <button
                            ref={removeTriggerRef(m.user.id)}
                            onClick={() => setPendingRemove(m.user.id)}
                            disabled={isDisabled}
                            aria-label={`Remove board role for ${userDisplayName(m.user)}`}
                            className="text-xs text-fg-muted hover:text-danger transition disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                          >
                            Remove board role
                          </button>
                        )}
                        {canRemove && !isRemoving && !allContent && (
                          <button
                            ref={removeTriggerRef(m.user.id)}
                            onClick={() => setPendingRemove(m.user.id)}
                            disabled={isDisabled}
                            className="text-xs text-fg-muted hover:text-danger transition disabled:opacity-40 w-5 text-center"
                            title="Remove direct board role"
                          >
                            ✕
                          </button>
                        )}
                        {(allContent ? !canRemove && !isRemoving : !canRemove || isRemoving) && <span className="w-5" />}
                      </div>
                    </div>

                    {canManage && !allContent && (
                      <div className="mt-1 pl-9 flex items-center gap-2">
                        {m.role === "admin" ? (
                          // Admins implicitly have full moderator rights — show as checked+disabled
                          // so the UI accurately reflects their capabilities (#574).
                          <label className="flex items-center gap-1.5 select-none cursor-default" title="Admins have full moderator rights">
                            <input
                              type="checkbox"
                              checked
                              disabled
                              readOnly
                              className="rounded accent-primary border-line-strong bg-surface-hover text-info focus:ring-primary-emphasis focus:ring-offset-0 w-3.5 h-3.5 opacity-60 cursor-not-allowed"
                            />
                            <span className="text-xs text-fg-muted">Moderator</span>
                          </label>
                        ) : m.role === "member" ? (
                          <label className="flex items-center gap-1.5 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={m.is_moderator ?? false}
                              disabled={isDisabled}
                              onChange={() => handleModeratorToggle(m.user.id, m.role as BoardRole, m.is_moderator ?? false)}
                              className="rounded accent-primary border-line-strong bg-surface-hover text-info focus:ring-primary-emphasis focus:ring-offset-0 w-3.5 h-3.5"
                            />
                            <span className="text-xs text-fg-tertiary">Moderator</span>
                          </label>
                        ) : (
                          // Collaborator / Viewer — moderator entitlement is not available (#574).
                          <label className="flex items-center gap-1.5 select-none cursor-default" title="Moderator entitlement requires Member role or above">
                            <input
                              type="checkbox"
                              checked={false}
                              disabled
                              readOnly
                              className="rounded accent-primary border-line-strong bg-surface-hover text-info focus:ring-primary-emphasis focus:ring-offset-0 w-3.5 h-3.5 opacity-40 cursor-not-allowed"
                            />
                            <span className="text-xs text-fg-muted">Moderator</span>
                          </label>
                        )}
                        <span className="relative group/mod-info">
                          <span className="text-xs text-fg-tertiary cursor-default select-none" tabIndex={0} aria-label="What Moderator can do">ⓘ</span>
                          <div className="pointer-events-none absolute bottom-full left-0 mb-1.5 w-64 bg-sunken text-fg text-xs rounded px-2 py-1.5 shadow-lg opacity-0 group-hover/mod-info:opacity-100 focus-within:opacity-100 transition-opacity delay-300 z-10">
                            Can assign, edit, delete, and archive cards created by other members.
                          </div>
                        </span>
                      </div>
                    )}

                    {isRemoving && (
                      <div role="status" aria-live="polite" aria-atomic="true" className="mt-1.5 pl-9 flex items-center gap-2 text-xs">
                        <span className="text-fg-tertiary">
                          {allContent ? (
                            <>
                              Remove this board role? Full access is not affected.
                            </>
                          ) : (
                            <>
                              Remove <span className="text-fg font-medium">{userDisplayName(m.user)}</span> from this board?
                            </>
                          )}
                        </span>
                        <button
                          onClick={() => handleRemoveConfirm(m.user.id)}
                          aria-disabled={isDisabled || undefined}
                          className="text-danger hover:text-danger font-medium transition aria-disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => { if (!isDisabled) setPendingRemove(null); }}
                          aria-disabled={isDisabled || undefined}
                          className="text-fg-tertiary hover:text-fg transition aria-disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              {members.length === 0 && (
                <p className="text-sm text-fg-muted py-4 text-center">No members yet.</p>
              )}

              <p role="status" aria-live="polite" aria-atomic="true" className="text-xs h-4 mt-1">
                {memberActionError && <span className="text-danger">{memberActionError}</span>}
              </p>

              {isAdmin && (
                <div className="border-t border-line pt-4 mt-2">
                  <p className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-3">Add member</p>
                  <div className="flex flex-col gap-4">
                    <div className="relative">
                      <input
                        ref={searchInputRef}
                        value={inviteQuery}
                        onChange={(e) => { setInviteQuery(e.target.value); setInviteSuccess(null); }}
                        placeholder="Search by name or email…"
                        className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                      />
                      {(() => {
                        // #1444 — no account matched an email-shaped query:
                        // offer to send it an invite instead.
                        const q = inviteQuery.trim().replace(/^@/, "");
                        const show =
                          emailInviteAvailable &&
                          EMAIL_RE.test(q) &&
                          settledSearch !== null &&
                          settledSearch.query === q &&
                          settledSearch.count === 0;
                        if (!show) return null;
                        return (
                          <p className="text-xs text-fg-muted mt-1.5" role="status" aria-live="polite">
                            No results for <span className="text-fg-secondary">{q}</span>.{" "}
                            <button
                              type="button"
                              onClick={() => {
                                emailFormRef.current?.prefill(q);
                                setInviteQuery("");
                                setSuggestions([]);
                                setDropdownAnchor(null);
                                setSettledSearch(null);
                              }}
                              className="text-info hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                            >
                              Invite by email
                            </button>
                          </p>
                        );
                      })()}
                      {suggestions.length > 0 && dropdownAnchor && (
                        <div
                          ref={suggestionsRef}
                          data-testid="member-suggestions"
                          style={{
                            position: "fixed",
                            top: suggestionsTop ?? 0,
                            left: dropdownAnchor.left,
                            width: dropdownAnchor.width,
                            maxHeight: `calc(100vh - ${2 * POPOVER_VIEWPORT_MARGIN}px)`,
                            // Hidden only for the pre-paint measuring pass.
                            visibility: suggestionsTop === null ? "hidden" : undefined,
                          }}
                          className="bg-surface border border-line-strong rounded-lg shadow-xl z-[60] overflow-y-auto"
                        >
                          {suggestions.map((u) => (
                            <button
                              key={u.id}
                              type="button"
                              onMouseDown={(e) => { e.preventDefault(); addToStaged(u); }}
                              className="w-full text-left px-3 py-2.5 hover:bg-surface-hover transition flex items-center gap-2.5"
                            >
                              <Avatar user={u} size="sm" />
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-fg truncate">{userDisplayName(u)}</p>
                                <p className="text-xs text-fg-muted truncate">{u.email}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {staged.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">To be added</p>
                        <div className="flex flex-col gap-0">
                          {staged.map((s) => (
                            <div key={s.user.id} className="py-2.5 border-b border-line/60 last:border-0">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <Avatar user={s.user} size="sm" />
                                  <p className="text-sm text-fg truncate">{userDisplayName(s.user)}</p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <SelectDropdown
                                    value={s.role}
                                    onChange={(v) => {
                                      setStaged((prev) =>
                                        prev.map((x) => x.user.id === s.user.id ? { ...x, role: v } : x)
                                      );
                                      clearStagedError(s.user.id);
                                    }}
                                    options={ROLE_OPTIONS}
                                    size="xs"
                                    // Locked while the adds are in flight so the role that was sent
                                    // is the role that was added (#1299).
                                    disabled={inviting}
                                    ariaDescribedBy={stagedErrors[s.user.id] ? `staged-error-${s.user.id}` : undefined}
                                  />
                                  <button
                                    aria-describedby={stagedErrors[s.user.id] ? `staged-error-${s.user.id}` : undefined}
                                    onClick={() => {
                                      setStaged((prev) => prev.filter((x) => x.user.id !== s.user.id));
                                      clearStagedError(s.user.id);
                                    }}
                                    className="text-xs text-fg-muted hover:text-danger transition w-5 text-center"
                                    title="Remove from invite list"
                                    aria-label="Remove from invite list"
                                  >
                                    ✕
                                  </button>
                                </div>
                              </div>
                              {stagedErrors[s.user.id] && (
                                <p id={`staged-error-${s.user.id}`} role="alert" className="text-xs text-danger mt-1 pl-8 break-words">
                                  <span className="sr-only">{userDisplayName(s.user)}: </span>{stagedErrors[s.user.id]}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <p className="text-xs min-h-4" role="status" aria-live="polite" aria-atomic="true">
                      <span className={inviteError ? "text-danger" : inviteSuccess ? "text-success" : ""}>{inviteError ?? inviteSuccess ?? ""}</span>
                    </p>

                    <button
                      onClick={handleInviteSubmit}
                      disabled={staged.length === 0 || inviting}
                      className="w-full py-2 rounded bg-button-primary hover:bg-button-primary-hover text-on-primary text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      {inviting ? "Adding…" : staged.length > 0 ? `Add ${staged.length} member${staged.length !== 1 ? "s" : ""} to board` : "Add to board"}
                    </button>
                  </div>

                  {/* #1444 — invite someone without an account, and the
                      invites still pending. Admins only, like Add member. */}
                  <InviteLinkPanel
                    className="border-t border-line pt-4 mt-6"
                    scope={{ kind: "board", id: board.id }}
                    variant="embedded"
                    allowShareableLinks
                    escapePriority={49}
                    reloadSignal={inviteReloadSignal}
                    isSiteAdmin={currentUserIsSiteAdmin}
                    emailFormRef={emailFormRef}
                    onEmailAvailabilityChange={setEmailInviteAvailable}
                  />
                </div>
              )}
            </div>
            </DemoInert>
          )}

          {/* ── Rules tab ── */}
          {tab === "rules" && (
            <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
            <div className="flex flex-col gap-5">
              <p className="text-xs text-fg-muted">
                Rules affect all board members. Only admins can change these.
              </p>

              {/* WIP and weight limit enforcement */}
              {isAdmin && onUpdateBoardSettings ? (
                <section>
                  <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Limit enforcement</h3>
                  <div className="flex items-center justify-between py-2 border-b border-line/60">
                    <div className="min-w-0 pr-4">
                      <span className="text-sm text-fg">Enforce WIP limits</span>
                      <p className="text-xs text-fg-muted mt-0.5">
                        When enabled, moving, creating, or restoring a card into a column that is at or over its WIP limit is blocked. Admins can override.
                      </p>
                    </div>
                    <Toggle
                      checked={board.enforce_wip_limits}
                      onChange={(v) => onUpdateBoardSettings({ enforce_wip_limits: v })}
                      aria-label="Enforce WIP limits"
                    />
                  </div>
                  {/* Hard WIP mode — visually subordinated under the soft enforcement toggle */}
                  <div className="ml-6 border-l-2 border-line pl-4 py-2 border-b border-line/60">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 pr-4">
                        <span className="text-sm text-fg-secondary">Hard mode (no admin override)</span>
                        <p className="text-xs text-fg-muted mt-0.5">
                          Hard mode is active regardless of whether soft enforcement is on. When enabled, no one — including admins — can override a WIP block.
                        </p>
                      </div>
                      <Toggle
                        checked={board.enforce_wip_hard}
                        onChange={(v) => {
                          if (v) {
                            setPendingHardWip(true);
                          } else {
                            onUpdateBoardSettings({ enforce_wip_hard: false });
                          }
                        }}
                        aria-label="Hard mode (no admin override)"
                        buttonRef={hardWipTriggerRef("hard-wip")}
                      />
                    </div>
                    {pendingHardWip && (
                      <div className="mt-1.5 flex items-center gap-2 text-xs">
                        <span className="text-fg-tertiary">Enable hard mode? No one — including admins — will be able to bypass WIP limits.</span>
                        <button
                          onClick={() => {
                            onUpdateBoardSettings({ enforce_wip_hard: true });
                            setPendingHardWip(false);
                          }}
                          className="text-danger hover:text-danger font-medium transition rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setPendingHardWip(false)}
                          className="text-fg-tertiary hover:text-fg transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between py-2 border-b border-line/60">
                    <div className="min-w-0 pr-4">
                      <span className="text-sm text-fg">Enforce weight limits</span>
                      <p className="text-xs text-fg-muted mt-0.5">
                        When enabled, moving, creating, or restoring a card into a column that would exceed its weight budget, or raising a card's weight, is blocked. Admins can override. Columns must have a weight limit set for this to take effect.
                      </p>
                    </div>
                    <Toggle
                      checked={board.enforce_weight_limits}
                      onChange={(v) => onUpdateBoardSettings({ enforce_weight_limits: v })}
                      aria-label="Enforce weight limits"
                    />
                  </div>
                  <div className="flex items-center justify-between py-2 border-b border-line/60">
                    <div className="min-w-0 pr-4">
                      <span className="text-sm text-fg">Show at-limit WIP indicator</span>
                      <p className="text-xs text-fg-muted mt-0.5">
                        When enabled, a column's header shows a calm "WIP n/n" indicator in place of the card count once the column is exactly at its WIP limit. Ambient only — does not change move enforcement.
                      </p>
                    </div>
                    <Toggle
                      checked={board.show_wip_at_limit}
                      onChange={(v) => onUpdateBoardSettings({ show_wip_at_limit: v })}
                      aria-label="Show at-limit WIP indicator"
                    />
                  </div>
                </section>
              ) : (
                <section>
                  <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Limit enforcement</h3>
                  <div className="flex flex-col gap-1 py-1">
                    <p className="text-sm text-fg-secondary">
                      WIP limits:{" "}
                      {board.enforce_wip_hard
                        ? "enforced (no override)"
                        : board.enforce_wip_limits
                          ? "enforced"
                          : "informational only"}
                    </p>
                    <p className="text-sm text-fg-secondary">Weight limits: {board.enforce_weight_limits ? "enforced" : "informational only"}</p>
                    <p className="text-sm text-fg-secondary">At-limit WIP indicator: {board.show_wip_at_limit ? "shown" : "hidden"}</p>
                  </div>
                </section>
              )}

              {/* Card aging settings */}
              <section aria-labelledby="card-aging-heading">
                <h3 id="card-aging-heading" className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Card aging settings</h3>
                {isAdmin ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <input
                          id="staleness-threshold"
                          aria-label="Stale card threshold"
                          type="number"
                          min="1"
                          value={stalenessThreshold}
                          onChange={(e) => setStalenessThreshold(Number(e.target.value))}
                          onBlur={handleStalenessBlur}
                          className="bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 w-20 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
                        />
                        <span className="text-sm text-fg-tertiary">days threshold</span>
                      </div>
                      <p className="text-xs text-fg-muted">Cards idle beyond this threshold are shown with a stale tint on the board, which deepens at 2× and 3× the threshold. Warning tint appears earlier (controlled by the % setting below).</p>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <input
                          id="staleness-warning-pct"
                          aria-label="Heatmap warning percentage"
                          type="number"
                          min="0"
                          max="100"
                          value={stalenessWarningPct}
                          onChange={(e) => setStalenessWarningPct(Number(e.target.value))}
                          onBlur={handleStalenessWarningPctBlur}
                          className="bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 w-20 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
                        />
                        <span className="text-sm text-fg-tertiary">% warning</span>
                      </div>
                      <p className="text-xs text-fg-muted">
                        Warning tint appears when a card has used this percentage of the threshold. Example: 14 days threshold, 50% warning → warning tint after 7 days, stale tint at 14 days. Set 0 to turn the warning tint off.
                      </p>
                    </div>
                    <p className="text-xs h-4">
                      {cardAgingError && <span className="text-danger">{cardAgingError}</span>}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-fg-secondary">{board.staleness_threshold_days ?? 14} days · {board.stale_warning_pct ?? 50}% warning</p>
                )}
              </section>
            </div>
            </DemoInert>
          )}

          {/* ── Sharing tab (admin-only) ── */}
          {tab === "sharing" && isAdmin && (
            <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
            <div className="flex flex-col gap-5">
              <section>
                <h3 ref={shareHeadingRef} tabIndex={-1} className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2 focus:outline-none">Public sharing</h3>
                <p className="text-xs text-fg-muted mb-4">
                  Anyone with this link can view this board without signing in. They cannot edit, comment, or see member details.
                </p>

                {/* Toggle row */}
                <div className="flex items-center justify-between py-2 border-b border-line/60 mb-3">
                  <span className="text-sm text-fg">Enable public share link</span>
                  <Toggle
                    checked={shareActive}
                    disabled={shareLoading}
                    onChange={() => {
                      if (shareActive) {
                        // handleDisableShare manages its own loading/error state (shareStatus) and never rejects.
                        void handleDisableShare();
                      } else {
                        // handleEnableShare manages its own loading/error state (shareStatus) and never rejects.
                        void handleEnableShare();
                      }
                    }}
                    aria-label="Enable public share link"
                  />
                </div>

                {/* One-time reveal (#1935) — right after enable or rotate. The
                    link is never fetched again, so this is the only chance to
                    copy it. */}
                {shareActive && shareUrl && (
                  <div ref={shareRevealRef} className="flex flex-col gap-2 transition-all duration-150" data-testid="share-link-reveal">
                    <p className="text-xs text-warning" id="share-reveal-note">
                      Copy this link now — it won't be shown again. If you lose it, rotate the link to get a new one.
                    </p>
                    <div
                      className="font-mono text-xs bg-sunken border border-warning/50 rounded px-2 py-1.5 text-fg truncate select-all"
                      title={shareUrl}
                    >
                      {shareUrl}
                    </div>
                    <div className="flex gap-2">
                      <button
                        ref={copyShareButtonRef}
                        type="button"
                        // handleCopyShareUrl manages its own copied/error state (shareStatus) and never rejects.
                        onClick={() => void handleCopyShareUrl()}
                        aria-describedby="share-reveal-note"
                        className="text-xs bg-button-primary text-on-primary px-3 py-1.5 rounded hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
                      >
                        {shareCopied ? "Copied!" : "Copy"}
                      </button>
                      <button
                        type="button"
                        onClick={handleDismissShareReveal}
                        aria-label="Done, hide the share link"
                        className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}

                {/* Active link that is not on screen (the modal was opened
                    later, or the admin clicked Done): say that it exists. */}
                {shareActive && !shareUrl && (
                  <p className="text-sm text-fg" data-testid="share-link-active">
                    A public share link is active.
                  </p>
                )}

                {/* Expiry indicator — the expiry of the link that is set now.
                    A dead (expired) link is called out in the warning tone. */}
                {shareActive && (
                  <p
                    className={`text-xs ${shareExpired ? "text-warning" : "text-fg-muted"} ${shareUrl ? "mt-2" : "mt-1 mb-3"}`}
                    data-testid="share-expiry-line"
                  >
                    {shareExpiryLabel}
                  </p>
                )}

                {/* Sharing OFF: expiry of the link about to be created. */}
                {!shareActive && (
                  <>
                    {renderShareTtlRow("Expires in", "share-ttl-help")}
                    <p id="share-ttl-help" className="text-xs text-fg-muted -mt-2 mb-3">
                      The link turns off automatically if you lose admin access to this board.
                    </p>
                  </>
                )}

                {/* Active link not on screen: Rotate is the way to get a link to
                    copy. It is only meaningful while the toggle is on, so it is a
                    subordinate block, grouped with the select that sets the
                    replacement link's expiry (an issued link's expiry is fixed).
                    Disabling is the toggle above. */}
                {shareActive && !shareUrl && (
                  <>
                    <p className="text-xs text-fg-muted mb-3">
                      The link turns off automatically if you lose admin access to this board.
                    </p>
                    <div className="ml-6 border-l-2 border-line pl-4 flex flex-col items-start gap-2">
                      <p className="text-xs text-fg-muted" id="share-rotate-help">
                        The link is shown only once, when it is created. To get a link you can copy, rotate it: the current link stops working.
                      </p>
                      {renderShareTtlRow("New link expires in", "share-rotate-help")}
                      <button
                        ref={rotateShareButtonRef}
                        type="button"
                        disabled={shareLoading}
                        // handleEnableShare manages its own loading/error state (shareStatus) and never rejects.
                        onClick={() => void handleEnableShare("Failed to rotate the link. Please try again.")}
                        aria-describedby="share-rotate-help"
                        className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Rotate link
                      </button>
                    </div>
                  </>
                )}

                {/* Status row — always reserve height; a live region so enable,
                    rotate, disable and copy results are announced. */}
                <p className="text-xs min-h-4 mt-2" role="status" aria-live="polite" aria-atomic="true">
                  {shareStatus ? (
                    <span className="text-danger">{shareStatus}</span>
                  ) : shareCopied ? (
                    <span className="text-success">Link copied.</span>
                  ) : shareNotice ? (
                    <span className="text-fg-secondary">{shareNotice}</span>
                  ) : null}
                </p>
              </section>
            </div>
            </DemoInert>
          )}

          {/* ── Webhooks tab (#863) ── */}
          {tab === "webhooks" && isAdmin && !demoMode && (
            <BoardSettingsWebhooksTab
              boardId={board.id}
              focusFirstStopped={webhookDeepLinkLive}
              currentUserHasPassword={currentUserHasPassword}
              registerCloseGuard={registerWebhookCloseGuard}
              onRequestClose={onClose}
            />
          )}

          {/* ── Data tab ── */}
          {tab === "data" && (
            <div className="flex flex-col gap-6">
              <section>
                <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Export permission</h3>
                {isAdmin ? (
                  <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
                    <p className="text-xs text-fg-muted mb-2">
                      Choose who can use the export action and download export files. This does not change what members can view on the board. Owners and site admins always bypass this threshold.
                    </p>
                    <SelectDropdown
                      value={exportMinRole}
                      onChange={(v) => handleExportMinRoleChange(v as BoardExportMinRole)}
                      options={[
                        { value: "viewer", label: "Anyone with read access (default)" },
                        { value: "collaborator", label: "Collaborators and above" },
                        { value: "member", label: "Members and above" },
                        { value: "admin", label: "Admins only" },
                      ]}
                    />
                    <p className="text-xs h-4 mt-1">
                      {exportRoleError && <span className="text-danger">{exportRoleError}</span>}
                    </p>
                  </DemoInert>
                ) : (
                  <p className="text-sm text-fg-secondary">
                    {exportMinRole === "viewer" && "Anyone with read access can export this board."}
                    {exportMinRole === "collaborator" && "Collaborators and above can export this board."}
                    {exportMinRole === "member" && "Members and above can export this board."}
                    {exportMinRole === "admin" && "Only admins can export this board."}
                  </p>
                )}
              </section>

              {/* Issue board lens — admin-only, gated on the instance feature flag. */}
              {isAdmin && gitLensEnabled && (
                <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
                <section>
                  <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Issue board lens</h3>
                  <p className="text-xs text-fg-muted mb-2">
                    Mirror a public GitHub or GitLab repository's issues as a read-only board.
                  </p>
                  {lensConnection ? (
                    <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-line-strong">
                      <div className="min-w-0">
                        <p className="text-sm text-fg font-medium truncate" title={lensConnection.repo_slug}>
                          {lensConnection.repo_slug}
                        </p>
                        <p className="text-xs text-fg-muted">
                          {lensConnection.provider === "github" ? "GitHub" : "GitLab"} · read-only
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => onManageLens?.()}
                        className="shrink-0 text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 text-sm rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                      >
                        Manage
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onManageLens?.()}
                      className="bg-button-primary hover:bg-button-primary-hover text-on-primary text-sm font-medium py-2 px-4 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      Connect a repository
                    </button>
                  )}
                </section>
                </DemoInert>
              )}

              {canExport && (
              <section>
                <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Export</h3>
                <div className="flex flex-col gap-2">
                  {(["json", "csv"] as const).map((fmt) => (
                    <label
                      key={fmt}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-emphasis ${
                        exportFormat === fmt
                          ? "border-primary-emphasis bg-primary-emphasis/10"
                          : "border-line-strong hover:bg-surface-hover/40"
                      }`}
                    >
                      <input
                        type="radio"
                        name="export-format"
                        value={fmt}
                        checked={exportFormat === fmt}
                        onChange={() => setExportFormat(fmt)}
                        className="sr-only"
                      />
                      <div>
                        <span className="text-sm text-fg font-medium">{fmt.toUpperCase()}</span>
                        <p className="text-xs text-fg-muted mt-0.5">
                          {fmt === "json"
                            ? "Full history: movements, activity log, and assignees"
                            : "Card data only, no history"}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
                <button
                  onClick={() => { if (exportFormat === "json") { exportBoardJson(board.id); } else { exportBoardCsv(board.id); } onClose(); }}
                  className="w-full mt-3 bg-button-primary hover:bg-button-primary-hover text-on-primary text-sm font-medium py-2 px-4 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  Export {exportFormat.toUpperCase()}
                </button>
              </section>
              )}

              {isAdmin && (
                <section>
                  <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Export history</h3>
                  {exportHistoryLoading && (
                    <div className="flex items-center gap-2 text-sm text-fg-tertiary">
                      <span className="inline-block w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      Loading export history…
                    </div>
                  )}
                  <p className="text-sm h-5 mt-1">
                    {exportHistoryError && <span className="text-danger">{exportHistoryError}</span>}
                  </p>
                  {!exportHistoryLoading && !exportHistoryError && exportHistory && exportHistory.length === 0 && (
                    <p className="text-sm text-fg-muted">No exports have been recorded for this board yet.</p>
                  )}
                  {!exportHistoryLoading && exportHistory && exportHistory.length > 0 && (
                    <ul className="flex flex-col divide-y divide-line">
                      {exportHistory.map((entry) => (
                        <li key={entry.id} className="py-2 flex flex-col gap-0.5">
                          <div className="flex items-center justify-between text-sm text-fg">
                            <span className="truncate">
                              {entry.actor ? userDisplayName(entry.actor) : "(deactivated user)"}
                            </span>
                            <span className="font-mono text-xs text-fg-muted">
                              {new Date(entry.created_at).toLocaleString()}
                            </span>
                          </div>
                          <div className="text-xs text-fg-muted">
                            {entry.actor_role_label} — {formatExportFormatLabel(entry.export_format)} · {formatExportRowCount(entry.export_format, entry.row_count)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {isAdmin && onBoardDeleted && (
                <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
                <section className="border-t border-line pt-5">
                  <h3 className="text-xs font-semibold text-danger uppercase tracking-wide mb-3">Danger Zone</h3>
                  {deleteError && (
                    <p role="alert" className="text-xs text-danger mb-2">{deleteError}</p>
                  )}
                  {!userCanDeleteBoard ? (
                    <p ref={deleteNoteRef} tabIndex={-1} className="text-sm text-fg-tertiary focus:outline-none">
                      Only the board owner ({board.owner?.display_name || board.owner?.username || "unknown"}) or a site administrator can delete this board.
                    </p>
                  ) : (
                  <>
                  <p className="text-sm text-fg-tertiary mb-3">
                    Permanently delete <span className="text-fg font-medium">{board.name}</span> and all its cards (including archived cards), columns, and history. This cannot be undone.
                  </p>
                  {/* Archived cards are not in board.cards but cascade with the
                      board, so they count toward the typed-confirmation gate
                      exactly like active cards (#1289). */}
                  <div className="flex flex-col gap-2">
                    {deleteArmed && (
                      <>
                        {(board.archived_card_count ?? 0) > 0 && (
                          <p className="text-xs text-danger">
                            This board has {board.archived_card_count} archived card{board.archived_card_count !== 1 ? "s" : ""}, which will also be permanently deleted.
                          </p>
                        )}
                        <p id="board-delete-confirm-hint" className="text-xs text-fg-muted">
                          Type <span className="text-fg-secondary font-mono">{board.name}</span> to confirm deletion.
                        </p>
                        <input
                          type="text"
                          ref={deleteInputRef}
                          value={deleteInput}
                          onChange={(e) => { if (!deleting) setDeleteInput(e.target.value); }}
                          readOnly={deleting}
                          aria-label="Type the board name to confirm deletion"
                          placeholder={board.name}
                          className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                        />
                      </>
                    )}
                    <button
                      type="button"
                      aria-disabled={deleting || !deleteReady}
                      aria-describedby={deleteArmed ? "board-delete-confirm-hint" : undefined}
                      onClick={deleteBoardNow}
                      className={`w-full bg-danger-bg text-on-danger text-sm font-medium py-2 px-4 rounded transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis ${deleting || !deleteReady ? "opacity-40 cursor-not-allowed" : "hover:bg-danger-bg-hover"}`}
                    >
                      {deleting ? "Deleting…" : "Delete board"}
                    </button>
                  </div>
                  </>
                  )}
                </section>
                </DemoInert>
              )}
            </div>
          )}

          {/* ── Display tab ── */}
          {tab === "display" && (
            <div className="flex flex-col gap-5">
              {/* Card density (#961) — per-board admin setting that drives the
                  card metadata layout. Replaces the prior per-user per-field
                  hide toggles (Labels / Due date / Assignee / Priority badge /
                  Last moved). New boards default to ``comfortable``; existing
                  boards were migrated to ``dense`` so they keep their pre-1.1
                  visual until an admin chooses otherwise. #974 layers a
                  per-user override (comfortable/standard/dense/follow-default)
                  on top of this board default — see the toggle below. */}
              <section aria-labelledby="card-density-heading">
                <h3 id="card-density-heading" className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Card density</h3>
                {isAdmin && onUpdateBoardSettings ? (
                  <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
                  <fieldset
                    className="flex flex-col gap-2 transition-colors duration-150"
                    aria-describedby={densityPresetSource?.via === "board-default" ? DENSITY_SET_BY_PRESET_ID : undefined}
                  >
                    <legend className="sr-only">Card density</legend>
                    {([
                      { value: "comfortable", label: "Comfortable", description: "One urgency badge (carries the date when overdue or due soon), one primary label, assignee. Future due dates move to the hover peek. Best for new boards." },
                      { value: "standard",    label: "Standard",    description: "Adds a standalone due-date pill for non-urgent dates, plus weight and attachment counts on the card face." },
                      { value: "dense",       label: "Dense",       description: "Today's full layout — every metadata field, no urgency badge or peek required." },
                    ] as const).map(({ value, label, description }) => {
                      const checked = board.card_density === value;
                      return (
                        <label
                          key={value}
                          className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-emphasis ${
                            checked
                              ? "border-primary-emphasis bg-primary-emphasis/10"
                              : "border-line-strong hover:bg-surface-hover/40"
                          }`}
                        >
                          <input
                            type="radio"
                            name="card-density"
                            value={value}
                            checked={checked}
                            onChange={() => onUpdateBoardSettings({ card_density: value })}
                            className="sr-only"
                          />
                          <span className="flex-1">
                            <span className="block text-sm text-fg font-medium">{label}</span>
                            <span className="block text-xs text-fg-muted mt-0.5">{description}</span>
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                  </DemoInert>
                ) : (
                  <p className="text-sm text-fg-secondary">
                    This board is set to <span className="font-medium text-fg capitalize">{board.card_density}</span> by default. Only board admins can change this — you can override it for your own view below.
                  </p>
                )}

                {/* #1146 — a preset now writes density too. Say so, or the radio
                    above and the toggle below can both look unrelated to what
                    the board shows. */}
                {/* When the preset wrote the personal key, the toggle below says so
                    instead (one statement of the source, not two that read as a
                    contradiction); this line covers a board default preset, which
                    writes no key. */}
                {densityPresetSource?.via === "board-default" && effectiveCardDensity && (
                  <p id={DENSITY_SET_BY_PRESET_ID} data-testid="density-set-by-preset" className="text-xs text-fg-tertiary mt-2">
                    Set by preset “{densityPresetSource.presetName}”: your view shows <span className="capitalize">{effectiveCardDensity}</span> density.
                  </p>
                )}

                {/* #974 — per-user density override, layered on top of the
                    board default above. Gated on its own callback prop,
                    independent of the isAdmin/viewPrefs gates elsewhere in
                    this tab: density override and column/swimlane
                    visibility are unrelated personal-settings concerns that
                    happen to share this section, and admins may want a
                    personal view that differs from the team default they
                    themselves set. */}
                {onSetCardDensityOverride && (
                  <div className="mt-3">
                    <ToggleField
                      checked={cardDensityOverride !== null}
                      onChange={(next) => {
                        if (next) {
                          // Seed with the density the member sees now (#1146): under
                          // a board default preset that sets one, that is not
                          // board.card_density, and seeding that would change their view.
                          const initial = lastPickedDensity ?? effectiveCardDensity ?? board.card_density;
                          setLastPickedDensity(initial);
                          onSetCardDensityOverride(initial);
                        } else {
                          onSetCardDensityOverride(null);
                        }
                      }}
                      label="Use my own density"
                      labelSize="xs"
                      descriptionId={DENSITY_OVERRIDE_DESCRIPTION_ID}
                      aria-describedby={DENSITY_OVERRIDE_DESCRIPTION_ID}
                      description={
                        cardDensityOverride !== null && densityPresetSource?.via === "own-key"
                          ? `Set by preset “${densityPresetSource.presetName}” for your view only — stored in your browser. Turn this off to use ${densityPresetSource.offFallsBackTo === "board-default-preset" ? "the board default preset's density" : "the board's density"}${densityPresetSource.offChangesDensity ? "; the preset will then show as Modified." : "."}`
                          : cardDensityOverride !== null
                          ? "Overriding the board default for your view only — stored in your browser."
                          : "Following the board default for your view."
                      }
                    />

                    {cardDensityOverride !== null && (
                      <fieldset
                        className="flex flex-col gap-2 mt-2 ml-6 border-l-2 border-line pl-4"
                        aria-describedby={densityPresetSource?.via === "own-key" ? DENSITY_OVERRIDE_DESCRIPTION_ID : undefined}
                      >
                        <legend className="sr-only">Your personal density override</legend>
                        {([
                          { value: "comfortable", label: "Comfortable", description: "One urgency badge (carries the date when overdue or due soon), one primary label, assignee. Future due dates move to the hover peek. Best for new boards." },
                          { value: "standard",    label: "Standard",    description: "Adds a standalone due-date pill for non-urgent dates, plus weight and attachment counts on the card face." },
                          { value: "dense",       label: "Dense",       description: "Today's full layout — every metadata field, no urgency badge or peek required." },
                        ] as const).map(({ value, label, description }) => {
                          const checked = cardDensityOverride === value;
                          return (
                            <label
                              key={value}
                              className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-emphasis ${
                                checked
                                  ? "border-primary-emphasis bg-primary-emphasis/10"
                                  : "border-line-strong hover:bg-surface-hover/40"
                              }`}
                            >
                              <input
                                type="radio"
                                name="personal-card-density"
                                value={value}
                                checked={checked}
                                onChange={() => {
                                  setLastPickedDensity(value);
                                  onSetCardDensityOverride(value);
                                }}
                                className="sr-only"
                              />
                              <span className="flex-1">
                                <span className="block text-sm text-fg font-medium">{label}</span>
                                <span className="block text-xs text-fg-muted mt-0.5">{description}</span>
                              </span>
                            </label>
                          );
                        })}
                      </fieldset>
                    )}
                  </div>
                )}
              </section>

              {/* Default preset (#1146) — board admin setting, read-only line for
                  everyone else, same split as Card density above. Presets are
                  code-defined in 1.3; this stores only which one is the default. */}
              <section aria-labelledby="default-preset-heading">
                <h3 id="default-preset-heading" className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Board default preset</h3>
                {isAdmin && onUpdateBoardSettings ? (
                  <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
                  <fieldset className="flex flex-col gap-2 transition-colors duration-150" aria-describedby="default-preset-help">
                    <legend className="sr-only">Board default preset</legend>
                    {[
                      { value: null, label: "None", description: "No preset is applied unless a member picks one." },
                      ...listBoardPresets().map((p) => ({ value: p.id as BoardPresetId | null, label: p.name, description: p.description })),
                    ].map(({ value, label, description }) => {
                      const checked = (board.default_preset ?? null) === value;
                      return (
                        <label
                          key={value ?? "none"}
                          className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-emphasis ${
                            checked
                              ? "border-primary-emphasis bg-primary-emphasis/10"
                              : "border-line-strong hover:bg-surface-hover/40"
                          }`}
                        >
                          <input
                            type="radio"
                            name="default-preset"
                            value={value ?? ""}
                            checked={checked}
                            onChange={() => onUpdateBoardSettings({ default_preset: value })}
                            className="sr-only"
                          />
                          <span className="flex-1">
                            <span className="block text-sm text-fg font-medium">{label}</span>
                            <span className="block text-xs text-fg-muted mt-0.5">{description}</span>
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                  </DemoInert>
                ) : (
                  <p className="text-sm text-fg-secondary">
                    {getBoardPreset(board.default_preset) ? (
                      <>This board's default preset is <span className="font-medium text-fg">{getBoardPreset(board.default_preset)?.name}</span>. Only board admins can change this.</>
                    ) : (
                      <>This board has no default preset. Only board admins can change this.</>
                    )}
                  </p>
                )}
                <p id="default-preset-help" className="text-xs text-fg-tertiary mt-2">
                  Members who have not picked a preset in the board toolbar see this one. Their own choice, or a link with a preset, comes first.
                </p>
              </section>

              {viewPrefs && onToggleHiddenColumn && onToggleHiddenSwimlane && (
                <>
                  <p className="text-xs text-fg-muted">
                    The settings below are personal and stored in your browser. They do not affect what other users see.
                  </p>

                  {/* Columns */}
                  {board.columns.length > 0 && (
                    <section>
                      <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Columns</h3>
                      <div className="flex flex-col gap-0">
                        {board.columns.map((col) => {
                          const isHidden = viewPrefs.hiddenColumnIds.includes(col.id);
                          return (
                            <label
                              key={col.id}
                              className="flex items-center justify-between py-2 border-b border-line/60 last:border-0 cursor-pointer group"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="color-dot w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                                <span className={`text-sm truncate ${isHidden ? "text-fg-muted line-through" : "text-fg"}`}>
                                  {col.name}
                                </span>
                              </div>
                              <input
                                type="checkbox"
                                checked={!isHidden}
                                onChange={() => onToggleHiddenColumn(col.id)}
                                className="w-4 h-4 rounded accent-primary shrink-0"
                              />
                            </label>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {/* Swimlanes */}
                  {board.swimlanes.length > 0 && (
                    <section>
                      <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Swimlanes</h3>
                      <div className="flex flex-col gap-0">
                        {board.swimlanes.map((lane) => {
                          const isHidden = viewPrefs.hiddenSwimlaneIds.includes(lane.id);
                          return (
                            <label
                              key={lane.id}
                              className="flex items-center justify-between py-2 border-b border-line/60 last:border-0 cursor-pointer group"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="color-dot w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: lane.color }} />
                                <span className={`text-sm truncate ${isHidden ? "text-fg-muted line-through" : "text-fg"}`}>
                                  {lane.name}
                                </span>
                              </div>
                              <input
                                type="checkbox"
                                checked={!isHidden}
                                onChange={() => onToggleHiddenSwimlane(lane.id)}
                                className="w-4 h-4 rounded accent-primary shrink-0"
                              />
                            </label>
                          );
                        })}
                      </div>
                    </section>
                  )}

                </>
              )}

            </div>
          )}
        </div>

        {tab === "members" && (
          <div className="px-6 py-3 border-t border-line text-xs text-fg-muted">
            Members inherited from group membership are shown here. Assigning a direct role overrides group access.
          </div>
        )}
    </ModalWrapper>
  );
}
