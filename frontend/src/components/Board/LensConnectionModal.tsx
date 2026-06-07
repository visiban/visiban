import { useState } from "react";
import axios from "axios";
import ModalWrapper from "../shared/ModalWrapper";
import SelectDropdown from "../Common/SelectDropdown";
import { putLensConnection, deleteLensConnection } from "../../api/gitLens";
import type { LensConnection, LensProvider } from "../../types";

interface Props {
  boardId: number;
  /** Existing connection when editing; null when creating a new one. */
  connection: LensConnection | null;
  onSaved: (connection: LensConnection) => void;
  onRemoved: () => void;
  onClose: () => void;
}

const PROVIDER_OPTIONS: { value: LensProvider; label: string }[] = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
];

const COLUMN_DIM_OPTIONS = [
  { value: "pipeline", label: "Pipeline (workflow)" },
  { value: "status", label: "Status" },
  { value: "state", label: "State (open/closed)" },
];
const SWIMLANE_DIM_OPTIONS = [
  { value: "milestone", label: "Milestone" },
  { value: "assignee", label: "Assignee" },
  { value: "label", label: "Label" },
];

/**
 * Admin-only setup modal for the read-only issue board lens. Two required
 * fields (provider, repo slug) plus an optional "Advanced" disclosure for the
 * default pivot dimensions. Launched from Board Settings → Data.
 */
export default function LensConnectionModal({ boardId, connection, onSaved, onRemoved, onClose }: Props) {
  const [provider, setProvider] = useState<LensProvider>(connection?.provider ?? "github");
  const [repoSlug, setRepoSlug] = useState(connection?.repo_slug ?? "");
  const [columnDim, setColumnDim] = useState(connection?.column_dim ?? "status");
  const [swimlaneDim, setSwimlaneDim] = useState(connection?.swimlane_dim ?? "milestone");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Inline confirm step before removing — the lens is board-wide and removing it
  // hides the Lens tab for everyone, so it must be confirmed first.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedSlug = repoSlug.trim().replace(/^\/+|\/+$/g, "");
  // Client-side mirror of the backend slug check (owner/repo, no spaces).
  const slugValid = trimmedSlug.length > 0 && trimmedSlug.includes("/") && !trimmedSlug.includes(" ");

  const handleSubmit = async () => {
    if (!slugValid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await putLensConnection(boardId, {
        provider,
        repo_slug: trimmedSlug,
        column_dim: columnDim,
        swimlane_dim: swimlaneDim,
      });
      onSaved(saved);
    } catch (err) {
      // Surface the first field error the backend returned, falling back to a
      // generic message. Never assume a specific field is present.
      let message = "Could not save the lens connection.";
      if (axios.isAxiosError(err) && err.response?.data && typeof err.response.data === "object") {
        const body = err.response.data as Record<string, unknown>;
        const first = body.repo_slug ?? body.provider ?? body.detail ?? body.column_dim ?? body.swimlane_dim;
        if (Array.isArray(first) && typeof first[0] === "string") message = first[0];
        else if (typeof first === "string") message = first;
      }
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (removing) return;
    setRemoving(true);
    setError(null);
    try {
      await deleteLensConnection(boardId);
      onRemoved();
    } catch {
      setError("Could not remove the lens connection.");
      setRemoving(false);
      setConfirmingRemove(false);
    }
  };

  return (
    <ModalWrapper open onClose={onClose} title={connection ? "Edit issue lens" : "Connect an issue lens"} maxWidth="max-w-md">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="lens-provider" className="text-xs text-fg-muted">Provider</label>
          <SelectDropdown<LensProvider>
            id="lens-provider"
            value={provider}
            onChange={setProvider}
            options={PROVIDER_OPTIONS}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="lens-repo-slug" className="text-xs text-fg-muted">Repository</label>
          <input
            id="lens-repo-slug"
            type="text"
            value={repoSlug}
            onChange={(e) => setRepoSlug(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && slugValid) { e.preventDefault(); void handleSubmit(); } }}
            placeholder="owner/repo"
            autoFocus
            className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
          />
          <p className="text-xs text-fg-muted">Public repositories only.</p>
        </div>

        {/* Advanced disclosure — default pivot dimensions */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            className="text-xs text-fg-secondary hover:text-fg flex items-center gap-1 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            <span aria-hidden="true">{showAdvanced ? "▾" : "▸"}</span>
            Advanced: choose dimensions
          </button>
          {showAdvanced && (
            <div className="flex flex-col gap-3 mt-3 pl-1">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-fg-muted">Columns</label>
                <SelectDropdown value={columnDim} onChange={setColumnDim} options={COLUMN_DIM_OPTIONS} />
                <p className="text-xs text-fg-muted">
                  Pipeline groups issues by workflow stage (Backlog → Done) using linked
                  branches and merge requests. Recommended for tracking delivery progress.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-fg-muted">Swimlanes</label>
                <SelectDropdown value={swimlaneDim} onChange={setSwimlaneDim} options={SWIMLANE_DIM_OPTIONS} />
              </div>
            </div>
          )}
        </div>

        {/* Reserve vertical space unconditionally so the footer doesn't jump. */}
        <p className="text-xs h-4">
          {error && <span className="text-danger">{error}</span>}
        </p>

        <div className="flex items-center justify-end gap-3">
          {connection && !confirmingRemove && (
            <button
              type="button"
              onClick={() => setConfirmingRemove(true)}
              className="mr-auto bg-danger-bg hover:bg-danger-bg-hover text-on-danger px-3 py-1.5 text-sm rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Remove lens
            </button>
          )}
          {connection && confirmingRemove && (
            <div className="mr-auto flex items-center gap-2 text-xs">
              <span className="text-fg-tertiary">Remove this connection?</span>
              <button
                type="button"
                onClick={handleRemove}
                disabled={removing}
                className="text-danger hover:text-danger font-medium transition disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
              >
                {removing ? "Removing…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingRemove(false)}
                disabled={removing}
                className="text-fg-tertiary hover:text-fg transition disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Cancel
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 text-sm rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!slugValid || saving}
            className="bg-button-primary hover:bg-button-primary-hover text-on-primary px-3 py-1.5 text-sm rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : connection ? "Save" : "Connect"}
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}
