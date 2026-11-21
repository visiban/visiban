/**
 * Shared page parts (#2475, Consistency sheet). Every page redesign (#2473, #2474, #2476–#2480)
 * builds from these instead of spelling the classes out again. Colors are app tokens only
 * (the #2475 token table): Page `bg-page`, Panel `bg-surface`, Well `bg-canvas`, Sunken
 * `bg-sunken`, Chip `bg-surface-hover`. No part hard-codes a color. See frontend/CLAUDE.md
 * § Shared page layouts and parts.
 */
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./buttonClasses";
import { STATUS_TONE_LABEL, type StatusControlTone, type StatusTone } from "./model";

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
}

/**
 * A native button in one of the six variants. `type` defaults to "button" so a part inside a
 * form never submits by accident; an icon-only button must be given an `aria-label`.
 */
export function Button({ variant = "secondary", size, fullWidth, className, type = "button", buttonRef, ...rest }: ButtonProps) {
  return <button ref={buttonRef} type={type} className={buttonClasses(variant, { size, fullWidth, className })} {...rest} />;
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

/**
 * Page heading: an `h2` at 24/650 with a one-line description. The `h1` belongs to the app
 * header (#2473); pages outside the shell use `CenteredLayout`, which keeps its own `h1`.
 * `accessory` holds the star and status control on the Overview layout, beside the heading.
 */
export function PageHeading({ title, description, accessory, actions, id, headingRef, level: Tag = "h2" }: {
  title: ReactNode;
  description?: ReactNode;
  accessory?: ReactNode;
  actions?: ReactNode;
  id?: string;
  /** Heading level. Defaults to `h2`; a section inside a page that already has an `h2` passes `h3`. */
  level?: "h2" | "h3";
  /** Makes the heading focusable (`tabIndex=-1`) so a page can move focus here when the row that held it goes away. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Tag id={id} ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="text-2xl font-semibold text-fg break-words focus:outline-none">{title}</Tag>
          {accessory}
        </div>
        {description && <p className="mt-1 text-sm text-fg-secondary">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Card heading, 15/650. Level defaults to `h3` (under the page's `h2`). */
export function CardHeading({ children, as: Tag = "h3", id }: { children: ReactNode; as?: "h2" | "h3" | "h4"; id?: string }) {
  return <Tag id={id} className="text-[15px] leading-5 font-semibold text-fg">{children}</Tag>;
}

/** Section label: 13px uppercase, 0.06em tracking, `fg-tertiary`. */
export function SectionLabel({ children, as: Tag = "h3", id }: { children: ReactNode; as?: "h2" | "h3" | "h4" | "p"; id?: string }) {
  return <Tag id={id} className="text-[13px] leading-5 font-semibold uppercase tracking-[0.06em] text-fg-tertiary">{children}</Tag>;
}

// ---------------------------------------------------------------------------
// Status pills
// ---------------------------------------------------------------------------

// Tint + on-tint text + a solid dot: tint, dot and word together, so color is never the only
// signal. The Pending pair is the Filter panel's measured active pair (7.78:1 light, 7.15 dark).
const STATUS_TONE_CLASS: Record<StatusControlTone, { pill: string; dot: string }> = {
  on_track: { pill: "bg-success/15 text-success-on-tint", dot: "bg-success" },
  at_risk: { pill: "bg-warning/15 text-warning-on-tint", dot: "bg-warning" },
  off_track: { pill: "bg-danger/15 text-danger-on-tint", dot: "bg-danger" },
  pending: { pill: "bg-primary-emphasis/10 text-info-on-tint", dot: "bg-info" },
  // Hollow: a boundary border on the panel color and a hollow dot.
  none: { pill: "bg-surface border border-line-boundary text-fg-secondary", dot: "border border-fg-secondary" },
};

/** Static status pill (22–24px at 12px) for listings. */
export function StatusPill({ tone, label }: { tone: StatusTone; label?: string }) {
  const c = STATUS_TONE_CLASS[tone];
  return (
    <span data-tone={tone} className={`inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-xs font-medium whitespace-nowrap ${c.pill}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full shrink-0 ${c.dot}`} />
      {label ?? STATUS_TONE_LABEL[tone]}
    </span>
  );
}

/**
 * A bare status dot for dense lists (the nav drawer and the board switcher, #2473). The status
 * word rides along as sr-only text and a tooltip, so color is never the only signal.
 */
export function StatusDot({ tone }: { tone: StatusControlTone }) {
  const label = STATUS_TONE_LABEL[tone];
  return (
    <span data-tone={tone} title={label} className="inline-flex items-center shrink-0">
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${STATUS_TONE_CLASS[tone].dot}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Interactive status control: a 30px button at 13px, as in the board header. */
export function StatusControl({ tone, label, onClick, "aria-label": ariaLabel, "aria-expanded": ariaExpanded, "aria-haspopup": ariaHasPopup, buttonRef }: {
  tone: StatusControlTone;
  label?: string;
  onClick?: () => void;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "dialog" | "menu" | "listbox" | true;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const c = STATUS_TONE_CLASS[tone];
  return (
    <button
      ref={buttonRef}
      type="button"
      data-tone={tone}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup}
      className={`inline-flex items-center gap-1.5 h-[30px] max-sm:h-11 px-2.5 rounded-full text-[13px] font-medium whitespace-nowrap transition hover:ring-1 hover:ring-inset hover:ring-line-emphasis focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${c.pill}`}
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full shrink-0 ${c.dot}`} />
      {label ?? STATUS_TONE_LABEL[tone]}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Filter pills
// ---------------------------------------------------------------------------

/**
 * Identical to the board's Show chips (#2272): 34px pills, a count in every pill. `count` may be omitted only when the server cannot supply one (Admin → Board invites, #2476); never show a count the page did not load. Selected is a
 * 22% primary tint with the selected (`info`) border and weight 650 plus `aria-pressed`, so the
 * state never rests on color alone; resting is the panel color with a `line-strong` border.
 */
export function FilterPill({ label, count, selected, onClick }: { label: string; count?: number; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 h-[34px] max-sm:h-11 px-3 rounded-full border text-sm text-fg transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
        selected ? "bg-primary/[0.22] border-info font-semibold" : "bg-surface border-line-strong font-medium hover:bg-surface-hover"
      }`}
    >
      <span>{label}</span>
      {count !== undefined && <span className="text-fg-secondary tabular-nums">{count}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// List well and rows
// ---------------------------------------------------------------------------

/** A list or table on the page ground, like a board cell. Wide tables scroll inside the well. */
export function ListWell({ children, label, as: Tag = "div" }: { children: ReactNode; label?: string; as?: "div" | "ul" }) {
  return (
    <Tag aria-label={label} className="bg-canvas border border-line rounded-[10px] p-1 overflow-x-auto flex flex-col gap-0.5">
      {children}
    </Tag>
  );
}

/** A row in a `ListWell`: 8px radius, highlights to the panel color on hover. */
export function ListRow({ children, as: Tag = "div" }: { children: ReactNode; as?: "div" | "li" }) {
  return <Tag className="flex items-center gap-3 min-w-0 rounded-lg px-3 py-2 text-sm text-fg hover:bg-surface transition-colors">{children}</Tag>;
}

// ---------------------------------------------------------------------------
// Settings card and rows
// ---------------------------------------------------------------------------

/** Settings card: the panel color, 10px radius, 18px padding. */
export function SettingsCard({ title, description, children, id, headingAs }: { title?: ReactNode; description?: ReactNode; children: ReactNode; id?: string; /** `h4` when the card sits under a section's `h3` heading (default `h3`). */ headingAs?: "h3" | "h4" }) {
  const headingId = useId();
  return (
    <section aria-labelledby={title ? (id ?? headingId) : undefined} className="bg-surface border border-line rounded-[10px] p-[18px]">
      {title && <CardHeading as={headingAs} id={id ?? headingId}>{title}</CardHeading>}
      {description && <p className="mt-1 text-sm text-fg-secondary">{description}</p>}
      <div className={title || description ? "mt-3" : ""}>{children}</div>
    </section>
  );
}

/**
 * A 44×26 switch. Saves on change: the caller persists in `onChange`, there is no Save button.
 * On phones the hit area grows to 44×44 around the same track (§ Phone touch targets).
 */
export function Switch({ checked, onChange, disabled, busy, id, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, "aria-describedby": ariaDescribedBy }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** In-flight save: sets `aria-busy` but keeps the switch enabled, so focus is not dropped. */
  busy?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={() => onChange(!checked)}
      className="group/switch relative inline-flex h-[26px] w-11 max-sm:h-11 shrink-0 items-center justify-center rounded-full focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        className={`relative inline-flex h-[26px] w-11 shrink-0 items-center rounded-full border transition-colors group-focus/switch:ring-2 group-focus/switch:ring-primary-emphasis group-focus/switch:ring-offset-1 ring-offset-surface ${
          checked ? "bg-primary border-primary" : "bg-surface-active border-line-boundary"
        }`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-5 w-5 rounded-full bg-fg shadow transition-transform ${checked ? "translate-x-[20px]" : "translate-x-[2px]"}`}
        />
      </span>
    </button>
  );
}

/** Setting row: label and description on the left, a switch on the right. */
export function SettingSwitchRow({ label, description, checked, onChange, disabled, busy }: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const labelId = useId();
  const descId = useId();
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p id={labelId} className="text-sm font-medium text-fg">{label}</p>
        {description && <p id={descId} className="mt-0.5 text-sm text-fg-secondary">{description}</p>}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} busy={busy} aria-labelledby={labelId} aria-describedby={description ? descId : undefined} />
    </div>
  );
}

/** Column headings for a block of `SettingTwoSwitchRow`s. */
export function SettingTwoSwitchHeader() {
  return (
    <div className="flex items-center justify-end gap-4 pb-1" aria-hidden="true">
      <span className="w-11 text-center text-xs font-medium text-fg-tertiary">In-app</span>
      <span className="w-11 text-center text-xs font-medium text-fg-tertiary">Email</span>
    </div>
  );
}

/**
 * Setting row with two switches, "In-app" and "Email" (#2477 Notifications). Each switch is
 * named "<event>, in-app" / "<event>, email". Email is shown off and disabled while in-app is
 * off: an email for an event the user has silenced in the app would be a surprise.
 */
export function SettingTwoSwitchRow({ event, description, inApp, email, onInAppChange, onEmailChange, inAppBusy, emailBusy }: {
  event: string;
  description?: ReactNode;
  inApp: boolean;
  email: boolean;
  onInAppChange: (checked: boolean) => void;
  onEmailChange: (checked: boolean) => void;
  /** In-flight save of that switch: `aria-busy`, still enabled so focus is kept. */
  inAppBusy?: boolean;
  emailBusy?: boolean;
}) {
  const descId = useId();
  const reasonId = useId();
  const emailDescribedBy = [description ? descId : "", inApp ? "" : reasonId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{event}</p>
        {description && <p id={descId} className="mt-0.5 text-sm text-fg-secondary">{description}</p>}
        {/* A switch disabled by a dependency says why (never opacity alone). */}
        {!inApp && <p id={reasonId} className="mt-0.5 text-xs text-fg-secondary">Turn on in-app to get email.</p>}
      </div>
      <div className="flex items-center gap-4">
        <Switch checked={inApp} onChange={onInAppChange} busy={inAppBusy} aria-label={`${event}, in-app`} aria-describedby={description ? descId : undefined} />
        <Switch checked={inApp && email} onChange={onEmailChange} busy={emailBusy} disabled={!inApp} aria-label={`${event}, email`} aria-describedby={emailDescribedBy} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sticky Save bar
// ---------------------------------------------------------------------------

/**
 * For forms with several fields. Shows only while there are unsaved changes: a status message,
 * Discard (Quiet) and "Save <thing>" (Primary). Drawn on the Chrome surface (`bg-sunken`).
 */
export function SaveBar({ thing, saveLabel, dirty, saving = false, onDiscard, onSave, saveRef }: {
  thing: string;
  /** Button text when it differs from "Save <thing>" (Email: "Save email settings"). */
  saveLabel?: string;
  dirty: boolean;
  saving?: boolean;
  onDiscard: () => void;
  onSave: () => void;
  /** Lets a caller return focus to Save when an inline confirm it opened closes (#1367). */
  saveRef?: Ref<HTMLButtonElement>;
}) {
  if (!dirty) return null;
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-line bg-sunken px-4 py-3">
      <p role="status" className="flex-1 min-w-0 text-sm text-fg-secondary">You have unsaved {thing} changes.</p>
      <Button variant="quiet" onClick={onDiscard} disabled={saving}>Discard</Button>
      <Button variant="primary" buttonRef={saveRef} onClick={() => { if (!saving) onSave(); }} aria-busy={saving || undefined}>{saving ? "Saving…" : (saveLabel ?? `Save ${thing}`)}</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline confirm
// ---------------------------------------------------------------------------

/**
 * Danger-tinted box: one full sentence that names the target and the consequence, then Cancel
 * (Quiet) and the action (Danger), both 36px. Only for the change that removes access.
 */
export function InlineConfirm({ message, actionLabel, onConfirm, onCancel, busy = false }: {
  message: ReactNode;
  actionLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  // Non-modal, so no focus trap and no alertdialog role: a labeled group that takes focus on its
  // safe escape (Cancel) when it opens. The caller returns focus to its trigger on cancel.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return (
    <div role="group" aria-label={actionLabel} className="rounded-[10px] border border-danger/40 bg-danger/10 p-3">
      <p className="text-sm text-fg">{message}</p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="quiet" buttonRef={cancelRef} onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy}>{actionLabel}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

/** Names what is missing and the one action that fills it. */
export function EmptyState({ title, description, action, icon, headingLevel = "h2", testId }: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  headingLevel?: "h1" | "h2" | "h3";
  testId?: string;
}) {
  const Tag = headingLevel;
  return (
    <div data-testid={testId} className="flex flex-col items-center text-center gap-2 px-4 py-10">
      {icon && <span aria-hidden="true" className="mb-1 text-fg-faint">{icon}</span>}
      <Tag className="text-base font-semibold text-fg">{title}</Tag>
      {description && <p className="max-w-sm text-sm text-fg-secondary">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form field (Centered layout)
// ---------------------------------------------------------------------------

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className"> {
  label: string;
  /** Required: every field states its `autocomplete` (#2479). */
  autoComplete: string;
  hint?: ReactNode;
  /** Sits right of the label, e.g. "Forgot password?". */
  labelAccessory?: ReactNode;
  id?: string;
  /** `danger` colors the hint as an error (set `aria-invalid` too). */
  hintTone?: "danger";
  /** Ref to the input, for programmatic focus. */
  inputRef?: Ref<HTMLInputElement>;
}

/** A visibly labeled input. 36px, 48px on phones (the Centered layout's control height). */
export function Field({ label, hint, labelAccessory, id, hintTone, inputRef, ...input }: FieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={inputId} className="text-sm font-medium text-fg-secondary">{label}</label>
        {labelAccessory}
      </div>
      <input
        id={inputId}
        ref={inputRef}
        aria-describedby={hint ? hintId : undefined}
        className="w-full h-9 max-sm:h-12 bg-surface border border-line-strong text-fg placeholder-fg-muted rounded px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
        {...input}
      />
      {hint && <p id={hintId} className={`mt-1 text-xs ${hintTone === "danger" ? "text-danger" : "text-fg-tertiary"}`}>{hint}</p>}
    </div>
  );
}

/** The "or" rule between provider buttons and the form. */
export function OrDivider({ label = "or" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3" role="separator" aria-label={label}>
      <div aria-hidden="true" className="h-px flex-1 bg-line" />
      <span aria-hidden="true" className="text-xs text-fg-tertiary">{label}</span>
      <div aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}
