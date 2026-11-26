import { useEffect, useId, useState } from "react";
import { getColumns } from "../../api/boards";
import { setNeeded } from "../../api/cards";
import type { Card } from "../../types";
import SelectDropdown from "../Common/SelectDropdown";

type NeededFields = Pick<Card, "needed_at_column" | "planned" | "planned_released_at">;

interface Props {
  card: Card;
  /** The child's own board, where `POST .../needed/` is called. */
  boardId: number;
  /** The child board's first column: planning is only allowed while the card waits there. */
  firstColumnId: number | null | undefined;
  canEdit: boolean;
  onChanged: (fields: NeededFields) => void;
}

/**
 * Change Needed on an existing child (#2549, #2371 § 1). Shown on a child that is planned or waits in its board's
 * first column; a child already in progress is plain work, so there is nothing to change.
 *
 * The column options are the PARENT board's columns after the parent's own, read from that board only when the
 * viewer can open the parent. A viewer who can't open it sees "Planned for a later stage" and may only choose Now
 * (the column names would reveal the parent board, Rule 19); the server enforces the same and records every change
 * in the card's history.
 */
export default function CardNeededField({ card, boardId, firstColumnId, canEdit, onChanged }: Props) {
  const uid = useId();
  const id = `${uid}-needed`;
  const helpId = `${uid}-needed-help`;
  const parent = card.parent ?? null;
  const visibleParent = parent && !parent.hidden ? parent : null;
  const inFirst = firstColumnId != null && card.column === firstColumnId;
  const show = parent != null && (card.planned === true || inFirst);
  const [later, setLater] = useState<{ id: number; name: string }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentBoardId = visibleParent?.board_id ?? null;
  const parentColumnId = visibleParent?.column_id ?? null;
  useEffect(() => {
    if (!show || !canEdit || parentBoardId == null || !inFirst) return;
    let live = true;
    getColumns(parentBoardId)
      .then((cols) => {
        if (!live) return;
        const sorted = [...cols].sort((a, c) => a.position - c.position);
        const at = sorted.findIndex((c) => c.id === parentColumnId);
        setLater(at < 0 ? [] : sorted.slice(at + 1).map((c) => ({ id: c.id, name: c.name })));
      })
      // No columns to offer: the select still offers Now, which needs no parent read.
      .catch(() => { if (live) setLater([]); });
    return () => { live = false; };
  }, [show, canEdit, parentBoardId, parentColumnId, inFirst]);

  if (!show) return null;

  const current = card.planned && card.needed_at_column != null ? String(card.needed_at_column) : card.planned ? "planned" : "now";
  const options = [{ value: "now", label: "Now" }];
  if (card.planned && card.needed_at_column == null) options.push({ value: "planned", label: "Planned for a later stage" });
  const columns = later ?? (card.planned && card.needed_at_column != null && card.needed_at_column_name
    ? [{ id: card.needed_at_column, name: card.needed_at_column_name }]
    : []);
  for (const c of columns) options.push({ value: String(c.id), label: `When the parent reaches ${c.name}` });
  if (card.planned && card.needed_at_column != null && !columns.some((c) => String(c.id) === current)) {
    options.push({ value: current, label: `When the parent reaches ${card.needed_at_column_name ?? "a later column"}` });
  }

  const change = async (value: string) => {
    // Re-entry is ignored instead of disabling the trigger: a disabled button drops the focus that
    // SelectDropdown just returned to it (ux-review, #2549).
    if (saving || value === current || value === "planned") return;
    setSaving(true);
    setError(null);
    try {
      const fields = await setNeeded(boardId, card.id, value === "now" ? null : Number(value));
      onChanged(fields);
    } catch {
      setError("Couldn't change Needed. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-fact-section="needed" data-testid="card-needed-field" className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Needed</label>
      <SelectDropdown
        id={id}
        phoneSheet
        value={current}
        onChange={(v) => { void change(v); }}
        options={options}
        disabled={!canEdit}
        disabledReason={!canEdit ? "Changing Needed requires Member access" : undefined}
        ariaDescribedBy={helpId}
        className="w-full"
      />
      <p id={helpId} className="text-xs text-fg-tertiary">
        {visibleParent
          ? `Options: Now, then each later column on ${visibleParent.board_name}.`
          : "The parent is on a board you can't open, so Needed can only be set to Now."}
      </p>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}
