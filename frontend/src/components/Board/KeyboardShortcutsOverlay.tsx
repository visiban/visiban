import ModalWrapper from "../shared/ModalWrapper";
import { formatShortcut } from "../../utils/platform";

interface Props {
  onClose: () => void;
  onRestartTour?: () => void;
}

interface ShortcutRow {
  key: string;
  description: string;
}

interface ShortcutSection {
  heading: string;
  rows: ShortcutRow[];
}

// Grouped into four sections per the #868 audit: Navigation (cross-route
// chords), Board view (view-tab bindings), Board actions (on-board tools),
// and Help (everything else). Imperative-tone descriptions start with a verb
// ("Search…", "Toggle…") so each row reads as a command, not a status line.
function buildSections(): ShortcutSection[] {
  return [
    {
      heading: "Navigation",
      rows: [
        { key: formatShortcut({ mod: true, key: "K" }), description: "Open command palette" },
        { key: "/", description: "Focus the search box" },
        { key: formatShortcut({ mod: true, key: "," }), description: "Open board settings" },
      ],
    },
    {
      heading: "Board view",
      rows: [
        { key: "B", description: "Switch to Board view" },
        { key: "S", description: "Switch to Summary view" },
        { key: "H", description: "Switch to History view" },
        { key: "A", description: "Switch to Analytics view" },
      ],
    },
    {
      heading: "Board actions",
      rows: [
        { key: "F", description: "Toggle the filter bar" },
        { key: "E", description: "Collapse or expand everything" },
        { key: "C", description: "Collapse the hovered swimlane" },
        { key: "Y", description: "Toggle the archived cards panel" },
        { key: formatShortcut({ mod: true, shift: true, key: "L" }), description: "Switch card layout (compact / expanded)" },
        { key: formatShortcut({ mod: true, key: "\\" }), description: "Toggle the activity drawer" },
        { key: formatShortcut({ mod: true, shift: true, key: "E" }), description: "Export the board" },
        { key: ".", description: "Open the overflow menu" },
        { key: "Space + drag", description: "Pan the board" },
        { key: "Tab", description: "Move between filter chips; Delete or Backspace to remove" },
      ],
    },
    {
      heading: "Help",
      rows: [
        { key: "?", description: "Show this help" },
        { key: "Esc", description: "Close card or dialog; go back when nothing is open" },
      ],
    },
  ];
}

export default function KeyboardShortcutsOverlay({ onClose, onRestartTour }: Props) {
  const sections = buildSections();
  return (
    <ModalWrapper open={true} onClose={onClose} title="Keyboard shortcuts" maxWidth="max-w-md">
      <div className="flex flex-col gap-4">
        {sections.map(({ heading, rows }) => (
          <section key={heading}>
            <h3 className="text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5">
              {heading}
            </h3>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line">
                {rows.map(({ key, description }) => (
                  <tr key={`${heading}-${key}`}>
                    <td className="py-2 pr-4 w-24">
                      <kbd className="inline-block bg-surface-hover text-fg text-xs font-mono px-1.5 py-0.5 rounded border border-line-strong">
                        {key}
                      </kbd>
                    </td>
                    <td className="py-2 text-fg-secondary">{description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
      {onRestartTour && (
        <>
          <div className="my-3">
            <div className="h-px bg-sunken" />
            <div className="h-px bg-surface-active/50" />
          </div>
          <button
            onClick={onRestartTour}
            className="flex items-center gap-2 text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover w-full px-2 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" strokeLinecap="round"/>
              <polyline points="8,1 8,4 11,4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Restart tour
          </button>
        </>
      )}
    </ModalWrapper>
  );
}
