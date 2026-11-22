import { useEffect, useId, useRef, useState } from "react";
import { Link, useInRouterContext } from "react-router-dom";
import { getChildrenSettingBlockers, getDefaultChildBoardOptions } from "../../api/boards";
import type { Board, ChildrenSettingBlockers } from "../../types";
import SelectDropdown from "../Common/SelectDropdown";
import ParentNameSettings from "./ParentNameSettings";
import { boardsCapLine } from "../Card/childBoardOptionsCap";

interface Props {
  board: Pick<Board, "id" | "cards_can_have_children" | "default_child_board"> &
    Partial<Pick<Board, "parent_name_singular" | "parent_name_plural">>;
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
 * in a `role="group"`. The turn-off confirm is not built: turning off with live parent links is refused,
 * so that case is a blocked state too, not a confirm.
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
  const reasonsRef = useRef<HTMLDivElement>(null);
  const checked = board.cards_can_have_children;
  // The reason link is router navigation (no full page load); a bare render with no
  // router (a unit test) keeps a plain anchor.
  const inRouter = useInRouterContext();
  const [blockers, setBlockers] = useState<ChildrenSettingBlockers | null>(null);
  const [options, setOptions] = useState<{ id: number; name: string }[]>([]);
  // How many boards qualify in all (#2449): the list holds at most 100.
  const [optionsTotal, setOptionsTotal] = useState<number | undefined>(undefined);
  // A failed blockers read must not leave the switch looking usable with no explanation (#2448).
  // The server still refuses a bad flip on save, so this only explains; it does not gate.
  const [blockersFailed, setBlockersFailed] = useState(false);
  const [blockersTry, setBlockersTry] = useState(0);
  // Retry unmounts once the read succeeds; focus then moves to the switch it explains instead of
  // falling to <body> (frontend/CLAUDE.md, focus anchors). A failed retry keeps Retry, and focus.
  const switchRef = useRef<HTMLButtonElement>(null);
  const focusSwitchAfterRetry = useRef(false);

  // Re-read after every flip or default change: another admin's link or default move changes the answer.
  useEffect(() => {
    let live = true;
    getChildrenSettingBlockers(board.id)
      .then((b) => {
        if (!live) return;
        setBlockers(b);
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
      .then((o) => { if (live) { setOptions(o.boards); setOptionsTotal(o.boards_total); } })
      .catch(() => { if (live) { setOptions([]); setOptionsTotal(undefined); } });
    return () => { live = false; };
  }, [board.id, checked]);

  // Reasons the flip is refused, as the server decides it on save.
  const turnOnReasons: Reason[] = [];
  const turnOffReasons: Reason[] = [];
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
    } else if (blockers.parent_cards > 0) {
      turnOffReasons.push({
        key: "parents",
        text: `${plural(blockers.parent_cards, "card here has", "cards here have")} children. Remove those links before turning children off.`,
      });
    }
  }
  const reasons = checked ? turnOffReasons : turnOnReasons;
  const blocked = reasons.length > 0;

  const activate = () => {
    if (blocked) {
      reasonsRef.current?.focus();
      return;
    }
    onUpdate({ cards_can_have_children: !checked });
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
        ref={switchRef}
        role="switch"
        aria-checked={checked}
        aria-disabled={blocked ? true : undefined}
        aria-labelledby={labelId}
        aria-describedby={`${helpId} ${statusId}${blocked ? ` ${reasonsId}` : ""}`}
        onClick={activate}
        data-testid="children-switch"
        className={`flex w-full min-h-11 items-center justify-between gap-4 rounded text-left focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${blocked ? "cursor-not-allowed" : ""}`}
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
            {" "}{checked ? "Can't be turned off" : "Can't be turned on"}: {plural(reasons.length, "reason", "reasons")} below.
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
            {checked ? "Cards here already have children" : "A child can't also have children"}
          </p>
          <p className="text-xs text-fg-muted mt-0.5">
            {checked
              ? "A parent board keeps its links until they are removed."
              : `Exactly two tiers. ${plural(reasons.length, "thing", "things")} on this board stand in the way:`}
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
          </div>
          <SelectDropdown
            id={defaultId}
            ariaDescribedBy={capLine ? `${defaultHelpId} ${defaultCapId}` : defaultHelpId}
            value={board.default_child_board != null ? String(board.default_child_board) : "none"}
            onChange={(v) => onUpdate({ default_child_board: v === "none" ? null : Number(v) })}
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

