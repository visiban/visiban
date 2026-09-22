import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAdminEmailSettings,
  patchAdminEmailSettings,
  sendAdminTestEmail,
} from "../../api/auth";
import type {
  EmailConfigSource,
  EmailTestErrorCode,
  SiteEmailSettings,
  SiteEmailSettingsPatch,
  User,
} from "../../types";

/**
 * Admin → Settings → Email (SMTP). Issue #306.
 *
 * This section deliberately diverges from its siblings in `SettingsTab`, which
 * all autosave on blur or on selection. Per frontend/CLAUDE.md § Composite
 * inline editors, an editor with interdependent sub-fields and cross-field
 * validation uses explicit Save/Cancel — and here the stakes make the rule
 * concrete: a PATCH landing `config_source: "database"` with an empty host
 * would silently kill every password reset on the instance, and blur-commit
 * makes that a reachable state on the way to a good one.
 */

type Encryption = "starttls" | "ssl" | "none";

interface EmailDraft {
  config_source: EmailConfigSource;
  host: string;
  port: string; // string while editing; parsed on save
  username: string;
  encryption: Encryption;
  from_email: string;
  timeout: string; // string while editing
}

type FieldKey = keyof EmailDraft | "password";

type TestResult =
  | { kind: "success"; email: string }
  | { kind: "failure"; code: EmailTestErrorCode }
  | { kind: "throttled" }
  | { kind: "network" };

const CONFIG_SOURCE_OPTIONS: ReadonlyArray<{
  value: EmailConfigSource;
  label: string;
  description: string;
}> = [
  {
    value: "env",
    label: "Environment variables",
    description: "Use the EMAIL_* variables set on the server. The settings below are ignored.",
  },
  {
    value: "database",
    label: "Database",
    description: "Use the settings below. They override the EMAIL_* environment variables.",
  },
];

const ENCRYPTION_OPTIONS: ReadonlyArray<{ value: Encryption; label: string }> = [
  { value: "starttls", label: "STARTTLS" },
  { value: "ssl", label: "SSL/TLS" },
  { value: "none", label: "None" },
];

const ENCRYPTION_HELP: Record<Encryption, string> = {
  starttls: "Connects in the clear, then upgrades to TLS. Standard on port 587.",
  ssl: "Encrypted from the first byte. Standard on port 465.",
  none: "",
};

/**
 * Two booleans that cannot both be true are really a three-state choice, so the
 * draft holds the choice and the wire mapping lives here. Keeping it in one
 * named pair rather than inline is what makes the "backend somehow returned
 * both true" case resolvable in exactly one place.
 */
function encryptionFromServer(s: Pick<SiteEmailSettings, "use_tls" | "use_ssl">): Encryption {
  if (s.use_ssl) return "ssl";
  if (s.use_tls) return "starttls";
  return "none";
}

function encryptionToWire(e: Encryption): { use_tls: boolean; use_ssl: boolean } {
  if (e === "ssl") return { use_tls: false, use_ssl: true };
  if (e === "starttls") return { use_tls: true, use_ssl: false };
  return { use_tls: false, use_ssl: false };
}

function serverToDraft(s: SiteEmailSettings): EmailDraft {
  return {
    config_source: s.config_source,
    host: s.host,
    port: String(s.port),
    username: s.username,
    encryption: encryptionFromServer(s),
    from_email: s.from_email,
    timeout: String(s.timeout),
  };
}

function draftToPatch(d: EmailDraft): SiteEmailSettingsPatch {
  return {
    config_source: d.config_source,
    host: d.host.trim(),
    port: Number(d.port),
    username: d.username.trim(),
    from_email: d.from_email.trim(),
    timeout: Number(d.timeout),
    ...encryptionToWire(d.encryption),
  };
}

function draftsEqual(a: EmailDraft, b: EmailDraft): boolean {
  return (
    a.config_source === b.config_source &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.encryption === b.encryption &&
    a.from_email === b.from_email &&
    a.timeout === b.timeout
  );
}

// Plain addresses only, matching the backend's DRF EmailField exactly.
//
// `Visiban <noreply@acme.com>` is a legal SMTP From value and an earlier draft
// accepted it here — but the backend rejects it, so the client was promising
// something the server would 400 on. Keeping the server strict is deliberate:
// EmailField is what makes CRLF header injection into the SMTP conversation
// unreachable, and relaxing it to a permissive regex would reopen that surface.
// If display-name senders are wanted later, that is a separate change with an
// explicit validator rejecting \r, \n, U+2028, U+2029 and U+0085.
const PLAIN_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isIntegerInRange(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value.trim())) return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max;
}

const TEST_COPY: Record<EmailTestErrorCode, { headline: string; remedy: string }> = {
  dns_failure: {
    headline: "Couldn't find that mail server.",
    remedy: "Check the host name for typos.",
  },
  connection_refused: {
    headline: "The mail server refused the connection.",
    remedy: "Check the port, and that a firewall isn't blocking it.",
  },
  tls_failure: {
    headline: "Encryption handshake failed.",
    remedy: "Try another encryption mode, or check the server certificate.",
  },
  auth_failed: {
    headline: "The server rejected the username or password.",
    remedy: "Re-enter the password and save before testing again.",
  },
  timeout: {
    headline: "The mail server didn't respond in time.",
    remedy: "Check the host and port, or raise the timeout.",
  },
  config_unusable: {
    headline: "The saved configuration can't be used.",
    remedy: "Complete the settings above and save, then test again.",
  },
  no_recipient: {
    headline: "Your account has no email address.",
    remedy: "Add one in your profile, then test again.",
  },
  backend_pinned: {
    headline: "EMAIL_BACKEND is set on the server.",
    remedy: "Visiban can't test that path — it is not what sends mail.",
  },
  unknown: {
    headline: "The test failed.",
    remedy: "Check the server logs — the error wasn't recognized.",
  },
};

interface Props {
  currentUser: User;
}

export default function EmailSettingsSection({ currentUser }: Props) {
  const [server, setServer] = useState<SiteEmailSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [passwordInput, setPasswordInput] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingSourceSwitch, setConfirmingSourceSwitch] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    getAdminEmailSettings()
      .then((data) => {
        setServer(data);
        setDraft(serverToDraft(data));
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty =
    !!draft &&
    !!server &&
    (!draftsEqual(draft, serverToDraft(server)) || passwordInput !== "" || clearPassword);

  function validate(d: EmailDraft, s: SiteEmailSettings): Partial<Record<FieldKey, string>> {
    const next: Partial<Record<FieldKey, string>> = {};
    const dbSelected = d.config_source === "database";

    if (dbSelected && !d.host.trim()) next.host = "Host is required.";
    if (!isIntegerInRange(d.port, 1, 65535)) {
      next.port = "Port must be a whole number between 1 and 65535.";
    }
    if (!isIntegerInRange(d.timeout, 1, 300)) {
      next.timeout = "Timeout must be a whole number between 1 and 300.";
    }

    const from = d.from_email.trim();
    if (dbSelected && !from) {
      next.from_email = "From address is required.";
    } else if (from && !PLAIN_EMAIL.test(from)) {
      next.from_email = "Enter a valid email address.";
    }

    // The cross-field rule that puts this form under the explicit-Save rule:
    // a username with no password after save cannot authenticate.
    const willHavePassword = clearPassword
      ? passwordInput !== ""
      : passwordInput !== "" || s.password_set;
    if (d.username.trim() && !willHavePassword) {
      next.password = "A password is required when a username is set.";
    }

    return next;
  }

  function commitSave() {
    if (!draft || !server) return;
    setConfirmingSourceSwitch(false);
    setSaving(true);
    setSaveError(null);
    setSaved(false);

    const patch = draftToPatch(draft);
    // "Leave blank to keep" is enforced on the wire: the key is absent unless
    // the admin typed a new value or explicitly asked to clear it.
    if (passwordInput !== "") {
      patch.password = passwordInput;
    } else if (clearPassword) {
      patch.password = "";
    }

    patchAdminEmailSettings(patch)
      .then((updated) => {
        setServer(updated);
        setDraft(serverToDraft(updated));
        setPasswordInput("");
        setClearPassword(false);
        setErrors({});
        setSaved(true);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaved(false), 3000);
      })
      .catch((err: unknown) => {
        // Distribute DRF field errors where the keys match, so the admin sees
        // the problem next to the field rather than only a generic line.
        const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
        if (data && typeof data === "object") {
          const fieldErrors: Partial<Record<FieldKey, string>> = {};
          for (const key of [
            "config_source", "host", "port", "username",
            "password", "from_email", "timeout",
          ] as FieldKey[]) {
            const value = data[key];
            if (Array.isArray(value) && typeof value[0] === "string") {
              fieldErrors[key] = value[0];
            } else if (typeof value === "string") {
              fieldErrors[key] = value;
            }
          }
          if (Object.keys(fieldErrors).length > 0) setErrors(fieldErrors);
        }
        setSaveError("Failed to save email settings.");
      })
      .finally(() => setSaving(false));
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || !server || saving) return;

    const found = validate(draft, server);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    // Switching env → database re-routes all outbound mail the moment it saves,
    // so it takes the inline confirmation. The reverse restores the previous
    // behavior and needs none.
    if (
      server.config_source === "env" &&
      draft.config_source === "database" &&
      !confirmingSourceSwitch
    ) {
      setConfirmingSourceSwitch(true);
      return;
    }
    commitSave();
  }

  function handleCancel() {
    if (!server) return;
    setDraft(serverToDraft(server));
    setPasswordInput("");
    setClearPassword(false);
    setErrors({});
    setSaveError(null);
    setConfirmingSourceSwitch(false);
  }

  function handleTest() {
    setTesting(true);
    setTestResult(null);
    sendAdminTestEmail()
      .then((result) => {
        setTestResult(
          result.success
            ? { kind: "success", email: result.sent_to ?? currentUser.email }
            : { kind: "failure", code: result.code ?? "unknown" },
        );
      })
      .catch((err: unknown) => {
        const response = (err as {
          response?: { status?: number; data?: { code?: EmailTestErrorCode } };
        })?.response;
        if (response?.status === 429) {
          setTestResult({ kind: "throttled" });
        } else if (response?.data?.code) {
          setTestResult({ kind: "failure", code: response.data.code });
        } else if (response?.status && response.status < 500) {
          setTestResult({ kind: "failure", code: "unknown" });
        } else {
          setTestResult({ kind: "network" });
        }
      })
      .finally(() => setTesting(false));
  }

  const heading = (
    <p className="text-sm font-medium text-fg-tertiary uppercase tracking-wide mb-3">
      Email (SMTP)
    </p>
  );

  if (loading) {
    return (
      <div>
        {heading}
        <div className="px-4 py-3 rounded-lg border border-line bg-surface">
          <p className="text-sm text-fg-tertiary">Loading…</p>
        </div>
      </div>
    );
  }

  if (loadError || !server || !draft) {
    return (
      <div>
        {heading}
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-line bg-surface">
          <p className="text-sm text-danger">Failed to load email settings.</p>
          <button
            type="button"
            onClick={load}
            className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-0.5 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // --- "Currently sending mail" panel derivation -------------------------
  const passwordBroken = server.password_set && !server.password_decryptable;
  let tone: "neutral" | "warning" = "neutral";
  let sourceLabel: string;
  let warningText = "";
  const detailLines: string[] = [];

  if (server.effective_source === "env_backend_override") {
    tone = "warning";
    sourceLabel = "EMAIL_BACKEND override";
    warningText =
      "EMAIL_BACKEND is set on the server, so both the environment SMTP variables and the settings below are bypassed.";
  } else {
    sourceLabel =
      server.effective_source === "env" ? "Environment variables" : "Database";
    if (server.effective_host) {
      detailLines.push(
        `${server.effective_host}:${server.effective_port} · ${server.effective_use_tls ? "TLS on" : "TLS off"}`,
      );
    }
    if (server.effective_from_email) {
      detailLines.push(`From ${server.effective_from_email}`);
    }
    if (!server.effective_host) {
      tone = "warning";
      warningText =
        "No mail server is set, so password resets and invites are not being delivered.";
    } else if (server.effective_source === "database" && passwordBroken) {
      tone = "warning";
      warningText =
        "The stored password can't be decrypted, so mail is failing. Re-enter it below.";
    }
  }

  // --- password helper state --------------------------------------------
  let passwordPlaceholder = "";
  let passwordLine1: React.ReactNode = null;
  let passwordLine2: React.ReactNode = null;

  if (clearPassword) {
    passwordLine1 = <span className="text-warning">Password will be cleared when you save.</span>;
    passwordLine2 = (
      <button
        type="button"
        onClick={() => setClearPassword(false)}
        className="text-fg-secondary hover:text-fg underline rounded text-xs focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >
        Undo
      </button>
    );
  } else if (!server.password_set) {
    passwordLine1 = <span className="text-fg-muted">No password stored.</span>;
    passwordLine2 = (
      <span className="text-fg-muted">
        Leave blank if your server doesn&rsquo;t require a password.
      </span>
    );
  } else if (server.password_decryptable) {
    passwordPlaceholder = "Leave blank to keep the current password";
    passwordLine1 = <span className="text-fg-muted">A password is stored.</span>;
    passwordLine2 = (
      <span className="text-fg-muted">Type a new one to replace it, or Clear to remove it.</span>
    );
  } else {
    passwordPlaceholder = "Enter the password again";
    passwordLine1 = (
      <span className="text-warning">Can&rsquo;t decrypt the stored password — re-enter it.</span>
    );
    passwordLine2 = (
      <span className="text-warning">The server&rsquo;s secret key most likely changed.</span>
    );
  }
  if (errors.password) {
    // Replaces BOTH lines. Overriding only line 1 would leave "Leave blank if
    // your server doesn't require authentication." sitting directly beneath
    // "A password is required when a username is set." — two contradictory
    // instructions shown at once.
    passwordLine1 = <span className="text-danger">{errors.password}</span>;
    passwordLine2 = null;
  }

  // --- test result copy --------------------------------------------------
  let resultHeadline: React.ReactNode = null;
  let resultRemedy: React.ReactNode = null;
  if (dirty) {
    resultHeadline = <span className="text-fg-muted">Save your changes before testing.</span>;
  } else if (testing) {
    resultHeadline = <span className="text-fg-muted">Sending…</span>;
  } else if (testResult?.kind === "success") {
    resultHeadline = <span className="text-success">Test email sent to {testResult.email}.</span>;
    resultRemedy = <span className="text-fg-muted">Check your inbox — and your spam folder.</span>;
  } else if (testResult?.kind === "throttled") {
    resultHeadline = <span className="text-warning">Too many test emails.</span>;
    resultRemedy = <span className="text-fg-muted">You can send 5 per hour. Try again later.</span>;
  } else if (testResult?.kind === "network") {
    resultHeadline = <span className="text-danger">Couldn&rsquo;t reach Visiban to run the test.</span>;
    resultRemedy = <span className="text-fg-muted">Check your connection and try again.</span>;
  } else if (testResult?.kind === "failure") {
    const copy = TEST_COPY[testResult.code] ?? TEST_COPY.unknown;
    resultHeadline = <span className="text-danger">{copy.headline}</span>;
    resultRemedy = <span className="text-fg-muted">{copy.remedy}</span>;
  }

  const inputClass =
    "w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted transition";
  const labelClass = "block text-xs font-medium text-fg-tertiary uppercase tracking-wide";

  return (
    <div>
      {heading}
      <div className="flex flex-col gap-3 px-4 py-3 rounded-lg border border-line bg-surface">
        {/* A. What is actually sending mail right now */}
        <div
          role="group"
          aria-labelledby="smtp-effective-heading"
          className={`flex flex-col gap-1 px-3 py-2 rounded border ${
            tone === "warning" ? "border-warning/30 bg-warning/10" : "border-line bg-sunken"
          }`}
        >
          <div className="flex items-center gap-2">
            {tone === "warning" && (
              <span aria-hidden="true" className="text-base leading-none shrink-0 text-warning">
                ⚠
              </span>
            )}
            <p
              id="smtp-effective-heading"
              className="text-xs font-medium text-fg-tertiary uppercase tracking-wide"
            >
              Currently sending mail
            </p>
          </div>
          <p className={`text-sm font-medium ${tone === "warning" ? "text-warning" : "text-fg"}`}>
            {sourceLabel}
          </p>
          {detailLines.map((line) => (
            <p key={line} className="text-xs text-fg-muted truncate min-w-0" title={line}>
              {line}
            </p>
          ))}
          {/* min-h-4, not h-4: these warnings are full sentences that wrap to
              two lines at text-xs inside max-w-lg, and the two most common ones
              are first-run states. A fixed h-4 would clip the second line into
              the block below. The space is still reserved unconditionally. */}
          <p className="text-xs min-h-4">
            {warningText && <span className="text-warning">{warningText}</span>}
          </p>
        </div>

        {/* noValidate is load-bearing: the number inputs carry min/max for the
            spinner UI, and without it the browser's native constraint
            validation silently blocks submit on an out-of-range port and shows
            an unstyled native bubble instead of the reserved error slot — so
            the field would never get aria-invalid and the message would not
            match the rest of the form. Our validate() is the single authority. */}
        <form onSubmit={handleSave} noValidate className="flex flex-col gap-3">
          {/* B1. Configuration source */}
          <div
            className="flex flex-col gap-2"
            role="radiogroup"
            aria-label="Email configuration source"
          >
            {CONFIG_SOURCE_OPTIONS.map(({ value, label, description }) => (
              <label
                key={value}
                className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg border transition-colors duration-150 cursor-pointer focus-within:ring-2 focus-within:ring-primary-emphasis ${
                  saving ? "opacity-40 pointer-events-none" : ""
                } ${
                  draft.config_source === value
                    ? "border-primary-emphasis bg-primary-emphasis/10"
                    : "border-line-strong hover:bg-surface-hover/40"
                }`}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name="smtp_config_source"
                  value={value}
                  checked={draft.config_source === value}
                  disabled={saving}
                  onChange={() => setDraft((d) => (d ? { ...d, config_source: value } : d))}
                />
                <span
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    draft.config_source === value
                      ? "border-primary-emphasis"
                      : "border-line-strong"
                  }`}
                >
                  {draft.config_source === value && (
                    <span className="w-2 h-2 rounded-full bg-primary-emphasis" />
                  )}
                </span>
                <span>
                  <span className="block text-sm font-medium text-fg">{label}</span>
                  <span className="block text-xs text-fg-muted mt-0.5">{description}</span>
                </span>
              </label>
            ))}
          </div>

          {/* B2. The stored SMTP configuration.
              Deliberately NOT indented as a subordinate settings block: these
              fields stay relevant whichever source is selected, because the
              only safe migration path is fill in → save → test → then switch.
              Gating them on the radio would force admins to switch blind. */}
          <div className="pt-3 border-t border-line-subtle flex flex-col gap-3">
            <div>
              <p className="text-xs font-medium text-fg-tertiary uppercase tracking-wide">
                SMTP server
              </p>
              {/* Reads server, not draft. The panel above states saved truth
                  only, and this line makes the same kind of present-tense
                  claim — asserting "not in use" from an uncommitted radio
                  click would be false while the database config is still
                  live. */}
              <p className="text-xs min-h-4">
                {server.config_source === "env" && (
                  <span className="text-fg-muted">
                    Saved, but not in use — Environment variables is selected above.
                  </span>
                )}
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="smtp-host" className={labelClass}>
                Host
              </label>
              <input
                id="smtp-host"
                type="text"
                value={draft.host}
                onChange={(e) => setDraft((d) => (d ? { ...d, host: e.target.value } : d))}
                disabled={saving}
                placeholder="smtp.example.com"
                autoComplete="off"
                aria-invalid={!!errors.host}
                aria-describedby="smtp-host-help"
                className={inputClass}
              />
              <p id="smtp-host-help" className="text-xs h-4">
                {errors.host ? (
                  <span className="text-danger">{errors.host}</span>
                ) : (
                  <span className="text-fg-muted">Hostname or IP address of your SMTP server.</span>
                )}
              </p>
            </div>

            <div className="flex flex-wrap items-start gap-4">
              <div className="flex flex-col gap-1">
                <label htmlFor="smtp-port" className={labelClass}>
                  Port
                </label>
                <input
                  id="smtp-port"
                  type="number"
                  min={1}
                  max={65535}
                  inputMode="numeric"
                  value={draft.port}
                  onChange={(e) => setDraft((d) => (d ? { ...d, port: e.target.value } : d))}
                  disabled={saving}
                  aria-invalid={!!errors.port}
                  aria-describedby="smtp-port-help"
                  className="w-24 bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent transition"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="smtp-timeout" className={labelClass}>
                  Timeout
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="smtp-timeout"
                    type="number"
                    min={1}
                    max={300}
                    inputMode="numeric"
                    value={draft.timeout}
                    onChange={(e) => setDraft((d) => (d ? { ...d, timeout: e.target.value } : d))}
                    disabled={saving}
                    aria-invalid={!!errors.timeout}
                    aria-describedby="smtp-timeout-help"
                    className="w-20 bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent transition"
                  />
                  <span className="text-sm text-fg-tertiary">seconds</span>
                </div>
              </div>
            </div>
            <div className="flex gap-4">
              <p id="smtp-port-help" className="text-xs min-h-4">
                {errors.port && <span className="text-danger">{errors.port}</span>}
              </p>
              <p id="smtp-timeout-help" className="text-xs h-4">
                {errors.timeout ? (
                  <span className="text-danger">{errors.timeout}</span>
                ) : (
                  <span className="text-fg-muted">How long to wait before giving up.</span>
                )}
              </p>
            </div>
            <p className="text-xs text-fg-muted">
              Conventional ports: 587 STARTTLS · 465 SSL/TLS · 25 unencrypted.
            </p>

            {/* Encryption. A radio group, not two toggles: two booleans that
                cannot both be true make the illegal state representable, and
                the recovery is either an error the user must fix or a silent
                mutation of the other control. */}
            <div className="flex flex-col gap-1">
              <p className={labelClass}>Encryption</p>
              <div
                className="flex flex-wrap gap-2"
                role="radiogroup"
                aria-label="Encryption"
                aria-describedby="smtp-encryption-help"
              >
                {ENCRYPTION_OPTIONS.map(({ value, label }) => (
                  <label
                    key={value}
                    className={`px-2 py-1 text-xs rounded border cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-emphasis ${
                      saving ? "opacity-40 pointer-events-none" : ""
                    } ${
                      draft.encryption === value
                        ? "border-primary-emphasis bg-primary-emphasis/10 text-fg"
                        : "border-line-strong hover:bg-surface-hover/40 text-fg-secondary"
                    }`}
                  >
                    <input
                      type="radio"
                      className="sr-only"
                      name="smtp_encryption"
                      value={value}
                      checked={draft.encryption === value}
                      disabled={saving}
                      onChange={() => setDraft((d) => (d ? { ...d, encryption: value } : d))}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p id="smtp-encryption-help" className="text-xs h-4">
                {draft.encryption === "none" ? (
                  <span className="text-warning">
                    Credentials and message contents are sent unencrypted.
                  </span>
                ) : (
                  <span className="text-fg-muted">{ENCRYPTION_HELP[draft.encryption]}</span>
                )}
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="smtp-username" className={labelClass}>
                Username
              </label>
              <input
                id="smtp-username"
                type="text"
                value={draft.username}
                onChange={(e) => setDraft((d) => (d ? { ...d, username: e.target.value } : d))}
                disabled={saving}
                placeholder="user@example.com"
                autoComplete="off"
                aria-invalid={!!errors.username}
                aria-describedby="smtp-username-help"
                className={inputClass}
              />
              <p id="smtp-username-help" className="text-xs h-4">
                {errors.username ? (
                  <span className="text-danger">{errors.username}</span>
                ) : (
                  <span className="text-fg-muted">
                    Leave blank if your server doesn&rsquo;t require authentication.
                  </span>
                )}
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label htmlFor="smtp-password" className={labelClass}>
                  Password
                </label>
                {server.password_set && !clearPassword && (
                  <button
                    type="button"
                    onClick={() => {
                      setClearPassword(true);
                      setPasswordInput("");
                    }}
                    disabled={saving}
                    className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-0.5 rounded text-xs disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    Clear
                  </button>
                )}
              </div>
              <input
                id="smtp-password"
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                disabled={saving || clearPassword}
                placeholder={passwordPlaceholder}
                autoComplete="new-password"
                aria-invalid={!!errors.password}
                aria-describedby="smtp-password-help"
                className={`w-full bg-surface border rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted transition disabled:opacity-40 ${
                  passwordBroken ? "border-warning/50" : "border-line"
                }`}
              />
              <div id="smtp-password-help" className="text-xs h-8">
                <p>{passwordLine1}</p>
                <p>{passwordLine2}</p>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="smtp-from-email" className={labelClass}>
                From address
              </label>
              <input
                id="smtp-from-email"
                type="text"
                value={draft.from_email}
                onChange={(e) => setDraft((d) => (d ? { ...d, from_email: e.target.value } : d))}
                disabled={saving}
                placeholder="noreply@yourdomain.com"
                autoComplete="off"
                aria-invalid={!!errors.from_email}
                aria-describedby="smtp-from-email-help"
                className={inputClass}
              />
              <p id="smtp-from-email-help" className="text-xs h-4">
                {errors.from_email ? (
                  <span className="text-danger">{errors.from_email}</span>
                ) : (
                  <span className="text-fg-muted">
                    The address recipients see. Some providers require it to match the username.
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* B3. Footer. This section owns its own status line rather than
              writing to the tab-level one, which sits far below the button. */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="text-xs h-4">
              {saveError ? (
                <span className="text-danger">{saveError}</span>
              ) : saved ? (
                <span className="text-success">Email settings saved.</span>
              ) : dirty ? (
                <span className="text-fg-muted">Unsaved changes</span>
              ) : null}
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={handleCancel}
                disabled={!dirty || saving}
                aria-label="Discard email settings changes"
                className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!dirty || saving}
                className="bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium px-3 py-1.5 rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Save email settings
              </button>
            </div>
          </div>

          {confirmingSourceSwitch && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-fg-tertiary">
                Switch to database configuration? All outbound email will use these settings as
                soon as you save.
              </span>
              <button
                type="button"
                onClick={commitSave}
                className="text-danger hover:text-danger font-medium transition rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirmingSourceSwitch(false)}
                aria-label="Cancel switching the email configuration source"
                className="text-fg-tertiary hover:text-fg transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Cancel
              </button>
            </div>
          )}
        </form>

        {/* C. Verification. Outside the <form> so Enter can never fire it, and
            below the divider so "this tests what is saved, not what you typed"
            reads without needing a paragraph to explain it. */}
        <div className="pt-3 border-t border-line-subtle flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || dirty}
              title={dirty ? "Save your changes before testing." : undefined}
              className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis flex items-center gap-2"
            >
              {testing && (
                <span
                  className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0"
                  aria-hidden="true"
                />
              )}
              {testing ? "Sending…" : "Send test email"}
            </button>
          </div>
          <p className="text-xs text-fg-muted">
            Sends a test message to your own address ({currentUser.email}) using the saved
            configuration.
          </p>
          <div role="status" aria-live="polite" aria-atomic="true">
            <p className="text-xs h-4">{resultHeadline}</p>
            <p className="text-xs h-4">{resultRemedy}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
