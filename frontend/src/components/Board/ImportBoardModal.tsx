import { useCallback, useEffect, useRef, useState } from "react";
import ModalWrapper from "../shared/ModalWrapper";
import SampleGallery, { type SampleFocusRequest, type SampleListState } from "./SampleGallery";
import { getSampleBoardFile, listSampleBoards } from "../../api/boards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { ImportOptions, SampleBoardSummary } from "../../types";

interface Props {
  /** Called with a third `options` argument only when the user deselected
   *  something; a default import passes just `(file, name)` (#119). */
  onImport: (file: File, name?: string, options?: ImportOptions) => Promise<void>;
  onCancel: () => void;
  /** When provided, shows a link that switches to the Trello import wizard (#456). */
  onSwitchToTrello?: () => void;
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

type IncludeKey = "labels" | "cards" | "comments" | "checklist" | "history";
type IncludeState = Record<IncludeKey, boolean>;
type DependentKey = "comments" | "checklist" | "history";

const ALL_INCLUDED: IncludeState = { labels: true, cards: true, comments: true, checklist: true, history: true };

interface IncludeRow {
  key: IncludeKey;
  label: string;
  /** Consequence-slot copy while checked (empty: the slot stays blank). */
  rest: string;
  /** Consequence-slot copy while unchecked. */
  off: string;
}

const CARDS_ROW: IncludeRow = {
  key: "cards",
  label: "Cards",
  rest: "Includes assignees and due dates.",
  off: "Cards and everything on them are skipped",
};
const DEPENDENT_ROWS: IncludeRow[] = [
  { key: "comments", label: "Comments", rest: "", off: "Comments are skipped" },
  { key: "checklist", label: "Checklist items", rest: "", off: "Checklist items are skipped" },
  {
    key: "history",
    label: "Card history",
    rest: "Movements and activity entries.",
    off: "Movements and activity are skipped",
  },
];
const LABELS_ROW: IncludeRow = {
  key: "labels",
  label: "Labels",
  rest: "Label definitions and the labels on cards.",
  off: "Card labels are skipped",
};

/** "Importing: everything", or "Importing: structure, cards, labels, …" —
 *  only what is selected, in a fixed order. */
function importingSummary(include: IncludeState, isCsv: boolean): string {
  const relevant: IncludeKey[] = isCsv ? ["cards", "labels"] : ["cards", "labels", "comments", "checklist", "history"];
  if (relevant.every((key) => include[key])) return "Importing: everything";
  const parts: string[] = [];
  if (include.cards) parts.push("cards");
  if (include.labels) parts.push("labels");
  if (!isCsv && include.cards) {
    if (include.comments) parts.push("comments");
    if (include.checklist) parts.push("checklist items");
    if (include.history) parts.push("history");
  }
  return parts.length === 0 ? "Importing: structure only" : `Importing: structure, ${parts.join(", ")}`;
}

/** The options to send, or `undefined` when everything is included. Never
 *  sends a contradiction: with Cards off, every dependent is sent `false`. */
function optionsPayload(include: IncludeState, isCsv: boolean): ImportOptions | undefined {
  const payload: ImportOptions = isCsv
    ? { cards: include.cards, labels: include.labels }
    : include.cards
      ? { ...include }
      : { labels: include.labels, cards: false, comments: false, checklist: false, history: false };
  return Object.values(payload).every(Boolean) ? undefined : payload;
}

export default function ImportBoardModal({ onImport, onCancel, onSwitchToTrello }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [include, setInclude] = useState<IncludeState>(ALL_INCLUDED);
  // The modal's one polite live region: the Cards cascade (#119) and a sample
  // load starting or canceled. A failed sample is the card's own role="alert".
  const [cascadeAnnouncement, setCascadeAnnouncement] = useState("");
  // "Start from a sample" (#1452). `source` is set once a sample's file has been
  // fetched and wrapped as `file`; `sampleLoad` tracks the one in flight or failed.
  const [samples, setSamples] = useState<SampleBoardSummary[]>([]);
  const [listState, setListState] = useState<SampleListState>("loading");
  const [source, setSource] = useState<SampleBoardSummary | null>(null);
  const [sampleLoad, setSampleLoad] = useState<{ id: string; status: "loading" | "error" } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [focusRequest, setFocusRequest] = useState<SampleFocusRequest | null>(null);
  const listAbort = useRef<AbortController | null>(null);
  const sampleAbort = useRef<AbortController | null>(null);
  const includeRef = useRef<HTMLFieldSetElement>(null);
  // The dependents' values from just before Cards was unchecked, restored when
  // it is re-checked so a deliberate uncheck (e.g. History) survives the round trip.
  const dependentsMemo = useRef<Pick<IncludeState, DependentKey> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const requestFocus = (id: string) => setFocusRequest((prev) => ({ id, n: (prev?.n ?? 0) + 1 }));

  const loadList = useCallback(() => {
    listAbort.current?.abort();
    const ctrl = new AbortController();
    listAbort.current = ctrl;
    setListState("loading");
    listSampleBoards(ctrl.signal)
      .then((list) => {
        if (ctrl.signal.aborted) return;
        setSamples(list);
        // An empty list is "unavailable", not an empty gallery: the section never disappears silently.
        setListState(list.length > 0 ? "ready" : "unavailable");
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setListState("unavailable");
      });
  }, []);

  useEffect(() => {
    loadList();
    return () => {
      listAbort.current?.abort();
      sampleAbort.current?.abort();
    };
  }, [loadList]);

  /** Abort the in-flight sample request (not just hide the spinner). */
  const abortSampleLoad = () => {
    sampleAbort.current?.abort();
    sampleAbort.current = null;
  };

  // Escape while a sample loads cancels the load and leaves the modal open. Its
  // own priority (48) sits above the modal's 40; it passes through otherwise.
  useEscapeStack(() => {
    if (sampleLoad?.status !== "loading") return false;
    abortSampleLoad();
    setSampleLoad(null);
    setCascadeAnnouncement("Loading canceled.");
    requestFocus(sampleLoad.id);
  }, 48);

  /** A new file starts from "import everything" — choices made for the
   *  previous file (possibly a different format) do not carry over. */
  const resetSelection = () => {
    setError(null);
    setInclude(ALL_INCLUDED);
    dependentsMemo.current = null;
    setCascadeAnnouncement("");
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    // Choosing a file wins over a sample still loading.
    abortSampleLoad();
    setSampleLoad(null);
    setFile(selected);
    resetSelection();
  };

  const selectSample = async (sample: SampleBoardSummary) => {
    abortSampleLoad();
    const ctrl = new AbortController();
    sampleAbort.current = ctrl;
    setSampleLoad({ id: sample.id, status: "loading" });
    // The one announcement of the load: a region that is already mounted (and empty)
    // is reliably read; the card's own text is visual only.
    setCascadeAnnouncement(`Loading the ${sample.title} sample.`);
    try {
      const blob = await getSampleBoardFile(sample.id, ctrl.signal);
      if (ctrl.signal.aborted) return;
      // The fetched export goes through the unchanged import path as a File.
      resetSelection();
      setFile(new File([blob], `${sample.id}.json`, { type: "application/json" }));
      setSource(sample);
      setSampleLoad(null);
      sampleAbort.current = null;
    } catch {
      if (ctrl.signal.aborted) return;
      setSampleLoad({ id: sample.id, status: "error" });
      setCascadeAnnouncement(""); // the card's alert owns the failure message
      requestFocus(sample.id); // the card's button is now "Try again"
    }
  };

  // The sample is fetched: land on the include options, the next step.
  useEffect(() => {
    if (source) includeRef.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
  }, [source]);

  const changeSample = () => {
    if (!source) return;
    const id = source.id;
    setSource(null);
    setFile(null);
    resetSelection();
    requestFocus(id);
  };

  const toggle = (key: IncludeKey, checked: boolean) => {
    // A CSV file shows no dependent rows, so there is no cascade to announce.
    const announce = file !== null && detectFormat(file) !== "CSV";
    if (key !== "cards") {
      setInclude((prev) => ({ ...prev, [key]: checked }));
      return;
    }
    if (!checked) {
      dependentsMemo.current = { comments: include.comments, checklist: include.checklist, history: include.history };
      setInclude((prev) => ({ ...prev, cards: false, comments: false, checklist: false, history: false }));
      if (announce) {
        setCascadeAnnouncement("Comments, checklist items, and card history are unavailable while Cards is unchecked");
      }
    } else {
      const restored = dependentsMemo.current ?? { comments: true, checklist: true, history: true };
      dependentsMemo.current = null;
      setInclude((prev) => ({ ...prev, cards: true, ...restored }));
      if (announce) setCascadeAnnouncement("Comments, checklist items, and card history are available again");
    }
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
      const chosen = optionsPayload(include, format === "CSV");
      // A sample is dated around its anchor; shifting it to today keeps the
      // imported board from opening mostly overdue.
      const options: ImportOptions | undefined = source ? { ...chosen, shift_dates_from: source.date_anchor } : chosen;
      // Two arguments for a default import, so callers (and their tests) see
      // exactly the pre-#119 call; the third only when something differs.
      if (options) await onImport(file, name.trim() || undefined, options);
      else await onImport(file, name.trim() || undefined);
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
  const showInclude = format === "JSON" || format === "CSV";
  const isCsv = format === "CSV";

  const renderRow = (row: IncludeRow, dependent: boolean) => {
    const checked = include[row.key];
    const unavailable = dependent && !include.cards;
    const slotId = `import-include-${row.key}-hint`;
    const hint = unavailable ? "Requires Cards" : checked ? row.rest : row.off;
    return (
      <div key={row.key} className={dependent ? "ml-6 border-l-2 border-line pl-4" : undefined}>
        {/* Dim only the text: the native disabled control dims itself. */}
        <label className={`flex items-center gap-2 select-none ${unavailable ? "" : "cursor-pointer"}`}>
          <input
            type="checkbox"
            checked={checked}
            disabled={unavailable || submitting}
            onChange={(e) => toggle(row.key, e.target.checked)}
            aria-describedby={slotId}
            className="w-4 h-4 rounded accent-primary"
          />
          <span className={`text-sm ${unavailable ? "text-fg-muted" : "text-fg-secondary"}`}>{row.label}</span>
        </label>
        <p id={slotId} className="text-xs text-fg-muted mt-0.5 ml-6 min-h-4">
          {hint}
        </p>
      </div>
    );
  };

  return (
    <ModalWrapper
      open={true}
      onClose={onCancel}
      title="Import Board"
      subtitle="Upload a Visiban JSON or CSV export to create a new board. JSON also preserves full card history — movements and activity log."
      maxWidth="max-w-[640px]"
      panelClassName="max-h-[calc(100dvh-2rem)]"
      noPadding
      labelId="import-board-title"
      headerBorder
    >
        {/* Body */}
        <div className="px-4 sm:px-6 py-5 space-y-4 flex-1 min-h-0 overflow-y-auto">
          {!source && (
            <SampleGallery
              samples={samples}
              listState={listState}
              pending={sampleLoad}
              expanded={expanded}
              onExpandedChange={setExpanded}
              onSelect={(sample) => void selectSample(sample)}
              onRetryList={loadList}
              focusRequest={focusRequest}
            />
          )}

          {/* Source: the sample that stands in for the file (#1452) */}
          {source && (
            <div>
              <p className="block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5">Source</p>
              <div className="flex items-center justify-between gap-3 border border-line-strong rounded-lg px-3 py-2.5">
                <span className="text-sm text-fg-secondary truncate">
                  From sample: <span className="text-fg font-medium">{source.title}</span> &middot; ~{source.card_count} cards
                </span>
                <button
                  type="button"
                  onClick={changeSample}
                  disabled={submitting}
                  aria-label={`Change sample (currently ${source.title})`}
                  className="shrink-0 border border-line-strong text-fg-secondary hover:text-fg hover:bg-surface-hover text-xs font-medium px-2.5 py-1 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40"
                >
                  Change
                </button>
              </div>
            </div>
          )}

          {/* File input */}
          {!source && <div>
            <label className="block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5">
              File
            </label>
            <button
              type="button"
              className="block w-full border border-dashed border-line-strong rounded-lg p-4 text-center cursor-pointer hover:border-line-emphasis transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              onClick={() => fileRef.current?.click()}
            >
              {file ? (
                <span className="block text-sm">
                  <span className="block text-fg font-medium truncate">{file.name}</span>
                  <span className="block text-fg-tertiary text-xs mt-0.5">
                    {formatFileSize(file.size)} &middot; {format}
                  </span>
                </span>
              ) : (
                <span className="block text-fg-muted text-sm">
                  Click to select a .json or .csv file
                </span>
              )}
            </button>
            {/* Sibling, not a child: interactive content may not nest inside a <button>. */}
            <input
              ref={fileRef}
              type="file"
              accept=".json,.csv"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>}

          {/* Upload notes sit under the dropzone they describe; a sample is far under the limits. */}
          {!source && (
            <>
              <div className="flex gap-2.5 bg-surface-hover/50 border border-line-strong rounded-lg px-3 py-2.5 text-xs text-fg-secondary">
                <span className="shrink-0 text-fg-tertiary mt-px" aria-hidden="true">ℹ</span>
                <span>Imports are limited to <strong className="text-fg">500 cards</strong>, <strong className="text-fg">50 columns</strong>, and <strong className="text-fg">100 swimlanes</strong>. For larger boards, split into smaller boards before importing.</span>
              </div>

              {onSwitchToTrello && !submitting && (
                <p className="text-xs text-fg-tertiary">
                  Coming from Trello?{" "}
                  <button
                    type="button"
                    onClick={onSwitchToTrello}
                    className="text-info hover:underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
                  >
                    Import a Trello export
                  </button>
                </p>
              )}
            </>
          )}

          {/* Optional name override */}
          <div>
            <label className="block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5">
              Board name <span className="text-fg-faint normal-case">(optional override)</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmit(); // handleSubmit manages its own submitting/error state and never rejects
                // While a sample loads, Escape belongs to the stack handler (48): it cancels the load.
                if (e.key === "Escape" && sampleLoad?.status !== "loading") onCancel();
              }}
              placeholder={'Leave blank for "Imported: <name from file>"'}
              className="w-full bg-surface border border-line focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent text-fg-secondary rounded px-3 py-1.5 text-sm placeholder-fg-muted transition"
            />
          </div>

          {/* What to import (#119) — only once a supported file is chosen. */}
          {showInclude && (
            <fieldset ref={includeRef} className="min-w-0" aria-describedby="import-include-note">
              <legend className="block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5">
                Include
              </legend>
              <p id="import-include-note" className="text-xs text-fg-muted mb-2">
                {isCsv
                  ? "Board structure (name, columns, swimlanes) is always imported."
                  : "Board structure (name, columns, swimlanes, custom fields) is always imported."}
              </p>
              <div className="space-y-2 bg-sunken border border-line rounded-lg px-3 py-2.5">
                {renderRow(CARDS_ROW, false)}
                {!isCsv && DEPENDENT_ROWS.map((row) => renderRow(row, true))}
                {renderRow(LABELS_ROW, false)}
              </div>
            </fieldset>
          )}
          {showInclude && (
            <p id="import-summary" className="text-xs text-fg-muted min-h-8">
              {importingSummary(include, isCsv)}
            </p>
          )}
          {/* The one live region for the Cards cascade; the per-row
              consequence slots are deliberately not live. */}
          <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {cascadeAnnouncement}
          </div>

          {/* Error */}
          {error && (
            <div className="bg-danger/10 border border-danger/30 rounded-lg px-4 py-3">
              <p className="text-danger text-sm">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-line flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!file || submitting}
            aria-describedby={showInclude && !submitting ? "import-summary" : undefined}
            className="bg-button-primary hover:bg-button-primary-hover disabled:opacity-40 disabled:cursor-not-allowed text-on-primary text-sm font-medium px-5 py-2 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {submitting ? "Importing..." : "Import"}
          </button>
        </div>
    </ModalWrapper>
  );
}
