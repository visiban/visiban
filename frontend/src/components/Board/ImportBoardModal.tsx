import { useCallback, useEffect, useId, useRef, useState } from "react";
import ModalWrapper from "../shared/ModalWrapper";
import SampleGallery, { type SampleFocusRequest, type SampleListState } from "./SampleGallery";
import { getSampleBoardFile, listSampleBoards } from "../../api/boards";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { formatDateStr } from "../../utils/date";
import type { ImportOptions, SampleBoardSummary } from "../../types";

interface Props {
  /** Called with a third `options` argument only when the user deselected
   *  something; a default import passes just `(file, name)` (#119). */
  onImport: (file: File, name?: string, options?: ImportOptions) => Promise<void>;
  onCancel: () => void;
  /** When provided, shows a link that switches to the Trello import wizard (#456). */
  onSwitchToTrello?: () => void;
  /** The user's date format, for a custom "Adjust dates" day in the hint (#1949). */
  dateFormat?: string;
}

/** The upload limit, checked again on submit (the server enforces its own). */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

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

/** Today in the browser's time zone, as YYYY-MM-DD (the date input's format). */
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The top-level `date_anchor` of a chosen JSON file, or null (#1949). The
 *  server reads the same key and shifts the dates by default; the modal reads
 *  it only to decide whether to show the Dates controls. Only a string counts,
 *  exactly as on the server, so the opt-out is offered whenever the server
 *  would shift. A file that is not parseable JSON shows none: the server
 *  reports its own error on submit. */
function readDateAnchor(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data: unknown = JSON.parse(String(reader.result));
        const anchor = (data as { date_anchor?: unknown } | null)?.date_anchor;
        resolve(typeof anchor === "string" ? anchor : null);
      } catch {
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}

export default function ImportBoardModal({ onImport, onCancel, onSwitchToTrello, dateFormat }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [include, setInclude] = useState<IncludeState>(ALL_INCLUDED);
  // Date shift (#1949): `fileAnchor` is a chosen file's own date_anchor (a
  // sample's comes from the manifest instead). `shiftTo` is the "Adjust dates"
  // target; it is sent as shift_dates_to only when it differs from today.
  const [fileAnchor, setFileAnchor] = useState<string | null>(null);
  const [shiftDates, setShiftDates] = useState(true);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [today, setToday] = useState(localToday);
  const [shiftTo, setShiftTo] = useState(today);
  const anchorRead = useRef(0);
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
  const fileLabelId = useId();
  const fileButtonId = useId();
  const nameInputId = useId();
  const adjustPanelId = useId();
  const shiftToId = useId();
  const shiftToErrorId = useId();

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
    // A new file is dated around today again, with the adjuster closed. A
    // pending read of the previous file's anchor is discarded.
    anchorRead.current += 1;
    setFileAnchor(null);
    setShiftDates(true);
    setAdjustOpen(false);
    const now = localToday();
    setToday(now);
    setShiftTo(now);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    // Choosing a file wins over a sample still loading.
    abortSampleLoad();
    setSampleLoad(null);
    setFile(selected);
    resetSelection();
    // An over-limit file is refused on submit; never parse one just to look for an anchor.
    if (selected && detectFormat(selected) === "JSON" && selected.size <= MAX_IMPORT_BYTES) {
      const readId = anchorRead.current;
      void readDateAnchor(selected).then((anchor) => {
        if (anchorRead.current === readId) setFileAnchor(anchor);
      });
    }
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
    if (targetInvalid) {
      // The inline error under the date field already says why; keep focus there.
      document.getElementById(shiftToId)?.focus();
      return;
    }

    if (file.size > MAX_IMPORT_BYTES) {
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
      const dates = datesPayload();
      const options: ImportOptions | undefined = chosen || dates ? { ...chosen, ...dates } : undefined;
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
  // The Dates controls appear only when the import would shift: a sample, or a
  // JSON file that carries its own date_anchor.
  const anchor = source?.date_anchor ?? fileAnchor;
  const showDates = format === "JSON" && anchor !== null;
  // `max` only constrains the native picker: a typed later day is refused here
  // (inline error, submit blocked) rather than sent for the server to 400.
  const targetInvalid = showDates && shiftDates && shiftTo !== "" && shiftTo > today;
  const customTarget = shiftTo !== "" && shiftTo !== today && !targetInvalid;

  /** The date-shift options to send (#1949), or `undefined` for none. The
   *  server shifts an anchored file to today by default, so a raw file sends
   *  nothing unless the user turned shifting off or picked another day; a
   *  sample keeps sending its manifest anchor as shift_dates_from. */
  function datesPayload(): ImportOptions | undefined {
    if (!showDates) return undefined;
    if (!shiftDates) return { shift_dates: false };
    const to: ImportOptions = customTarget ? { shift_dates_to: shiftTo } : {};
    if (source) return { shift_dates_from: source.date_anchor, ...to };
    return customTarget ? to : undefined;
  }

  const datesHint = !shiftDates
    ? "Dates are imported exactly as written in the file."
    : customTarget
      ? `Dated around ${formatDateStr(shiftTo, dateFormat)} instead of today.`
      : "Dated around today, so the board does not open mostly overdue.";

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
            {/* Dropzone-as-button (frontend/CLAUDE.md): the title is a <p id> named by the
                button's aria-labelledby, not a <label htmlFor> aimed at the hidden input.
                The button also names itself so the chosen file or hint stays in its name. */}
            <p id={fileLabelId} className="block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5">
              File
            </p>
            <button
              type="button"
              id={fileButtonId}
              aria-labelledby={`${fileLabelId} ${fileButtonId}`}
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
            <label htmlFor={nameInputId} className="block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5">
              Board name <span className="text-fg-faint normal-case">(optional override)</span>
            </label>
            <input
              id={nameInputId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmit(); // handleSubmit manages its own submitting/error state and never rejects
                // Escape is owned by the escape stack (#1973): the sample-load handler (48) cancels a load,
                // otherwise ModalWrapper (40) closes. An inline onCancel here would run it twice.
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
          {/* Dates (#1949) — only when the import would shift them. */}
          {showDates && (
            <fieldset className="min-w-0">
              <legend className="block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5">
                Dates
              </legend>
              <div className="space-y-2 bg-sunken border border-line rounded-lg px-3 py-2.5">
                <div>
                  <label className="flex items-center gap-2 select-none cursor-pointer">
                    <input
                      type="checkbox"
                      checked={shiftDates}
                      disabled={submitting}
                      onChange={(e) => setShiftDates(e.target.checked)}
                      aria-describedby="import-dates-hint"
                      className="w-4 h-4 rounded accent-primary"
                    />
                    <span className="text-sm text-fg-secondary">Move dates to today</span>
                  </label>
                  <p id="import-dates-hint" className="text-xs text-fg-muted mt-0.5 ml-6 min-h-8">
                    {datesHint}
                  </p>
                </div>
                {shiftDates && (
                  <div className="ml-6">
                    <button
                      type="button"
                      onClick={() => setAdjustOpen((open) => !open)}
                      aria-expanded={adjustOpen}
                      aria-controls={adjustOpen ? adjustPanelId : undefined}
                      disabled={submitting}
                      className="inline-flex items-center gap-1 text-xs text-info hover:underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded disabled:opacity-40"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 16 16"
                        className={`w-3 h-3 transition-transform motion-reduce:transition-none ${adjustOpen ? "" : "-rotate-90"}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                      >
                        <path d="M4 6l4 4 4-4" />
                      </svg>
                      Adjust dates
                    </button>
                    {adjustOpen && (
                      <div id={adjustPanelId} className="mt-2">
                        <label htmlFor={shiftToId} className="block text-xs text-fg-tertiary mb-1">
                          Date the board around
                        </label>
                        <input
                          id={shiftToId}
                          type="date"
                          value={shiftTo}
                          max={today}
                          disabled={submitting}
                          onChange={(e) => setShiftTo(e.target.value)}
                          aria-invalid={targetInvalid || undefined}
                          aria-describedby={targetInvalid ? shiftToErrorId : undefined}
                          className={`bg-surface border focus:outline-none focus:ring-2 text-fg-secondary rounded px-3 py-1.5 text-sm transition ${
                            targetInvalid
                              ? "border-danger focus:ring-danger-emphasis"
                              : "border-line focus:ring-primary-emphasis focus:border-transparent"
                          }`}
                        />
                        {/* Always-mounted alert slot; only its text varies (frontend/CLAUDE.md #1437). */}
                        <p id={shiftToErrorId} role="alert" className="text-xs text-danger mt-0.5 min-h-4">
                          {targetInvalid ? "Pick today or an earlier day." : ""}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </fieldset>
          )}

          {/* The one live region for the Cards cascade; the per-row
              consequence slots are deliberately not live. */}
          <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {cascadeAnnouncement}
          </div>

          {/* Error */}
          {error && (
            <div className="bg-danger/10 border border-danger/30 rounded-lg px-4 py-3">
              <p className="text-danger-on-tint text-sm">{error}</p>
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
            aria-describedby={
              showInclude && !submitting ? (showDates ? "import-summary import-dates-hint" : "import-summary") : undefined
            }
            className="bg-button-primary hover:bg-button-primary-hover disabled:opacity-40 disabled:cursor-not-allowed text-on-primary text-sm font-medium px-5 py-2 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {submitting ? "Importing..." : "Import"}
          </button>
        </div>
    </ModalWrapper>
  );
}
