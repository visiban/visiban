import { useState } from "react";
import ModalWrapper from "../shared/ModalWrapper";
import { exportBoardCsv, exportBoardJson } from "../../api/boards";

interface Props {
  boardId: number;
  onClose: () => void;
}

/**
 * Standalone export modal available to all board roles (viewer, collaborator,
 * member, admin). Admins can also reach export via BoardSettingsModal → Data tab.
 */
export default function BoardExportModal({ boardId, onClose }: Props) {
  const [exportFormat, setExportFormat] = useState<"json" | "csv">("json");
  const [status, setStatus] = useState<{ text: string; type: "success" | "error" } | null>(null);

  function handleExport() {
    try {
      if (exportFormat === "json") {
        exportBoardJson(boardId);
      } else {
        exportBoardCsv(boardId);
      }
      setStatus({ text: "Download started", type: "success" });
      setTimeout(() => setStatus(null), 3000);
    } catch {
      setStatus({ text: "Export failed — please try again", type: "error" });
    }
  }

  return (
    <ModalWrapper
      open
      onClose={onClose}
      title="Export Board"
      maxWidth="max-w-sm"
      labelId="export-board-title"
    >
      <div className="flex flex-col gap-4">
        <fieldset>
          <legend className="sr-only">Export format</legend>
          <div className="flex flex-col gap-2">
            {(["json", "csv"] as const).map((fmt) => (
              <label
                key={fmt}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-blue-500 ${
                  exportFormat === fmt
                    ? "border-blue-500 bg-info/10"
                    : "border-line-strong hover:bg-surface-hover/40"
                }`}
              >
                <input
                  type="radio"
                  name="export-format"
                  value={fmt}
                  checked={exportFormat === fmt}
                  onChange={() => setExportFormat(fmt)}
                  className="sr-only"
                />
                <div>
                  <span className="text-sm text-fg font-medium">{fmt.toUpperCase()}</span>
                  <p className="text-xs text-fg-muted mt-0.5">
                    {fmt === "json"
                      ? "Full history: movements, activity log, and assignees"
                      : "Card data only, no history"}
                  </p>
                </div>
              </label>
            ))}
          </div>
        </fieldset>

        <button
          onClick={handleExport}
          className="w-full bg-blue-600 hover:bg-blue-700 text-fg text-sm font-medium py-2 px-4 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Export {exportFormat.toUpperCase()}
        </button>

        <p className="text-xs h-4">
          {status && (
            <span className={status.type === "success" ? "text-success" : "text-danger"}>
              {status.text}
            </span>
          )}
        </p>
      </div>
    </ModalWrapper>
  );
}
