import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import StageSettingsPanel from "./StageSettingsPanel";
import { useOptionalBoardContext } from "../../contexts/BoardContext";
import type { BoardColor } from "../../utils/boardColors";
import { updateColumn } from "../../api/boards";
import type { Card, Column, CustomFieldDefinition, Swimlane } from "../../types";
import { COLUMN_COLORS } from "../../constants/colors";
import ColorSwatchPicker from "../Common/ColorSwatchPicker";
import ModalWrapper from "../shared/ModalWrapper";
import IntakeColumnCallout, { DoneColumnMore } from "./IntakeColumnCallout";
import ColumnPolicyEditor from "./ColumnPolicyEditor";
import HelpLink from "../Common/HelpLink";
import { useOverflowFade } from "../../hooks/useOverflowFade";
import { useColumnPolicyDraft } from "../../hooks/useColumnPolicyDraft";
import { isImeComposing } from "../../utils/imeComposition";
import type { StageRemap } from "../../hooks/useBoard";

export type EditColumnTab = "settings" | "policy" | "stage";

interface Props {
  boardId: number;
  column: Column;
  cardCount: number;
  /** A stage save adds `remapped` (#1102); the board applies it with `applyStageRemap`. */
  onUpdated: (column: Column & { remapped?: StageRemap[] }) => void;
  onRequestDelete: (column: Column) => void;
  onClose: () => void;
  /** Open on this tab (#1101: "Add policy…" and the popover's "Edit policy"
   *  open on Policy). Unset opens on Settings. */
  initialTab?: EditColumnTab;
  /** Colors in use on the board, offered in the custom color popover (#2098). */
  boardColors?: BoardColor[];
  /** True when this is the board's first not-done column (#2298). Computed by
   *  the caller from the full column list; absent renders no callout. */
  isIntakeColumn?: boolean;
  /**
   * The board's full swimlane and field lists for the Stage tab (#2278),
   * hidden lanes included. Absent, the board context is used; with neither,
   * the Stage tab says it cannot load rather than saving a partial view,
   * because Save stage replaces every lane exception it sends.
   */
  swimlanes?: Swimlane[];
  customFieldDefinitions?: CustomFieldDefinition[];
  /** This column's cards, for the Stage tab's "N cards will move" summary. */
  cards?: Pick<Card, "column" | "gates_passed">[];
}

const TABS: { id: EditColumnTab; label: string }[] = [
  { id: "settings", label: "Settings" },
  { id: "policy", label: "Policy" },
  // Stage settings (#2278): sub-columns, tracks and lane exceptions, with their own Save stage.
  { id: "stage", label: "Stage" },
];

export default function EditColumnModal({ boardId, column, cardCount, onUpdated, onRequestDelete, onClose, initialTab, boardColors, isIntakeColumn, swimlanes, customFieldDefinitions, cards }: Props) {
  const [tab, setTab] = useState<EditColumnTab>(initialTab ?? "settings");
  // The Stage tab mounts on first visit and then stays mounted (hidden) so its drafts survive tab switches.
  const [stageMounted, setStageMounted] = useState(tab === "stage");
  if (tab === "stage" && !stageMounted) setStageMounted(true);
  const [stageFooter, setStageFooter] = useState<HTMLDivElement | null>(null);
  const [name, setName] = useState(column.name);
  const [color, setColor] = useState(column.color);
  const [wipLimit, setWipLimit] = useState(column.wip_limit?.toString() ?? "");
  const [weightLimit, setWeightLimit] = useState(column.weight_limit?.toString() ?? "");
  const [allowCardCreation, setAllowCardCreation] = useState(column.allow_card_creation);
  const [isDone, setIsDone] = useState(column.is_done);
  // Policy drafts (#1101): seeded once at mount, as the other fields are; the
  // modal is mounted fresh for each edit. Save sends `policy` only when dirty,
  // so a rename never overwrites a policy another admin changed meanwhile.
  const { entry, done, mode, setEntry, setDone, setMode, nextKey, dirty: policyChanged, toPolicy } = useColumnPolicyDraft(column);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A stage saved while Settings or Policy drafts are unsaved (#2368): the
  // modal stays open so those drafts are not lost, and the saved column (with
  // every `remapped` entry so far) reaches the board when the modal closes or
  // the Settings save lands. The Stage panel remounts on it (`stageKey`), so
  // a second Save stage sends the new sub-column ids, not the old rows.
  const [pendingStage, setPendingStage] = useState<(Column & { remapped?: StageRemap[] }) | null>(null);
  const [stageKey, setStageKey] = useState(0);
  // Save stage closes the modal only when no Settings or Policy edit is unsaved.
  const otherTabsDirty = name !== column.name || color !== column.color
    || wipLimit !== (column.wip_limit?.toString() ?? "") || weightLimit !== (column.weight_limit?.toString() ?? "")
    || allowCardCreation !== column.allow_card_creation || isDone !== column.is_done || policyChanged;

  // The Name field takes focus when the modal opens on Settings, never when
  // the user arrows back to the Settings tab: that would pull focus off the
  // tab strip mid-navigation.
  const autoFocusNameRef = useRef(!initialTab || initialTab === "settings");
  useEffect(() => { autoFocusNameRef.current = false; }, []);

  const tabsId = useId();
  const tabRefs = useRef(new Map<EditColumnTab, HTMLButtonElement>());
  const bodyRef = useRef<HTMLDivElement>(null);
  const { moreBelow, onScroll: onBodyScroll } = useOverflowFade(bodyRef, [tab, entry.length, done.length]);

  // Deep link onto the Policy tab (frontend/CLAUDE.md § Deep-link into a
  // tabbed modal): focus its tab after ModalWrapper has focused the panel, and
  // only if nothing deeper already took focus.
  useEffect(() => {
    if (!initialTab) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      const panel = bodyRef.current?.closest('[role="dialog"]');
      if (active === null || active === document.body || active === panel) {
        tabRefs.current.get(initialTab)?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design: a deep link applies to the first open
  }, []);

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const id = TABS[next].id;
    setTab(id);
    tabRefs.current.get(id)?.focus();
  };

  // Every way out of the modal hands a pending stage save to the board first.
  const close = () => {
    if (pendingStage) onUpdated(pendingStage);
    onClose();
  };

  const onStageSaved = (saved: Column & { remapped?: StageRemap[] }) => {
    if (!otherTabsDirty) {
      onUpdated(pendingStage ? { ...saved, remapped: [...(pendingStage.remapped ?? []), ...(saved.remapped ?? [])] } : saved);
      onClose();
      return;
    }
    setPendingStage((prev) => ({ ...saved, remapped: [...(prev?.remapped ?? []), ...(saved.remapped ?? [])] }));
    setStageKey((k) => k + 1);
  };
  // Derived, so it clears if the other drafts are reverted.
  const stageSavedNote = pendingStage && otherTabsDirty ? "Stage saved. Your Settings and Policy changes are not saved yet." : "";
  // The remount destroys the focused Save stage button: put focus on the Stage tab. A layout effect, so the
  // same commit does it; a passive one leaves focus on <body> until React gets round to it (#2608, #2609).
  useLayoutEffect(() => {
    if (stageKey > 0) tabRefs.current.get("stage")?.focus();
  }, [stageKey]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateColumn(boardId, column.id, {
        name: name.trim(),
        color,
        wip_limit: wipLimit ? parseInt(wipLimit) : null,
        weight_limit: weightLimit ? parseInt(weightLimit) : null,
        allow_card_creation: allowCardCreation,
        is_done: isDone,
        ...(policyChanged ? { policy: toPolicy() } : {}),
      });
      // The PATCH response already carries the saved stage; keep its remap.
      onUpdated(pendingStage ? { ...updated, remapped: pendingStage.remapped } : updated);
      onClose();
    } catch {
      setError("Failed to save column. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalWrapper
      open={true}
      onClose={close}
      title="Edit Column"
      maxWidth="max-w-md"
      labelId="edit-column-title"
      // Fixed-height tabbed modal (frontend/CLAUDE.md § Modals and dialogs):
      // the panel does not jump between the short Settings tab and a long
      // Policy tab, and the body scrolls under a fixed footer.
      panelClassName="h-[85vh] max-h-[640px] min-h-0 flex flex-col"
      noPadding
      headerBorder
    >
      <div role="tablist" aria-label="Column settings sections" className="flex border-b border-line px-6 gap-1 text-sm shrink-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el) tabRefs.current.set(t.id, el);
              else tabRefs.current.delete(t.id);
            }}
            type="button"
            role="tab"
            id={`${tabsId}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${tabsId}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={onTabKeyDown}
            className={`px-3 py-2.5 max-sm:min-h-11 font-medium whitespace-nowrap shrink-0 transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis rounded ${
              tab === t.id ? "border-b-2 border-info text-info" : "text-fg-tertiary hover:text-fg-secondary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* One scroll region per tab body (#1455): focusable, named, with a
          bottom fade while more is below. */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={bodyRef}
          role="region"
          aria-label={tab === "settings" ? "Column settings" : tab === "policy" ? "Column policy" : "Stage settings"}
          tabIndex={0}
          onScroll={onBodyScroll}
          className="flex-1 min-h-0 overflow-y-auto scroll-pb-8 px-6 py-4 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis"
        >
          <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-tab-${tab}`}>
          {tab === "settings" ? (
            <div className="flex flex-col gap-3">
              <div>
                <label htmlFor={`${tabsId}-name`} className="text-xs text-fg-tertiary mb-1 block">Name *</label>
                <input
                  id={`${tabsId}-name`}
                  autoFocus={autoFocusNameRef.current}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e)) void handleSave(); }} // handleSave manages its own saving/error state and never rejects
                  className="w-full bg-surface border border-line rounded px-3 py-1.5 max-sm:min-h-11 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <label className="text-xs text-fg-tertiary">WIP limit</label>
                    <HelpLink topic="wip-limit" />
                  </div>
                  <input
                    value={wipLimit}
                    onChange={(e) => setWipLimit(e.target.value.replace(/\D/g, ""))}
                    placeholder="None"
                    className="w-full bg-surface border border-line rounded px-3 py-1.5 max-sm:min-h-11 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                  />
                </div>
                <div>
                  <label className="text-xs text-fg-tertiary mb-1 block">Weight limit</label>
                  <input
                    value={weightLimit}
                    onChange={(e) => setWeightLimit(e.target.value.replace(/\D/g, ""))}
                    placeholder="None"
                    className="w-full bg-surface border border-line rounded px-3 py-1.5 max-sm:min-h-11 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-fg-tertiary mb-1 block">Color</label>
                <ColorSwatchPicker colors={COLUMN_COLORS} value={color} onChange={setColor} allowCustom boardColors={boardColors} />
              </div>

              <label className="flex items-center gap-2 cursor-pointer select-none max-sm:min-h-11">
                <input
                  type="checkbox"
                  checked={allowCardCreation}
                  onChange={(e) => setAllowCardCreation(e.target.checked)}
                  className="w-4 h-4 rounded accent-primary"
                />
                <span className="text-sm text-fg-secondary">Allow card creation</span>
              </label>

              <div className="border-t border-line mt-3 pt-3">
                <p className="text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-2">Analytics behavior</p>
                <label className="flex flex-col gap-0.5 cursor-pointer select-none">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={isDone}
                      onChange={(e) => setIsDone(e.target.checked)}
                      className="w-4 h-4 rounded accent-primary"
                    />
                    <span className="text-sm text-fg-secondary">Count as completed (for cycle-time metrics)</span>
                  </div>
                  <p className="text-xs text-fg-muted mt-0.5 ml-6">
                    Cards moved into this column are counted as completed in analytics.
                  </p>
                </label>
                {/* Saved is_done, not the draft checkbox, so toggling it does not flicker the note. */}
                {column.is_done && <DoneColumnMore idPrefix={tabsId} />}
                {isIntakeColumn && !column.is_done && <IntakeColumnCallout idPrefix={tabsId} />}
              </div>

              <div className="border-t border-line mt-3 pt-3">
                {/* Reserved status row — always rendered to prevent layout shift */}
                <p className="text-xs h-4 text-fg-tertiary">
                  {cardCount > 0 ? `Cannot delete — ${cardCount} card${cardCount === 1 ? '' : 's'} in this column` : ''}
                </p>
                <button
                  type="button"
                  onClick={() => { close(); onRequestDelete(column); }}
                  disabled={cardCount > 0}
                  className="w-full px-3 py-1.5 max-sm:min-h-11 text-sm font-medium bg-danger-bg hover:bg-danger-bg-hover text-on-danger rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis disabled:opacity-40 disabled:cursor-not-allowed mt-2"
                >
                  Delete column
                </button>
              </div>
            </div>
          ) : tab === "stage" ? null : (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-fg-muted">Every column's policy can also be edited together in Board settings → Rules. <HelpLink topic="column-policies" variant="text" /></p>
              <ColumnPolicyEditor
                entry={entry}
                done={done}
                mode={mode}
                onEntryChange={setEntry}
                onDoneChange={setDone}
                onModeChange={setMode}
                nextKey={nextKey}
              />
            </div>
          )}
          {stageMounted && (
            <div hidden={tab !== "stage"}>
              <StageTab
                boardId={boardId}
                swimlanes={swimlanes}
                definitions={customFieldDefinitions}
                cards={cards}
                footerTarget={tab === "stage" ? stageFooter : null}
                key={stageKey}
                column={pendingStage ?? column}
                onSaved={onStageSaved}
                onCancel={close}
              />
            </div>
          )}
          </div>
        </div>
        {moreBelow && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface to-transparent" />
        )}
      </div>

      {/* The Stage tab saves through its own Save stage (a separate endpoint): its
          panel portals its status and buttons into this fixed footer. */}
      {tab === "stage" && (
        <div className="flex flex-col gap-2 px-6 py-3 border-t border-line shrink-0" data-testid="stage-footer">
          <p className="text-xs text-fg-tertiary">
            {otherTabsDirty
              ? <>Save stage saves this tab only. <span className="text-warning">The dialog stays open so you can save your Settings and Policy changes after.</span></>
              : "Save stage saves this tab only and closes."}
          </p>
          <p className="text-xs text-success-on-tint" role="status" aria-live="polite" aria-atomic="true" data-testid="stage-saved-note">{stageSavedNote}</p>
          <div ref={setStageFooter} className="flex items-center gap-2" />
        </div>
      )}
      {tab !== "stage" && <div className="flex gap-3 px-6 py-4 border-t border-line items-center justify-end shrink-0">
        {/* Also says why Save is off, which matters on the Policy tab where
            the Name field is out of sight. */}
        <p id={`${tabsId}-status`} className="text-xs h-4 flex-1" role="status" aria-live="polite" aria-atomic="true">
          <span className="text-danger">{error ?? (name.trim() ? "" : "Name is required.")}</span>
        </p>
        <button onClick={close} className="text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 max-sm:min-h-11 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || saving}
          aria-describedby={name.trim() ? undefined : `${tabsId}-status`}
          className="text-sm bg-button-primary text-on-primary px-4 py-1.5 max-sm:min-h-11 rounded hover:bg-button-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>}
    </ModalWrapper>
  );
}

/**
 * The Stage tab body (#2278). Lanes and fields come from the caller, else the
 * board context. With neither it renders a can't-load state and no Save:
 * Save stage replaces every lane exception it sends, so a panel seeded from
 * an empty list would wipe them (frontend/CLAUDE.md § Gated stages and tracks).
 */
function StageTab({ boardId, column, swimlanes, definitions, cards, footerTarget, onSaved, onCancel }: {
  boardId: number;
  column: Column;
  swimlanes?: Swimlane[];
  definitions?: CustomFieldDefinition[];
  cards?: Pick<Card, "column" | "gates_passed">[];
  footerTarget: HTMLElement | null;
  onSaved: (c: Column & { remapped?: StageRemap[] }) => void;
  onCancel: () => void;
}) {
  const board = useOptionalBoardContext()?.board;
  const lanes = swimlanes ?? board?.swimlanes;
  const defs = definitions ?? board?.custom_field_definitions;
  const stageCards = cards ?? board?.cards;
  if (!lanes || !defs) {
    return (
      <>
        <p role="alert" data-testid="stage-settings-unavailable" className="text-sm text-fg-secondary">
          Stage settings can't load this board's swimlanes and fields here, so they can't be edited. Close this dialog, reload the board and try again.
        </p>
        {footerTarget && createPortal(
          <div className="flex flex-1 justify-end">
            <button type="button" onClick={onCancel} className="text-sm px-3 py-1.5 max-sm:min-h-11 rounded text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Close</button>
          </div>,
          footerTarget,
        )}
      </>
    );
  }
  return (
    <StageSettingsPanel
      boardId={boardId}
      column={column}
      swimlanes={lanes}
      definitions={defs}
      cards={stageCards}
      footerTarget={footerTarget}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}
