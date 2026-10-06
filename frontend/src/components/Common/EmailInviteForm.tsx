import { useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";
import { getSiteConfig } from "../../api/auth";
import type { InviteEmailSent, SiteConfig } from "../../types";
import SingleSelectDropdown from "./SingleSelectDropdown";
import { EMAIL_RE } from "../../constants/inviteEmail";

/**
 * "Invite by email" section shared by the group invite panel, the board
 * Members tab (#1444) and the site-admin Invite Links tab (#731). Copy and
 * feedback are identical on every surface (frontend/CLAUDE.md, feature-parity
 * rule); only the pickers and the surface-specific notices differ.
 */

type Role = "admin" | "member" | "collaborator" | "viewer";
type ExpiryDays = 1 | 7 | 30;

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
  { value: "collaborator", label: "Collaborator" },
  { value: "viewer", label: "Viewer" },
];

// Same auto-clear timing as the other inline success messages (#1280).
const SENT_CLEAR_MS = 5000;

// Backend codes (visiban.mail taxonomy) that mean "the relay itself is the
// problem", so a site admin has something to go fix.
const MAIL_SERVER_CODES = new Set(["auth_failed", "config_unusable", "connection_refused"]);

const HELPER_TEXT = "Sends a single-use link that expires in 7 days.";

const EXPIRY_OPTIONS: { value: ExpiryDays; label: string }[] = [
  { value: 1, label: "1 day" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
];

// Above ModalWrapper's 40: the board form lives inside Board Settings, so an
// open picker must take Escape before the modal does (frontend/CLAUDE.md).
const BOARD_PICKER_ESCAPE_PRIORITY = 51;
const GENERIC_SEND_ERROR = "Could not send — check the address and try again.";


interface Line {
  tone: "success" | "warning" | "danger" | "muted";
  text: string;
}

const TONE_CLASS: Record<Line["tone"], string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-fg-muted",
};

/** Imperative handle for hosts that steer someone into the form (#1444). */
export interface EmailInviteFormHandle {
  /** Fill the address, scroll the form into view and focus Send invite. */
  prefill: (email: string) => void;
}

export interface EmailInvitePayload {
  email: string;
  role?: Role;
  expiry_days?: ExpiryDays;
}

interface Props {
  /** "group" and "board" show the role picker and the sign-up notice; "board"
   *  also an Expires picker; "site" the Settings → Email pointer when mail is
   *  not set up. */
  surface: "group" | "site" | "board";
  send: (payload: EmailInvitePayload) => Promise<InviteEmailSent>;
  /** Called after a successful send so the host can refetch its link list. */
  onSent?: () => void;
  /** Site surface only: switches the Admin page to its Settings tab. */
  onOpenEmailSettings?: () => void;
  /** Group surface: whether the sender (the signed-in user) is a site admin.
   *  On an invite-only site only a site admin's emailed invite lets a new
   *  person create an account (#1445). */
  senderIsSiteAdmin?: boolean;
  /** Role choices; defaults to all four. The board passes Member/Collaborator/
   *  Viewer — an invite can never grant Admin. */
  roleOptions?: { value: Role; label: string }[];
  /** The "or create a shareable link" divider under the form. Off on the
   *  board until shareable board links ship (#439). */
  showLinkDivider?: boolean;
  /** Fired once site-config has loaded (or failed): whether the form renders
   *  a send control at all. */
  onAvailabilityChange?: (available: boolean) => void;
  ref?: Ref<EmailInviteFormHandle>;
}

interface ErrorShape {
  response?: {
    status?: number;
    data?: { code?: string; detail?: string };
    headers?: Record<string, string | undefined>;
  };
}

function errorLines(err: unknown): Line[] {
  const { status, data, headers } = (err as ErrorShape).response ?? {};
  if (status === 400) {
    if (data?.code === "invite_email_cap_reached" && data.detail) {
      return [{ tone: "danger", text: data.detail }];
    }
    return [{ tone: "danger", text: "Enter a valid email address." }];
  }
  if (status === 429) {
    const seconds = Number(headers?.["retry-after"]);
    const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : null;
    const wait = minutes === null ? "a few minutes" : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
    return [{ tone: "warning", text: `You've sent a lot of invites. Try again in ${wait}.` }];
  }
  if (status === 502) {
    const lines: Line[] = [{ tone: "danger", text: GENERIC_SEND_ERROR }];
    if (data?.code && MAIL_SERVER_CODES.has(data.code)) {
      lines.push({
        tone: "muted",
        text: "The mail server rejected the message. A site admin can check Admin → Settings → Email.",
      });
    }
    return lines;
  }
  return [{ tone: "danger", text: GENERIC_SEND_ERROR }];
}

function expiryLabel(days: ExpiryDays): string {
  return days === 1 ? "1 day" : `${days} days`;
}

export default function EmailInviteForm({
  surface,
  send,
  onSent,
  onOpenEmailSettings,
  senderIsSiteAdmin = false,
  roleOptions = ROLE_OPTIONS,
  showLinkDivider = true,
  onAvailabilityChange,
  ref,
}: Props) {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [expiryDays, setExpiryDays] = useState<ExpiryDays>(7);
  const [sending, setSending] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [focusTick, setFocusTick] = useState(0);
  const [prefillTick, setPrefillTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusId = useId();
  // Read through a ref so a host passing an inline callback does not refetch
  // site-config on every render.
  const availabilityRef = useRef(onAvailabilityChange);
  useEffect(() => { availabilityRef.current = onAvailabilityChange; });

  useEffect(() => {
    let cancelled = false;
    getSiteConfig()
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        availabilityRef.current?.(c.invite_email_available);
      })
      // Unknown availability: render nothing rather than offering a send that
      // may not work. The create-link form below is unaffected.
      .catch(() => { if (!cancelled) availabilityRef.current?.(false); });
    return () => { cancelled = true; };
  }, []);

  useImperativeHandle(ref, () => ({
    prefill: (address: string) => {
      setEmail(address);
      setLines([]);
      setPrefillTick((t) => t + 1);
    },
  }), []);

  // After a prefill re-renders the (now enabled) Send button, bring the form
  // into view and put focus on Send so Enter sends the invite.
  useEffect(() => {
    if (prefillTick === 0) return;
    rootRef.current?.scrollIntoView?.({ block: "nearest" });
    submitRef.current?.focus();
  }, [prefillTick]);

  useEffect(() => {
    return () => { if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current); };
  }, []);

  // Focus returns to the input only after the post-send re-render re-enables it
  // (a disabled input cannot take focus).
  useEffect(() => {
    if (focusTick > 0) inputRef.current?.focus();
  }, [focusTick]);

  if (!config) return null;

  const divider = !showLinkDivider ? null : (
    <div className="flex items-center gap-3" aria-hidden="true">
      <div className="flex-1 border-t border-line" />
      <span className="text-xs text-fg-muted">or create a shareable link</span>
      <div className="flex-1 border-t border-line" />
    </div>
  );

  if (!config.invite_email_available) {
    if (surface !== "site") return null;
    // Demo sites switch emailing off on purpose; pointing at Settings would
    // send the admin to a fix that cannot work.
    if (config.demo_mode) {
      return (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-fg-muted">Email invites are disabled on this demo site.</p>
          {divider}
        </div>
      );
    }
    // site-config does not say *why* sending is unavailable (email not set up
    // vs INVITE_EMAIL_ENABLED=false), so the copy covers both causes honestly.
    return (
      <div className="flex flex-col gap-4">
        <p className="text-xs text-fg-muted">
          Email invites aren't available. Check that email is set up in{" "}
          {onOpenEmailSettings ? (
            <button
              type="button"
              onClick={onOpenEmailSettings}
              className="text-info hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Settings → Email
            </button>
          ) : (
            "Settings → Email"
          )}{" "}
          and that email invites are enabled.
        </p>
        {divider}
      </div>
    );
  }

  const valid = EMAIL_RE.test(email.trim());
  // A new person can sign up from a group invite only on an invite-only site,
  // and only when a site admin sent it (#1445). Everyone else sending on a
  // closed or invite-only site gets the "can't sign up" warning.
  const inviteOnly = config.registration_mode === "invite_only";
  // Board invites follow the same rule as group invites (#1444).
  const membershipSurface = surface === "group" || surface === "board";
  const closedSite =
    membershipSurface && (config.registration_mode === "closed" || (inviteOnly && !senderIsSiteAdmin));
  const inviteOnlySite = membershipSurface && inviteOnly && senderIsSiteAdmin;
  const helperText = surface === "board"
    ? `Sends a single-use invite that expires in ${expiryLabel(expiryDays)}.`
    : HELPER_TEXT;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || sending) return;
    const address = email.trim();
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setLines([]);
    setSending(true);
    try {
      const payload: EmailInvitePayload =
        surface === "board" ? { email: address, role, expiry_days: expiryDays }
        : surface === "group" ? { email: address, role }
        : { email: address };
      const res = await send(payload);
      const next: Line[] = [{ tone: "success", text: `Invite sent to ${address}.` }];
      if (res.delivery === "console") {
        next.push({ tone: "warning", text: "Email is printed to the server console in development." });
      }
      setLines(next);
      setEmail("");
      setFocusTick((t) => t + 1);
      clearTimerRef.current = setTimeout(() => {
        setLines([]);
        clearTimerRef.current = null;
      }, SENT_CLEAR_MS);
      onSent?.();
    } catch (err: unknown) {
      setLines(errorLines(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      <h4 className="text-sm font-medium text-fg-tertiary uppercase tracking-wide">Invite by email</h4>
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col sm:flex-row gap-2 items-start">
        <input
          ref={inputRef}
          type="email"
          autoComplete="off"
          aria-label="Email address"
          aria-describedby={statusId}
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={sending}
          className="w-full sm:flex-1 min-w-0 bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent disabled:opacity-40"
        />
        {surface === "group" && (
          <SingleSelectDropdown<Role>
            label="Role"
            options={roleOptions}
            selected={role}
            onChange={(v) => { if (v) setRole(v); }}
          />
        )}
        {surface === "board" && (
          <>
            <SingleSelectDropdown<Role>
              label="Role"
              options={roleOptions}
              selected={role}
              onChange={(v) => { if (v) setRole(v); }}
              portalMenu
              escapePriority={BOARD_PICKER_ESCAPE_PRIORITY}
            />
            <SingleSelectDropdown<ExpiryDays>
              label="Expires"
              options={EXPIRY_OPTIONS}
              selected={expiryDays}
              onChange={(v) => { if (v) setExpiryDays(v); }}
              portalMenu
              escapePriority={BOARD_PICKER_ESCAPE_PRIORITY}
            />
          </>
        )}
        <button
          ref={submitRef}
          type="submit"
          disabled={!valid || sending}
          className="px-3 py-1.5 text-sm rounded font-medium bg-button-primary hover:bg-button-primary-hover disabled:opacity-40 text-on-primary transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          {sending ? "Sending…" : "Send invite"}
        </button>
      </form>

      {/* One reserved status slot for every state — never a toast. */}
      <div id={statusId} role="status" aria-live="polite" aria-atomic="true" className="text-xs min-h-4 flex flex-col gap-0.5">
        {lines.length === 0 && !sending ? (
          <p className="text-fg-muted">{helperText}</p>
        ) : (
          lines.map((l) => (
            <p key={l.text} className={TONE_CLASS[l.tone]}>{l.text}</p>
          ))
        )}
      </div>

      {inviteOnlySite && (
        <p className="text-xs text-fg-muted">
          New people can join this site only from invites you email, not from a shareable link.
        </p>
      )}

      {closedSite && (
        <p className="text-xs text-warning">
          New users can't sign up on this site. Only people who already have an account can join from this invite.
        </p>
      )}

      {divider}
    </div>
  );
}
