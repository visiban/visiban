import ModalWrapper from "../shared/ModalWrapper";

interface Props {
  onClose: () => void;
}

const SHORTCUTS = [
  { key: "f", description: "Toggle filter bar" },
  { key: "/", description: "Open filters and focus search" },
  { key: "?", description: "Show this help" },
  { key: "Esc", description: "Close card or dialog; go back when nothing is open" },
  { key: "Space + drag", description: "Pan the board" },
];

export default function KeyboardShortcutsOverlay({ onClose }: Props) {
  return (
    <ModalWrapper open={true} onClose={onClose} title="Keyboard shortcuts" maxWidth="max-w-sm">
      <table className="w-full text-sm">
        <tbody className="divide-y divide-slate-700">
          {SHORTCUTS.map(({ key, description }) => (
            <tr key={key}>
              <td className="py-2 pr-4 w-12">
                <kbd className="inline-block bg-slate-700 text-slate-200 text-xs font-mono px-1.5 py-0.5 rounded border border-slate-600">
                  {key}
                </kbd>
              </td>
              <td className="py-2 text-slate-300">{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ModalWrapper>
  );
}
