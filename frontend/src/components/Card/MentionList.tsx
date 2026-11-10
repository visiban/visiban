import { forwardRef, useEffect, useId, useImperativeHandle, useState } from "react";
import { isImeComposing } from "../../utils/imeComposition";
import type { BoardUser } from "../../types";
import { userDisplayName } from "../../types";

interface Props {
  items: BoardUser[];
  command: (attrs: { id: string; label: string }) => void;
  /**
   * Reports the rendered listbox id and the active option id (null when no
   * list is rendered) so the host can wire the combobox half of the ARIA
   * pattern onto the editor element it owns (#2149).
   */
  onActiveChange?: (state: { listboxId: string; activeId: string } | null) => void;
}

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

const MentionList = forwardRef<MentionListRef, Props>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Unique per instance so ids never collide (#2137).
  const baseId = useId();

  useEffect(() => {
    setSelectedIndex(0);
  }, [props.items]);

  const { onActiveChange } = props;
  const hasItems = props.items.length > 0;
  const activeIndex = hasItems ? Math.min(selectedIndex, props.items.length - 1) : -1;
  useEffect(() => {
    onActiveChange?.(
      activeIndex >= 0
        ? { listboxId: `${baseId}-listbox`, activeId: `${baseId}-option-${activeIndex}` }
        : null,
    );
  }, [onActiveChange, activeIndex, baseId]);

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
      if (event.key === "Enter" && !isImeComposing(event)) {
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
    <div
      id={`${baseId}-listbox`}
      role="listbox"
      aria-label="Mention suggestions"
      // Keep focus in the editor when the pointer lands on padding or the
      // scrollbar: a blur would end the suggestion (#2149).
      onMouseDown={(e) => e.preventDefault()}
      className="bg-surface border border-line-strong rounded-lg shadow-xl py-1 min-w-40 max-w-64">
      {props.items.map((u, i) => (
        <div
          key={u.username}
          id={`${baseId}-option-${i}`}
          role="option"
          aria-selected={i === selectedIndex}
          onMouseDown={(e) => {
            e.preventDefault();
            props.command({ id: u.username, label: userDisplayName(u) });
          }}
          className={`w-full text-left px-3 py-1.5 text-sm cursor-pointer transition ${
            i === selectedIndex
              ? "bg-surface-hover text-fg"
              : "text-fg-secondary hover:bg-surface-hover hover:text-fg"
          }`}
        >
          <span className="font-medium">@{u.username}</span>
          {userDisplayName(u) !== u.username && (
            <span className="text-fg-muted ml-2 text-xs">{userDisplayName(u)}</span>
          )}
        </div>
      ))}
    </div>
  );
});

MentionList.displayName = "MentionList";

export default MentionList;
