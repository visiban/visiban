import { Toggle, ToggleField } from "../../Common/Toggle";
import type { TrelloImportMapping, TrelloImportPreview } from "../../../types";
import {
  DEFAULT_SWIMLANE_NAME,
  defaultSwimlaneCollides,
  deriveTotals,
  plural,
  unmappableLine,
  visibleWarnings,
} from "./trelloImportCopy";

interface Props {
  preview: TrelloImportPreview;
  config: TrelloImportMapping;
  onConfigChange: (next: TrelloImportMapping) => void;
  boardName: string;
  onBoardNameChange: (name: string) => void;
  groupName?: string;
}

const sectionHeading = "text-sm font-medium text-fg-tertiary uppercase tracking-wide";
const fieldLabel = "block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5";
const textInput =
  "w-full bg-surface border border-line focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent text-fg-secondary rounded px-3 py-1.5 text-sm placeholder-fg-muted transition";

function Separator() {
  return (
    <div role="separator" aria-hidden="true">
      <div className="h-px bg-sunken" />
      <div className="h-px bg-surface-active/50" />
    </div>
  );
}

function Tile({ value, one, many }: { value: number; one: string; many: string }) {
  return (
    <div className="bg-sunken border border-line rounded-lg px-3 py-2">
      <p className={`font-mono text-lg ${value === 0 ? "text-fg-muted" : "text-fg-secondary"}`}>
        {value}
      </p>
      <p className="text-xs text-fg-muted">{value === 1 ? one : many}</p>
    </div>
  );
}

export default function TrelloReviewStep({
  preview,
  config,
  onConfigChange,
  boardName,
  onBoardNameChange,
  groupName,
}: Props) {
  const set = (patch: Partial<TrelloImportMapping>) => onConfigChange({ ...config, ...patch });
  const totals = deriveTotals(preview, config);
  const warnings = visibleWarnings(preview, config);
  const { labels, columns } = preview.mapping;
  const { members, counts } = preview;
  const selected = new Set(config.swimlane_label_ids);
  const collides = defaultSwimlaneCollides(preview, config);
  const nameEmpty = !boardName.trim();

  const toggleLabel = (id: string, on: boolean) => {
    // Keep selection in the order the user picks, which is the swimlane order.
    const ids = config.swimlane_label_ids.filter((x) => x !== id);
    set({ swimlane_label_ids: on ? [...ids, id] : ids });
  };

  return (
    <>
      {/* a) Board name */}
      <div>
        <label htmlFor="trello-board-name" className={fieldLabel}>
          Board name
        </label>
        <input
          id="trello-board-name"
          value={boardName}
          maxLength={255}
          onChange={(e) => onBoardNameChange(e.target.value)}
          aria-describedby="trello-board-name-help"
          aria-invalid={nameEmpty}
          className={textInput}
        />
        <p id="trello-board-name-help" className={`text-xs min-h-4 mt-1 ${nameEmpty ? "text-danger" : "text-fg-muted"}`}>
          {nameEmpty
            ? "Enter a board name."
            : groupName
              ? `This board will be created in ${groupName}.`
              : "This board will be created in your personal boards."}
        </p>
      </div>

      {/* b) Warnings and unmappable data */}
      {(warnings.length > 0 || preview.unmappable.length > 0) && (
        <div
          role="group"
          aria-labelledby="trello-warnings-title"
          className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 flex gap-2.5"
        >
          <span aria-hidden="true" className="text-base leading-none shrink-0 text-warning-on-tint">⚠</span>
          <div className="min-w-0">
            <p id="trello-warnings-title" className="text-sm font-medium text-warning-on-tint">
              Some Trello data can't be imported
            </p>
            <ul className="text-xs text-fg-secondary space-y-1 mt-1.5 list-disc pl-4">
              {warnings.map((w, i) => (
                <li key={`${w.code}-${i}`}>
                  {w.message}
                  {w.count > 1 ? ` (${w.count})` : ""}
                </li>
              ))}
              {preview.unmappable.map((u, i) => (
                <li key={`${u.kind}-${i}`}>{unmappableLine(u.kind, u.count)}</li>
              ))}
            </ul>
            <p className="text-xs text-fg-muted mt-1.5">Everything else will import normally.</p>
          </div>
        </div>
      )}

      {/* c) Summary tiles */}
      <div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Tile value={totals.columns} one="Column" many="Columns" />
          <Tile value={totals.cards} one="Card" many="Cards" />
          <Tile value={counts.labels} one="Label" many="Labels" />
          <Tile value={counts.members} one="Member" many="Members" />
          <Tile value={counts.checklists} one="Checklist" many="Checklists" />
          <Tile value={counts.checklist_items} one="Checklist item" many="Checklist items" />
          <Tile value={counts.comments} one="Comment" many="Comments" />
          <Tile value={counts.attachments} one="Attachment" many="Attachments" />
        </div>
        {counts.cards_archived > 0 && (
          <p className="text-xs text-fg-muted mt-2">
            {plural(counts.cards_archived, "archived card", "archived cards")} will be imported as archived.
          </p>
        )}
      </div>

      <Separator />

      {/* d) Columns */}
      <section aria-labelledby="trello-columns-title" className="space-y-3">
        <div>
          <h4 id="trello-columns-title" className={sectionHeading}>Columns</h4>
          <p className="text-xs text-fg-muted mt-1">Each Trello list becomes a column, in the same order.</p>
        </div>
        {counts.lists_archived > 0 && (
          <ToggleField
            checked={config.include_archived_lists}
            onChange={(v) => set({ include_archived_lists: v })}
            label="Include archived lists"
            description="Archived Trello lists are skipped by default. Turn this on to import them as columns; their cards are imported as archived."
          />
        )}
        {columns.length === 0 ? (
          <p className="text-xs text-fg-muted italic">This export has no lists.</p>
        ) : (
          <div
            className="rounded-lg border border-line overflow-x-auto overflow-y-auto max-h-56 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis"
            tabIndex={0}
            role="group"
            aria-label="Trello lists"
          >
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface text-fg-tertiary text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium">Trello list</th>
                  <th className="text-right px-4 py-2.5 font-medium">Cards</th>
                  <th className="text-left px-4 py-2.5 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((c) => {
                  const skipped = c.archived && !config.include_archived_lists;
                  return (
                    <tr key={c.trello_id} className="border-t border-line-subtle">
                      <td className={`px-4 py-2.5 max-w-0 w-full ${c.archived ? "text-fg-muted" : "text-fg"}`}>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="truncate" title={c.name}>{c.name}</span>
                          {c.archived && (
                            <span className="px-2 py-0.5 text-xs rounded-full border border-line text-fg-tertiary shrink-0">
                              Archived
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-fg-secondary">
                        <span className={c.card_count === 0 ? "text-fg-muted" : undefined}>{c.card_count}</span>
                      </td>
                      <td className={`px-4 py-2.5 whitespace-nowrap ${skipped ? "text-fg-muted" : "text-fg-secondary"}`}>
                        {skipped ? "Skipped" : "Imported"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Separator />

      {/* e) Swimlanes */}
      <section aria-labelledby="trello-swimlanes-title" className="space-y-3">
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <h4 id="trello-swimlanes-title" className={sectionHeading}>Swimlanes</h4>
            {labels.length > 0 && (
              <span className="text-xs text-fg-muted shrink-0">
                {selected.size} of {labels.length} labels selected
              </span>
            )}
          </div>
          {labels.length > 0 && (
            <p className="text-xs text-fg-muted mt-1">
              Optional. Choose Trello labels to turn into swimlanes. A card goes to the swimlane of its first selected
              label. Other cards go to your default swimlane.
            </p>
          )}
        </div>
        {labels.length === 0 ? (
          <p className="text-xs text-fg-muted italic">
            No labels in this export. All cards will go to a single swimlane named “{config.default_swimlane_name.trim() || DEFAULT_SWIMLANE_NAME}”.
          </p>
        ) : (
          <>
            <ul
              className="rounded-lg border border-line divide-y divide-line max-h-56 overflow-y-auto focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis"
              tabIndex={0}
              aria-label="Trello labels"
            >
              {labels.map((l) => {
                const reasonId = `trello-label-reason-${l.trello_id}`;
                return (
                  <li key={l.trello_id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <span
                        className="inline-flex items-center max-w-full min-w-0 text-xs px-2 py-0.5 rounded-full border font-medium"
                        style={{ backgroundColor: `${l.color}22`, borderColor: `${l.color}44`, color: l.color }}
                        title={
                          l.original_color && l.original_color !== l.color ? `Trello color: ${l.original_color}` : l.name
                        }
                      >
                        <span className="truncate">{l.name}</span>
                      </span>
                      {!l.swimlane_eligible && (
                        <p id={reasonId} className="text-xs text-fg-muted mt-0.5">
                          Unnamed labels can't be swimlanes.
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-fg-muted shrink-0 ml-auto">
                      {plural(l.card_count, "card", "cards")}
                    </span>
                    <Toggle
                      checked={selected.has(l.trello_id)}
                      onChange={(v) => toggleLabel(l.trello_id, v)}
                      disabled={!l.swimlane_eligible}
                      aria-label={`Make swimlane: ${l.name}`}
                      aria-describedby={l.swimlane_eligible ? undefined : reasonId}
                    />
                  </li>
                );
              })}
            </ul>
            {selected.size > 0 && (
              <div className="ml-6 border-l-2 border-line pl-4">
                <label htmlFor="trello-default-swimlane" className={fieldLabel}>
                  Default swimlane name
                </label>
                <input
                  id="trello-default-swimlane"
                  value={config.default_swimlane_name}
                  maxLength={100}
                  placeholder={DEFAULT_SWIMLANE_NAME}
                  onChange={(e) => set({ default_swimlane_name: e.target.value })}
                  aria-describedby="trello-default-swimlane-help"
                  aria-invalid={collides}
                  className={textInput}
                />
                <p
                  id="trello-default-swimlane-help"
                  className={`text-xs min-h-4 mt-1 ${collides ? "text-danger" : "text-fg-muted"}`}
                >
                  {collides
                    ? "This name matches a label you turned into a swimlane. Choose a different name."
                    : "Cards without a selected label go here."}
                </p>
              </div>
            )}
          </>
        )}
      </section>

      <Separator />

      {/* f) Members */}
      <section aria-labelledby="trello-members-title" className="space-y-3">
        <h4 id="trello-members-title" className={sectionHeading}>Members</h4>
        {members.total === 0 ? (
          <p className="text-xs text-fg-muted italic">This export has no members.</p>
        ) : (
          <div role="group" aria-label="Member matching" className="rounded-lg border border-line px-4 py-3 space-y-3">
            <p className="text-sm text-fg-secondary">
              {members.total === 1
                ? members.matched === 1
                  ? "The Trello member matches an existing user."
                  : "The Trello member doesn't match an existing user."
                : `${members.matched} of ${members.total} Trello members match existing users.`}{" "}
              <span className="text-fg-muted">Only people you can already see are checked.</span>
            </p>
            {members.unmatched.length > 0 && (
              <div>
                <p className="text-xs text-fg-muted mb-1">Not matched ({members.unmatched.length})</p>
                <ul
                  className="max-h-32 overflow-y-auto divide-y divide-line rounded border border-line focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis"
                  tabIndex={0}
                  aria-label="Unmatched Trello members"
                >
                  {members.unmatched.map((m) => (
                    <li key={m.trello_id} className="px-3 py-1.5 text-sm text-fg-secondary truncate" title={m.full_name}>
                      {m.full_name}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-fg-muted mt-1">
                  These people can't be linked to a Visiban user, so their cards import without them as assignee.
                </p>
              </div>
            )}
            {members.matched > 0 ? (
              <ToggleField
                checked={config.add_matched_members}
                onChange={(v) => set({ add_matched_members: v })}
                label="Add matched members to this board"
                description={
                  config.add_matched_members
                    ? "Matched users become board members and are assigned to their cards. Their comments keep them as author, marked “(imported from Trello)”; comments by people who aren't matched are attributed to you."
                    : "With this off, cards import without assignees and all comments are attributed to you with “(imported from Trello)”."
                }
              />
            ) : (
              <p className="text-xs text-fg-muted">
                No members matched. Cards will import without assignees, and comments will be attributed to you with
                “(imported from Trello)”.
              </p>
            )}
          </div>
        )}
      </section>
    </>
  );
}
