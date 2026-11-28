import { useEffect, useId, useRef, useState } from "react";
import { Link, useInRouterContext } from "react-router-dom";
import { getChildrenSettingBlockers, getDefaultChildBoardOptions } from "../../api/boards";
import type { Board, ChildrenSettingBlockers, UnavailableChildBoard } from "../../types";
import SelectDropdown from "../Common/SelectDropdown";
import ParentNameSettings from "./ParentNameSettings";
import { boardsCapLine } from "../Card/childBoardOptionsCap";
import UnavailableChildBoards from "../Card/UnavailableChildBoards";
import { buttonClasses } from "../Page/buttonClasses";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
import { useConfirmAnnouncement } from "../../hooks/useConfirmAnnouncement";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { turnOffBody } from "./childCardsTurnOff";

interface Props {
  board: Pick<Board, "id" | "cards_can_have_children" | "default_child_board"> &
    Partial<Pick<Board, "name" | "parent_name_singular" | "parent_name_plural">>;
  /** Board admins only: the section is not rendered for anyone else (the page shows a read-only line). */
  onUpdate: (patch: Record<string, unknown>) => void | Promise<unknown>;
  /** Server refusal of the last flip (#1104), shown inline so a race past the blockers read is not silent. */
  error?: string | null;
  /** Closes settings and filters the board to its child cards (Parent filter "any", #2209). Absent: no button. */
  onShowChildCards?: () => void;
}

type Reason = { key: string; text: string; ask?: string; change?: { id: number; name: string }; showCount?: number };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Board settings > Rules: "Cards on this board can have children" and the default child board (#2208).
 *
 * The switch is a whole-row `button role="switch"`. When the server's blockers say the flip would be
 * refused it stays focusable but `aria-disabled`; activating it only moves focus to the reasons, which sit
 * in a `role="group"`. Only turning ON can be blocked. Turning OFF while cards here have children is
 * allowed (#2446): those parents keep their children, tab, rollup and Add child (the server's per-card
 * rule), so the flip asks first in an inline confirm (#2208 spec, canvas 2f c) instead of refusing.
 * With no parent links there is nothing to keep and the flip saves at once.
 */

export default function ChildCardsSettings({ board, onUpdate, error = null, onShowChildCards }: Props) {
  const uid = useId();
  const labelId = `${uid}-label`;
  const helpId = `${uid}-help`;
  const statusId = `${uid}-status`;
  const reasonsId = `${uid}-reasons`;
  const defaultId = `${uid}-default`;
  const defaultHelpId = `${uid}-default-help`;
  const defaultCapId = `${uid}-default-cap`;
  const defaultUnavailableId = `${uid}-default-unavailable`;
  const reasonsRef = useRef<HTMLDivElement>(null);
  const checked = board.cards_can_have_children;
  // The reason link is router navigation (no full page load); a bare render with no
  // router (a unit test) keeps a plain anchor.
  const inRouter = useInRouterContext();
  const [blockers, setBlockers] = useState<ChildrenSettingBlockers | null>(null);
  // The flag value `blockers` was read for: after a flip the held answer is for the old state
  // until the re-read lands, so it counts as unknown (#2446).
  const [blockersFor, setBlockersFor] = useState<boolean | null>(null);
  const [options, setOptions] = useState<{ id: number; name: string }[]>([]);
  // How many boards qualify in all (#2449): the list holds at most 100.
  const [optionsTotal, setOptionsTotal] = useState<number | undefined>(undefined);
  // #2719: boards this admin could pick once they qualify, named with why they're missing from the select.
  const [unavailable, setUnavailable] = useState<UnavailableChildBoard[]>([]);
  // A failed blockers read must not leave the switch looking usable with no explanation (#2448).
  // For turning ON the server still refuses a bad flip on save, so this only explains. Turning OFF
  // is never refused since #2446, so there the turn-off confirm is the only guard: an unknown
  // parent count (pending or failed read) shows it with count-free copy rather than skipping it.
  const [blockersFailed, setBlockersFailed] = useState(false);
  const [blockersTry, setBlockersTry] = useState(0);
  // Retry unmounts once the read succeeds; focus then moves to the switch it explains instead of
  // falling to <body> (frontend/CLAUDE.md, focus anchors). A failed retry keeps Retry, and focus.
  const switchRef = useRef<HTMLButtonElement>(null);
  const focusSwitchAfterRetry = useRef(false);
  // Turn-off confirm (#2446). `saving` drives the buttons; the ref lets Escape read it without a stale closure.
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [savingOff, setSavingOff] = useState(false);
  const savingOffRef = useRef(false);
  const turnOffRef = useRef<HTMLButtonElement>(null);
  const confirmTrigger = useConfirmFocusReturn<"children-off">(confirmingOff ? "children-off" : null);

  // Re-read after every flip or default change: another admin's link or default move changes the answer.
  useEffect(() => {
    let live = true;
    const readFor = checked;
    getChildrenSettingBlockers(board.id)
      .then((b) => {
        if (!live) return;
        setBlockers(b);
        setBlockersFor(readFor);
        setBlockersFailed(false);
        if (focusSwitchAfterRetry.current) {
          focusSwitchAfterRetry.current = false;
          // After the commit that removes Retry, so the focus is not lost with it.
          // Only when focus fell with Retry: a slow read must not pull it from where the user moved.
          window.setTimeout(() => {
            if (!document.activeElement || document.activeElement === document.body) switchRef.current?.focus();
          }, 0);
        }
      })
      .catch(() => { if (live) { setBlockers(null); setBlockersFailed(true); focusSwitchAfterRetry.current = false; } });
    return () => { live = false; };
  }, [board.id, checked, board.default_child_board, blockersTry]);

  useEffect(() => {
    if (!checked) return;
    let live = true;
    getDefaultChildBoardOptions(board.id)
      .then((o) => { if (live) { setOptions(o.boards); setOptionsTotal(o.boards_total); setUnavailable(o.unavailable ?? []); } })
      .catch(() => { if (live) { setOptions([]); setOptionsTotal(undefined); setUnavailable([]); } });
    return () => { live = false; };
  }, [board.id, checked]);

  // Reasons the flip is refused, as the server decides it on save.
  const turnOnReasons: Reason[] = [];
  if (blockers) {
    if (!checked) {
      if (blockers.child_cards > 0) {
        turnOnReasons.push({
          key: "children",
          text: `${plural(blockers.child_cards, "card here is a child", "cards here are children")} of cards on another board.`,
          showCount: blockers.child_cards,
        });
      }
      blockers.default_of.forEach((d, i) => {
        if (d.hidden) {
          turnOnReasons.push({
            key: `default-${i}`,
            text: "This board is the default child board of another board you can't open.",
            ask: "Ask an admin of that board.",
          });
        } else {
          turnOnReasons.push({
            key: `default-${d.id}`,
            text: `This board is the default child board of ${d.name}.`,
            change: d.can_change ? { id: d.id, name: d.name } : undefined,
            ask: d.can_change ? undefined : "Ask an admin of that board.",
          });
        }
      });
    }
  }
  // Turning off is never refused for parent links any more (#2446), so only the turn-on side has reasons.
  const reasons = checked ? [] : turnOnReasons;
  const blocked = reasons.length > 0;
  // null = unknown: no answer yet for this flag value, or the read failed.
  const parentCount = !checked ? 0 : blockers && blockersFor === checked ? blockers.parent_cards : null;
  const boardName = board.name || "this board";
  const offTitle = `Turn off children on ${boardName}?`;
  const offBody = turnOffBody(parentCount);
  useConfirmAnnouncement(confirmingOff ? `${offTitle} ${offBody}` : null);

  // Open: focus goes to Turn off (the primary action), per the spec.
  useEffect(() => {
    if (confirmingOff) turnOffRef.current?.focus();
  }, [confirmingOff]);

  const cancelOff = () => {
    setConfirmingOff(false);
    switchRef.current?.focus();
  };

  // Above ModalWrapper's 40 so Escape cancels the confirm, not the modal; swallowed while the request runs (#2054).
  useEscapeStack(() => {
    if (!confirmingOff) return false;
    if (savingOffRef.current) return true;
    cancelOff();
    return true;
  }, 41);

  // The parent resolves with the failure (shown through `error`) rather than rejecting, so a rejection is
  // unexpected; swallow it here so it never becomes an unhandled rejection.
  const save = (patch: Record<string, unknown>) => {
    void Promise.resolve()
      .then(() => onUpdate(patch))
      .catch(() => undefined);
  };

  const activate = () => {
    if (blocked) {
      reasonsRef.current?.focus();
      return;
    }
    if (savingOffRef.current) return;
    if (checked && (parentCount === null || parentCount > 0)) {
      setConfirmingOff(true);
      return;
    }
    save({ cards_can_have_children: !checked });
  };

  const confirmOff = () => {
    if (savingOffRef.current) return;
    savingOffRef.current = true;
    setSavingOff(true);
    void Promise.resolve()
      .then(() => onUpdate({ cards_can_have_children: false }))
      .catch(() => undefined)
      .finally(() => {
        savingOffRef.current = false;
        setSavingOff(false);
        // Closing unmounts the focused button; useConfirmFocusReturn puts focus back on the switch.
        setConfirmingOff(false);
      });
  };

  const defaultInList = board.default_child_board != null && options.some((o) => o.id === board.default_child_board);
  const selectOptions = [
    { value: "none", label: "None (ask each time)" },
    ...options.map((o) => ({ value: String(o.id), label: o.name })),
    ...(board.default_child_board != null && !defaultInList
      ? [{ value: String(board.default_child_board), label: "A board you can't change" }]
      : []),
  ];

  const capLine = boardsCapLine(options.length, optionsTotal);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        ref={(el) => { switchRef.current = el; confirmTrigger("children-off")(el); }}
        role="switch"
        aria-checked={checked}
        // Also inert while the turn-off save runs: `activate` ignores it then (savingOffRef).
        aria-disabled={blocked || savingOff ? true : undefined}
        aria-labelledby={labelId}
        aria-describedby={`${helpId} ${statusId}${blocked ? ` ${reasonsId}` : ""}`}
        onClick={activate}
        data-testid="children-switch"
        className={`flex w-full min-h-11 items-center justify-between gap-4 rounded text-left focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${blocked || savingOff ? "cursor-not-allowed" : ""}`}
      >
        <span className="min-w-0 flex-1">
          <span id={labelId} className="block text-sm text-fg-secondary">Cards on this board can have children</span>
          <span id={helpId} className="block text-sm text-fg-muted mt-0.5">
            Turns on the Children tab, the rollup on each card and Add child. Off by default.
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`relative inline-flex h-[26px] w-11 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-primary" : "bg-surface-active"} ${blocked ? "opacity-40" : ""}`}
        >
          <span className={`inline-block h-5 w-5 rounded-full bg-fg shadow transition-transform ${checked ? "translate-x-[21px]" : "translate-x-[3px]"}`} />
        </span>
      </button>
      <p id={statusId} data-testid="children-status" className="text-xs text-fg-muted">
        {checked ? "On." : "Off."}
        {blocked && (
          <span className="text-warning-on-tint">
            {" "}Can't be turned on: {plural(reasons.length, "reason", "reasons")} below.
          </span>
        )}
        {blockersFailed && (
          <span role="status" className="block text-warning-on-tint mt-1" data-testid="children-blockers-unavailable">
            Couldn't check whether this can change. The server will still refuse a change that isn't allowed.{" "}
            <button
              type="button"
              onClick={() => { focusSwitchAfterRetry.current = true; setBlockersTry((n) => n + 1); }}
              className="max-sm:min-h-11 rounded underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Retry
            </button>
          </span>
        )}
        {error && <span className="block text-danger mt-1" data-testid="children-error">{error}</span>}
      </p>

      {confirmingOff && (
        <div
          role="group"
          aria-labelledby={`${uid}-off-title`}
          aria-describedby={`${uid}-off-body`}
          data-testid="children-off-confirm"
          className="rounded border border-line bg-surface-raised p-3"
        >
          <p id={`${uid}-off-title`} className="text-sm font-medium text-fg break-words">{offTitle}</p>
          <p id={`${uid}-off-body`} className="text-xs text-fg-muted mt-0.5">{offBody}</p>
          <div className="mt-2 flex flex-row items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => { if (!savingOffRef.current) cancelOff(); }}
              aria-disabled={savingOff ? true : undefined}
              className={buttonClasses("quiet", { className: "aria-disabled:opacity-40 aria-disabled:cursor-not-allowed" })}
            >
              Keep it on
            </button>
            <button
              type="button"
              ref={turnOffRef}
              onClick={confirmOff}
              aria-disabled={savingOff ? true : undefined}
              data-testid="children-off-confirm-button"
              className={buttonClasses("primary", { className: "aria-disabled:opacity-40 aria-disabled:cursor-not-allowed" })}
            >
              {savingOff ? "Turning off…" : "Turn off"}
            </button>
          </div>
        </div>
      )}

      {blocked && (
        <div
          id={reasonsId}
          ref={reasonsRef}
          role="group"
          tabIndex={-1}
          aria-labelledby={`${reasonsId}-title`}
          className="rounded border border-line bg-surface-raised p-3 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          <p id={`${reasonsId}-title`} className="text-sm font-medium text-fg">
            A child can't also have children
          </p>
          <p className="text-xs text-fg-muted mt-0.5">
            {`Exactly two tiers. ${plural(reasons.length, "thing", "things")} on this board stand in the way:`}
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {reasons.map((r) => (
              <li key={r.key} className="text-sm text-fg-secondary">
                {r.text}
                {r.ask && <span className="block text-fg-muted">{r.ask}</span>}
                {r.showCount !== undefined && onShowChildCards && (
                  <button
                    type="button"
                    onClick={onShowChildCards}
                    data-testid="show-child-cards"
                    className="mt-1 block max-sm:min-h-11 text-info underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
                  >
                    {r.showCount === 1 ? "Show the card" : `Show the ${r.showCount} cards`}
                  </button>
                )}
                {r.change && (() => {
                  const cls = "mt-1 inline-flex max-sm:min-h-11 items-center text-info underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded";
                  const to = `/boards/${r.change.id}?settings=rules`;
                  return inRouter
                    ? <Link to={to} className={cls}>Change on {r.change.name}</Link>
                    : <a href={to} className={cls}>Change on {r.change.name}</a>;
                })()}
              </li>
            ))}
          </ul>
        </div>
      )}

      {checked && (
        <div className="flex items-start justify-between gap-3 py-1 max-sm:flex-col">
          <div className="min-w-0 pr-4">
            <label htmlFor={defaultId} className="text-sm text-fg-secondary">Default child board</label>
            <p id={defaultHelpId} className="text-sm text-fg-muted mt-0.5">
              Add child on a card here creates the new card in this board's first column. Children already linked stay where they are. Leave unset to ask each time.
            </p>
            <p className="text-xs text-fg-muted mt-0.5">
              Only boards you administer are listed (setting a default needs admin on both boards). Changing this affects parents with no children yet.
            </p>
            <UnavailableChildBoards id={defaultUnavailableId} boards={unavailable} className="mt-1" />
          </div>
          <SelectDropdown
            id={defaultId}
            ariaDescribedBy={[defaultHelpId, capLine ? defaultCapId : null, unavailable.length > 0 ? defaultUnavailableId : null].filter(Boolean).join(" ")}
            value={board.default_child_board != null ? String(board.default_child_board) : "none"}
            onChange={(v) => save({ default_child_board: v === "none" ? null : Number(v) })}
            options={selectOptions}
          />
          {capLine && (
            <p id={defaultCapId} className="text-xs text-fg-muted mt-1" data-testid="default-child-board-cap">{capLine}</p>
          )}
        </div>
      )}

      {checked && (
        <ParentNameSettings
          board={{
            id: board.id,
            parent_name_singular: board.parent_name_singular ?? "",
            parent_name_plural: board.parent_name_plural ?? "",
          }}
          onUpdate={onUpdate}
        />
      )}
    </div>
  );
}

