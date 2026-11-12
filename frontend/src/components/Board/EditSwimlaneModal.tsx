import { useId, useRef, useState } from "react";
import type { BoardColor } from "../../utils/boardColors";
import { updateSwimlane, deleteSwimlane } from "../../api/boards";
import type { Card, Column, Swimlane, SwimlaneCustomFieldDefinition, SwimlaneLimitEnforcement } from "../../types";
import { columnLimitModes, laneUsage, swimlaneLimitModes, type LimitFlags, type LimitMode } from "../../utils/placementLimits";
import { useOverflowFade } from "../../hooks/useOverflowFade";
import { COLUMN_COLORS } from "../../constants/colors";
import ColorSwatchPicker from "../Common/ColorSwatchPicker";
import ModalWrapper from "../shared/ModalWrapper";
import SwimlaneFieldEditRow from "./SwimlaneFieldEditRow";
import { urlErrorFromServer } from "../../utils/customFieldValue";
import { isImeComposing } from "../../utils/imeComposition";

interface Props {
  boardId: number;
  swimlane: Swimlane;
  cardCount: number;
  onUpdated: (swimlane: Swimlane) => void;
  onDeleted: (swimlaneId: number) => void;
  onClose: () => void;
  /** Row field schema (#1140). The Fields section is omitted when empty. */
  swimlaneFieldDefinitions?: SwimlaneCustomFieldDefinition[];
  /** The user's `date_format` preference (#1993). */
  userDateFormat?: string;
  /** The board's columns, for "Columns that count" (#1150). */
  columns?: Column[];
  /** The row's cards, for the limits' "Now N" helpers (#1150). */
  laneCards?: Card[];
  /** Colors in use on the board, offered in the custom color popover (#2098). */
  boardColors?: BoardColor[];
  /** The board's enforce_* flags, which "Follow board settings" inherits (#1150). */
  limitFlags?: LimitFlags;
}

type EnforcementChoice = "inherit" | SwimlaneLimitEnforcement;

const RADIO_BASE = "flex flex-col rounded-lg border px-3 py-2 cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-emphasis";
const RADIO_ON = "border-primary-emphasis bg-primary-emphasis/10";
const RADIO_OFF = "border-line-strong hover:bg-surface-hover/40";
const NUMBER_INPUT = "w-20 bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted";

/** "" or "0" means no limit (the helper says so); anything else is the number. */
function parseLimit(raw: string): number | null {
  const n = raw === "" ? 0 : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The "Already over" note for a limit typed below the current total. Worded
 * for the enforcement the modal currently selects (completeness-check on
 * #1150): not enforced, a block an admin can override, or a hard stop.
 */
function alreadyOverNote(kind: "wip" | "weight", current: number, limit: number, mode: LimitMode | null): string {
  const now = kind === "wip" ? `${current} card${current === 1 ? "" : "s"} count now` : `${current} weight counts now`;
  if (mode === null) {
    return `Already over: ${now}. This limit is not enforced here, so it only shows on the row.`;
  }
  const what = kind === "wip"
    ? `a new card is refused until ${limit === 1 ? "no card counts" : `fewer than ${limit} cards count`}`
    : `a card that would add weight past ${limit} is refused`;
  const who = mode === "hard" ? " for everyone" : ", unless a board admin overrides";
  return `Already over: ${now}. Nothing moves; ${what}${who}.`;
}

/** What "Follow board settings" means on this board right now. */
function boardModeDescription(flags: LimitFlags): string {
  const modes = columnLimitModes(flags);
  const wip = modes.wip === "hard"
    ? "WIP limits block everyone"
    : modes.wip === "block"
      ? "WIP limits block, board admins can override"
      : "WIP limits only show on the row";
  const weight = modes.weight ? "weight limits block, board admins can override" : "weight limits only show on the row";
  return `Board now: ${wip}; ${weight}.`;
}

export default function EditSwimlaneModal({ boardId, swimlane, cardCount, onUpdated, onDeleted, onClose, swimlaneFieldDefinitions, userDateFormat, columns = [], laneCards = [], boardColors, limitFlags = { enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false } }: Props) {
  const [name, setName] = useState(swimlane.name);
  const [color, setColor] = useState(swimlane.color);
  // Row limits (#1150). Seeded once from the swimlane at mount (useState
  // initializers), never from an effect (frontend/CLAUDE.md § Local input
  // buffers).
  const [wipLimit, setWipLimit] = useState(swimlane.wip_limit?.toString() ?? "");
  const [weightLimit, setWeightLimit] = useState(swimlane.weight_limit?.toString() ?? "");
  const [enforcement, setEnforcement] = useState<EnforcementChoice>(swimlane.limit_enforcement ?? "inherit");
  // null = the default (every column not marked done), shown as those boxes
  // checked; the first change makes the list explicit.
  const [countedIds, setCountedIds] = useState<number[] | null>(swimlane.limit_column_ids ?? null);
  const [countedError, setCountedError] = useState<string | null>(null);
  const limitsId = useId();
  const firstCountedRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { moreBelow, onScroll: onBodyScroll } = useOverflowFade(bodyRef, [columns.length, swimlaneFieldDefinitions?.length]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const defs = [...(swimlaneFieldDefinitions ?? [])].sort((a, b) => a.position - b.position);

  // Values held at mount, so Save can send a diff rather than the whole set.
  const [initialValues] = useState<Record<number, string>>(() =>
    Object.fromEntries((swimlane.custom_field_values ?? []).map((v) => [v.field_definition, v.value]))
  );
  const [fieldValues, setFieldValues] = useState<Record<number, string>>(initialValues);

  // #1390 — URL fields whose input currently holds invalid, uncommitted text.
  // A ref, not state: clicking Save blurs the input first, and the blur's
  // refusal must be visible to the click handler that runs right after it.
  const invalidFieldIds = useRef<Set<number>>(new Set());
  const fieldsRef = useRef<HTMLDivElement>(null);
  // Server 400s mapped back onto the URL field they were about.
  const [fieldErrors, setFieldErrors] = useState<Record<number, string>>({});

  const effectiveCounted = countedIds ?? columns.filter((c) => !c.is_done).map((c) => c.id);
  // "Now N" against the selection being edited, not the saved one.
  const usage = laneUsage({ ...swimlane, limit_column_ids: effectiveCounted }, columns, laneCards);
  const newWip = parseLimit(wipLimit);
  const newWeight = parseLimit(weightLimit);
  const wipAlreadyOver = newWip !== null && usage.count > newWip;
  const weightAlreadyOver = newWeight !== null && usage.weight > newWeight;
  // The modes the selected enforcement gives, for the "Already over" copy.
  const selectedModes = swimlaneLimitModes(limitFlags, {
    ...swimlane, limit_enforcement: enforcement === "inherit" ? null : enforcement,
  });

  const toggleCounted = (columnId: number, checked: boolean) => {
    setCountedError(null);
    const next = checked
      ? [...effectiveCounted, columnId]
      : effectiveCounted.filter((id) => id !== columnId);
    setCountedIds([...new Set(next)].sort((a, b) => a - b));
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    if (countedIds !== null && countedIds.length === 0) {
      // The server refuses an empty list; say so here and keep the modal open.
      setCountedError("Choose at least one column, or the limit would count nothing.");
      firstCountedRef.current?.focus();
      return;
    }
    if (invalidFieldIds.current.size > 0) {
      // Never save without the invalid text and close as if it had been
      // saved: stay open, and put the user back on the field with its
      // inline error still showing.
      fieldsRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus();
      return;
    }
    setSaving(true);
    setFieldErrors({});
    setSaveError(null);
    try {
      // Diff, not the whole array: apply_swimlane_custom_field_values leaves
      // definitions it is not told about alone, so sending only what changed
      // is both correct and strictly safer than a full replace — a field this
      // client never knew about (added by another admin mid-edit) is not
      // silently cleared. A cleared field is sent as "" and deletes its row.
      const changed = defs
        .filter((d) => (fieldValues[d.id] ?? "") !== (initialValues[d.id] ?? ""))
        .map((d) => ({ field_definition: d.id, value: fieldValues[d.id] ?? "" }));

      const updated = await updateSwimlane(boardId, swimlane.id, {
        name: name.trim(),
        color,
        wip_limit: newWip,
        weight_limit: newWeight,
        limit_enforcement: enforcement === "inherit" ? null : enforcement,
        limit_column_ids: countedIds,
        ...(changed.length > 0 && { custom_field_values: changed }),
      });
      onUpdated(updated);
      onClose();
    } catch (err) {
      // The value serializer prefixes each message with the field's name, so
      // a refused URL can be pinned to its input; anything else keeps the
      // generic message.
      const body = JSON.stringify((err as { response?: { data?: unknown } } | null)?.response?.data ?? "");
      const mapped: Record<number, string> = {};
      for (const d of defs) {
        if (d.field_type !== "url" || !body.includes(`'${d.name}'`)) continue;
        const message = urlErrorFromServer(err);
        if (message) mapped[d.id] = message;
      }
      setFieldErrors(mapped);
      setSaveError(
        Object.keys(mapped).length > 0
          ? "Couldn't save this swimlane. Fix the highlighted field and try again."
          : "Couldn't save this swimlane. Try again."
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    await deleteSwimlane(boardId, swimlane.id);
    onDeleted(swimlane.id);
    onClose();
  };

  // Dynamic title based on delete-confirmation state
  const title = confirmDelete
    ? (cardCount > 0 ? "Cannot delete swimlane" : "Delete swimlane?")
    : "Edit Swimlane";

  return (
    <ModalWrapper
      open={true}
      onClose={onClose}
      title={title}
      maxWidth="max-w-md"
      labelId="edit-swimlane-title"
      // The limits section (#1150) makes this modal taller than a short
      // viewport, so the body scrolls and the footer stays put, as in
      // ImportBoardModal.
      panelClassName="max-h-[calc(100dvh-2rem)]"
      noPadding
    >
      {confirmDelete ? (
        <div className="px-6 pb-6">
        {cardCount > 0 ? (
          <>
            <p className="text-sm text-fg-tertiary mb-5">
              <span className="font-medium text-fg">{swimlane.name}</span> has {cardCount} card{cardCount !== 1 ? "s" : ""}. Move or delete all cards before removing this swimlane.
            </p>
            <div className="flex justify-end">
              <button onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 text-sm bg-surface-hover text-fg rounded hover:bg-surface-active transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
                OK
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-fg-tertiary text-sm mb-1">
              <span className="text-fg font-medium">{swimlane.name}</span> will be permanently deleted.
            </p>
            <p className="text-danger text-sm mb-1">
              If the swimlane contains any archived cards, they will also be permanently deleted.
            </p>
            <p className="text-fg-muted text-sm mb-5">This cannot be undone.</p>
            <div className="flex items-center justify-end gap-3">
              <button onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 text-sm text-fg-tertiary hover:text-fg rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
                Cancel
              </button>
              <button onClick={handleDelete} className="px-3 py-1.5 text-sm font-medium bg-danger-bg text-on-danger rounded hover:bg-danger-bg-hover transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis">
                Delete
              </button>
            </div>
          </>
        )}
        </div>
      ) : (
        <>
          {/* One scroll region for the whole form (#1455): focusable, named,
              with a bottom fade while more is below. */}
          <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            ref={bodyRef}
            onScroll={onBodyScroll}
            tabIndex={0}
            role="region"
            aria-label="Swimlane settings"
            className="flex-1 min-h-0 overflow-y-auto scroll-pb-8 px-6 pb-2 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis"
          >
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-xs text-fg-tertiary mb-1 block">Name *</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e)) void handleSave(); }} // handleSave manages its own saving/error state (saveError) and never rejects
                className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
              />
            </div>

            <div>
              <label className="text-xs text-fg-tertiary mb-1 block">Color</label>
              <ColorSwatchPicker colors={COLUMN_COLORS} value={color} onChange={setColor} allowCustom boardColors={boardColors} />
            </div>
          </div>

          {/* Context-gated: omit the section *and* its divider when the board
              defines no row fields, rather than showing an empty heading. */}
          {defs.length > 0 && (
            <>
              <div className="border-t border-line my-4" />
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2">
                Swimlane fields <span className="ml-1.5 normal-case font-normal text-fg-muted">({defs.length})</span>
              </p>
              {/* Not collapsible: this is one of two sections in a focused
                  modal, and a collapsed section behind a Save button is a trap. */}
              <div ref={fieldsRef} className="flex flex-col gap-4">
                {defs.map((def) => (
                  <SwimlaneFieldEditRow
                    key={def.id}
                    definition={def}
                    value={fieldValues[def.id]}
                    onChange={(v) => setFieldValues((prev) => ({ ...prev, [def.id]: v }))}
                    onInvalidChange={(invalid) => {
                      if (invalid) invalidFieldIds.current.add(def.id);
                      else invalidFieldIds.current.delete(def.id);
                    }}
                    serverError={fieldErrors[def.id] ?? null}
                    userDateFormat={userDateFormat}
                  />
                ))}
              </div>
            </>
          )}

          {/* Row limits (#1150), after the row fields so a field near the top
              never needs the body scrolled to reach. Rendered whether or not a limit is set: the
              counted columns and the enforcement choice are what an admin
              decides before typing a number, and hiding them would make the
              capability undiscoverable. */}
          <div className="border-t border-line my-4" />
          <section aria-labelledby={`${limitsId}-heading`}>
            <h3 id={`${limitsId}-heading`} className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2">
              Limits
            </h3>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${limitsId}-wip`} className="text-xs text-fg-tertiary">WIP limit</label>
                <div className="flex items-center gap-2">
                  <input
                    id={`${limitsId}-wip`}
                    inputMode="numeric"
                    maxLength={6}
                    value={wipLimit}
                    onChange={(e) => setWipLimit(e.target.value.replace(/\D/g, ""))}
                    placeholder="0"
                    aria-describedby={`${limitsId}-wip-help`}
                    className={NUMBER_INPUT}
                  />
                  <span className="text-sm text-fg-tertiary">cards</span>
                </div>
                <p id={`${limitsId}-wip-help`} className="text-xs min-h-4">
                  {wipAlreadyOver ? (
                    <span className="text-warning">
                      {alreadyOverNote("wip", usage.count, newWip ?? 0, selectedModes.wip)}
                    </span>
                  ) : (
                    <span className="text-fg-muted">Now {usage.count} · 0 = no limit</span>
                  )}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${limitsId}-weight`} className="text-xs text-fg-tertiary">Weight limit</label>
                <div className="flex items-center gap-2">
                  <input
                    id={`${limitsId}-weight`}
                    inputMode="numeric"
                    maxLength={6}
                    value={weightLimit}
                    onChange={(e) => setWeightLimit(e.target.value.replace(/\D/g, ""))}
                    placeholder="0"
                    aria-describedby={`${limitsId}-weight-help`}
                    className={NUMBER_INPUT}
                  />
                  <span className="text-sm text-fg-tertiary">weight</span>
                </div>
                <p id={`${limitsId}-weight-help`} className="text-xs min-h-4">
                  {weightAlreadyOver ? (
                    <span className="text-warning">
                      {alreadyOverNote("weight", usage.weight, newWeight ?? 0, selectedModes.weight)}
                    </span>
                  ) : (
                    <span className="text-fg-muted">Now {usage.weight} · 0 = no limit</span>
                  )}
                </p>
              </div>
            </div>

            {columns.length > 0 && (
              <fieldset className="mt-3" aria-describedby={`${limitsId}-counted-help`}>
                <legend className="text-xs text-fg-tertiary mb-1.5">Columns that count</legend>
                <div className="flex flex-col gap-1">
                  {columns.map((col, i) => (
                    <label key={col.id} className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        ref={i === 0 ? firstCountedRef : undefined}
                        type="checkbox"
                        aria-invalid={countedError !== null ? true : undefined}
                        checked={effectiveCounted.includes(col.id)}
                        onChange={(e) => toggleCounted(col.id, e.target.checked)}
                        className="w-4 h-4 rounded accent-primary"
                      />
                      <span className="text-sm text-fg-secondary">
                        {col.name}{col.is_done && <span className="text-fg-tertiary"> (done)</span>}
                      </span>
                    </label>
                  ))}
                </div>
                <p id={`${limitsId}-counted-help`} className="text-xs min-h-4 mt-1">
                  {countedError ? (
                    <span className="text-danger">{countedError}</span>
                  ) : (
                    <span className="text-fg-muted">
                      {countedIds === null ? "Default: every column not marked done." : "Only cards in the checked columns count."}
                    </span>
                  )}
                </p>
              </fieldset>
            )}

            <fieldset className="mt-3">
              <legend className="text-xs text-fg-tertiary mb-1.5">When the row is full</legend>
              <div className="flex flex-col gap-2">
                {([
                  ["inherit", "Follow board settings", boardModeDescription(limitFlags)],
                  ["block", "Block, admins can override", "Moves and new cards are refused; a board admin can move anyway."],
                  ["hard", "Block for everyone", "No one can add a card past the WIP limit. A weight limit can still be overridden by a board admin."],
                ] as const).map(([value, label, description]) => (
                  <label key={value} className={`${RADIO_BASE} ${enforcement === value ? RADIO_ON : RADIO_OFF}`}>
                    <input
                      type="radio"
                      name={`${limitsId}-enforcement`}
                      value={value}
                      checked={enforcement === value}
                      onChange={() => setEnforcement(value)}
                      className="sr-only"
                    />
                    <span className="text-sm text-fg font-medium">{label}</span>
                    <span className="text-xs text-fg-muted mt-0.5">{description}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </section>

          </div>
          {moreBelow && (
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface to-transparent" />
          )}
          </div>

          <div className="px-6 pb-6">
          <p className="text-xs h-4 mt-2">
            {saveError && <span className="text-danger">{saveError}</span>}
          </p>

          <div className="flex justify-between items-center mt-2">
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-sm text-danger hover:text-danger transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
            >
              Delete swimlane
            </button>
            <div className="flex gap-2">
              <button onClick={onClose} className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
              <button
                onClick={handleSave}
                disabled={!name.trim() || saving}
                className="text-sm bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
          </div>
        </>
      )}
    </ModalWrapper>
  );
}
