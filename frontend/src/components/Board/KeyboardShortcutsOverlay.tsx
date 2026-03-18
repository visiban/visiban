import { useEscapeStack } from "../../hooks/useEscapeStack";

interface Props {
  onClose: () => void;
}

const SHORTCUTS = [
  { key: "f", description: "Toggle filter bar" },
  { key: "/", description: "Open filters and focus search" },
  { key: "?", description: "Show this help" },
  { key: "Esc", description: "Close card or dialog; go back when nothing is open" },
];

export default function KeyboardShortcutsOverlay({ onClose }: Props) {
  useEscapeStack(onClose, 40);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-slate-800 rounded-xl shadow-2xl w-72 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">Keyboard shortcuts</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition text-lg leading-none">×</button>
        </div>
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
      </div>
    </div>
  );
}
