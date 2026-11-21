import { Button } from "../Page";

interface Props {
  /** First name (or display name) for the heading. */
  name?: string;
  /** Opens the create-board flow (template gallery and blank board). */
  onCreateBoard: () => void;
  /** Opens the invite link / token entry. */
  onJoinGroup: () => void;
  /** Opens the Visiban/Trello import. Omitted when import is unavailable. */
  onImport?: () => void;
  /** The admin's name or contact, when the instance exposes one (#2474). Nothing exposes it yet. */
  adminContact?: string | null;
  /** Hosted demo: create and import are refused by the server; shown aria-disabled with the reason. */
  disabledReason?: string | null;
  /** Reason for Import when it differs (demo copy names "imported"); defaults to `disabledReason`. */
  importDisabledReason?: string | null;
}

/**
 * First run (#2474): no boards and no groups. It leads with joining a team, because an invited
 * user with no group would otherwise create a stray personal board. Every in-page heading under
 * the shell is h2 or lower: the header owns the h1 (#2473).
 */
export default function OnboardingEmptyState({ name, onCreateBoard, onJoinGroup, onImport, adminContact, disabledReason, importDisabledReason }: Props) {
  const disabled = Boolean(disabledReason);
  const guard = (fn: () => void) => () => { if (!disabled) fn(); };
  const disabledProps = (label: string, reason = disabledReason) =>
    disabled ? { "aria-disabled": true as const, "aria-label": `${label}. ${reason}`, title: reason ?? undefined, className: "opacity-40 cursor-not-allowed" } : {};
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 py-6" data-testid="first-run">
      <div>
        <h2 id="first-run-heading" tabIndex={-1} className="text-2xl font-semibold text-fg focus:outline-none">{name ? `Welcome to Visiban, ${name}` : "Welcome to Visiban"}</h2>
        <p className="mt-1 text-sm text-fg-secondary">You're not on a team yet, and you have no boards of your own.</p>
      </div>

      <section aria-labelledby="first-run-join" className="bg-surface border border-line rounded-[10px] p-[18px]">
        <h3 id="first-run-join" className="text-[15px] leading-5 font-semibold text-fg">Waiting to join a team?</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          {adminContact
            ? `Your administrator, ${adminContact}, can add you to a group or send you an invite link.`
            : "Your administrator can add you to a group or send you an invite link."}
        </p>
        <div className="mt-3">
          <Button variant="primary" onClick={onJoinGroup}>I have an invite link</Button>
        </div>
      </section>

      <section aria-labelledby="first-run-own" className="bg-surface border border-line rounded-[10px] p-[18px]">
        <h3 id="first-run-own" className="text-[15px] leading-5 font-semibold text-fg">Or start a board of your own</h3>
        <p className="mt-1 text-sm text-fg-secondary">Boards you start here are personal. You can move one into a group later.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={guard(onCreateBoard)} {...disabledProps("Start from a template")}>Start from a template</Button>
          {onImport && (
            <Button variant="secondary" onClick={guard(onImport)} {...disabledProps("Import a board", importDisabledReason ?? disabledReason)}>Import a board (Visiban or Trello)</Button>
          )}
          <Button variant="secondary" onClick={guard(onCreateBoard)} {...disabledProps("Blank board")}>Blank board</Button>
        </div>
      </section>
    </div>
  );
}
