import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Swimlane } from "../../types";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";
import { buttonClasses } from "../Page/buttonClasses";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";
import type { LaneSortState } from "../../hooks/useLaneSort";
import {
  laneSortAccessibleName,
  laneSortRuleText,
  laneSortSummary,
  newLaneSort,
  type LaneSort,
  type LaneSortOption,
} from "../../utils/laneSort";

/** Up to this many fields show as a plain list; more collapse to a searchable picker. */
export const LANE_SORT_PLAIN_LIST_MAX = 8;
/** Up to this many lanes pin from toggle chips; more pin from a list and a "Pin a lane" picker. */
export const LANE_PIN_CHIPS_MAX = 8;

const BOARD_ORDER = "__board__";
const NOTHING = "__nothing__";

interface Props {
  state: LaneSortState;
  /** Every lane in board order. */
  lanes: readonly Swimlane[];
  isAdmin: boolean;
  /** Lanes the lane filters hide (they keep their sorted place). */
  hiddenLaneCount: number;
}

const focusRing = "focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
const linkButton = `text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-0.5 min-h-6 max-sm:min-h-11 rounded shrink-0 underline-offset-2 hover:underline ${focusRing}`;

/**
 * The "Lanes: …" control above the board and its Lane order popover (#2698,
 * canvas 9n6A4pJayorNdwbVmRVtPB screens 1, 2, 6, 8, 9 and the copy deck).
 *
 * Sorting is a view, not a mutation: every change here only rewrites the
 * board URL (useLaneSort) and sends no request. Phase A shows no scope
 * switch; the slot above the helper sentence is left free for "My view"
 * (#2705). "Save as board order" (#2699) is not part of this control yet.
 */
export default function LaneOrderControl({ state, lanes, isAdmin, hiddenLaneCount }: Props) {
  const { sort, options, setSort, notice, dismissNotice, noValuesYet, emptyKeys, togglePin, message, announce } = state;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const popoverId = `lane-order-${useId().replace(/:/g, "")}`;
  const main = sort ? options.find((o) => o.key === sort.key) : undefined;
  const pinnedCount = sort?.pins.length ?? 0;
  const summary = laneSortSummary(sort, options, pinnedCount);
  const rule = sort ? laneSortRuleText(sort, options, pinnedCount) : "";

  const close = (refocus: boolean) => { setOpen(false); if (refocus) triggerRef.current?.focus(); };
  useDropdownEscape(open, () => setOpen(false), triggerRef);
  useEffect(() => {
    if (!open) return;
    const outside = (t: Node) => !panelRef.current?.contains(t) && !triggerRef.current?.contains(t);
    const onDown = (e: MouseEvent) => { if (outside(e.target as Node)) setOpen(false); };
    // Tabbing out closes it too; the inner menus are in-flow (no portalMenu), so they count as inside.
    const onFocusIn = (e: FocusEvent) => { if (outside(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  /** Apply a change at once (there is no Apply button) and announce it. */
  const apply = (next: LaneSort | null) => {
    setSort(next);
    if (!next) { announce("Showing the board order."); return; }
    const opt = options.find((o) => o.key === next.key);
    if (opt && (next.key !== sort?.key || next.reverse !== sort?.reverse)) {
      announce(`Lanes sorted by ${opt.label}, ${opt.directions[next.reverse ? 1 : 0]}. Only you see this sort.`);
    }
  };
  const chooseAnother = () => { dismissNotice(); setOpen(true); };

  const shown = lanes.length - hiddenLaneCount;
  const besideText = !sort
    ? "Everyone sees this order."
    : hiddenLaneCount > 0
      ? `Sorting ${shown} of ${lanes.length} lanes. ${hiddenLaneCount} are hidden by lane filters.`
      : "Not saved as board order. Only you see this sort.";

  let noticeText: string | null = null;
  let noticeChoose = false;
  let noticeDismiss = false;
  if (notice?.kind === "deleted") { noticeText = `The field "${notice.field}" was deleted, so your sort was turned off. Lanes are in board order.`; noticeChoose = true; noticeDismiss = true; }
  else if (notice?.kind === "cant_use") { noticeText = "You can't use the field this link sorts by, so lanes are in board order."; noticeChoose = true; noticeDismiss = true; }
  else if (notice?.kind === "then_deleted") { noticeText = `The field "${notice.field}" was deleted. Ties now follow the board order.`; noticeDismiss = true; }
  else if (sort && main && noValuesYet) { noticeText = `No lane has a ${main.label} yet, so lanes are in board order.`; noticeChoose = true; }

  return (
    <div data-lane-order className="relative flex flex-col gap-1 px-3 py-1.5 bg-surface border-b border-line shrink-0">
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popoverId : undefined}
          aria-label={laneSortAccessibleName(sort, options, pinnedCount)}
          title={rule || undefined}
          onClick={() => setOpen((v) => !v)}
          className={`border rounded px-2 py-1 text-sm min-h-8 max-sm:min-h-11 shrink-0 transition ${focusRing} focus:ring-offset-1 focus:ring-offset-surface ${
            sort ? "bg-primary-emphasis/20 border-primary-soft text-fg" : "bg-surface border-line-strong text-fg-secondary hover:border-line-emphasis"
          }`}
        >
          {summary}
        </button>
        <span className="text-xs text-fg-secondary">{besideText}</span>
        {sort && (
          <button type="button" className={linkButton} onClick={() => apply(null)}>
            Reset to board order
          </button>
        )}
      </div>
      {noticeText && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-fg-secondary" data-lane-order-notice>
          <span className="min-w-0">{noticeText}</span>
          {noticeChoose && <button type="button" className={linkButton} onClick={chooseAnother}>Choose another field</button>}
          {noticeDismiss && <button type="button" className={linkButton} onClick={dismissNotice}>Dismiss</button>}
        </div>
      )}
      {/* Always mounted so "sorted" / "cleared" / pin results are announced reliably. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{message}</div>
      {open && (
        <div
          ref={panelRef}
          id={popoverId}
          role="dialog"
          aria-labelledby={`${popoverId}-title`}
          className="absolute left-3 top-full mt-1 z-40 w-80 max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto rounded-lg border border-line bg-surface shadow-lg p-3 flex flex-col gap-3 text-sm"
        >
          <h2 id={`${popoverId}-title`} className="text-sm font-semibold text-fg">Lane order</h2>
          {/* Phase B (#2705): the "Who sees this order" switch goes here. */}
          <p className="text-xs text-fg-secondary">
            {sort
              ? "Only you see this sort. It stays on when you reload. The board order stays the same for everyone."
              : "This is the board order. Everyone sees it. Pick a field to sort your own view."}
          </p>
          <SortFieldPicker
            options={options}
            selected={sort?.key ?? null}
            emptyKeys={emptyKeys}
            onSelect={(key) => apply(key === null ? null : { ...(sort ?? newLaneSort(key)), key, reverse: false, then: sort?.then === key ? null : sort?.then ?? null })}
          />
          {sort && main && (
            <>
              <fieldset className="flex flex-col gap-1">
                <legend className="text-xs font-medium text-fg-secondary mb-1">Direction</legend>
                {main.directions.map((label, i) => (
                  <label key={label} className="flex items-center gap-2 min-h-8 max-sm:min-h-11 text-fg">
                    <input type="radio" name={`${popoverId}-dir`} className={`accent-primary ${focusRing}`} checked={sort.reverse === (i === 1)} onChange={() => apply({ ...sort, reverse: i === 1 })} />
                    {label}
                  </label>
                ))}
              </fieldset>
              <div>
                <span aria-hidden="true" className="block text-xs font-medium text-fg-secondary mb-1">Then by</span>
                <SingleSelectDropdown<string>
                  label="Then by"
                  ariaLabel="Then by"
                  className="w-full"
                  escapePriority={26}
                  options={[{ value: NOTHING, label: "Nothing (board order)" }, ...options.filter((o) => o.key !== sort.key).map((o) => ({ value: o.key, label: o.label, group: o.group }))]}
                  selected={sort.then ?? NOTHING}
                  onChange={(v) => apply({ ...sort, then: !v || v === NOTHING ? null : v })}
                />
              </div>
              {!main.alwaysHasValue && (
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-xs font-medium text-fg-secondary mb-1">Lanes with no value:</legend>
                  <div className="flex gap-4">
                    {(["Last", "First"] as const).map((label) => (
                      <label key={label} className="flex items-center gap-2 min-h-8 max-sm:min-h-11 text-fg">
                        <input type="radio" name={`${popoverId}-empty`} className={`accent-primary ${focusRing}`} checked={sort.emptyFirst === (label === "First")} onChange={() => apply({ ...sort, emptyFirst: label === "First" })} />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <PinControls lanes={lanes} pins={sort.pins} onToggle={togglePin} />
            </>
          )}
          <div className="flex items-center justify-between gap-2 border-t border-line pt-2">
            {!isAdmin ? <span className="text-xs text-fg-tertiary">Only board admins can change the board order for everyone.</span> : <span />}
            <button type="button" className={buttonClasses("quiet")} onClick={() => close(true)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SortFieldPicker({ options, selected, emptyKeys, onSelect }: {
  options: readonly LaneSortOption[];
  selected: string | null;
  emptyKeys: ReadonlySet<string>;
  onSelect: (key: string | null) => void;
}) {
  const id = useId().replace(/:/g, "");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const searchable = options.length > LANE_SORT_PLAIN_LIST_MAX;
  const all = useMemo(() => [
    { key: BOARD_ORDER, label: "Board order", group: "Lane" as const, hint: "Set by board admins" },
    ...options.map((o) => ({ key: o.key, label: o.label, group: o.group, hint: emptyKeys.has(o.key) ? "No values yet" : undefined })),
  ], [options, emptyKeys]);
  const q = query.trim().toLocaleLowerCase();
  const matches = q ? all.filter((o) => o.label.toLocaleLowerCase().includes(q)) : all;
  const groups = (["Lane", "Custom fields", "Computed"] as const).map((g) => ({ g, items: matches.filter((m) => m.group === g) })).filter((x) => x.items.length);
  const flat = groups.flatMap((x) => x.items);
  const current = selected ?? BOARD_ORDER;
  const choose = (key: string) => onSelect(key === BOARD_ORDER ? null : key);

  if (!searchable) {
    return (
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-fg-secondary mb-1">Sort lanes by</legend>
        {groups.map(({ g, items }) => (
          <div key={g} role="group" aria-label={g} className="flex flex-col">
            <span aria-hidden="true" className="text-[11px] uppercase tracking-wide text-fg-tertiary mt-1">{g}</span>
            {items.map((o) => (
              <label key={o.key} className="flex items-center gap-2 min-h-8 max-sm:min-h-11 text-fg">
                <input type="radio" name={`${id}-field`} className={`accent-primary ${focusRing}`} checked={current === o.key} onChange={() => choose(o.key)} />
                <span>{o.label}</span>
                {o.hint && <span className="text-xs text-fg-tertiary">{o.hint}</span>}
              </label>
            ))}
          </div>
        ))}
      </fieldset>
    );
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && flat[active]) { e.preventDefault(); choose(flat[active].key); }
  };
  const activeKey = flat[Math.min(active, flat.length - 1)]?.key;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-search`} className="text-xs font-medium text-fg-secondary">Sort lanes by</label>
      <input
        id={`${id}-search`}
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={activeKey ? `${id}-opt-${activeKey}` : undefined}
        aria-describedby={`${id}-result`}
        placeholder="Find a field"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={onKey}
        className={`bg-surface border border-line-strong rounded px-2 py-1 text-sm min-h-8 max-sm:min-h-11 ${focusRing}`}
      />
      <span id={`${id}-result`} role="status" className="text-xs text-fg-tertiary">
        {q && flat.length > 0 ? `${flat.length} of ${all.length} fields match "${query.trim()}". Arrow keys to move, Enter to choose.` : ""}
      </span>
      {q && flat.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-fg-secondary">
          <span>{`No field matches "${query.trim()}".`}</span>
          <button type="button" className={linkButton} onClick={() => { setQuery(""); setActive(0); }}>Clear search</button>
        </div>
      ) : (
        <div id={`${id}-list`} role="listbox" aria-label="Sort lanes by" className="flex flex-col max-h-56 overflow-y-auto">
          {groups.map(({ g, items }) => (
            <div key={g} role="group" aria-label={g}>
              <span aria-hidden="true" className="block text-[11px] uppercase tracking-wide text-fg-tertiary mt-1">{g}</span>
              {items.map((o) => (
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- keyboard choice goes through the combobox (aria-activedescendant); focus never leaves the search box
                <div
                  key={o.key}
                  id={`${id}-opt-${o.key}`}
                  role="option"
                  aria-selected={current === o.key}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o.key)}
                  className={`flex items-center gap-2 px-2 min-h-8 max-sm:min-h-11 rounded cursor-pointer ${o.key === activeKey ? "bg-surface-hover ring-1 ring-primary-emphasis" : ""} ${current === o.key ? "font-medium text-fg" : "text-fg-secondary"}`}
                >
                  <span>{o.label}</span>
                  {current === o.key && <span className="sr-only">, selected</span>}
                  {o.hint && <span className="text-xs text-fg-tertiary">{o.hint}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PinControls({ lanes, pins, onToggle }: { lanes: readonly Swimlane[]; pins: readonly number[]; onToggle: (lane: Swimlane) => void }) {
  const pinSet = new Set(pins);
  const pinned = lanes.filter((l) => pinSet.has(l.id));
  const heading = `Pinned to the top (${pinned.length})`;
  if (lanes.length <= LANE_PIN_CHIPS_MAX) {
    return (
      <div role="group" aria-label={heading}>
        <span aria-hidden="true" className="block text-xs font-medium text-fg-secondary mb-1">{heading}</span>
        <div className="flex flex-wrap gap-1.5">
          {lanes.map((l) => (
            <button
              key={l.id}
              type="button"
              aria-pressed={pinSet.has(l.id)}
              onClick={() => onToggle(l)}
              className={`text-xs rounded-full border px-2 py-0.5 min-h-6 max-sm:min-h-11 ${focusRing} ${pinSet.has(l.id) ? "border-primary-soft bg-primary-emphasis/20 text-fg" : "border-line-strong text-fg-secondary hover:border-line-emphasis"}`}
            >
              {pinSet.has(l.id) && <span aria-hidden="true">✓ </span>}{l.name}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div role="group" aria-label={heading} className="flex flex-col gap-1">
      <span aria-hidden="true" className="block text-xs font-medium text-fg-secondary">{heading}</span>
      {pinned.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {pinned.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 text-fg">
              <span className="min-w-0 truncate">{l.name}</span>
              <button type="button" className={linkButton} onClick={() => onToggle(l)}>{`Unpin ${l.name}`}</button>
            </li>
          ))}
        </ul>
      )}
      <SingleSelectDropdown<number>
        label="Pin a lane"
        ariaLabel="Pin a lane"
        className="w-full"
        escapePriority={26}
        options={lanes.filter((l) => !pinSet.has(l.id)).map((l) => ({ value: l.id, label: l.name }))}
        selected={null}
        onChange={(v) => { const lane = lanes.find((l) => l.id === v); if (lane) onToggle(lane); }}
      />
    </div>
  );
}

/**
 * What a lane band adds while a sort is on (#2698): the value it is sorted on
 * (only for keys the band does not already show), a "Pinned" tag, and the
 * pin button. Rendered by SwimlaneRow through its `sortBand` slot, so the band
 * goes back to exactly what it was the moment the sort is cleared.
 */
export function LaneSortBandSlot({ lane, value, pinned, onTogglePin }: {
  lane: Swimlane;
  value: string | null;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  return (
    <span className="flex items-center gap-2 shrink-0" data-testid="lane-sort-band">
      {pinned && <span className="text-xs font-semibold text-fg-secondary bg-surface-hover rounded-full px-2 py-0.5">Pinned</span>}
      {value && <span className="text-sm font-semibold text-fg whitespace-nowrap tabular-nums" data-testid="lane-sort-value">{value}</span>}
      <button
        type="button"
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin ${lane.name}` : `Pin ${lane.name} to the top`}
        title={pinned ? `Unpin ${lane.name}` : `Pin ${lane.name} to the top`}
        onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
        className={`w-6 h-6 max-sm:w-11 max-sm:h-11 rounded flex items-center justify-center text-fg-tertiary hover:text-fg hover:bg-surface-hover ${focusRing}`}
      >
        <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 16 16" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <path d="M6 2h4l-.5 4 2.5 2.5V10H4V8.5L6.5 6z M8 10v4" />
        </svg>
      </button>
    </span>
  );
}
