import { useEffect, useRef, useState } from "react";
import type { AxiosProgressEvent } from "axios";
import ModalWrapper from "../shared/ModalWrapper";
import Spinner from "../Common/Spinner";
import { confirmTrelloImport, previewTrelloImport } from "../../api/boards";
import type { Board, TrelloImportMapping, TrelloImportPreview } from "../../types";
import TrelloReviewStep from "./trello/TrelloReviewStep";
import {
  DEFAULT_SWIMLANE_NAME,
  defaultSwimlaneCollides,
  deriveTotals,
  describeTrelloError,
  formatFileSize,
  plural,
  validateTrelloFile,
  type TrelloErrorMessage,
} from "./trello/trelloImportCopy";

interface Props {
  groupId?: number;
  groupName?: string;
  onCancel: () => void;
  onImported: (board: Board) => void;
}

type Phase = "upload" | "review" | "creating";

const DEFAULT_CONFIG: TrelloImportMapping = {
  swimlane_label_ids: [],
  default_swimlane_name: DEFAULT_SWIMLANE_NAME,
  include_archived_lists: false,
  add_matched_members: false,
};

const primaryBtn =
  "bg-button-primary hover:bg-button-primary-hover disabled:opacity-40 disabled:cursor-not-allowed text-on-primary text-sm font-medium px-5 py-2 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis inline-flex items-center gap-2";
const textBtn =
  "text-fg-tertiary text-sm hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded";

function pctOf(e: AxiosProgressEvent): number {
  if (!e.total) return 0;
  return Math.min(100, Math.round((e.loaded * 100) / e.total));
}

function ProgressBar({ pct }: { pct: number }) {
  const indeterminate = pct >= 100;
  return (
    <div
      className="h-2 rounded-full bg-sunken overflow-hidden"
      role="progressbar"
      aria-label="Upload progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : pct}
    >
      <div
        // Indeterminate: full-width pulse, but a static one-third bar under reduced
        // motion so a stopped pulse never reads as "done" (frontend/CLAUDE.md § Import samples).
        className={`h-full bg-button-primary transition-[width] motion-reduce:transition-none ${indeterminate ? "w-full animate-pulse motion-reduce:animate-none motion-reduce:w-1/3" : ""}`}
        style={indeterminate ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}

export default function TrelloImportModal({ groupId, groupName, onCancel, onImported }: Props) {
  const [phase, setPhase] = useState<Phase>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<TrelloImportPreview | null>(null);
  const [config, setConfig] = useState<TrelloImportMapping>(DEFAULT_CONFIG);
  const [boardName, setBoardName] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<TrelloErrorMessage | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const lastAnnouncedPct = useRef(-1);
  const firstRender = useRef(true);

  // Abort any in-flight preview when the modal unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // The previously focused button unmounts on each phase change, so move
  // focus to the new step heading (skipped on open — ModalWrapper handles it).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [phase]);

  const trackProgress = (e: AxiosProgressEvent) => {
    const next = pctOf(e);
    setPct(next);
    const bucket = Math.floor(next / 25) * 25;
    if (bucket !== lastAnnouncedPct.current) {
      lastAnnouncedPct.current = bucket;
      setAnnouncement(`Uploading, ${bucket} percent`);
    }
  };

  const pickFile = (picked: File | null | undefined) => {
    if (!picked) return;
    abortRef.current?.abort();
    setPreviewing(false);
    setFile(picked);
    setError(null);
    if (picked !== previewFile) {
      setPreview(null);
      setPreviewFile(null);
      setConfig(DEFAULT_CONFIG);
    }
    const invalid = validateTrelloFile(picked);
    if (invalid) {
      setError({ tone: "danger", text: invalid });
      setAnnouncement(""); // the visible callout is inside the live region
    }
  };

  const handleContinue = async () => {
    if (!file || previewing) return;
    const invalid = validateTrelloFile(file);
    if (invalid) {
      setError({ tone: "danger", text: invalid });
      return;
    }
    // Same file as last time: re-enter the review step from the cache
    // instead of spending another preview against the throttle.
    if (preview && previewFile === file) {
      setPhase("review");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;
    setPreviewing(true);
    setError(null);
    setPct(0);
    lastAnnouncedPct.current = -1;
    try {
      const data = await previewTrelloImport(file, {
        groupId,
        signal: controller.signal,
        onUploadProgress: trackProgress,
      });
      if (requestId !== requestIdRef.current || controller.signal.aborted) return;
      setPreview(data);
      setPreviewFile(file);
      setBoardName(data.board.name);
      setConfig(DEFAULT_CONFIG);
      const totals = deriveTotals(data, DEFAULT_CONFIG);
      setAnnouncement(
        `Step 2 of 2: Review and configure. ${plural(totals.cards, "card", "cards")}, ${plural(totals.columns, "column", "columns")}.`,
      );
      setPhase("review");
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const msg = describeTrelloError(err, "preview");
      if (msg) {
        setError(msg);
        setAnnouncement(""); // the visible callout is inside the live region
      }
    } finally {
      if (requestId === requestIdRef.current) setPreviewing(false);
    }
  };

  const handleCreate = async () => {
    if (!file || !preview || !boardName.trim() || defaultSwimlaneCollides(preview, config)) return;
    setPhase("creating");
    setError(null);
    setPct(0);
    lastAnnouncedPct.current = -1;
    setAnnouncement("Creating board");
    try {
      const result = await confirmTrelloImport(
        file,
        {
          name: boardName.trim(),
          fileSha256: preview.file_sha256,
          mapping: {
            ...config,
            default_swimlane_name: config.default_swimlane_name.trim() || DEFAULT_SWIMLANE_NAME,
          },
        },
        { groupId, onUploadProgress: trackProgress },
      );
      onImported(result.board);
    } catch (err) {
      const msg = describeTrelloError(err, "confirm");
      setPhase("review");
      if (msg) {
        setError(msg);
        setAnnouncement(""); // the visible callout is inside the live region
      }
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    onCancel();
  };

  const subtitle =
    phase === "upload"
      ? "Step 1 of 2 · Choose file"
      : phase === "review"
        ? "Step 2 of 2 · Review and configure"
        : "Creating board";
  const heading = phase === "upload" ? "Choose file" : phase === "review" ? "Review and configure" : "Creating board";
  const createBlockedReason = !boardName.trim()
    ? "Enter a board name."
    : preview && defaultSwimlaneCollides(preview, config)
      ? "Choose a default swimlane name that is different from the labels you turned into swimlanes."
      : "";
  const createBlockedField = !boardName.trim() ? "trello-board-name" : "trello-default-swimlane";

  return (
    <ModalWrapper
      open={true}
      onClose={handleCancel}
      title="Import from Trello"
      subtitle={subtitle}
      maxWidth="max-w-2xl"
      noPadding
      headerBorder
      labelId="import-trello-title"
      dismissable={phase !== "creating"}
      panelClassName={phase !== "upload" ? "h-[85vh] max-h-[640px] min-h-0" : ""}
    >
      {/* A file dropped anywhere in the wizard (or on the busy dropzone) must
          never fall through to the browser, which would navigate to the file. */}
      <div
        className="flex flex-col flex-1 min-h-0"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
      >
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className={`text-sm font-medium text-fg-tertiary uppercase tracking-wide focus:outline-none ${phase === "creating" ? "sr-only" : ""}`}
          >
            {heading}
          </h3>

          {phase === "upload" && (
            <>
              <div className="flex gap-2.5 bg-surface-hover/50 border border-line-strong rounded-lg px-3 py-2.5 text-xs text-fg-secondary">
                <span className="shrink-0 text-fg-tertiary mt-px" aria-hidden="true">ℹ</span>
                <span>
                  Export your board from Trello: open the board menu, choose <strong className="text-fg">Print, export, and share</strong>,
                  then <strong className="text-fg">Export as JSON</strong>. Files up to 25 MB are accepted by default.
                </span>
              </div>

              <div>
                <p
                  id="trello-file-label"
                  className="block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5"
                >
                  Trello export file
                </p>
                <input
                  ref={fileRef}
                  id="trello-file"
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(e) => {
                    pickFile(e.target.files?.[0]);
                    // Reset so re-picking the same file fires onChange again.
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  aria-labelledby="trello-file-label trello-file-state"
                  aria-disabled={previewing}
                  onClick={() => {
                    if (!previewing) fileRef.current?.click();
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (!previewing) setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    if (!previewing) pickFile(e.dataTransfer.files?.[0]);
                  }}
                  className={`w-full border border-dashed rounded-lg p-6 text-center transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis aria-disabled:cursor-not-allowed aria-disabled:opacity-60 ${
                    dragOver ? "border-primary-emphasis bg-primary-emphasis/10" : "border-line-strong hover:border-line-emphasis"
                  }`}
                >
                  {file ? (
                    <span id="trello-file-state" className="block text-sm pointer-events-none">
                      <span className="block text-fg font-medium truncate" title={file.name}>{file.name}</span>
                      <span className="block text-fg-tertiary text-xs mt-0.5">
                        {formatFileSize(file.size)} · Click to choose a different file
                      </span>
                    </span>
                  ) : (
                    <span id="trello-file-state" className="block text-fg-muted text-sm pointer-events-none">
                      Click to select a Trello .json file, or drag it here
                    </span>
                  )}
                </button>
              </div>

              {previewing && (
                <div className="space-y-1.5">
                  <p className="text-xs text-fg-tertiary">{pct >= 100 ? "Reading export…" : `Uploading… ${pct}%`}</p>
                  <ProgressBar pct={pct} />
                </div>
              )}
            </>
          )}

          {phase === "review" && preview && (
            <TrelloReviewStep
              preview={preview}
              config={config}
              onConfigChange={setConfig}
              boardName={boardName}
              onBoardNameChange={setBoardName}
              groupName={groupName}
            />
          )}

          {phase === "creating" && (
            <div className="flex flex-col items-center justify-center gap-4 py-10 min-h-full">
              {pct < 100 ? (
                <>
                  <p className="text-sm text-fg-secondary">Uploading file… {pct}%</p>
                  <div className="w-full max-w-sm">
                    <ProgressBar pct={pct} />
                  </div>
                </>
              ) : (
                <>
                  <Spinner size="lg" label="Creating board" />
                  <p className="text-sm text-fg-secondary">Creating board…</p>
                  <p className="text-xs text-fg-muted">Large boards can take a minute. Keep this window open.</p>
                </>
              )}
            </div>
          )}
        </div>

        {/* The one live region: announcements plus the visible error callout. */}
        <div role="status" aria-live="polite" aria-atomic="true" className="shrink-0 px-6">
          <span className="sr-only">{announcement}</span>
          {error && (
            <div
              className={`mb-3 rounded-lg px-4 py-3 border ${
                error.tone === "warning" ? "bg-warning/10 border-warning/30" : "bg-danger/10 border-danger/30"
              }`}
            >
              <p className={`text-sm ${error.tone === "warning" ? "text-warning" : "text-danger"}`}>{error.text}</p>
            </div>
          )}
        </div>

        {phase !== "creating" && (
          <div
            className={`px-6 py-4 border-t border-line shrink-0 flex flex-wrap items-center gap-3 ${
              phase === "review" ? "justify-between" : "justify-end"
            }`}
          >
            {phase === "review" && (
              <button type="button" onClick={() => { setError(null); setPhase("upload"); }} className={`${textBtn} inline-flex items-center gap-1`}>
                <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M12.7 15.3a1 1 0 01-1.4 0l-4.6-4.6a1 1 0 010-1.4l4.6-4.6a1 1 0 111.4 1.4L8.8 10l3.9 3.9a1 1 0 010 1.4z" clipRule="evenodd" />
                </svg>
                Back
              </button>
            )}
            <div className="flex items-center gap-3">
              <button type="button" onClick={handleCancel} className={textBtn}>
                Cancel
              </button>
              {phase === "upload" ? (
                <button
                  type="button"
                  onClick={handleContinue}
                  disabled={!file || previewing || !!(file && validateTrelloFile(file))}
                  className={primaryBtn}
                >
                  {previewing && (
                    <span
                      aria-hidden="true"
                      className="w-3 h-3 border-2 border-on-primary border-t-transparent rounded-full animate-spin shrink-0"
                    />
                  )}
                  {previewing ? (pct >= 100 ? "Reading export…" : "Uploading…") : "Continue"}
                </button>
              ) : (
                <>
                  {createBlockedReason && (
                    <span id="trello-create-blocked" className="sr-only">
                      {createBlockedReason}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (createBlockedReason) {
                        // Bring the (possibly scrolled-away) invalid field into view.
                        document.getElementById(createBlockedField)?.focus();
                        return;
                      }
                      void handleCreate(); // handleCreate manages its own phase/error state and never rejects
                    }}
                    aria-disabled={!!createBlockedReason}
                    aria-describedby={createBlockedReason ? "trello-create-blocked" : undefined}
                    className={`${primaryBtn} aria-disabled:opacity-40 aria-disabled:cursor-not-allowed`}
                  >
                    Create board
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </ModalWrapper>
  );
}
