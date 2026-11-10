import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { listGroups } from "../../api/groups";
import { moveBoardToGroup } from "../../api/boards";
import { buildGroupTree } from "../Group/GroupTree";
import type { Board, Group } from "../../types";
import ModalWrapper from "../shared/ModalWrapper";

interface TreeNode {
  group: Group;
  children: TreeNode[];
}

// Placing a board in a group needs group admin there or on an ancestor; the
// server reports that per group as `can_place_boards` (#1692). Groups the
// caller cannot place into stay in the tree (their subgroups may be
// placeable, and the tree is the navigation) but are blocked with a reason
// (frontend/CLAUDE.md, "Blocked rows in pickers"). The board's current group
// stays selectable even then: choosing it again is "leave the board where it
// is", which sends no request.
const NOT_PLACEABLE_REASON = "Group admins only";
const CURRENT_GROUP_NOTE = "Current group";

/** True when a descendant of `node` (not `node` itself) is placeable or is `selected`. */
function hasTargetBelow(node: TreeNode, selected: number | null): boolean {
  return node.children.some(
    (child) => child.group.can_place_boards || child.group.id === selected || hasTargetBelow(child, selected),
  );
}

interface Props {
  board: Board;
  onMoved: (updated: Board) => void;
  onClose: () => void;
}

export default function MoveBoardModal({ board, onMoved, onClose }: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<number | null>(board.group);
  const [loadError, setLoadError] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const moveButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setLoadError(false);
    listGroups()
      .then(setGroups)
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  const handleMove = async () => {
    if (selected === board.group) { onClose(); return; }
    setSaving(true);
    setMoveError(null);
    try {
      const updated = await moveBoardToGroup(board.id, selected);
      onMoved(updated);
      onClose();
    } catch (err) {
      // Keep the modal open so the user can pick another group. Only a
      // refusal (403/404) for a group target gets the group-specific copy;
      // anything else (network, server, personal move) is a generic failure.
      const code = axios.isAxiosError(err) ? err.response?.status : undefined;
      const refused = selected !== null && (code === 403 || code === 404);
      setMoveError(
        refused
          ? "Could not move this board to that group. Choose another group, or ask a group admin."
          : "Could not move this board. Try again.",
      );
      // The button is disabled while saving, which drops focus to body;
      // restore it once re-enabled so the failure does not strand keyboard users.
      setTimeout(() => moveButtonRef.current?.focus(), 0);
    } finally {
      setSaving(false);
    }
  };

  const roots = buildGroupTree(groups);
  const hasChanged = selected !== board.group;

  return (
    <ModalWrapper open={true} onClose={onClose} title="Move board" maxWidth="max-w-sm">
      <p className="text-sm text-fg-tertiary mb-4">
        Moving <span className="font-medium text-fg">"{board.name}"</span> to:
      </p>

      {loading ? (
        <p className="text-sm text-fg-muted py-4 text-center">Loading groups…</p>
      ) : loadError ? (
        <p className="text-sm text-danger py-4 text-center">Could not load groups. Please try again.</p>
      ) : (
        <div className="flex flex-col max-h-72 overflow-y-auto -mx-2 px-2">
          <PickerRow
            label="Personal (no group)"
            icon={"\u{1F3E0}"}
            selected={selected === null}
            onSelect={() => { setSelected(null); setMoveError(null); }}
          />

          {roots.length > 0 && <div className="my-1 h-px bg-surface-hover" />}

          {roots.map((node) => (
            <GroupPickerNode
              key={node.group.id}
              node={node}
              selected={selected}
              currentGroupId={board.group}
              onSelect={(id) => { setSelected(id); setMoveError(null); }}
            />
          ))}

          {groups.length === 0 && (
            <p className="text-sm text-fg-muted px-3 py-2">No groups available.</p>
          )}
          {groups.length > 0 && !groups.some((g) => g.can_place_boards) && (
            <p className="text-xs text-fg-tertiary px-3 py-2">
              You can only place boards in groups where you are an admin.
            </p>
          )}
        </div>
      )}

      <p role="alert" aria-live="assertive" aria-atomic="true" className="text-xs text-danger mt-3 min-h-4">
        {moveError}
      </p>

      <div className="flex justify-end gap-3 mt-5">
        <button
          onClick={onClose}
          className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Cancel
        </button>
        <button
          ref={moveButtonRef}
          onClick={handleMove}
          disabled={!hasChanged || saving}
          className="text-sm bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
        >
          {saving ? "Moving…" : "Move"}
        </button>
      </div>
    </ModalWrapper>
  );
}

function GroupPickerNode({
  node, selected, currentGroupId, onSelect, depth = 0,
}: {
  node: TreeNode;
  selected: number | null;
  currentGroupId: number | null;
  onSelect: (id: number | null) => void;
  depth?: number;
}) {
  const hasChildren = node.children.length > 0;
  // Start open when something choosable (or the current choice) is below, so a
  // placeable subgroup is never hidden behind a collapsed blocked parent.
  const [expanded, setExpanded] = useState(() => hasTargetBelow(node, selected));
  const { group } = node;
  const isCurrent = group.id === currentGroupId;
  const note = group.can_place_boards ? undefined : isCurrent ? CURRENT_GROUP_NOTE : NOT_PLACEABLE_REASON;

  return (
    <div>
      <div className="flex items-center gap-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name}`}
            aria-expanded={expanded}
            className={`shrink-0 w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-fg-secondary transition-transform duration-150 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${expanded ? "rotate-90" : ""}`}
          >
            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}

        <PickerRow
          label={group.name}
          icon={"\u{1F465}"}
          selected={selected === group.id}
          onSelect={() => onSelect(group.id)}
          blocked={!group.can_place_boards && !isCurrent}
          note={note}
          noteId={`move-board-group-note-${group.id}`}
        />
      </div>

      {hasChildren && expanded && (
        <div className="relative ml-[22px]">
          <div className="absolute left-0 top-0 bottom-0 w-px bg-surface-active" />
          {node.children.map((child, i) => {
            const isLast = i === node.children.length - 1;
            return (
              <div key={child.group.id} className="relative pl-3">
                <div className="absolute left-0 top-[50%] w-3 h-px bg-surface-active -translate-y-px" />
                {isLast && (
                  <div className="absolute left-[-1px] w-px bg-surface" style={{ top: "50%", bottom: 0 }} />
                )}
                <GroupPickerNode
                  node={child}
                  selected={selected}
                  currentGroupId={currentGroupId}
                  onSelect={onSelect}
                  depth={depth + 1}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PickerRow({
  label, icon, selected, onSelect, blocked = false, note, noteId,
}: {
  label: string;
  icon: string;
  selected: boolean;
  onSelect: () => void;
  /** The caller may not choose this row: aria-disabled (stays focusable), no click. */
  blocked?: boolean;
  /** Inline note (the block reason, or "Current group"), tied to the row by aria-describedby. */
  note?: string;
  noteId?: string;
}) {
  return (
    <button
      type="button"
      onClick={blocked ? undefined : onSelect}
      aria-pressed={selected}
      aria-disabled={blocked || undefined}
      aria-describedby={note ? noteId : undefined}
      className={`flex items-center gap-2 flex-1 min-w-0 px-3 py-2 rounded text-left transition text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
        blocked
          ? "cursor-not-allowed text-fg-muted"
          : selected ? "bg-primary-emphasis/20 text-info-on-tint" : "hover:bg-surface-hover text-fg-secondary"
      }`}
    >
      <span className={`shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center transition ${
        selected ? "border-primary-soft" : "border-line-strong"
      }`}>
        {selected && <span className="w-1.5 h-1.5 rounded-full bg-primary-soft" />}
      </span>
      <span>{icon}</span>
      <span className="flex-1 truncate font-medium" title={label}>{label}</span>
      {note && (
        <span id={noteId} className="shrink-0 text-xs text-fg-tertiary">
          {note}
        </span>
      )}
    </button>
  );
}
