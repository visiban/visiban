import { useEffect, useId, useRef, useState } from "react";
import { updateColumn } from "../../api/boards";
import type { Column } from "../../types";
import { COLUMN_COLORS } from "../../constants/colors";
import ColorSwatchPicker from "../Common/ColorSwatchPicker";
import ModalWrapper from "../shared/ModalWrapper";
import ColumnPolicyEditor from "./ColumnPolicyEditor";
import { useOverflowFade } from "../../hooks/useOverflowFade";
import { useColumnPolicyDraft } from "../../hooks/useColumnPolicyDraft";

export type EditColumnTab = "settings" | "policy";

interface Props {
  boardId: number;
  column: Column;
  cardCount: number;
  onUpdated: (column: Column) => void;
  onRequestDelete: (column: Column) => void;
  onClose: () => void;
  /** Open on this tab (#1101: "Add policy…" and the popover's "Edit policy"
   *  open on Policy). Unset opens on Settings. */
  initialTab?: EditColumnTab;
}

const TABS: { id: EditColumnTab; label: string }[] = [
  { id: "settings", label: "Settings" },
  { id: "policy", label: "Policy" },
];

export default function EditColumnModal({ boardId, column, cardCount, onUpdated, onRequestDelete, onClose, initialTab }: Props) {
  const [tab, setTab] = useState<EditColumnTab>(initialTab ?? "settings");
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
      onUpdated(updated);
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
      onClose={onClose}
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
            className={`px-3 py-2.5 font-medium whitespace-nowrap shrink-0 transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis rounded ${
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
          aria-label={tab === "settings" ? "Column settings" : "Column policy"}
          tabIndex={0}
          onScroll={onBodyScroll}
          className="flex-1 min-h-0 overflow-y-auto px-6 py-4 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis"
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
                  onKeyDown={(e) => { if (e.key === "Enter") void handleSave(); }} // handleSave manages its own saving/error state and never rejects
                  className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-fg-tertiary mb-1 block">WIP limit</label>
                  <input
                    value={wipLimit}
                    onChange={(e) => setWipLimit(e.target.value.replace(/\D/g, ""))}
                    placeholder="None"
                    className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                  />
                </div>
                <div>
                  <label className="text-xs text-fg-tertiary mb-1 block">Weight limit</label>
                  <input
                    value={weightLimit}
                    onChange={(e) => setWeightLimit(e.target.value.replace(/\D/g, ""))}
                    placeholder="None"
                    className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-fg-tertiary mb-1 block">Color</label>
                <ColorSwatchPicker colors={COLUMN_COLORS} value={color} onChange={setColor} allowCustom />
              </div>

              <label className="flex items-center gap-2 cursor-pointer select-none">
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
              </div>

              <div className="border-t border-line mt-3 pt-3">
                {/* Reserved status row — always rendered to prevent layout shift */}
                <p className="text-xs h-4 text-fg-tertiary">
                  {cardCount > 0 ? `Cannot delete — ${cardCount} card${cardCount === 1 ? '' : 's'} in this column` : ''}
                </p>
                <button
                  type="button"
                  onClick={() => { onClose(); onRequestDelete(column); }}
                  disabled={cardCount > 0}
                  className="w-full px-3 py-1.5 text-sm font-medium bg-danger-bg hover:bg-danger-bg-hover text-on-danger rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis disabled:opacity-40 disabled:cursor-not-allowed mt-2"
                >
                  Delete column
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-fg-muted">Every column's policy can also be edited together in Board settings → Rules.</p>
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
          </div>
        </div>
        {moreBelow && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface to-transparent" />
        )}
      </div>

      <div className="flex gap-3 px-6 py-4 border-t border-line items-center justify-end shrink-0">
        {/* Also says why Save is off, which matters on the Policy tab where
            the Name field is out of sight. */}
        <p id={`${tabsId}-status`} className="text-xs h-4 flex-1" role="status" aria-live="polite" aria-atomic="true">
          <span className="text-danger">{error ?? (name.trim() ? "" : "Name is required.")}</span>
        </p>
        <button onClick={onClose} className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || saving}
          aria-describedby={name.trim() ? undefined : `${tabsId}-status`}
          className="text-sm bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalWrapper>
  );
}
