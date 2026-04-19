import ModalWrapper from "../shared/ModalWrapper";

interface Props {
  onClose: () => void;
  onRestartTour?: () => void;
}

const SHORTCUTS = [
  { key: "f", description: "Toggle filter bar" },
  { key: "c", description: "Collapse / expand hovered swimlane" },
  { key: "/", description: "Open filters and focus search" },
  { key: "Tab", description: "Move between filter chips; Delete or Backspace to remove" },
  { key: "?", description: "Show this help" },
  { key: "Esc", description: "Close card or dialog; go back when nothing is open" },
  { key: "Space + drag", description: "Pan the board" },
];

export default function KeyboardShortcutsOverlay({ onClose, onRestartTour }: Props) {
  return (
    <ModalWrapper open={true} onClose={onClose} title="Keyboard shortcuts" maxWidth="max-w-sm">
      <table className="w-full text-sm">
        <tbody className="divide-y divide-line">
          {SHORTCUTS.map(({ key, description }) => (
            <tr key={key}>
              <td className="py-2 pr-4 w-12">
                <kbd className="inline-block bg-surface-hover text-fg text-xs font-mono px-1.5 py-0.5 rounded border border-line-strong">
                  {key}
                </kbd>
              </td>
              <td className="py-2 text-fg-secondary">{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {onRestartTour && (
        <>
          <div className="my-3">
            <div className="h-px bg-line" />
          </div>
          <button
            onClick={() => { onRestartTour(); onClose(); }}
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
