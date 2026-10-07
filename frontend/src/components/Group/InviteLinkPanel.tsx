import { useState, useEffect, useCallback, useRef } from "react";
import type { Ref } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
import { listInviteLinks, createInviteLink, revokeInviteLink, sendInviteLinkEmail } from "../../api/groups";
import {
  createBoardInviteLink,
  listBoardInviteLinks,
  revokeBoardInviteLink,
  sendBoardInviteEmail,
} from "../../api/boards";
import { getSiteConfig } from "../../api/auth";
import type { BoardInviteLink, GroupInviteLink, RegistrationMode } from "../../types";
import EmailInviteForm from "../Common/EmailInviteForm";
import type { EmailInviteFormHandle, EmailInvitePayload } from "../Common/EmailInviteForm";
import SelectDropdown from "../Common/SelectDropdown";
import { ToggleField } from "../Common/Toggle";
import Spinner from "../Common/Spinner";
import { INVITE_ROLE_LABELS } from "../../constants/invites";

/** What the panel manages invites for (#1444): a group, or a board. */
export interface InviteScope {
  kind: "group" | "board";
  id: number;
}

interface Props {
  scope: InviteScope;
  /** "card" (default): the group page's bordered card with its "Invite links"
   *  heading. "embedded": no chrome, for a host that supplies its own section
   *  (Board Settings → Members). */
  variant?: "card" | "embedded";
  /** Shareable-link creation ("New link"). Boards turn it on with #439. */
  allowShareableLinks?: boolean;
  /** Escape priority for the revoke prompt. 40 on the group page (above its
   *  priority-0 Escape-to-navigate); inside Board Settings it must sit above
   *  ModalWrapper's 40, so the board passes 49 (frontend/CLAUDE.md). */
  escapePriority?: number;
  /** Bumped by the parent on an invite socket event to trigger a refetch so
   *  another admin's change converges here in real time (#1051). */
  reloadSignal?: number;
  /** Whether the signed-in admin is a site admin — decides the sign-up
   *  notice on the email form (#1445). */
  isSiteAdmin?: boolean;
  /** Handle onto the email form, for a host that pre-fills it (#1444). */
  emailFormRef?: Ref<EmailInviteFormHandle>;
  /** Forwarded to the email form: whether sending by email is available. */
  onEmailAvailabilityChange?: (available: boolean) => void;
  /** Extra classes for the embedded root (the host's section chrome), so the
   *  whole section — border included — disappears when there is nothing to
   *  show (#1444). */
  className?: string;
}

/** The fields the panel reads, common to group and board invite rows. */
type PanelLink = (GroupInviteLink | (BoardInviteLink & { is_active?: boolean; token?: string })) & {
  can_register?: boolean;
};

/** What the create form submits; each kind maps it onto its own endpoint. */
interface CreatePayload {
  name?: string;
  role: "admin" | "member" | "collaborator" | "viewer";
  expiry_days: number | null;
  single_use: boolean;
}

interface InviteApi {
  list: (id: number) => Promise<PanelLink[]>;
  create: (id: number, payload: CreatePayload) => Promise<PanelLink>;
  revoke: (id: number, linkId: number) => Promise<unknown>;
  send: (id: number, payload: EmailInvitePayload) => ReturnType<typeof sendInviteLinkEmail>;
}

// Arrow wrappers, not bare references, so each kind's API module is only
// touched when that kind is in use.
const INVITE_API: Record<InviteScope["kind"], InviteApi> = {
  group: {
    list: (id) => listInviteLinks(id),
    create: (id, payload) => createInviteLink(id, payload),
    revoke: (id, linkId) => revokeInviteLink(id, linkId),
    send: (id, payload) => sendInviteLinkEmail(id, { email: payload.email, role: payload.role }),
  },
  board: {
    list: (id) => listBoardInviteLinks(id),
    // The board form offers only grantable roles and 1/7/30 days (#439); the
    // server refuses anything else, so the narrowing here is a formality.
    create: (id, payload) => createBoardInviteLink(id, {
      name: payload.name,
      role: payload.role === "admin" ? undefined : payload.role,
      expiry_days: (payload.expiry_days ?? 7) as 1 | 7 | 30,
      single_use: payload.single_use,
    }),
    revoke: (id, linkId) => revokeBoardInviteLink(id, linkId),
    send: (id, payload) => sendBoardInviteEmail(id, {
      email: payload.email,
      role: payload.role === "admin" ? undefined : payload.role,
      expiry_days: payload.expiry_days,
    }),
  },
};

const BOARD_ROLE_OPTIONS: { value: "member" | "collaborator" | "viewer"; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "collaborator", label: "Collaborator" },
  { value: "viewer", label: "Viewer" },
];

const ALREADY_USED_REVOKE_ERROR = "This invite was already used, so it can't be revoked.";
const GENERIC_REVOKE_ERROR = "Could not revoke invite.";


const ROLE_COLORS: Record<string, string> = {
  admin: "bg-palette-purple text-palette-purple-pale",
  member: "bg-primary text-info",
  collaborator: "bg-palette-teal text-palette-teal-pale",
  viewer: "bg-surface-active text-fg",
};

const STATUS_LABELS: Record<string, string> = {
  used: "Used",
  expired: "Expired",
  revoked: "Revoked",
};

const STATUS_COLORS: Record<string, string> = {
  used: "bg-surface-hover text-fg-tertiary",
  expired: "bg-danger/60 text-danger",
  revoked: "bg-surface-hover text-fg-muted",
};

const EXPIRY_OPTIONS = [
  { label: "1 day", value: 1 },
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "Never", value: null },
];

// A shareable board link always expires (#439): no "Never".
const BOARD_EXPIRY_OPTIONS = EXPIRY_OPTIONS.filter((opt) => opt.value !== null);

const MAX_LINKS = 5;

const CAP_MESSAGE = `Maximum of ${MAX_LINKS} active invite links reached. Revoke a link to create a new one.`;

function formatExpiry(link: PanelLink): string {
  if (link.is_expired) return "Expired";
  if (!link.expires_at) return "Never";
  const d = new Date(link.expires_at);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatUsedAt(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Derive effective status for backward compatibility with older API responses. */
function effectiveStatus(link: PanelLink): GroupInviteLink["status"] {
  return link.status ?? (link.is_expired ? "expired" : "pending");
}

function formatMetaDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "Sent Oct 6 by alice" / "Created Oct 6 by alice"; drops "by …" when the
 *  sender's account is gone. */
function metaLine(link: PanelLink): string | null {
  if (!link.created_at) return null;
  const verb = link.delivery === "email" ? "Sent" : "Created";
  const by = link.created_by_username ? ` by ${link.created_by_username}` : "";
  return `${verb} ${formatMetaDate(link.created_at)}${by}`;
}

/** The message for a failed create: the server's `detail` (e.g. the cap), else
 *  the first field error of a 400 (e.g. `expiry_days`), else a generic line. */
function createErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.detail === "string") return record.detail;
    const first = Object.values(record)[0];
    const message = Array.isArray(first) ? first[0] : first;
    if (typeof message === "string") return message;
  }
  return "Failed to create invite link.";
}

/** Where focus goes after an action removes or replaces the focused control. */
type FocusTarget = "name" | "newLink" | "copy" | "heading";

function newestFirst(a: PanelLink, b: PanelLink): number {
  if (a.created_at === b.created_at) return b.id - a.id;
  return a.created_at < b.created_at ? 1 : -1;
}

export default function InviteLinkPanel({
  scope,
  variant = "card",
  allowShareableLinks = true,
  escapePriority = 40,
  reloadSignal,
  isSiteAdmin = false,
  emailFormRef,
  onEmailAvailabilityChange,
  className = "",
}: Props) {
  const { kind, id: scopeId } = scope;
  const api = INVITE_API[kind];
  const isBoard = kind === "board";
  const [links, setLinks] = useState<PanelLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // Track which link was just created and has its raw token available
  const [revealId, setRevealId] = useState<number | null>(null);

  // New link form state
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formRole, setFormRole] = useState<"admin" | "member" | "collaborator" | "viewer">("member");
  const [formExpiry, setFormExpiry] = useState<number | null>(7);
  const [formSingleUse, setFormSingleUse] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<number | null>(null);
  const revokeTriggerRef = useConfirmFocusReturn(confirmRevokeId);
  const [loadError, setLoadError] = useState(false);
  const [copyErrorId, setCopyErrorId] = useState<number | null>(null);
  // #1421: one revoke in flight at a time, and its failure reported in place.
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [revokeError, setRevokeError] = useState<{ id: number; message: string } | null>(null);
  // Board list: used/expired/revoked rows sit behind a toggle (local only).
  const [showPast, setShowPast] = useState(false);
  // Whether the email form can send (null until site-config loads).
  const [emailAvailable, setEmailAvailable] = useState<boolean | null>(null);
  // Board shareable links (#439): the create form says whether a new person
  // can sign up from a link, which depends on the site's registration mode.
  const [registrationMode, setRegistrationMode] = useState<RegistrationMode | null>(null);
  const wantsRegistrationMode = isBoard && allowShareableLinks;
  useEffect(() => {
    if (!wantsRegistrationMode) return;
    let canceled = false;
    getSiteConfig()
      .then((c) => { if (!canceled) setRegistrationMode(c.registration_mode); })
      // Unknown mode: show no notice rather than a possibly wrong one.
      .catch(() => {});
    return () => { canceled = true; };
  }, [wantsRegistrationMode]);

  // Escape cancels the open revoke prompt before the host's own Escape
  // handler — GroupDetail's priority-0 navigate (#1238), or Board Settings'
  // ModalWrapper at 40, which is why the board passes 49.
  useEscapeStack(() => {
    if (confirmRevokeId !== null && revokingId === null) { setConfirmRevokeId(null); return; }
    return false;
  }, escapePriority);

  // Clear the "Copied!" feedback timer on unmount so setCopiedId(null) never
  // runs after teardown (#870).
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus management (#439): an action that unmounts the focused control —
  // opening/closing the create form, a create that swaps the form for the
  // reveal, a revoke that removes its own trigger — moves focus to a stable
  // target after the re-render, never leaving it on <body>.
  const [pendingFocus, setPendingFocus] = useState<FocusTarget | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const newLinkButtonRef = useRef<HTMLButtonElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (pendingFocus === null) return;
    const target = {
      name: nameInputRef,
      newLink: newLinkButtonRef,
      copy: copyButtonRef,
      heading: headingRef,
    }[pendingFocus].current;
    (target ?? headingRef.current)?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    };
  }, []);

  const fetchLinks = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    // A refetch shows the rows' real state, so an earlier revoke message
    // about one of them no longer applies.
    setRevokeError(null);
    try {
      const data = await api.list(scopeId);
      // The list never carries raw tokens; keep one we are still revealing so a
      // refetch (e.g. the invite_link.created echo of our own email send) does
      // not wipe a just-created link's one-time token.
      setLinks((prev) =>
        data.map((l) => {
          const token = prev.find((p) => p.id === l.id)?.token;
          return token ? { ...l, token } : l;
        })
      );
    } catch {
      // Previously unhandled: a failed load left `links` at its prior value
      // (empty on first mount) with no indication anything went wrong — the
      // empty state silently read as "no invite links" (#1375).
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [api, scopeId]);

  useEffect(() => {
    // void: fetchLinks catches its own rejection above and surfaces it via loadError.
    void fetchLinks();
  }, [fetchLinks]);

  // Refetch when the parent signals an invite_link.revoked socket event so the
  // panel converges with another admin's revoke without a manual reload (#1051).
  // Keyed on whether the signal CHANGED, not a "skip first run" flag: StrictMode's
  // dev remount keeps refs, so a boolean flag would fire an extra mount fetch
  // (#1479). `fetchLinks` changing alone is already covered by the effect above.
  const lastSignalRef = useRef(reloadSignal);
  useEffect(() => {
    if (lastSignalRef.current === reloadSignal) return;
    lastSignalRef.current = reloadSignal;
    void fetchLinks();
  }, [reloadSignal, fetchLinks]);

  const handleCopy = async (link: PanelLink) => {
    // For just-created links with raw token, copy the full join URL
    if (link.token) {
      const url = `${window.location.origin}/join/${link.token}`;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Previously: the "Copied!" confirmation showed unconditionally even
        // when the write itself failed (clipboard permission denied, insecure
        // context, etc.), telling the user the wrong thing (#1375).
        setCopyErrorId(link.id);
        return;
      }
    }
    setCopyErrorId(null);
    setCopiedId(link.id);
    if (copiedTimerRef.current !== null) {
      clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = setTimeout(() => {
      setCopiedId(null);
      copiedTimerRef.current = null;
    }, 2000);
  };

  const handleDismissReveal = (linkId: number) => {
    // Clear the raw token from client-side state
    setLinks((prev) =>
      prev.map((l) => (l.id === linkId ? { ...l, token: undefined } : l))
    );
    setRevealId(null);
    setCopyErrorId((prev) => (prev === linkId ? null : prev));
  };

  const handleRevoke = async (linkId: number) => {
    // In-flight guard (#1421): a second click while the DELETE is pending
    // must not send another.
    if (revokingId !== null) return;
    setRevokingId(linkId);
    setRevokeError(null);
    try {
      await api.revoke(scopeId, linkId);
      setConfirmRevokeId(null);
      // Keep the revoked link visible with status="revoked" rather than removing it.
      setLinks((prev) =>
        prev.map((l) => (l.id === linkId ? { ...l, is_active: false, status: "revoked" as const } : l))
      );
      if (revealId === linkId) setRevealId(null);
      // The Revoke trigger is gone (the row is terminal now), so
      // useConfirmFocusReturn has nothing to return to.
      setPendingFocus("heading");
    } catch (err: unknown) {
      const httpStatus = (err as { response?: { status?: number } }).response?.status;
      if (httpStatus === 400) {
        // Redeemed while the prompt was open: say so, and show its real state.
        setConfirmRevokeId(null);
        if (isBoard) setShowPast(true);
        // Refetch first (it clears revokeError), then report the outcome.
        await fetchLinks();
        setRevokeError({ id: linkId, message: ALREADY_USED_REVOKE_ERROR });
        setPendingFocus("heading");
      } else {
        // Leave the prompt open with both buttons re-enabled so it can be retried.
        setRevokeError({ id: linkId, message: GENERIC_REVOKE_ERROR });
      }
    } finally {
      setRevokingId(null);
    }
  };

  const handleCreate = async () => {
    setCreateError(null);
    setCreating(true);
    try {
      const newLink = await api.create(scopeId, {
        name: formName.trim() || undefined,
        role: formRole,
        expiry_days: formExpiry,
        single_use: formSingleUse,
      });
      setLinks((prev) => [...prev, newLink]);
      setRevealId(newLink.id);
      setShowForm(false);
      setPendingFocus("copy");
      setFormName("");
      setFormRole("member");
      setFormExpiry(7);
      setFormSingleUse(false);
    } catch (err: unknown) {
      setCreateError(createErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  // Active links exclude consumed single-use links (they're dead weight against the cap)
  // and emailed links (#731), which the backend caps separately. Board rows
  // carry no is_active: the server's effective status already folds in
  // revoked, used, expired and a sender who lost admin (#439).
  const activeCount = links.filter((l) =>
    isBoard
      ? effectiveStatus(l) === "pending" && l.delivery === "link"
      : l.is_active && !l.used_at && l.delivery !== "email"
  ).length;
  const atLimit = activeCount >= MAX_LINKS;

  // The spinner replaces the list only while nothing is shown yet. A
  // background refetch — a reloadSignal bump, including the invite_link.created
  // echo of this admin's own create — keeps the rows mounted, so a focused
  // control (the reveal's Copy) and a one-time token are not torn down (#439).
  const showSpinner = loading && links.length === 0;

  const sortedLinks = isBoard ? [...links].sort(newestFirst) : links;
  const pendingLinks = sortedLinks.filter((l) => effectiveStatus(l) === "pending");
  const pastLinks = sortedLinks.filter((l) => effectiveStatus(l) !== "pending");

  const revokeControls = (link: PanelLink) => {
    const isConfirming = confirmRevokeId === link.id;
    const inFlight = revokingId === link.id;
    return (
      <>
        {!isConfirming && (
          <button
            ref={revokeTriggerRef(link.id)}
            onClick={() => { setRevokeError(null); setConfirmRevokeId(link.id); }}
            aria-label={isBoard ? `Revoke invite ${link.prefix}` : undefined}
            className="text-xs text-danger hover:text-danger transition whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded px-1"
          >
            Revoke
          </button>
        )}
        {/* BoardSettingsModal inline-confirm pattern (frontend/CLAUDE.md § Modals and dialogs) */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={isConfirming ? "basis-full flex flex-wrap items-center gap-2 text-xs" : "contents"}
        >
          {isConfirming && (
            <>
              <span className="text-fg-tertiary">
                {isBoard && link.delivery === "email"
                  ? "Revoke this invite? The person it was emailed to will no longer be able to join."
                  : "Revoke this invite link? Anyone holding it will no longer be able to join."}
              </span>
              <button
                onClick={() => void handleRevoke(link.id)}
                disabled={inFlight}
                className="text-danger hover:text-danger font-medium transition rounded disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
              >
                Confirm
              </button>
              <button
                onClick={() => { if (inFlight) return; setConfirmRevokeId(null); setRevokeError(null); }}
                disabled={inFlight}
                className="text-fg-tertiary hover:text-fg transition rounded disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Cancel
              </button>
            </>
          )}
          {revokeError?.id === link.id && revokeError.message === GENERIC_REVOKE_ERROR && (
            <p className="basis-full text-xs text-danger mt-1">{revokeError.message}</p>
          )}
        </div>
      </>
    );
  };

  /** One-time token reveal: the raw token exists only in this session. */
  const tokenReveal = (link: PanelLink) => (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-warning">
        Copy this link now — it won't be shown again.
      </p>
      <div
        className="font-mono text-xs bg-sunken border border-warning/50 rounded px-2 py-1.5 text-fg truncate"
        title={`${window.location.origin}/join/${link.token}`}
      >
        {`${window.location.origin}/join/${link.token}`}
      </div>
      <div className="flex gap-2">
        <button
          ref={copyButtonRef}
          // void: handleCopy now catches its own rejection and surfaces it via copyErrorId.
          onClick={() => void handleCopy(link)}
          className="text-xs bg-button-primary text-on-primary px-3 py-1.5 rounded hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
        >
          {copyErrorId === link.id ? "Failed — try again" : copiedId === link.id ? "Copied!" : "Copy"}
        </button>
        <button
          onClick={() => handleDismissReveal(link.id)}
          className="text-xs text-fg-tertiary hover:text-fg-secondary px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Done
        </button>
      </div>
    </div>
  );

  // Always mounted, so the outcome of a revoke that lost to a redemption is
  // announced even though the prompt that started it has closed and (on the
  // board) the row has moved to the past list (#1421).
  const revokeAnnouncement = (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {revokeError?.message === ALREADY_USED_REVOKE_ERROR ? revokeError.message : ""}
    </div>
  );

  const emailForm = (
    <EmailInviteForm
      ref={emailFormRef}
      surface={kind}
      send={(payload) => api.send(scopeId, payload)}
      onSent={() => void fetchLinks()}
      senderIsSiteAdmin={isSiteAdmin}
      roleOptions={isBoard ? BOARD_ROLE_OPTIONS : undefined}
      showLinkDivider={allowShareableLinks}
      onAvailabilityChange={(available) => {
        setEmailAvailable(available);
        onEmailAvailabilityChange?.(available);
      }}
    />
  );

  const createForm = (
    <div className="flex flex-col gap-3 border border-line rounded-lg p-3 bg-sunken">
      <p className="text-xs font-semibold text-fg-secondary">New invite link</p>

      <div className="flex flex-col gap-1">
        <label htmlFor={`invite-link-name-${kind}-${scopeId}`} className="text-xs text-fg-tertiary">Name (optional)</label>
        <input
          ref={nameInputRef}
          id={`invite-link-name-${kind}-${scopeId}`}
          type="text"
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          placeholder="e.g. Engineering onboarding"
          maxLength={100}
          className="text-xs bg-surface border border-line rounded px-2 py-1.5 text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder:text-fg-muted"
        />
      </div>

      <div className="flex gap-3">
        <div className="flex flex-col gap-1 flex-1">
          <label className="text-xs text-fg-tertiary">Role</label>
          <SelectDropdown
            value={formRole}
            onChange={(v) => setFormRole(v as "admin" | "member" | "collaborator" | "viewer")}
            ariaLabel="Role"
            options={isBoard ? BOARD_ROLE_OPTIONS : [
              { value: "admin", label: "Admin" },
              { value: "member", label: "Member" },
              { value: "collaborator", label: "Collaborator" },
              { value: "viewer", label: "Viewer" },
            ]}
            size="xs"
          />
        </div>

        <div className="flex flex-col gap-1 flex-1">
          <label className="text-xs text-fg-tertiary">Expires</label>
          <SelectDropdown
            value={formExpiry === null ? "null" : String(formExpiry)}
            onChange={(v) => setFormExpiry(v === "null" ? null : Number(v))}
            ariaLabel="Expires"
            options={(isBoard ? BOARD_EXPIRY_OPTIONS : EXPIRY_OPTIONS).map((opt) => ({
              value: String(opt.value),
              label: opt.label,
            }))}
            size="xs"
          />
        </div>
      </div>

      {/* Single-use toggle */}
      <ToggleField
        label="Single use"
        description="Link expires after one person joins."
        labelSize="xs"
        checked={formSingleUse}
        onChange={setFormSingleUse}
      />

      {/* Board (#439): whether a new person can sign up from a link depends on
          the site's registration mode — shareable links never admit a new
          account on an invite-only or closed site. */}
      {isBoard && registrationMode !== null && registrationMode !== "open" && (
        <p className="text-xs text-fg-muted">
          New users can't sign up from an invite link on this site. Only people who already have an account can join with it.
        </p>
      )}

      {/* Reserved error slot — always rendered to prevent layout shift.
          h-4 matches text-xs's 1rem line-height so the slot doesn't clip. */}
      <p className="text-xs h-4">
        {createError && <span className="text-danger">{createError}</span>}
      </p>

      <div className="flex gap-3 items-center justify-end">
        <button
          onClick={() => {
            setShowForm(false);
            setCreateError(null);
            setFormSingleUse(false);
            setPendingFocus("newLink");
          }}
          className="text-xs text-fg-tertiary hover:text-fg-secondary px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Cancel
        </button>
        <button
          onClick={() => void handleCreate()}
          disabled={creating}
          className="text-xs bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
        >
          {creating ? "Creating…" : "Create link"}
        </button>
      </div>
    </div>
  );

  const newLinkButton = allowShareableLinks && !atLimit && !showForm && (
    <button
      ref={newLinkButtonRef}
      onClick={() => { setShowForm(true); setPendingFocus("name"); }}
      className="text-xs bg-button-primary text-on-primary px-3 py-1.5 rounded hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
    >
      New link
    </button>
  );

  const capWarning = allowShareableLinks && atLimit && !showForm && (
    <p className="text-xs text-warning">{CAP_MESSAGE}</p>
  );

  if (isBoard) {
    const boardRow = (link: PanelLink) => {
      const linkStatus = effectiveStatus(link);
      const pending = linkStatus === "pending";
      const meta = metaLine(link);
      const isRevealing = revealId === link.id && !!link.token;
      const rowClasses =
        isRevealing ? "border-warning/50 bg-sunken"
        : linkStatus === "revoked" ? "border-line bg-sunken/50 opacity-60"
        : linkStatus === "used" ? "border-line bg-sunken/50 opacity-75"
        : linkStatus === "expired" ? "border-danger/40 bg-sunken/50 opacity-70"
        : "border-line bg-sunken";
      return (
        <li key={link.id} className={`flex flex-col gap-1.5 p-3 rounded-lg border transition-all duration-150 ${rowClasses}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-fg truncate flex-1">
              {link.delivery === "email" ? "Emailed invite" : link.name || "Invite link"}
            </span>
            <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${ROLE_COLORS[link.role] ?? ROLE_COLORS.member}`}>
              {INVITE_ROLE_LABELS[link.role] ?? link.role}
            </span>
            {!pending && (
              <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${STATUS_COLORS[linkStatus]}`}>
                {STATUS_LABELS[linkStatus]}
              </span>
            )}
            {pending && link.can_register === false && (
              <span
                className="px-1.5 py-0.5 text-xs font-semibold rounded border border-line text-fg-tertiary"
                title="New people can't create an account from this invite on this site."
              >
                Existing accounts only
              </span>
            )}
            {linkStatus === "used" && link.used_at ? (
              <span className="text-xs text-fg-muted">Used {formatUsedAt(link.used_at)}</span>
            ) : (
              <span className={`text-xs ${link.is_expired ? "text-danger font-semibold" : "text-fg-muted"}`}>
                {formatExpiry(link)}
              </span>
            )}
            {pending && link.delivery === "link" && link.single_use && (
              <span className="text-xs text-warning">1-use</span>
            )}
          </div>
          {isRevealing ? tokenReveal(link) : (
            <div className="flex flex-wrap gap-2">
              <div className="flex-1 text-xs bg-surface border border-line rounded px-2 py-1 text-fg-tertiary truncate font-mono">
                {link.prefix}…
              </div>
              {pending && revokeControls(link)}
            </div>
          )}
          {revokeError?.id === link.id && revokeError.message === ALREADY_USED_REVOKE_ERROR && (
            <p className="text-xs text-danger mt-1">{revokeError.message}</p>
          )}
          {meta && <p className="text-xs text-fg-muted">{meta}</p>}
        </li>
      );
    };

    // Nothing to send and nothing sent: render no section at all rather than
    // a heading over an empty list. The root stays the same element with the
    // form at the same position (display: contents drops its box and border),
    // so the form is not remounted and availability is not re-fetched.
    const sectionHidden =
      !allowShareableLinks && emailAvailable === false && !loadError && (loading || links.length === 0);

    return (
      <div
        className={sectionHidden
          ? "contents"
          : `${variant === "card" ? "bg-surface border border-line rounded-lg p-4" : ""} flex flex-col gap-4 ${className}`.trim()}
      >
        {emailForm}
        {!sectionHidden && revokeAnnouncement}
        {!sectionHidden && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h4 ref={headingRef} tabIndex={-1} className="text-sm font-medium text-fg-tertiary uppercase tracking-wide focus:outline-none">Pending invites</h4>
            {newLinkButton}
          </div>
          {/* About emailed invites — irrelevant once sending is unavailable. */}
          {emailAvailable !== false && (
            <p className="text-xs text-fg-muted">
              Visiban doesn't keep the email address an invite was sent to. Tell invites apart by when they were sent.
            </p>
          )}
          {/* "Invite link", never "share link": the board's public Share link
              (Sharing tab) is a different, sign-in-free feature (#439). */}
          {allowShareableLinks && (
            <p className="text-xs text-fg-muted">
              Anyone with an invite link can join this board after signing in. To let people view without signing in, use the Sharing tab.
            </p>
          )}
          {capWarning}
          {allowShareableLinks && showForm && createForm}
          {showSpinner ? (
            <Spinner />
          ) : loadError ? (
            <div className="py-2">
              <p role="alert" className="text-xs text-danger mb-2">Failed to load invites.</p>
              <button
                onClick={() => void fetchLinks()}
                className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Try again
              </button>
            </div>
          ) : (
            <>
              {pendingLinks.length === 0 ? (
                <p className="text-xs text-fg-muted">No pending invites.</p>
              ) : (
                <ul className="flex flex-col gap-2">{pendingLinks.map(boardRow)}</ul>
              )}
              {pastLinks.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowPast((v) => !v)}
                    aria-expanded={showPast}
                    className="self-start text-xs text-fg-tertiary hover:text-fg px-1.5 py-0.5 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    {showPast ? "Hide past invites" : `Show past invites (${pastLinks.length})`}
                  </button>
                  {showPast && <ul className="flex flex-col gap-2">{pastLinks.map(boardRow)}</ul>}
                </>
              )}
            </>
          )}
        </div>
        )}
      </div>
    );
  }

  return (
    <div className={`${variant === "card" ? "bg-surface border border-line rounded-lg p-4" : ""} flex flex-col gap-4 ${className}`.trim()}>
      {revokeAnnouncement}
      <div className="flex items-center justify-between">
        <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-fg-secondary focus:outline-none">Invite links</h3>
        {newLinkButton}
      </div>

      {emailForm}

      {showSpinner ? (
        <Spinner />
      ) : loadError ? (
        <div className="text-center py-2">
          <p role="alert" className="text-xs text-danger mb-2">Failed to load invite links.</p>
          <button
            onClick={() => void fetchLinks()}
            className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Try again
          </button>
        </div>
      ) : links.length === 0 ? (
        <p className="text-xs text-fg-muted">No invite links.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {links.map((link) => {
            const isRevealing = revealId === link.id && link.token;
            const linkStatus = effectiveStatus(link);
            const isTerminal = linkStatus === "used" || linkStatus === "revoked";

            const rowClasses = (() => {
              if (isRevealing) return "border-warning/50 bg-sunken";
              if (linkStatus === "revoked") return "border-line bg-sunken/50 opacity-60";
              if (linkStatus === "used") return "border-line bg-sunken/50 opacity-75";
              if (linkStatus === "expired") return "border-danger/40 bg-sunken/50 opacity-70";
              // pending
              if (link.single_use ?? false) return "border-warning/40 bg-sunken";
              return "border-line bg-sunken";
            })();

            return (
              <li
                key={link.id}
                className={`flex flex-col gap-1.5 p-3 rounded-lg border transition-all duration-150 ${rowClasses}`}
              >
                {/* Row 1 — name + badges */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-fg truncate flex-1">
                    {link.name || "Default"}
                  </span>
                  <span
                    className={`text-xs font-semibold px-1.5 py-0.5 rounded ${ROLE_COLORS[link.role] ?? ROLE_COLORS.member}`}
                  >
                    {INVITE_ROLE_LABELS[link.role] ?? link.role}
                  </span>

                  {/* Emailed links are single-use and never reveal a token (#731). */}
                  {link.delivery === "email" && (
                    <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-surface-hover text-fg-tertiary">
                      Emailed
                    </span>
                  )}

                  {/* Status badge — shown for non-pending states */}
                  {linkStatus !== "pending" && (
                    <span
                      className={`text-xs font-semibold px-1.5 py-0.5 rounded ${STATUS_COLORS[linkStatus]}`}
                    >
                      {STATUS_LABELS[linkStatus]}
                    </span>
                  )}

                  {/* Expiry text — replaced by used_at when consumed */}
                  {linkStatus !== "used" && (
                    <span
                      className={`text-xs ${link.is_expired ? "text-danger font-semibold" : "text-fg-muted"}`}
                    >
                      {formatExpiry(link)}
                    </span>
                  )}

                  {/* Used-at date — only when consumed */}
                  {linkStatus === "used" && link.used_at && (
                    <span className="text-xs text-fg-muted">
                      Used {formatUsedAt(link.used_at)}
                    </span>
                  )}

                  {/* 1-use indicator — only for live single-use links */}
                  {linkStatus === "pending" && (link.single_use ?? false) && (
                    <span className="text-xs text-warning">1-use</span>
                  )}
                </div>

                {/* Row 2 — token reveal or prefix + revoke (hidden for terminal states) */}
                {isRevealing ? (
                  tokenReveal(link)
                ) : !isTerminal ? (
                  /* Normal display — prefix only + revoke */
                  <div className="flex flex-wrap gap-2">
                    <div className="flex-1 text-xs bg-surface border border-line rounded px-2 py-1 text-fg-tertiary truncate font-mono">
                      {link.prefix}…
                    </div>
                    {revokeControls(link)}
                  </div>
                ) : null}
                {revokeError?.id === link.id && revokeError.message === ALREADY_USED_REVOKE_ERROR && (
                  <p className="text-xs text-danger mt-1">{revokeError.message}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {capWarning}

      {allowShareableLinks && showForm && createForm}
    </div>
  );
}
