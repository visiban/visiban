import { useEffect, useRef, useState } from "react";
import type { BoardMembership } from "../../types";
import { userDisplayName } from "../../types";

interface Props {
  value: string;
  onChange: (val: string) => void;
  members: BoardMembership[];
  placeholder?: string;
  rows?: number;
  className?: string;
}

interface MentionState {
  active: boolean;
  query: string;
  startIndex: number; // index of the '@' in value
}

export default function MentionTextarea({ value, onChange, members, placeholder, rows = 2, className }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<MentionState>({ active: false, query: "", startIndex: -1 });
  const [selectedIndex, setSelectedIndex] = useState(0);

  const suggestions = mention.active
    ? members
        .map((m) => m.user)
        .filter((u) => {
          const q = mention.query.toLowerCase();
          return u.username.toLowerCase().startsWith(q) || userDisplayName(u).toLowerCase().startsWith(q);
        })
        .slice(0, 6)
    : [];

  // Reset selection when suggestions change
  useEffect(() => {
    setSelectedIndex(0);
  }, [mention.query]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value;
    const cursor = e.target.selectionStart ?? newVal.length;

    // Find the @-word before the cursor
    const textBeforeCursor = newVal.slice(0, cursor);
    const match = textBeforeCursor.match(/@([\w.]*)$/);

    if (match) {
      setMention({ active: true, query: match[1], startIndex: cursor - match[0].length });
    } else {
      setMention({ active: false, query: "", startIndex: -1 });
    }

    onChange(newVal);
  };

  const insertMention = (username: string) => {
    const before = value.slice(0, mention.startIndex);
    const after = value.slice(mention.startIndex + 1 + mention.query.length);
    const newVal = `${before}@${username} ${after}`;
    onChange(newVal);
    setMention({ active: false, query: "", startIndex: -1 });

    // Restore focus and move cursor after the inserted mention
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = before.length + username.length + 2; // '@' + username + ' '
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(pos, pos);
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mention.active || suggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insertMention(suggestions[selectedIndex].username);
    } else if (e.key === "Escape") {
      setMention({ active: false, query: "", startIndex: -1 });
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={rows}
        className={className}
      />
      {mention.active && suggestions.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-50 bottom-full mb-1 left-0 w-56 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden"
        >
          {suggestions.map((u, i) => (
            <button
              key={u.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); insertMention(u.username); }}
              className={`w-full text-left px-3 py-2 text-sm flex flex-col hover:bg-blue-50 transition ${
                i === selectedIndex ? "bg-blue-50" : ""
              }`}
            >
              <span className="font-medium text-gray-800">@{u.username}</span>
              {userDisplayName(u) !== u.username && (
                <span className="text-xs text-gray-400">{userDisplayName(u)}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
