import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { BoardUser } from "../../types";
import { userDisplayName } from "../../types";

interface Props {
  items: BoardUser[];
  command: (attrs: { id: string; label: string }) => void;
}

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

const MentionList = forwardRef<MentionListRef, Props>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [props.items]);

  useImperativeHandle(ref, () => ({
    onKeyDown({ event }) {
      if (event.key === "ArrowUp") {
        setSelectedIndex((i) => (i - 1 + props.items.length) % props.items.length);
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelectedIndex((i) => (i + 1) % props.items.length);
        return true;
      }
      if (event.key === "Enter") {
        const u = props.items[selectedIndex];
        if (u) {
          props.command({ id: u.username, label: userDisplayName(u) });
        }
        return true;
      }
      return false;
    },
  }));

  if (!props.items.length) {
    return null;
  }

  return (
    <div className="bg-surface border border-line-strong rounded-lg shadow-xl py-1 min-w-40 max-w-64">
      {props.items.map((u, i) => (
        <button
          key={u.username}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            props.command({ id: u.username, label: userDisplayName(u) });
          }}
          className={`w-full text-left px-3 py-1.5 text-sm transition ${
            i === selectedIndex
              ? "bg-surface-hover text-fg"
              : "text-fg-secondary hover:bg-surface-hover hover:text-fg"
          }`}
        >
          <span className="font-medium">@{u.username}</span>
          {userDisplayName(u) !== u.username && (
            <span className="text-fg-muted ml-2 text-xs">{userDisplayName(u)}</span>
          )}
        </button>
      ))}
    </div>
  );
});

MentionList.displayName = "MentionList";

export default MentionList;
