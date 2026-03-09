interface Props {
  onClose: () => void;
}

const SHORTCUTS = [
  { key: "f", description: "Toggle filter bar" },
  { key: "/", description: "Open filters and focus search" },
  { key: "?", description: "Show this help" },
  { key: "Esc", description: "Deselect cards / close dialogs" },
];

export default function KeyboardShortcutsOverlay({ onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-white rounded-xl shadow-2xl w-72 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-800">Keyboard shortcuts</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-50">
            {SHORTCUTS.map(({ key, description }) => (
              <tr key={key}>
                <td className="py-2 pr-4 w-12">
                  <kbd className="inline-block bg-gray-100 text-gray-700 text-xs font-mono px-1.5 py-0.5 rounded border border-gray-200">
                    {key}
                  </kbd>
                </td>
                <td className="py-2 text-gray-600">{description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
