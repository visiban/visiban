import HelpLink from "../Common/HelpLink";
import type { SocketStatus } from "../../hooks/useBoardSocket";
import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import ModalWrapper from "../shared/ModalWrapper";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
import { useConfirmAnnouncement } from "../../hooks/useConfirmAnnouncement";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { formatShortcut } from "../../utils/platform";
import { useIsPhoneViewport } from "../../hooks/useIsPhoneViewport";
import {
  SECTION_GROUPS,
  SECTION_LABELS,
  findSettings,
  settingKey,
  locateSettingTarget,
  resolveInitialSection,
  type SettingEntry,
  type SettingsInitialSection,
  type SettingsSection,
} from "./boardSettingsSections";
import { useToast } from "../../contexts/useToast";
import { canDeleteBoard } from "../../utils/canDeleteBoard";
import { POPOVER_VIEWPORT_MARGIN, useInputAnchoredPlacement, visibleMaxHeight } from "../../hooks/useAnchoredPlacement";
import SelectDropdown from "../Common/SelectDropdown";
import { resolveRollupField } from "../../utils/laneRollup";
import HealthReviewDaysInput from "../Common/HealthReviewDaysInput";
import HealthOffTrackInput from "../Common/HealthOffTrackInput";
import { HealthComputedTime, HealthRecomputeButton } from "../Common/HealthComputedBlock";
import { applyHealthRecompute, pickBoardHealth } from "../../utils/healthStatus";
import RoleInfoTooltip from "../Common/RoleInfoTooltip";
import type { BoardFull, BoardPresetId, CardDensity, CustomFieldDefinition, CustomFieldSet, EffectiveBoardMember, LensConnection, Swimlane, SwimlaneCustomFieldDefinition, User } from "../../types";
import BoardSettingsFieldsTab from "./BoardSettingsFieldsTab";
import BoardSettingsFieldSetsSection, { type FieldSetCloseGuard } from "./BoardSettingsFieldSetsSection";
import BoardSettingsSwimlaneFieldsTab from "./BoardSettingsSwimlaneFieldsTab";
import BoardSettingsWebhooksTab, { type WebhookCloseGuard } from "./BoardSettingsWebhooksTab";
import { userDisplayName } from "../../types";
import type { Column } from "../../types";
import BoardSettingsPoliciesSection from "./BoardSettingsPoliciesSection";
import { exportBoardCsv, exportBoardJson, patchColumn, setBoardMember, removeBoardMember, deleteBoard, patchBoard, enableBoardSharing, disableBoardSharing, getBoardExportHistory, recomputeBoardHealth } from "../../api/boards";
import type { BoardExportLogEntry, BoardExportMinRole, BoardMembership, WebhookChangedPayload } from "../../types";
import type { BoardRole } from "../../api/boards";
import { searchUsers } from "../../api/auth";
import type { ViewPrefs } from "../../hooks/useViewPrefs";
import Avatar from "../Common/Avatar";
import { Toggle, ToggleField } from "../Common/Toggle";
import ChildCardsSettings from "./ChildCardsSettings";
import BoardDeleteImpactNotice from "./BoardDeleteImpact";
import DemoInert from "../Common/DemoInert";
import { getBoardPreset, listBoardPresets } from "../../boardPresets/registry";
import type { PresetDensitySource } from "../../hooks/useBoardPreset";
import InviteLinkPanel from "../Group/InviteLinkPanel";
import { EMAIL_RE } from "../../constants/inviteEmail";
import type { EmailInviteFormHandle } from "../Common/EmailInviteForm";
import { DEMO_SETTINGS_REASON } from "../../constants/demoCopy";
import { LOCKED_MEMBERSHIP_NOTE } from "../../constants/membership";
import { formatExportFormatLabel, formatExportRowCount } from "../../utils/exportHistory";

// Chip tooltip and accessible description for a member whose all-content access
// overrides their board role (#1301).
// Shared by the visible prompt and its announcement so they cannot drift apart.
const ASSIGNEE_OVERRIDE_PROMPT = "Let assignees move their cards anyway? A card's assignee can move it past Block limits with a reason, unless they assigned it to themselves.";
const HARD_WIP_PROMPT = "Enable hard mode? No one, including admins, will be able to bypass WIP limits.";
const FULL_ACCESS_DESCRIPTION = "Full access to all boards. This account's board role doesn't apply.";


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
  initialTab?: SettingsInitialSection;
  /** #863 — opened from a `webhook_disabled` notification: the Webhooks tab focuses the first webhook that was turned off automatically. */
  focusFirstStoppedWebhook?: boolean;
  /** #2057 — the latest `webhook.changed` frame; the Webhooks tab refetches on each. */
  webhookChange?: (WebhookChangedPayload & { seq: number }) | null;
  /** #2057 — bumped on each board-socket reconnect; the Webhooks tab re-reads its list on each. */
  webhookReconnectSignal?: number;
  /** #2403 — the board socket's state, for the Webhooks tab's "Live updates paused" banner. */
  webhookSocketStatus?: SocketStatus;
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
  /** May resolve with the request's error (null on success), so a control can say why it was refused. */
  onUpdateBoardSettings?: (patch: Record<string, unknown>) => void | Promise<unknown>;
  /** Rules > Child cards "Show the N cards": the host closes settings and applies the Parent filter (#2448). */
  onShowChildCards?: () => void;
  /**
   * #2244: merge server-resolved fields from a non-optimistic save (the review
   * setting's `health_review_due_at` is computed by the server), so the header
   * cue updates even when the socket is down.
   */
  onMergeBoardFields?: (patch: Partial<BoardFull>) => void;
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
  /** #2570 — apply a field-set change (an updater, or the whole list). */
  onFieldSetsUpdated?: (sets: CustomFieldSet[] | ((prev: CustomFieldSet[]) => CustomFieldSet[])) => void;
  onSwimlaneFieldsUpdated?: (definitions: SwimlaneCustomFieldDefinition[]) => void;
  /** #2245: merge a recomputed lane (resolver form of useBoard's updateSwimlane). */
  onUpdateSwimlane?: (resolver: (board: BoardFull) => Swimlane) => void;
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
  /** #2156 — called with the server's column after the Rules tab saves a column
   *  policy, so the board (and the column header's Policy button) update
   *  without waiting for the socket echo. */
  onColumnUpdated?: (column: Column) => void;
}

const DEMO_SETTINGS_NOTICE_ID = "board-settings-demo-notice";
// #1146 — the two places Display names a preset as the density's source. Each is
// referenced with aria-describedby by the control it explains.
const DENSITY_SET_BY_PRESET_ID = "density-set-by-preset";
const DENSITY_OVERRIDE_DESCRIPTION_ID = "density-override-description";
const HEALTH_AUTO_DESCRIPTION_ID = "health-auto-description";

/** #1967 — true when share link issue time `a` is later than `b`. Falls back
 *  to "different" when either value does not parse, so a malformed value can
 *  only withdraw a reveal, never keep a dead link on screen. */
function isLaterShareIssue(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a !== b;
  return ta > tb;
}

type Tab = SettingsSection;

interface StagedInvite {
  user: User;
  role: BoardRole;
}

const ADD_FALLBACK_ERROR = "Couldn't add this member.";

/** The server refuses to demote or remove the board owner's membership (#1828). */
const OWNER_MEMBERSHIP_NOTE = "The board owner is always an admin and cannot be removed.";
const OWNER_PROTECTED_CODE = "board_owner_protected";

/** True for the 400 the member endpoints send when the owner's membership is targeted. */
function isOwnerProtectedError(err: unknown): boolean {
  const data = (err as { response?: { data?: { code?: unknown } } })?.response?.data;
  return data?.code === OWNER_PROTECTED_CODE;
}

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

export default function BoardSettingsModal({ board, isAdmin, onClose, initialTab, onBoardDeleted, onBoardDeleting, onBoardDeleteFailed, currentUserId, onDeleteForbidden, viewPrefs, onToggleHiddenColumn, onToggleHiddenSwimlane, onUpdateBoardSettings, onShowChildCards, onMergeBoardFields, cardDensityOverride = null, onSetCardDensityOverride, densityPresetSource = null, effectiveCardDensity, gitLensEnabled = false, lensConnection = null, onManageLens, onFieldsUpdated, onFieldSetsUpdated, onSwimlaneFieldsUpdated, onUpdateSwimlane, demoMode = false, currentUserIsSiteAdmin = false, inviteReloadSignal, onMembersAdded, onShareChanged, shareLinkIssuedAt = null, focusFirstStoppedWebhook = false, webhookChange = null, webhookReconnectSignal = 0, webhookSocketStatus, currentUserHasPassword = true, onColumnUpdated }: Props) {
  // The Child cards switch (#1104): the server refuses a flip while card links
  // depend on the flag (400). Say why, instead of the silent revert the
  // sibling switches do.
  const [childCardsError, setChildCardsError] = useState<string | null>(null);
  const flipChildCards = async (value: boolean) => {
    setChildCardsError(null);
    const err = await onUpdateBoardSettings?.({ cards_can_have_children: value });
    if (!err) return;
    const data = (err as { response?: { status?: number; data?: { cards_can_have_children?: unknown; detail?: unknown } } })?.response?.data;
    const fieldMsg = Array.isArray(data?.cards_can_have_children) ? data?.cards_can_have_children[0] : undefined;
    setChildCardsError(
      typeof fieldMsg === "string" && fieldMsg
        ? fieldMsg
        : typeof data?.detail === "string" && data.detail
          ? data.detail
          : "Failed to change the Child cards setting. Please try again.",
    );
  };
  const settingsInert = demoMode && isAdmin;
  const isPhone = useIsPhoneViewport();
  const availableSections = new Set<Tab>(["members", "display", "rules", "fields", "field-sets", "swimlane-fields", "export"]);
  if (isAdmin) availableSections.add("sharing");
  if (isAdmin && !demoMode) availableSections.add("webhooks");
  if (isAdmin && gitLensEnabled) availableSections.add("lens");
  if (isAdmin && onBoardDeleted) availableSections.add("danger");
  // A deep link to a section this viewer cannot see falls back to Members rather than a blank panel.
  const [tab, setTab] = useState<Tab>(() => {
    const t = resolveInitialSection(initialTab) ?? "members";
    return availableSections.has(t) ? t : "members";
  });
  // #863: the Webhooks tab can hold a one-time secret that is lost if Board
  // settings closes or switches tabs before the admin acknowledges it. The tab
  // registers a guard; Close, the backdrop and every tab button ask it first.
  const webhookCloseGuardRef = useRef<WebhookCloseGuard | null>(null);
  const registerWebhookCloseGuard = useCallback((guard: WebhookCloseGuard | null) => {
    webhookCloseGuardRef.current = guard;
  }, []);
  // #2570: an unsaved field set draft asks before Close, Escape or a section switch.
  const fieldSetGuardRef = useRef<FieldSetCloseGuard | null>(null);
  const registerFieldSetGuard = useCallback((guard: FieldSetCloseGuard | null) => {
    fieldSetGuardRef.current = guard;
  }, []);
  const guardedClose = useCallback(() => {
    if (webhookCloseGuardRef.current?.(onClose)) return;
    if (fieldSetGuardRef.current?.(onClose)) return;
    onClose();
  }, [onClose]);
  const selectTab = (next: Tab, afterSwitch?: () => void) => {
    if (next === tab) {
      afterSwitch?.();
      return;
    }
    const go = () => {
      setTab(next);
      afterSwitch?.();
      // The notification deep link is one-shot: leaving the tab spends it.
      if (tab === "webhooks") setWebhookDeepLinkLive(false);
    };
    if (tab === "webhooks" && webhookCloseGuardRef.current?.(go)) return;
    if (tab === "field-sets" && fieldSetGuardRef.current?.(go)) return;
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
  const pendingRemoveMember = pendingRemove === null ? undefined : members.find((m) => m.user.id === pendingRemove);
  useConfirmAnnouncement(
    !pendingRemoveMember
      ? null
      : pendingRemoveMember.role === "site_admin" || pendingRemoveMember.has_all_content_access === true
        ? "Remove this board role? Full access is not affected."
        : `Remove ${userDisplayName(pendingRemoveMember.user)} from this board?`,
  );
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
  const [healthAutoError, setHealthAutoError] = useState<string | null>(null);
  const [healthAutoSaving, setHealthAutoSaving] = useState(false);
  const healthAutoSavingRef = useRef(false);
  // Tracks the last value actually persisted to the server, independent of the
  // (already-updated-on-keystroke) state above, so a failed save can revert to
  // the right value instead of the just-typed one.
  const syncedStalenessThresholdRef = useRef(board.staleness_threshold_days ?? 14);
  const syncedStalenessWarningPctRef = useRef(board.stale_warning_pct ?? 50);
  // Inline confirmation before enabling hard WIP mode — mirrors the member-removal confirm pattern.
  const [pendingHardWip, setPendingHardWip] = useState(false);
  const hardWipTriggerRef = useConfirmFocusReturn(pendingHardWip ? "hard-wip" : null);
  useConfirmAnnouncement(pendingHardWip ? HARD_WIP_PROMPT : null);
  // #1923: turning the assignee override on widens who can bypass limits, so it
  // confirms inline; turning it off does not.
  const [pendingAssigneeOverride, setPendingAssigneeOverride] = useState(false);
  const assigneeOverrideTriggerRef = useConfirmFocusReturn(pendingAssigneeOverride ? "assignee-override" : null);
  useConfirmAnnouncement(pendingAssigneeOverride ? ASSIGNEE_OVERRIDE_PROMPT : null);

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
  // Swimlane rollup (#2275): the chosen field when it still is a number field;
  // "stale" when the stored id points at a field retyped away from number.
  const rollupNumberFields = (board.custom_field_definitions ?? []).filter((d) => d.field_type === "number");
  // #2050 — the commitment point's choices: the board's columns that are not
  // done, in board order. A stored uid that no longer matches one reads as unset,
  // the same rule the server applies.
  const commitmentOptions = [...board.columns].filter((c) => !c.is_done).sort((a, b) => a.position - b.position);
  const commitmentColumn = commitmentOptions.find((c) => c.uid === board.commitment_column_uid) ?? null;
  const commitmentIsStale = !!board.commitment_column_uid && commitmentColumn === null;
  // #2051 — the board's flow-metric time zone. The browser's IANA list; a stored
  // name it lacks is still offered so the current value always shows.
  // Guarded: a browser without Intl.supportedValuesOf (pre-2022) still opens the modal.
  const timeZoneNames = (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [])
    .filter((n) => n !== "UTC");
  if (board.time_zone && board.time_zone !== "UTC" && !timeZoneNames.includes(board.time_zone)) {
    timeZoneNames.unshift(board.time_zone);
  }
  const timeZoneOptions = [
    { value: "none", label: "UTC (default)" },
    ...timeZoneNames.map((n) => ({ value: n, label: n.replace(/_/g, " ") })),
  ];
  const timeZoneValue = board.time_zone && board.time_zone !== "UTC" ? board.time_zone : "none";
  const rollupField = resolveRollupField(board.swimlane_rollup_field, board.custom_field_definitions);
  const rollupFieldIsStale = board.swimlane_rollup_field != null && rollupField === null;
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
  // Anchored to the member-search input, so never pinned over it (#2163).
  const { top: suggestionsTop, maxHeight: suggestionsMaxHeight } = useInputAnchoredPlacement(suggestionsRef, {
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
    } catch (err) {
      // Defensive: the owner row is locked, so this is a stale client or a race (#1828).
      setMemberActionError(isOwnerProtectedError(err) ? `Failed to update role. ${OWNER_MEMBERSHIP_NOTE}` : "Failed to update role. Please try again.");
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
  // administrator, the same predicate the Dashboard uses; the server
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
    if (tab !== "danger" || !userCanDeleteBoard || (deleteInput === "" && deleteError === null)) return false;
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

  // Escape 40.9 (frontend/CLAUDE.md): cancels only the assignee-override confirm.
  useEscapeStack(() => {
    if (!pendingAssigneeOverride || tab !== "rules") return false;
    setPendingAssigneeOverride(false);
  }, 40.9);

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
    } catch (err) {
      if (isOwnerProtectedError(err)) {
        setMemberActionError(`Failed to remove member. ${OWNER_MEMBERSHIP_NOTE}`);
        return;
      }
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

  // #2244: not optimistic, because only the server can resolve the new
  // health_review_due_at (the clock may belong to an ancestor group).
  const handleHealthReviewDaysSave = async (next: number | null) => {
    const updated = await patchBoard(board.id, { health_review_days: next });
    onMergeBoardFields?.({
      health_review_days: updated.health_review_days,
      health_review_due_at: updated.health_review_due_at,
    });
  };

  // #2245: not optimistic; the server answers with the board's resolved
  // health (turning auto on or off changes the effective value and origin).
  const handleHealthAutoToggle = async (next: boolean) => {
    // One PATCH at a time: a second click while saving would race the first.
    if (healthAutoSavingRef.current) return;
    healthAutoSavingRef.current = true;
    setHealthAutoSaving(true);
    setHealthAutoError(null);
    try {
      const updated = await patchBoard(board.id, { health_auto_enabled: next });
      onMergeBoardFields?.(pickBoardHealth(updated));
    } catch {
      setHealthAutoError("Failed to save automatic health status. Please try again.");
    } finally {
      healthAutoSavingRef.current = false;
      setHealthAutoSaving(false);
    }
  };
  const handleHealthOffTrackSave = async (next: number) => {
    const updated = await patchBoard(board.id, { health_off_track_cards: next });
    onMergeBoardFields?.(pickBoardHealth(updated));
  };
  const handleHealthRecompute = async () => {
    const result = await recomputeBoardHealth(board.id);
    applyHealthRecompute(result, (patch) => onMergeBoardFields?.(patch), (resolver) => onUpdateSwimlane?.(resolver));
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
    if (tab !== "export" || !isAdmin) return;
    if (exportHistory !== null || exportHistoryLoading) return;
    setExportHistoryLoading(true);
    setExportHistoryError(null);
    getBoardExportHistory(board.id, { page_size: 10 })
      .then((resp) => setExportHistory(resp.results))
      .catch(() => setExportHistoryError("Could not load export history."))
      .finally(() => setExportHistoryLoading(false));
  }, [tab, isAdmin, board.id, exportHistory, exportHistoryLoading]);

  // ── Sections and "Find a setting" (#2436) ──
  // Sections are hidden exactly as the old tabs were: Sharing and Webhooks for admins
  // (Webhooks never in demo mode, #863), Issue lens for admins when the instance flag is on,
  // Danger zone for admins who can reach the delete flow.
  const sectionLabel = (t: Tab): string =>
    t === "members" ? `Members (${members.length})`
    : t === "fields" ? `Card fields (${board.custom_field_definitions?.length ?? 0})`
    : t === "swimlane-fields" ? `Swimlane fields (${board.swimlane_custom_field_definitions?.length ?? 0})`
    : SECTION_LABELS[t];

  const onSidebarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const nextIdx = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
    // Manual activation: arrows move focus, Enter/Space selects, so the #863 webhook guard is asked once per switch.
    tabs[nextIdx]?.focus();
  };

  // The viewer's role or the instance flags can change while the modal is open.
  // `availableSections` is a fresh Set each render, so the effect keys on the one fact it acts on.
  const tabAvailable = availableSections.has(tab);
  useEffect(() => {
    if (!tabAvailable) setTab("members");
  }, [tabAvailable]);
  const [findQuery, setFindQuery] = useState("");
  const [jumpNotice, setJumpNotice] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pendingJump, setPendingJump] = useState<SettingEntry | null>(null);
  const highlightTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(highlightTimerRef.current), []);
  const findResults = findSettings(findQuery, availableSections);
  // Escape clears an open search before it can close the modal (priority above ModalWrapper's 40).
  useEscapeStack(() => {
    if (findQuery === "") return false;
    setFindQuery("");
  }, 41);
  const jumpToSetting = (entry: SettingEntry) => {
    setFindQuery("");
    setFindIndex(0);
    selectTab(entry.section, () => { setPendingJump(entry); setJumpNotice(`Jumped to ${entry.label}`); });
  };
  useEffect(() => {
    if (!pendingJump || pendingJump.section !== tab) return;
    // The section's panel mounts on this commit; some panels fill in after a fetch, so fall back to the panel top.
    const timer = window.setTimeout(() => {
      const root = panelRef.current;
      if (root) {
        const el = locateSettingTarget(root, pendingJump.target);
        if (el) {
          el.scrollIntoView?.({ block: "center" });
          const ring = ["ring-2", "ring-primary-emphasis", "rounded"];
          el.classList.add(...ring);
          window.clearTimeout(highlightTimerRef.current);
          highlightTimerRef.current = window.setTimeout(() => el.classList.remove(...ring), 1800);
        } else {
          root.scrollTo?.({ top: 0 });
          root.focus();
        }
      }
      setPendingJump(null);
      setJumpNotice("");
    }, 50);
    return () => window.clearTimeout(timer);
  }, [pendingJump, tab]);

  const liveFindText = findQuery.trim() !== "" && findResults.length > 0 ? `${findResults.length} settings found` : findQuery.trim() === "" ? jumpNotice : "";
  const findSetting = (
    <div
      className="relative"
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFindQuery(""); }}
    >
      {(liveFindText !== "") && <p role="status" className="sr-only">{liveFindText}</p>}
      <input
        type="search"
        aria-label="Find a setting"
        // The listbox/status node only exists while a query is typed; an aria-controls to a missing id is invalid (#2469).
        aria-controls={findQuery.trim() !== "" ? "board-settings-find-results" : undefined}
        aria-activedescendant={findResults.length > 0 ? `board-settings-find-${findIndex}` : undefined}
        aria-autocomplete="list"
        placeholder="Find a setting (e.g. export, WIP, fields)"
        value={findQuery}
        onChange={(e) => { setFindQuery(e.target.value); setFindIndex(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && findResults.length > 0) { e.preventDefault(); setFindIndex((i) => (i + 1) % findResults.length); }
          else if (e.key === "ArrowUp" && findResults.length > 0) { e.preventDefault(); setFindIndex((i) => (i - 1 + findResults.length) % findResults.length); }
          else if (e.key === "Enter" && findResults[findIndex]) { e.preventDefault(); jumpToSetting(findResults[findIndex]); }
        }}
        className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
      />
      {findQuery.trim() !== "" && (
        <div className="absolute left-0 right-0 top-full mt-1 z-10 rounded border border-line-strong bg-surface shadow-xl max-h-64 overflow-y-auto">
          {findResults.length > 0 ? (
            <ul id="board-settings-find-results" role="listbox" aria-label="Matching settings" className="py-1">
              {findResults.map((r, i) => (
                <li
                  key={settingKey(r)}
                  id={`board-settings-find-${i}`}
                  role="option"
                  aria-selected={i === findIndex}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => jumpToSetting(r)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jumpToSetting(r); } }}
                  className={`flex items-center justify-between gap-3 px-3 py-1.5 text-sm cursor-pointer max-sm:min-h-11 ${i === findIndex ? "bg-surface-hover text-fg" : "text-fg-secondary hover:bg-surface-hover"}`}
                >
                  <span className="truncate">{r.label}</span>
                  <span className="shrink-0 text-xs text-fg-muted">{SECTION_LABELS[r.section]}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p id="board-settings-find-results" role="status" className="px-3 py-2 text-sm text-fg-muted">
              No setting matches &lsquo;{findQuery.trim()}&rsquo;
            </p>
          )}
        </div>
      )}
    </div>
  );

  return (
    <ModalWrapper
      open={true}
      onClose={guardedClose}
      title="Board settings"
      subtitle={board.name}
      headerExtra={findSetting}
      maxWidth="max-w-4xl"
      noPadding
      labelId="board-settings-title"
      panelClassName="h-[85vh] max-h-[640px] min-h-0"
      headerBorder
    >

        {/* Grouped sidebar (#2436): a vertical tablist that switches panels in place.
            #2404: at max-sm every control in the modal is lifted to 44px by the panel container rule
            (ModalWrapper), so a new control here needs no lift of its own. */}
        <div className="flex flex-1 min-h-0">
        {!isPhone && (
        <div className="w-[232px] shrink-0 border-r border-line overflow-y-auto py-3 px-3">
          <div role="tablist" aria-orientation="vertical" aria-label="Board settings sections" onKeyDown={onSidebarKeyDown} className="flex flex-col gap-0.5">
            {/* #863: Webhooks is omitted from the DOM in demo mode and for non-admins, never DemoInert. */}
            {SECTION_GROUPS.map((g) => {
              const sections = g.sections.filter((t) => availableSections.has(t));
              if (sections.length === 0) return null;
              return (
                <Fragment key={g.label}>
                  <div role="presentation" className="px-2 pt-3 pb-1 text-xs font-semibold text-fg-tertiary uppercase tracking-wide first:pt-0">{g.label}</div>
                  {sections.map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      id={`board-settings-tab-${t}`}
                      aria-selected={tab === t}
                      aria-controls="board-settings-panel"
                      tabIndex={tab === t ? 0 : -1}
                      ref={tab === t ? activeTabRef : undefined}
                      onClick={() => selectTab(t)}
                      className={`text-left px-2 py-1.5 text-sm font-medium rounded border-l-2 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                        tab === t ? "border-primary-emphasis bg-primary-emphasis/15 text-fg" : `border-transparent hover:bg-surface-hover ${t === "danger" ? "text-danger" : "text-fg-tertiary hover:text-fg"}`
                      }`}
                    >
                      {sectionLabel(t)}
                    </button>
                  ))}
                </Fragment>
              );
            })}
          </div>
        </div>
        )}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* Phone (<sm): the sidebar becomes a Section select above the panel. */}
        {isPhone && (
        <div className="px-6 pt-3">
          <label htmlFor="board-settings-section-select" className="sr-only">Section</label>
          <select
            id="board-settings-section-select"
            value={tab}
            onChange={(e) => selectTab(e.target.value as Tab)}
            className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
          >
            {SECTION_GROUPS.map((g) => {
              const sections = g.sections.filter((t) => availableSections.has(t));
              return sections.length === 0 ? null : (
                <optgroup key={g.label} label={g.label}>
                  {sections.map((t) => <option key={t} value={t}>{sectionLabel(t)}</option>)}
                </optgroup>
              );
            })}
          </select>
        </div>
        )}

        {/* Content */}
        {/* Phone: no tab is rendered, so the panel is a region named for its section, not a tabpanel pointing at a missing tab. */}
        <div ref={panelRef} role={isPhone ? "region" : "tabpanel"} id="board-settings-panel" aria-labelledby={isPhone ? undefined : `board-settings-tab-${tab}`} aria-label={isPhone ? sectionLabel(tab) : undefined} tabIndex={0} className="overflow-y-auto flex-1 px-6 py-4 focus:outline-none focus:ring-2 focus:ring-primary-emphasis max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11 max-sm:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-sm:[&_select]:min-h-11 max-sm:[&_textarea]:min-h-11 max-sm:[&_label:has(input[type=checkbox])]:min-h-11 max-sm:[&_label:has(input[type=radio])]:min-h-11">
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

          {/* ── Field sets (#2570) ── */}
          {tab === "field-sets" && (
            <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
            <BoardSettingsFieldSetsSection
              registerCloseGuard={registerFieldSetGuard}
              board={board}
              isAdmin={isAdmin}
              onFieldSetsUpdated={(sets) => onFieldSetsUpdated?.(sets)}
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
                // The server refuses to demote or remove the owner's membership
                // (#1828), so the owner's row is read-only like a locked one.
                const isOwnerRow = board.owner?.id === m.user.id;
                const canManage = isAdmin && !isLocked && !isOwnerRow;
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
                          {isOwnerRow && !isLocked && (
                            <p className="text-xs text-fg-tertiary">{OWNER_MEMBERSHIP_NOTE}</p>
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
                        ) : isLocked || isOwnerRow ? (
                          <span className="text-xs text-fg-secondary capitalize px-2 py-1 bg-surface-hover rounded" title={isLocked ? "Site administrator — role managed at the instance level" : OWNER_MEMBERSHIP_NOTE}>
                            {isOwnerRow && !isLocked ? "admin" : m.role}
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
                          <button type="button"
                            ref={removeTriggerRef(m.user.id)}
                            onClick={() => setPendingRemove(m.user.id)}
                            disabled={isDisabled}
                            className="text-xs text-fg-muted hover:text-danger transition disabled:opacity-40 w-5 text-center rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                            title="Remove direct board role"
                            aria-label={`Remove direct board role for ${userDisplayName(m.user)}`}
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
                              className="rounded accent-primary border-line-strong bg-surface-hover text-info focus:ring-primary-emphasis focus:ring-offset-0 w-3.5 h-3.5 opacity-40 cursor-not-allowed"
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
                      <div className="mt-1.5 pl-9 flex items-center gap-2 text-xs">
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
                          className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-1 transition aria-disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
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

              <p className="text-xs mt-2">
                <HelpLink topic="permissions" variant="text" />
              </p>

              {isAdmin && (
                <div className="border-t border-line pt-4 mt-2">
                  <p className="text-sm font-medium text-fg-tertiary uppercase tracking-wide mb-3">Add member</p>
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
                            maxHeight: suggestionsMaxHeight ?? visibleMaxHeight(2 * POPOVER_VIEWPORT_MARGIN),
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
                              className="group w-full text-left px-3 py-2.5 hover:bg-surface-hover transition flex items-center gap-2.5 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis"
                            >
                              <Avatar user={u} size="sm" />
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-fg truncate">{userDisplayName(u)}</p>
                                <p className="text-xs text-fg-muted group-hover:text-fg-secondary truncate">{u.email}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {staged.length > 0 && (
                      <div>
                        <p className="text-sm font-medium text-fg-tertiary uppercase tracking-wide mb-2">To be added</p>
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
                                  <button type="button"
                                    aria-describedby={stagedErrors[s.user.id] ? `staged-error-${s.user.id}` : undefined}
                                    onClick={() => {
                                      setStaged((prev) => prev.filter((x) => x.user.id !== s.user.id));
                                      clearStagedError(s.user.id);
                                    }}
                                    className="text-xs text-fg-muted hover:text-danger transition disabled:opacity-40 w-5 text-center rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                                    title="Remove from invite list"
                                    aria-label={`Remove ${userDisplayName(s.user)} from invite list`}
                                    // Removing a row mid-flight would not cancel its add, and the
                                    // person could be re-staged under a new reason (#1299).
                                    disabled={inviting}
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
                  <div className="flex items-center gap-2 mb-2 min-w-0"><h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide">Limit enforcement</h3><HelpLink topic="wip-limit" /></div>
                  <div className="flex items-center justify-between py-2 border-b border-line/60">
                    <div className="min-w-0 pr-4">
                      <span className="text-sm text-fg">Enforce WIP limits</span>
                      <p className="text-xs text-fg-muted mt-0.5">
                        When enabled, moving, creating, or restoring a card into a column that is at or over its WIP limit is blocked. Admins (or the card's assignee, when enabled) can override.
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
                            // void: updateBoardSettings never rejects (it reloads and returns the error)
                            void onUpdateBoardSettings({ enforce_wip_hard: false });
                          }
                        }}
                        aria-label="Hard mode (no admin override)"
                        buttonRef={hardWipTriggerRef("hard-wip")}
                      />
                    </div>
                    {pendingHardWip && (
                      <div className="mt-1.5 flex items-center gap-2 text-xs">
                        <span className="text-fg-tertiary">{HARD_WIP_PROMPT}</span>
                        <button
                          onClick={() => {
                            void onUpdateBoardSettings({ enforce_wip_hard: true });
                            setPendingHardWip(false);
                          }}
                          className="text-danger hover:text-danger font-medium transition rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setPendingHardWip(false)}
                          className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-1 transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
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
                        When enabled, moving, creating, or restoring a card into a column that would exceed its weight budget, or raising a card's weight, is blocked. Admins (or the card's assignee, when enabled) can override. Columns must have a weight limit set for this to take effect.
                      </p>
                    </div>
                    <Toggle
                      checked={board.enforce_weight_limits}
                      onChange={(v) => onUpdateBoardSettings({ enforce_weight_limits: v })}
                      aria-label="Enforce weight limits"
                    />
                  </div>
                  {/* #1923: who besides an admin may override a Block limit. */}
                  <div className="py-2 border-b border-line/60">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 pr-4">
                        <span className="text-sm text-fg">Let a card&apos;s assignee move it anyway</span>
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-surface-hover text-fg-secondary">Board-wide</span>
                        <p className="text-xs text-fg-muted mt-0.5">
                          Covers Block limits on WIP and weight, with a reason. Hard limits still stop everyone. Not for cards they assigned to themselves.
                        </p>
                      </div>
                      <Toggle
                        checked={board.allow_assignee_override === true}
                        onChange={(v) => {
                          if (v) {
                            setPendingAssigneeOverride(true);
                          } else {
                            setPendingAssigneeOverride(false);
                            void onUpdateBoardSettings({ allow_assignee_override: false });
                          }
                        }}
                        aria-label="Let a card's assignee move it anyway"
                        buttonRef={assigneeOverrideTriggerRef("assignee-override")}
                      />
                    </div>
                    {pendingAssigneeOverride && (
                      <div className="mt-1.5 flex items-center gap-2 text-xs">
                        <span className="text-fg-tertiary">{ASSIGNEE_OVERRIDE_PROMPT}</span>
                        <button
                          onClick={() => {
                            void onUpdateBoardSettings({ allow_assignee_override: true });
                            setPendingAssigneeOverride(false);
                          }}
                          className="text-danger hover:text-danger font-medium transition rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setPendingAssigneeOverride(false)}
                          className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-1 transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between py-2 border-b border-line/60">
                    <div className="min-w-0 pr-4">
                      <span className="text-sm text-fg">Show at-limit WIP indicator</span>
                      <p className="text-xs text-fg-muted mt-0.5">
                        When enabled, a swimlane row's WIP line shows a calm "at limit" reading once the row is exactly at its WIP limit; off, it reads like an under-limit row. Column headers are unaffected. Ambient only — does not change move enforcement.
                      </p>
                    </div>
                    <Toggle
                      checked={board.show_wip_at_limit}
                      onChange={(v) => onUpdateBoardSettings({ show_wip_at_limit: v })}
                      aria-label="Show at-limit WIP indicator"
                    />
                  </div>
                  {/* #2275 — the number field each swimlane band sums over its open cards. */}
                  <div className="flex items-center justify-between gap-3 py-2 border-b border-line/60">
                    <div className="min-w-0 pr-4">
                      <label htmlFor="swimlane-rollup-field-select" className="text-sm text-fg">Swimlane rollup</label>
                      <p id="swimlane-rollup-field-help" className="text-xs text-fg-muted mt-0.5">
                        Each swimlane band shows the total of this number field over the lane&apos;s cards that are not in a done column, for example &ldquo;$413k open&rdquo;.
                        {rollupFieldIsStale && " The chosen field is no longer a number field, so the bands show no total; choose another field, or choose None to clear the setting."}
                        {rollupNumberFields.length === 0 && " Add a number field in the Fields tab first."}
                      </p>
                    </div>
                    <SelectDropdown
                      id="swimlane-rollup-field-select"
                      ariaDescribedBy="swimlane-rollup-field-help"
                      value={rollupField ? String(rollupField.id) : "none"}
                      onChange={(v) => onUpdateBoardSettings({ swimlane_rollup_field: v === "none" ? null : Number(v) })}
                      options={[
                        { value: "none", label: "None" },
                        ...rollupNumberFields.map((d) => ({ value: String(d.id), label: d.name })),
                      ]}
                      disabled={rollupNumberFields.length === 0 && !rollupFieldIsStale}
                      disabledReason="Swimlane rollup: add a number field first"
                    />
                  </div>
                </section>
              ) : (
                <section>
                  <div className="flex items-center gap-2 mb-2 min-w-0"><h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide">Limit enforcement</h3><HelpLink topic="wip-limit" /></div>
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
                    <p className="text-sm text-fg-secondary">Assignee override: {board.allow_assignee_override ? "on" : "off"}</p>
                    <p className="text-sm text-fg-secondary">At-limit WIP indicator: {board.show_wip_at_limit ? "shown" : "hidden"}</p>
                    <p className="text-sm text-fg-secondary">Swimlane rollup: {rollupField ? rollupField.name : "none"}</p>
                  </div>
                </section>
              )}

              {/* #2156 — column policies for the whole board */}
              <BoardSettingsPoliciesSection
                columns={board.columns}
                isAdmin={isAdmin}
                hiddenColumnIds={viewPrefs?.hiddenColumnIds}
                onSaveColumnPolicy={async (columnId, policy) => {
                  const updated = await patchColumn(board.id, columnId, { policy });
                  onColumnUpdated?.(updated);
                }}
              />

              {/* Card aging settings */}
              <section aria-labelledby="card-aging-heading">
                <div className="flex items-center gap-2 mb-2 min-w-0"><h3 id="card-aging-heading" className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide">Card aging settings</h3><HelpLink topic="board.stale" /></div>
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

              {/* #2050 — flow metrics: where cycle time starts */}
              <section aria-labelledby="flow-metrics-heading">
                <div className="flex items-center gap-2 mb-2 min-w-0"><h3 id="flow-metrics-heading" className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide">Flow metrics</h3><HelpLink topic="analytics.definitions" /></div>
                <div className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0 pr-4">
                    {isAdmin
                      ? <label htmlFor="commitment-column-select" className="text-sm text-fg">Cycle time starts at</label>
                      : <span className="text-sm text-fg">Cycle time starts at</span>}
                    <p id="commitment-column-help" className="text-xs text-fg-muted mt-0.5">
                      Cycle time and age start when a card first reaches this column or a later one. The default starts them when a card first leaves the column it was created in.
                      {commitmentIsStale && " The chosen column was deleted or marked done, so the default applies; choose another column to set a new one."}
                    </p>
                    <p className="text-xs text-fg-muted mt-0.5">Changing it re-measures past cards too.</p>
                  </div>
                  {isAdmin ? (
                    <SelectDropdown
                      id="commitment-column-select"
                      ariaDescribedBy="commitment-column-help"
                      value={commitmentColumn ? commitmentColumn.uid : "none"}
                      onChange={(v) => onUpdateBoardSettings?.({ commitment_column_uid: v === "none" ? null : v })}
                      options={[
                        { value: "none", label: "First move (default)" },
                        ...commitmentOptions.map((c) => ({ value: c.uid, label: c.name })),
                      ]}
                    />
                  ) : (
                    <p className="text-sm text-fg-secondary shrink-0" aria-describedby="commitment-column-help">
                      <span className="sr-only">Cycle time starts at: </span>
                      {commitmentColumn ? commitmentColumn.name : "First move (default)"}
                    </p>
                  )}
                </div>
                {/* #2051 — the zone flow-metric days and weeks are dated in */}
                <div className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0 pr-4">
                    {isAdmin
                      ? <label htmlFor="flow-time-zone-select" className="text-sm text-fg">Time zone for days and weeks</label>
                      : <span className="text-sm text-fg">Time zone for days and weeks</span>}
                    <p id="flow-time-zone-help" className="text-xs text-fg-muted mt-0.5">
                      Throughput, cumulative flow and date ranges count calendar days in this zone, for everyone on the board. Durations do not change.
                    </p>
                    <p className="text-xs text-fg-muted mt-0.5">Changing it re-counts past days too; no card data changes.</p>
                  </div>
                  {isAdmin ? (
                    <SelectDropdown
                      id="flow-time-zone-select"
                      ariaDescribedBy="flow-time-zone-help"
                      value={timeZoneValue}
                      onChange={(v) => onUpdateBoardSettings?.({ time_zone: v === "none" ? null : v })}
                      options={timeZoneOptions}
                    />
                  ) : (
                    <p className="text-sm text-fg-secondary shrink-0" aria-describedby="flow-time-zone-help">
                      <span className="sr-only">Time zone for days and weeks: </span>
                      {timeZoneValue === "none" ? "UTC (default)" : timeZoneValue.replace(/_/g, " ")}
                    </p>
                  )}
                </div>
              </section>

              {/* #2208 — two-tier card links: whether this board's cards can have child cards on another board */}
              <section aria-labelledby="child-cards-heading">
                <div className="flex items-center gap-2 mb-2 min-w-0"><h3 id="child-cards-heading" className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide">Child cards</h3><HelpLink topic="child-cards" /></div>
                {isAdmin ? (
                  <ChildCardsSettings board={board} error={childCardsError} onShowChildCards={onShowChildCards} onUpdate={async (patch) => { if (typeof patch.cards_can_have_children === "boolean") { /* awaited so the turn-off confirm (#2446) stays open, Escape swallowed, until the save settles */ await flipChildCards(patch.cards_can_have_children); return null; } /* ParentNameSettings awaits this result to roll back and show the error */ return await onUpdateBoardSettings?.(patch); }} />
                ) : (
                  <p className="text-sm text-fg-secondary">
                    {board.cards_can_have_children ? "Cards on this board can have child cards on another board." : "Cards on this board can't get new child cards. Cards that already have children keep them."}
                  </p>
                )}
              </section>

              {/* #2244 — health review cue, beside the stale-card threshold; #2245 — auto health */}
              <section aria-labelledby="health-review-heading">
                <div className="flex items-center gap-2 mb-2 min-w-0"><h3 id="health-review-heading" className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide">Health status</h3><HelpLink topic="health.review" /></div>
                {isAdmin ? (
                  <div className="flex flex-col gap-2 mb-3">
                    <ToggleField
                      checked={board.health_auto_enabled}
                      onChange={(v) => { void handleHealthAutoToggle(v); }}
                      ariaDisabled={healthAutoSaving}
                      label="Calculate health status automatically"
                      descriptionId={HEALTH_AUTO_DESCRIPTION_ID}
                      aria-describedby={HEALTH_AUTO_DESCRIPTION_ID}
                      description="Each night, lanes are rated from their open cards: overdue, stale, or blocked. The board shows the worst lane. A status you set by hand always wins."
                    />
                    {healthAutoError && <p role="alert" className="text-danger text-xs">{healthAutoError}</p>}
                    <div className="pl-6 flex flex-col gap-2">
                      <HealthOffTrackInput
                        value={board.health_off_track_cards}
                        onSave={handleHealthOffTrackSave}
                        disabled={!board.health_auto_enabled}
                      />
                      <div className="flex flex-wrap items-start gap-3">
                        <HealthRecomputeButton onRecompute={handleHealthRecompute} autoEnabled={board.health_auto_enabled} />
                        <span className="text-xs text-fg-tertiary pt-1.5" data-testid="health-last-computed">
                          <HealthComputedTime computedAt={board.health_computed_at} prefix="Last computed" />
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-fg-secondary mb-2" data-testid="health-auto-readonly">
                    {board.health_auto_enabled
                      ? `Automatic · Off track at ${board.health_off_track_cards} flagged ${board.health_off_track_cards === 1 ? "card" : "cards"}`
                      : "Manual only"}
                  </p>
                )}
                {isAdmin ? (
                  <HealthReviewDaysInput
                    entityKind="board"
                    value={board.health_review_days}
                    onSave={handleHealthReviewDaysSave}
                  />
                ) : (
                  <p className="text-sm text-fg-secondary">
                    {board.health_review_days === null ? "Off" : `Every ${board.health_review_days} ${board.health_review_days === 1 ? "day" : "days"}`}
                  </p>
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
                <div className="flex items-center gap-2 mb-2 min-w-0"><h3 ref={shareHeadingRef} tabIndex={-1} className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide focus:outline-none">Public sharing</h3><HelpLink topic="board.sharing" /></div>
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
              remoteChange={webhookChange}
              reconnectSignal={webhookReconnectSignal}
              socketStatus={webhookSocketStatus}
              members={members}
              currentUserId={currentUserId}
            />
          )}

          {/* ── Export section ── */}
          {tab === "export" && (
            <div className="flex flex-col gap-6">
              {canExport && (
              <section>
                <div className="flex items-center gap-2 mb-2 min-w-0"><h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide">Export</h3><HelpLink topic="board.export" /></div>
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
                <p className="text-xs text-fg-muted mt-2">Also on the board toolbar · {formatShortcut({ mod: true, shift: true, key: "E" })}</p>
              </section>
              )}

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
            </div>
          )}

          {/* ── Issue lens section ── */}
          {tab === "lens" && isAdmin && gitLensEnabled && (
            <div className="flex flex-col gap-6">
              {/* Issue board lens — admin-only, gated on the instance feature flag. */}
              {isAdmin && gitLensEnabled && (
                <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
                <section>
                  <div className="flex items-center gap-2 mb-2 min-w-0"><h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide">Issue board lens</h3><HelpLink topic="lens.configure" /></div>
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
            </div>
          )}

          {/* ── Danger zone section ── */}
          {tab === "danger" && isAdmin && !!onBoardDeleted && (
            <div className="flex flex-col gap-6">
              {(
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
                        <BoardDeleteImpactNotice boardId={board.id} />
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
                <div className="flex items-center gap-2 mb-2 min-w-0"><h3 id="card-density-heading" className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide">Card density</h3><HelpLink topic="board.display" /></div>
                {isAdmin && onUpdateBoardSettings ? (
                  <DemoInert active={settingsInert} describedBy={DEMO_SETTINGS_NOTICE_ID}>
                  <fieldset
                    className="flex flex-col gap-2 transition-colors duration-150"
                    aria-describedby={densityPresetSource?.via === "board-default" ? DENSITY_SET_BY_PRESET_ID : undefined}
                  >
                    <legend className="sr-only">Card density</legend>
                    {([
                      { value: "comfortable", label: "Comfortable", description: "A status line (Overdue, Due soon or Stale) in place of badges, one primary label, assignee. Future due dates are in the card details, not on the card. Best for new boards." },
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
                          { value: "comfortable", label: "Comfortable", description: "A status line (Overdue, Due soon or Stale) in place of badges, one primary label, assignee. Future due dates are in the card details, not on the card. Best for new boards." },
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
        </div>
        </div>
    </ModalWrapper>
  );
}
