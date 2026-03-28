import { useRef, useState } from "react";
import ModalWrapper from "../shared/ModalWrapper";

interface Props {
  onImport: (file: File, name?: string) => Promise<void>;
  onCancel: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function detectFormat(file: File): "JSON" | "CSV" | "Unknown" {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) return "JSON";
  if (name.endsWith(".csv")) return "CSV";
  if (file.type.includes("json")) return "JSON";
  if (file.type.includes("csv")) return "CSV";
  return "Unknown";
}

export default function ImportBoardModal({ onImport, onCancel }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    setError(null);
  };

  const handleSubmit = async () => {
    if (!file || submitting) return;

    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      setError("File is too large. Maximum size is 10 MB.");
      return;
    }

    const format = detectFormat(file);
    if (format === "Unknown") {
      setError("Unsupported file format. Please upload a .json or .csv file.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onImport(file, name.trim() || undefined);
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        "Import failed. Please check your file and try again.";
      setError(detail);
    } finally {
      setSubmitting(false);
    }
  };

  const format = file ? detectFormat(file) : null;

  return (
    <ModalWrapper
      open={true}
      onClose={onCancel}
      title="Import Board"
      subtitle="Upload a Visiban JSON or CSV export to create a new board. JSON preserves full card history — movements, activity log, and assignees."
      maxWidth="max-w-md"
      noPadding
      labelId="import-board-title"
      headerBorder
    >
        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Size limit notice */}
          <div className="flex gap-2.5 bg-slate-700/50 border border-slate-600 rounded-lg px-3 py-2.5 text-xs text-slate-300">
            <span className="shrink-0 text-slate-400 mt-px">ℹ</span>
            <span>Imports are limited to <strong className="text-slate-200">500 cards</strong>, <strong className="text-slate-200">50 columns</strong>, and <strong className="text-slate-200">100 swimlanes</strong>. For larger boards, split into smaller boards before importing.</span>
          </div>

          {/* File input */}
          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">
              File
            </label>
            <div
              className="border border-dashed border-slate-600 rounded-xl p-4 text-center cursor-pointer hover:border-slate-400 transition"
              onClick={() => fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".json,.csv"
                onChange={handleFileChange}
                className="hidden"
              />
              {file ? (
                <div className="text-sm">
                  <p className="text-white font-medium truncate">{file.name}</p>
                  <p className="text-slate-400 text-xs mt-0.5">
                    {formatFileSize(file.size)} &middot; {format}
                  </p>
                </div>
              ) : (
                <p className="text-slate-500 text-sm">
                  Click to select a .json or .csv file
                </p>
              )}
            </div>
          </div>

          {/* Optional name override */}
          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">
              Board name <span className="text-slate-600 normal-case">(optional override)</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
                if (e.key === "Escape") onCancel();
              }}
              placeholder="Leave blank to use name from file"
              className="w-full bg-slate-800 border border-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-slate-300 rounded px-3 py-1.5 text-sm placeholder-slate-500 transition"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-700 flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            className="text-slate-400 text-sm hover:text-white px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!file || submitting}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-5 py-2 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {submitting ? "Importing..." : "Import"}
          </button>
        </div>
    </ModalWrapper>
  );
}
