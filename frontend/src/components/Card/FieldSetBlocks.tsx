/**
 * Field set blocks on the card detail (#2570). Replaces the flat Custom fields
 * section when the board has at least one set; a board with none keeps the
 * flat section (CardDetail renders that branch, not this component).
 *
 * Sizes are a per-viewer view choice (`useFieldSetSizePref`); Maximize is a
 * transient layer over the card sheet, never persisted, one block at a time.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CustomFieldDefinition, CustomFieldSet, CustomFieldValue, FieldSetSize } from "../../types";
import { useFieldSetSizePref } from "../../hooks/useFieldSetSizePref";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import ActiveUnderline from "../Common/ActiveUnderline";
import CustomFieldEditRow from "./CustomFieldEditRow";
import { formatCustomFieldValue } from "../../utils/customFieldValue";
import {
  OTHER_FIELDS_KEY, blockProgress, buildCardBlocks, chipsThatFit, defaultSize, summaryChips, valueOf,
  type CardFieldBlock,
} from "../../utils/fieldSets";

/** Escape priority of the Maximize layer: above the sheet (30), below 31–37.5 (frontend/CLAUDE.md). */
export const MAXIMIZE_ESCAPE_PRIORITY = 30.5;

const QUIET_BTN = "px-2 py-1 text-xs rounded max-sm:min-h-11 text-fg-secondary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis aria-disabled:opacity-50 aria-disabled:cursor-not-allowed";
const ICON_BTN = "relative inline-flex items-center justify-center w-7 h-7 max-sm:w-11 max-sm:h-11 rounded text-fg-tertiary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
const WIDE_TYPES = new Set(["text", "url", "multi_select"]);

interface Props {
  boardId: number;
  cardId: number;
  cardTitle: string;
  swimlaneId: number | null;
  swimlaneName?: string;
  definitions: CustomFieldDefinition[];
  sets: CustomFieldSet[];
  values: CustomFieldValue[];
  canEdit: boolean;
  isAdmin: boolean;
  userId: number | null | undefined;
  userDateFormat: string;
  userTimezone: string;
  onSave: (definitionId: number, value: string) => Promise<void>;
  onOpenBoardSettings?: () => void;
}

function Progress({ filled, total, id }: { filled: number; total: number; id: string }) {
  if (total === 0) return null;
  const pct = Math.round((filled / total) * 100);
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      <span className="w-[72px] h-1.5 rounded-full bg-sunken overflow-hidden" aria-hidden="true">
        <span className={`block h-full ${filled === total ? "bg-success" : "bg-primary-emphasis"}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-xs text-fg-muted" aria-hidden="true">{filled}/{total}</span>
      <span id={id} className="sr-only">{filled} of {total} filled</span>
    </span>
  );
}

/** Summary / All fields toggles (`aria-pressed`) plus a separate Maximize action. */
export function FieldSetSizeControl({ name, size, onSize, onMaximize, maximizeRef }: {
  name: string;
  size: FieldSetSize;
  onSize: (s: Exclude<FieldSetSize, "collapsed">) => void;
  onMaximize: () => void;
  maximizeRef: (el: HTMLButtonElement | null) => void;
}) {
  const toggle = (value: "summary" | "expanded", label: string, path: string) => (
    <button
      type="button"
      aria-pressed={size === value}
      aria-label={label}
      title={label}
      onClick={() => onSize(value)}
      className={`${ICON_BTN} ${size === value ? "bg-primary-emphasis/20 text-info" : ""}`}
    >
      <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d={path} /></svg>
      <ActiveUnderline active={size === value} />
    </button>
  );
  return (
    <span className="flex items-center gap-1 shrink-0">
      <span role="group" aria-label={`${name} size`} className="flex items-center gap-0.5">
        {toggle("summary", "Summary", "M3 9h14v2H3z")}
        {toggle("expanded", "All fields", "M3 4h14v2H3zM3 9h14v2H3zM3 14h14v2H3z")}
      </span>
      <button
        type="button"
        ref={maximizeRef}
        aria-label={`Maximize ${name}`}
        aria-haspopup="dialog"
        title="Maximize"
        onClick={onMaximize}
        className={ICON_BTN}
      >
        <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M3 3h6v2H5v4H3zm8 0h6v6h-2V5h-4zM3 11h2v4h4v2H3zm12 0h2v6h-6v-2h4z" /></svg>
      </button>
    </span>
  );
}

function SummaryRow({ block, values, userDateFormat, onMore }: {
  block: CardFieldBlock; values: CustomFieldValue[]; userDateFormat: string; onMore: () => void;
}) {
  const chips = useMemo(() => summaryChips(block.definitions, values), [block.definitions, values]);
  const rowRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(chips.length);
  // Measure whole chips (they never shrink); jsdom reports 0 widths, so every chip "fits" there.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => {
      const widths = Array.from(row.querySelectorAll<HTMLElement>("[data-chip]")).map((el) => el.offsetWidth);
      setVisible(chipsThatFit(widths, row.clientWidth, 64, 6));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [chips]);
  const hidden = chips.slice(visible);
  const hiddenMissing = hidden.filter((c) => c.missing).length;
  const filledAny = chips.some((c) => !c.missing && valueOf(values, c.definition.id) !== undefined);
  if (!filledAny && chips.every((c) => c.missing)) return null;
  return (
    <div ref={rowRef} className="flex flex-nowrap items-center gap-1.5 overflow-hidden px-3 pb-2" data-testid="field-set-summary">
      {chips.map((chip, i) => {
        const v = valueOf(values, chip.definition.id);
        const text = chip.definition.field_type === "checkbox"
          ? `${chip.definition.name}: ${v === "true" ? "Yes" : "No"}`
          : chip.missing ? `${chip.definition.name} — missing` : `${chip.definition.name} ${formatCustomFieldValue(chip.definition, v ?? "", userDateFormat)}`;
        return (
          <span
            key={chip.definition.id}
            data-chip
            hidden={i >= visible}
            title={text}
            className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${chip.missing ? "bg-warning/15 text-warning-on-tint" : "bg-surface-hover text-fg-secondary"}`}
          >{text}</span>
        );
      })}
      {hidden.length > 0 && (
        <button type="button" onClick={onMore} className={`${QUIET_BTN} shrink-0 whitespace-nowrap`}>
          +{hidden.length}{hiddenMissing > 0 ? ` · ${hiddenMissing} missing` : ""}
        </button>
      )}
    </div>
  );
}

function FieldGrid({ block, values, props, gridClass, cellClass }: {
  block: CardFieldBlock; values: CustomFieldValue[]; props: Props; gridClass: string; cellClass?: string;
}) {
  return (
    <div className={gridClass}>
      {block.definitions.map((definition) => (
        <div
          key={definition.id}
          data-fact-section={`field:${definition.id}`}
          tabIndex={-1}
          className={`focus:outline-none ${WIDE_TYPES.has(definition.field_type) ? "sm:col-span-2" : ""} ${cellClass ?? ""}`}
        >
          <CustomFieldEditRow
            definition={definition}
            value={valueOf(values, definition.id)}
            disabled={!props.canEdit}
            userDateFormat={props.userDateFormat}
            userTimezone={props.userTimezone}
            onSave={(v) => props.onSave(definition.id, v)}
          />
        </div>
      ))}
    </div>
  );
}

export default function FieldSetBlocks(props: Props) {
  const { boardId, cardId, definitions, values, swimlaneId, canEdit, isAdmin } = props;
  // Structural live updates wait while a field row inside has focus (rule:
  // a live update never unmounts a focused field row); applied on blur.
  const rootRef = useRef<HTMLDivElement>(null);
  const [sets, setSets] = useState(props.sets);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const apply = () => {
      setSets((prev) => {
        const gone = prev.filter((p) => !props.sets.some((s) => s.uid === p.uid));
        if (gone.length > 0) setAnnouncement(`${gone.map((g) => g.name).join(", ")} was removed. Its fields are now under Other fields.`);
        return props.sets;
      });
    };
    const root = rootRef.current;
    const active = document.activeElement;
    if (root && active && root.contains(active) && active.closest("[data-fact-section]")) {
      const onOut = (e: FocusEvent) => {
        if (e.relatedTarget instanceof Node && (e.relatedTarget as Element).closest?.("[data-fact-section]") === active.closest("[data-fact-section]")) return;
        root.removeEventListener("focusout", onOut);
        apply();
      };
      root.addEventListener("focusout", onOut);
      return () => root.removeEventListener("focusout", onOut);
    }
    apply();
  }, [props.sets]);

  const blocks = useMemo(() => buildCardBlocks(definitions, sets, swimlaneId, values), [definitions, sets, swimlaneId, values]);
  const pref = useFieldSetSizePref(props.userId, boardId, [...props.sets.map((s) => s.uid), OTHER_FIELDS_KEY]);
  const sizeOf = (b: CardFieldBlock): FieldSetSize => pref.get(cardId, b.key)?.s ?? defaultSize(b);
  const lastOpenOf = (b: CardFieldBlock): "summary" | "expanded" => {
    const o = pref.get(cardId, b.key)?.o;
    if (o) return o;
    const d = b.set?.default_size ?? "expanded";
    return d === "collapsed" ? "summary" : d;
  };
  const setSize = (b: CardFieldBlock, s: FieldSetSize) => {
    pref.set(cardId, b.key, { s, o: s === "collapsed" ? lastOpenOf(b) : s });
  };

  const maximizeButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [maximized, setMaximized] = useState<string | null>(null);
  const maxIndex = blocks.findIndex((b) => b.key === maximized);
  const closeMaximize = useCallback(() => {
    const key = maximized;
    setMaximized(null);
    // Restore focus to that set's Maximize button, or the section heading if it is gone.
    requestAnimationFrame(() => {
      const btn = key ? maximizeButtons.current.get(key) : null;
      if (btn && btn.isConnected) btn.focus();
      else headingRef.current?.focus();
    });
  }, [maximized]);
  useEffect(() => {
    if (maximized !== null && maxIndex === -1) {
      setMaximized(null);
      headingRef.current?.focus();
    }
  }, [maximized, maxIndex]);

  const anyOverride = blocks.some((b) => pref.get(cardId, b.key) !== undefined);
  const allCollapsed = blocks.every((b) => sizeOf(b) === "collapsed");
  const laneLabel = props.swimlaneName ?? "this swimlane";

  return (
    <div ref={rootRef} data-testid="field-set-blocks">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="flex items-baseline gap-2">
          <h3 ref={headingRef} tabIndex={-1} className="text-xs font-semibold uppercase tracking-wide text-fg-muted focus:outline-none">Field sets</h3>
          <span className="text-xs text-fg-muted">{blocks.filter((b) => b.set).length} on this card</span>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className={QUIET_BTN} aria-disabled={allCollapsed}
            onClick={() => { if (!allCollapsed) blocks.forEach((b) => setSize(b, "collapsed")); }}>Collapse all</button>
          <button type="button" className={QUIET_BTN} aria-disabled={!anyOverride}
            onClick={() => { if (anyOverride) pref.resetCard(cardId); }}>Reset</button>
          {isAdmin && props.onOpenBoardSettings && (
            <button type="button" className={QUIET_BTN} onClick={props.onOpenBoardSettings}>Manage field sets</button>
          )}
        </div>
      </div>
      {blocks.filter((b) => b.set).length === 0 && sets.length > 0 && (
        <p className="text-xs text-fg-muted mb-2">No field sets apply to cards in {laneLabel}.</p>
      )}
      <div className="flex flex-col gap-3">
        {blocks.map((block) => {
          const size = sizeOf(block);
          const open = size !== "collapsed";
          const prog = blockProgress(block.definitions, values);
          const ids = { head: `fs-${cardId}-${block.key}-h`, body: `fs-${cardId}-${block.key}-b`, prog: `fs-${cardId}-${block.key}-p` };
          const subtitle = block.outOfLane ? `Not used in ${laneLabel}` : block.set?.description;
          const empty = prog.filled === 0 && block.definitions.every((d) => valueOf(values, d.id) === undefined);
          return (
            <section key={block.key} aria-labelledby={ids.head} className="rounded-[10px] border border-line bg-surface" data-testid={`field-set-${block.key}`}>
              <div className="flex items-center gap-3 px-3 min-h-11 flex-wrap">
                <button
                  type="button"
                  id={ids.head}
                  aria-expanded={open}
                  aria-controls={ids.body}
                  aria-describedby={prog.total > 0 ? ids.prog : undefined}
                  onClick={() => setSize(block, open ? "collapsed" : lastOpenOf(block))}
                  className="flex items-center gap-1.5 min-w-0 flex-1 text-left max-sm:min-h-11 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  <svg className={`w-3.5 h-3.5 shrink-0 text-fg-faint transition-transform ${open ? "" : "-rotate-90"}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold text-fg truncate" title={block.name}>{block.name}</span>
                    {subtitle && <span className="block text-xs text-fg-muted truncate" title={subtitle}>{subtitle}</span>}
                  </span>
                </button>
                <Progress {...prog} id={ids.prog} />
                <FieldSetSizeControl
                  name={block.name}
                  size={size}
                  onSize={(s) => setSize(block, s)}
                  onMaximize={() => setMaximized(block.key)}
                  maximizeRef={(el) => { maximizeButtons.current.set(block.key, el); }}
                />
              </div>
              <div id={ids.body} hidden={!open}>
                {open && empty && (
                  <p className="px-3 pb-2 text-xs text-fg-muted">
                    No values yet.
                    {canEdit && size === "summary" && (
                      <button type="button" className={`${QUIET_BTN} ml-1 text-info`} onClick={() => setSize(block, "expanded")}>Fill in</button>
                    )}
                  </p>
                )}
                {size === "summary" && (
                  <SummaryRow block={block} values={values} userDateFormat={props.userDateFormat} onMore={() => setSize(block, "expanded")} />
                )}
                {size === "expanded" && (
                  <FieldGrid block={block} values={values} props={props} gridClass="grid grid-cols-1 sm:grid-cols-2 gap-4 px-3 pb-3" />
                )}
              </div>
            </section>
          );
        })}
      </div>
      <div role="status" aria-live="polite" className="sr-only">{announcement}</div>
      {maximized !== null && maxIndex !== -1 && (
        <FieldSetMaximized
          anchor={rootRef.current}
          blocks={blocks}
          index={maxIndex}
          cardTitle={props.cardTitle}
          values={values}
          props={props}
          onNavigate={(i) => { setMaximized(blocks[i].key); }}
          onClose={closeMaximize}
        />
      )}
    </div>
  );
}

function FieldSetMaximized({ anchor, blocks, index, cardTitle, values, props, onNavigate, onClose }: {
  anchor: HTMLElement | null; blocks: CardFieldBlock[]; index: number; cardTitle: string; values: CustomFieldValue[];
  props: Props; onNavigate: (i: number) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const block = blocks[index];
  const prog = blockProgress(block.definitions, values);
  const [status, setStatus] = useState("");
  useFocusTrap(ref, true);
  useEscapeStack(() => { onClose(); return true; }, MAXIMIZE_ESCAPE_PRIORITY);
  useEffect(() => { ref.current?.querySelector<HTMLElement>("[data-restore]")?.focus(); }, []);
  // Cover the whole card sheet: portal into the sheet dialog when there is one.
  const host = (anchor?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body;
  const go = (i: number) => {
    if (i < 0 || i >= blocks.length) return;
    onNavigate(i);
    setStatus(`Showing ${blocks[i].name}, ${i + 1} of ${blocks.length}.`);
  };
  const navBtn = (label: string, target: number, d: string) => (
    <button type="button" aria-label={label} title={label} aria-disabled={target < 0 || target >= blocks.length}
      onClick={() => go(target)} className={`${ICON_BTN} aria-disabled:opacity-50`}>
      <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d={d} /></svg>
    </button>
  );
  return createPortal(
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="field-set-max-title"
      className="absolute inset-0 z-10 bg-surface flex flex-col" data-testid="field-set-maximized">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-line flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-fg-muted truncate">{cardTitle} › Field sets</p>
          <h2 id="field-set-max-title" className="text-base font-semibold text-fg truncate">{block.name}</h2>
        </div>
        <Progress {...prog} id="field-set-max-prog" />
        {navBtn("Previous field set", index - 1, "M12.7 4.3l1.4 1.4L9.8 10l4.3 4.3-1.4 1.4L7 10z")}
        {navBtn("Next field set", index + 1, "M7.3 4.3L5.9 5.7 10.2 10l-4.3 4.3 1.4 1.4L13 10z")}
        <button type="button" data-restore onClick={onClose}
          className="px-3 py-1.5 text-sm rounded border border-line-strong text-fg-secondary hover:bg-surface-hover max-sm:min-h-11 focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Restore</button>
      </div>
      <div className="relative flex-1 min-h-0">
        <div role="region" tabIndex={0} aria-label={`${block.name} fields`} data-testid="field-set-max-region"
          className="h-full overflow-y-auto scroll-pb-8 focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
          <FieldGrid block={block} values={values} props={props}
            gridClass="grid grid-cols-1 sm:grid-cols-2 gap-3 p-5" cellClass="rounded-[10px] border border-line bg-sunken p-3" />
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface" aria-hidden="true" />
      </div>
      <div role="status" aria-live="polite" className="sr-only">{status}</div>
    </div>,
    host,
  );
}
