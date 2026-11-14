import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { SwimlaneCustomFieldDefinition } from "../../types";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";
import AdminOnlyFieldGlyph from "../Common/AdminOnlyFieldGlyph";
import ActiveMark from "../Common/ActiveMark";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";
import { useAnchoredPlacement, POPOVER_VIEWPORT_MARGIN, visibleMaxHeight, clampLeftToVisible } from "../../hooks/useAnchoredPlacement";
import { useOverflowFade } from "../../hooks/useOverflowFade";
import {
  isRuleComplete,
  isTextRuleType,
  opsForFieldType,
  ruleText,
  type FieldRuleJoin,
  type FieldRuleOp,
  type RuleFieldType,
} from "../../utils/fieldRules";
import {
  LANE_FILTER_MAX_ITEMS,
  LANE_FILTER_MAX_RULES,
  LANE_FILTER_MAX_STRING,
  laneRuleCount,
  nextLaneItemId,
  summarizeLaneFilter,
  type LaneFilter,
  type LaneFilterItem,
  type LaneRule,
  type LaneValueFormatter,
} from "../../utils/laneFilter";
import { INVALID_PATTERN_MESSAGE, PATTERN_HINT, isInvalidTextPattern } from "../../utils/textMatch";

const PANEL_WIDTH = 560;
/** Above the popover's own 25 so Escape in an open inner menu closes only that menu. */
const INNER_ESCAPE_PRIORITY = 26;

const SECONDARY_BTN =
  "text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40 disabled:cursor-not-allowed";
const OP_LABELS: Record<FieldRuleOp, string> = { is: "is", is_not: "is not", contains: "contains", between: "between" };
/** No text choices for a field: no lane carries a value for it yet. */
const NO_CHOICES: string[] = [];
const INPUT_CLS =
  "bg-surface border border-line rounded px-2 py-1 text-sm text-fg-secondary placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent";

interface Props {
  filter: LaneFilter | undefined;
  /** Already limited to what this viewer may rule on (laneFilterFields). */
  fields: SwimlaneCustomFieldDefinition[];
  onChange: (next: LaneFilter | undefined) => void;
  anchorRect: DOMRect;
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** refocus = true returns focus to the trigger (Escape, Done). */
  onClose: (refocus: boolean) => void;
  /** Focus mode is on: lane filters are paused. */
  paused: boolean;
  fmt: LaneValueFormatter;
  id: string;
  /** Text/url field id to the lanes' distinct values (laneTextValueChoices). */
  textChoices?: Map<number, string[]>;
}

type FocusTarget = { kind: "row"; id: number } | { kind: "add" };

/**
 * Lane filter rule builder (#2205). Non-modal, untrapped `role="dialog"`
 * following ColumnPolicyPopover: placement from useAnchoredPlacement, Escape
 * at the dropdown tier (25, inner menus 26), outside click closes without
 * refocus, and focus leaving the panel closes it.
 *
 * Complete rules apply live (filters are reversible view state); Done only
 * closes. Inner menus are deliberately not portaled: a portaled menu would sit
 * outside the panel and the focusin-outside close would fire on it.
 */
export default function LaneFilterPopover({ filter, fields, onChange, anchorRect, triggerRef, onClose, paused, fmt, id, textChoices }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const readsAsId = `${id}-reads-as`;
  const headingId = `${id}-heading`;
  const items = filter?.items ?? [];
  const ruleCount = laneRuleCount(filter);
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const typeOf = (r: LaneRule): RuleFieldType | null =>
    r.field === null ? null : ((fieldsById.get(r.field)?.field_type as RuleFieldType | undefined) ?? null);

  const top = useAnchoredPlacement(panelRef, {
    anchor: { top: anchorRect.top, bottom: anchorRect.bottom },
    deps: [ruleCount, items.length, paused],
    onResize: () => onClose(false),
    onOutsideScroll: () => onClose(false),
  });

  useDropdownEscape(true, () => onClose(true), triggerRef);

  useEffect(() => {
    const outside = (target: Node) => !panelRef.current?.contains(target) && !triggerRef.current?.contains(target);
    const onDown = (e: MouseEvent) => { if (outside(e.target as Node)) onClose(false); };
    const onFocusIn = (e: FocusEvent) => { if (outside(e.target as Node)) onClose(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [onClose, triggerRef]);

  const { moreBelow, onScroll } = useOverflowFade(listRef, [ruleCount, items.length]);

  // Focus moves are requested by an action and applied after the commit that
  // renders the target, so a newly added row's trigger exists when focused.
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const placed = top !== null;
  const openedRef = useRef(false);
  useEffect(() => {
    if (!placed || openedRef.current) return;
    openedRef.current = true;
    const first = items[0];
    setFocusTarget(first ? { kind: "row", id: first.kind === "rule" ? first.id : first.rules[0].id } : { kind: "add" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on first placement
  }, [placed]);
  useLayoutEffect(() => {
    if (!focusTarget || !placed) return;
    const panel = panelRef.current;
    const el =
      focusTarget.kind === "add"
        ? panel?.querySelector<HTMLElement>("[data-lane-add]")
        : panel?.querySelector<HTMLElement>(`[data-lane-row="${focusTarget.id}"] button`);
    el?.focus();
    setFocusTarget(null);
  }, [focusTarget, placed]);

  const commit = (next: LaneFilterItem[]) => onChange(next.length > 0 ? { items: next } : undefined);

  const newRule = (join: FieldRuleJoin, idOffset = 0): LaneRule => ({
    kind: "rule", id: nextLaneItemId(filter) + idOffset, join, field: null, op: "is",
  });

  const canAdd = ruleCount < LANE_FILTER_MAX_RULES && items.length < LANE_FILTER_MAX_ITEMS;

  const addRule = () => {
    const r = newRule("and");
    commit([...items, r]);
    setFocusTarget({ kind: "row", id: r.id });
  };
  const addGroup = () => {
    const gid = nextLaneItemId(filter);
    const r = newRule("and", 1);
    commit([...items, { kind: "group", id: gid, join: "and", rules: [r] }]);
    setFocusTarget({ kind: "row", id: r.id });
  };
  const addToGroup = (gid: number) => {
    const r = newRule("and");
    commit(items.map((it) => (it.kind === "group" && it.id === gid ? { ...it, rules: [...it.rules, r] } : it)));
    setFocusTarget({ kind: "row", id: r.id });
  };

  // Flattened leaf order drives "Filter {n}" numbering and remove-focus.
  const leaves: LaneRule[] = items.flatMap((it) => (it.kind === "rule" ? [it] : it.rules));
  const leafNumber = new Map(leaves.map((r, i) => [r.id, i + 1]));
  const groupNumber = new Map(items.filter((it) => it.kind === "group").map((g, i) => [g.id, i + 1]));

  const focusAfterRemoving = (removedIds: number[]) => {
    const idx = leaves.findIndex((r) => r.id === removedIds[0]);
    const remaining = leaves.filter((r) => !removedIds.includes(r.id));
    const next = remaining[idx] ?? remaining[idx - 1];
    setFocusTarget(next ? { kind: "row", id: next.id } : { kind: "add" });
  };

  const removeRule = (rid: number) => {
    const next: LaneFilterItem[] = [];
    for (const it of items) {
      if (it.kind === "rule") {
        if (it.id !== rid) next.push(it);
      } else {
        const rules = it.rules.filter((r) => r.id !== rid);
        // Removing a group's last row removes the group.
        if (rules.length > 0) next.push(rules.length === it.rules.length ? it : { ...it, rules });
      }
    }
    commit(next);
    focusAfterRemoving([rid]);
  };
  const removeGroup = (gid: number) => {
    const g = items.find((it) => it.id === gid && it.kind === "group");
    commit(items.filter((it) => it !== g));
    focusAfterRemoving(g && g.kind === "group" ? g.rules.map((r) => r.id) : []);
  };
  const updateRule = (rid: number, patch: Partial<LaneRule>) => {
    const apply = (r: LaneRule) => (r.id === rid ? { ...r, ...patch } : r);
    commit(items.map((it) => (it.kind === "rule" ? apply(it) : { ...it, rules: it.rules.map(apply) })));
  };
  const setItemJoin = (iid: number, join: FieldRuleJoin) =>
    commit(items.map((it) => (it.id === iid ? { ...it, join } : it)));

  const summary = summarizeLaneFilter(filter, fields, fmt);

  const itemName = (it: LaneFilterItem) =>
    it.kind === "rule" ? `filter ${leafNumber.get(it.id)}` : `group ${groupNumber.get(it.id)}`;

  // Text `is` / `is not` choices: the lanes' values, plus a stored value no
  // lane carries any more (from a saved filter or link), so it stays visible
  // and removable instead of reading as "Choose a value".
  const choicesFor = (r: LaneRule): string[] => {
    const base = (r.field !== null && textChoices?.get(r.field)) || NO_CHOICES;
    const v = r.value?.trim();
    if (!v || base.some((c) => c.toLowerCase() === v.toLowerCase())) return base;
    return [...base, v].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  };

  const changeOp = (r: LaneRule, op: FieldRuleOp) => {
    if (op === r.op) return;
    if (op === "contains") {
      updateRule(r.id, { op, value: r.value ?? "" });
      return;
    }
    if (r.op === "contains") {
      // Typed text carries over only when it names a lane value, in that
      // value's own spelling; otherwise the rule waits for a choice.
      const v = r.value?.trim().toLowerCase();
      const hit = v ? choicesFor({ ...r, value: undefined }).find((c) => c.toLowerCase() === v) : undefined;
      updateRule(r.id, { op, value: hit });
      return;
    }
    updateRule(r.id, { op });
  };

  const renderRule = (r: LaneRule) => {
    const n = leafNumber.get(r.id) as number;
    const t = typeOf(r);
    const def = r.field === null ? undefined : fieldsById.get(r.field);
    const complete = isRuleComplete(r, t);
    const ops = t ? opsForFieldType(t) : [];
    const textType = t !== null && isTextRuleType(t);
    const valueChoices = textType && r.op !== "contains" ? choicesFor(r) : NO_CHOICES;
    const laneValues = new Set(((r.field !== null && textChoices?.get(r.field)) || NO_CHOICES).map((c) => c.toLowerCase()));
    const removeName = `Remove filter ${n}: ${complete && t && def ? ruleText(r, t, def.name, (raw) => fmt(def, raw)) : "incomplete"}`;
    return (
      <div key={r.id} data-lane-row={r.id} className="flex flex-wrap items-center gap-2">
        <SingleSelectDropdown<number>
          label="Choose a field"
          ariaLabel={`Filter ${n} field`}
          className="w-40 justify-between"
          labelClassName="truncate"
          escapePriority={INNER_ESCAPE_PRIORITY}
          options={fields.map((d) => ({
            value: d.id,
            label: d.name,
            icon: d.is_admin_only ? <AdminOnlyFieldGlyph className="w-3 h-3 text-fg-tertiary shrink-0" /> : undefined,
          }))}
          selected={r.field}
          onChange={(fid) => {
            if (fid === null || fid === r.field) return;
            const nt = fieldsById.get(fid)?.field_type as RuleFieldType;
            // A new field resets the operator and operands: they are typed.
            updateRule(r.id, { field: fid, op: opsForFieldType(nt)[0], value: undefined, min: undefined, max: undefined });
          }}
        />
        {ops.length > 1 ? (
          <SingleSelectDropdown<FieldRuleOp>
            label="is"
            ariaLabel={`Filter ${n} operator`}
            className="w-28 justify-between"
            escapePriority={INNER_ESCAPE_PRIORITY}
            options={ops.map((op) => ({ value: op, label: OP_LABELS[op] }))}
            selected={ops.includes(r.op) ? r.op : ops[0]}
            onChange={(op) => { if (op) changeOp(r, op); }}
          />
        ) : (
          <span className="text-sm text-fg-tertiary w-28">{t ? OP_LABELS[ops[0]] : ""}</span>
        )}
        {t === "dropdown" && def && (
          <div className="flex-1 min-w-[10rem]">
            <SingleSelectDropdown<string>
              label="Choose a value"
              ariaLabel={`Filter ${n} value`}
              className="w-full justify-between"
              labelClassName="truncate"
              escapePriority={INNER_ESCAPE_PRIORITY}
              options={def.choices.map((c) => ({ value: c, label: c }))}
              selected={r.value ? r.value : null}
              onChange={(v) => updateRule(r.id, { value: v ?? "" })}
            />
          </div>
        )}
        {textType && def && r.op === "contains" && (
          <div className="flex-1 min-w-[10rem]">
            <input
              type="text"
              value={r.value ?? ""}
              placeholder="Text to match"
              maxLength={LANE_FILTER_MAX_STRING}
              aria-label={`Filter ${n} ${def.name} contains`}
              aria-invalid={isInvalidTextPattern(r.value) || undefined}
              aria-describedby={`lane-rule-${r.id}-${isInvalidTextPattern(r.value) ? "error" : "hint"}`}
              onChange={(e) => updateRule(r.id, { value: e.target.value })}
              className={`${isInvalidTextPattern(r.value) ? INPUT_CLS.replace("border-line", "border-danger") : INPUT_CLS} w-full`}
            />
            {isInvalidTextPattern(r.value) ? (
              <p id={`lane-rule-${r.id}-error`} role="alert" className="text-xs text-danger mt-1">{INVALID_PATTERN_MESSAGE}</p>
            ) : (
              <p id={`lane-rule-${r.id}-hint`} className="text-xs text-fg-tertiary mt-1">{PATTERN_HINT}</p>
            )}
          </div>
        )}
        {textType && def && r.op !== "contains" && (
          <div className="flex-1 min-w-[10rem]">
            {valueChoices.length > 0 ? (
              <SingleSelectDropdown<string>
                label="Choose a value"
                ariaLabel={`Filter ${n} value`}
                className="w-full justify-between"
                labelClassName="truncate"
                escapePriority={INNER_ESCAPE_PRIORITY}
                // A kept stored value says why it matches nothing (#2226 ux-review).
                options={valueChoices.map((c) => ({ value: c, label: laneValues.has(c.toLowerCase()) ? c : `${c} (no lane has this)` }))}
                selected={valueChoices.find((c) => c.toLowerCase() === r.value?.trim().toLowerCase()) ?? null}
                onChange={(v) => updateRule(r.id, { value: v ?? "" })}
              />
            ) : (
              <span className="text-xs text-fg-tertiary">No lane has a value yet. Use contains to match text.</span>
            )}
          </div>
        )}
        {(t === "number" || t === "date") && def && (
          <div className="flex items-center gap-2 flex-1 min-w-[12rem]">
            <input
              type={t}
              value={r.min ?? ""}
              placeholder="Any"
              aria-label={`Filter ${n} ${def.name} from`}
              onChange={(e) => updateRule(r.id, { min: e.target.value })}
              className={`${INPUT_CLS} ${t === "number" ? "w-24" : "w-36"}`}
            />
            <span className="text-xs text-fg-tertiary">to</span>
            <input
              type={t}
              value={r.max ?? ""}
              placeholder="Any"
              aria-label={`Filter ${n} ${def.name} to`}
              onChange={(e) => updateRule(r.id, { max: e.target.value })}
              className={`${INPUT_CLS} ${t === "number" ? "w-24" : "w-36"}`}
            />
          </div>
        )}
        {!t && <span className="flex-1" />}
        <button
          type="button"
          aria-label={removeName}
          title="Remove filter"
          onClick={() => removeRule(r.id)}
          className="w-6 h-6 rounded hover:bg-surface-hover text-fg-tertiary hover:text-fg flex items-center justify-center shrink-0 ml-auto focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    );
  };

  return (
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-describedby={readsAsId}
      className="fixed z-50 bg-surface border border-line-strong rounded-lg shadow-xl focus:outline-none"
      // Single-key board shortcuts (`f`, `e`, …) listen on the document and only
      // skip text fields, so a printable key on a button in here would reach
      // them. Escape and modified keys still propagate (the Escape stack).
      onKeyDown={(e) => {
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
      }}
      style={{
        top: top ?? 0,
        left: clampLeftToVisible(anchorRect.left, PANEL_WIDTH),
        width: `min(${PANEL_WIDTH}px, calc(100vw - ${2 * POPOVER_VIEWPORT_MARGIN}px))`,
        visibility: top === null ? "hidden" : undefined,
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <h2 id={headingId} className="text-sm font-medium text-fg">Lane filters</h2>
        {items.length > 0 && (
          <button
            type="button"
            className={`${SECONDARY_BTN} ml-auto`}
            onClick={() => { commit([]); setFocusTarget({ kind: "add" }); }}
          >
            Clear lane filters
          </button>
        )}
      </div>
      {paused && (
        <p className="px-3 py-1.5 text-xs text-fg-tertiary">Paused while a lane is focused. Changes apply when you exit focus.</p>
      )}
      <div className="relative">
        <div
          ref={listRef}
          onScroll={onScroll}
          className="overflow-y-auto px-3 py-2 flex flex-col gap-1.5 scroll-pb-10"
          // Viewport minus margins and the header, Reads-as and footer chrome
          // (and the paused note, which takes about one line more).
          style={{ maxHeight: visibleMaxHeight(2 * POPOVER_VIEWPORT_MARGIN, paused ? "10.5rem" : "9rem") }}
        >
          {items.length === 0 && <p className="text-xs text-fg-faint italic">No lane filters yet.</p>}
          {items.map((it, i) => (
            <div key={it.id} className="flex flex-col gap-1.5">
              {i > 0 && (
                <JoinToggle
                  label={`Join ${itemName(items[i - 1])} and ${itemName(it)}`}
                  join={it.join}
                  onChange={(j) => setItemJoin(it.id, j)}
                />
              )}
              {it.kind === "rule" ? (
                renderRule(it)
              ) : (
                <div className="border border-line-strong rounded p-2 flex flex-col gap-1.5" data-lane-group={it.id}>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold uppercase tracking-wide text-fg-tertiary">Group {groupNumber.get(it.id)}</span>
                    <button
                      type="button"
                      disabled={!canAdd}
                      className="ml-auto text-xs text-fg-secondary hover:text-fg underline-offset-2 hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40"
                      onClick={() => addToGroup(it.id)}
                    >
                      + Add filter to group
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove group ${groupNumber.get(it.id)}`}
                      className="text-xs text-fg-secondary hover:text-fg underline-offset-2 hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                      onClick={() => removeGroup(it.id)}
                    >
                      Remove group
                    </button>
                  </div>
                  {it.rules.map((r, j) => (
                    <div key={r.id} className="flex flex-col gap-1.5">
                      {j > 0 && (
                        <JoinToggle
                          label={`Join filter ${leafNumber.get(it.rules[j - 1].id)} and filter ${leafNumber.get(r.id)}`}
                          join={r.join}
                          onChange={(jn) => updateRule(r.id, { join: jn })}
                        />
                      )}
                      {renderRule(r)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {moreBelow && (
          <div aria-hidden="true" className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-surface to-transparent pointer-events-none" />
        )}
      </div>
      <p id={readsAsId} role="status" aria-live="polite" aria-atomic="true" className="px-3 py-2 border-t border-line text-xs text-fg-tertiary min-h-4">
        {summary.readsAs}
      </p>
      <div className="flex items-center gap-3 px-3 py-2 border-t border-line">
        <button type="button" data-lane-add className={SECONDARY_BTN} disabled={!canAdd} onClick={addRule}>
          + Add filter
        </button>
        <button type="button" className={SECONDARY_BTN} disabled={!canAdd} onClick={addGroup}>
          + Add group
        </button>
        <button
          type="button"
          onClick={() => onClose(true)}
          className="ml-auto bg-button-primary hover:bg-button-primary-hover text-on-primary px-3 py-1 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-surface"
        >
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * Segmented And/Or connector (#2205). Two real buttons with `aria-pressed`;
 * the pressed one carries the ActiveMark check (#2185) and is bold as well as
 * tinted, so the state is never conveyed by color alone.
 */
export function JoinToggle({ label, join, onChange }: { label: string; join: FieldRuleJoin; onChange: (j: FieldRuleJoin) => void }) {
  const btn = (j: FieldRuleJoin, text: string, extra = "") => (
    <button
      type="button"
      aria-pressed={join === j}
      onClick={() => onChange(j)}
      className={`inline-flex items-center gap-1 min-h-6 px-2 text-xs transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis ${extra} ${
        join === j ? "bg-primary-emphasis/20 text-info font-semibold" : "text-fg-tertiary font-normal hover:text-fg-secondary hover:bg-surface-hover"
      }`}
    >
      <ActiveMark active={join === j} />
      {text}
    </button>
  );
  return (
    <div role="group" aria-label={label} className="inline-flex self-start rounded overflow-hidden border border-line-strong">
      {btn("and", "And", "border-r border-line-strong")}
      {btn("or", "Or")}
    </div>
  );
}

interface ControlProps {
  filter: LaneFilter | undefined;
  fields: SwimlaneCustomFieldDefinition[];
  onChange: (next: LaneFilter | undefined) => void;
  paused: boolean;
  fmt: LaneValueFormatter;
  /** Complete leaf rules, for the badge. */
  activeRuleCount: number;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /** Text/url field id to the lanes' distinct values, for text `is` rules. */
  textChoices?: Map<number, string[]>;
}

/** The "Lanes" trigger in the filter strip plus its popover. */
export function LaneFilterControl({ filter, fields, onChange, paused, fmt, activeRuleCount, triggerRef: externalRef, textChoices }: ControlProps) {
  const ownRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalRef ?? ownRef;
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const id = useId();
  const popoverId = `lane-filter-${id.replace(/:/g, "")}`;
  const open = anchor !== null;
  const hasRules = (filter?.items.length ?? 0) > 0;
  const onClose = useRef((refocus: boolean) => {
    setAnchor(null);
    if (refocus) triggerRef.current?.focus();
  }).current;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-lane-filter-trigger
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={activeRuleCount > 0 ? `Lanes, ${activeRuleCount} active` : undefined}
        onClick={() => {
          if (open) setAnchor(null);
          else if (triggerRef.current) setAnchor(triggerRef.current.getBoundingClientRect());
        }}
        className={`bg-surface border rounded px-2 py-1 text-sm focus:outline-none flex items-center gap-1.5 transition shrink-0 focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-sunken ${
          hasRules && activeRuleCount > 0 ? "border-primary-soft text-info" : "border-line-strong text-fg-secondary hover:border-line-emphasis"
        }`}
      >
        Lanes
        {activeRuleCount > 0 && (
          <span aria-hidden="true" className="bg-primary-emphasis/30 text-info text-xs rounded-full px-1.5 tabular-nums">{activeRuleCount}</span>
        )}
        <svg aria-hidden="true" className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {anchor && (
        <LaneFilterPopover
          id={popoverId}
          filter={filter}
          fields={fields}
          onChange={onChange}
          anchorRect={anchor}
          triggerRef={triggerRef}
          onClose={onClose}
          paused={paused}
          fmt={fmt}
          textChoices={textChoices}
        />
      )}
    </>
  );
}
