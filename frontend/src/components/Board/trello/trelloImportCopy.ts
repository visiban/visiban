// Pure helpers for the Trello import wizard (#456): error copy, pluralization,
// and the client-side derivations that let the review step react to mapping
// options without another dry-run request.
import type { TrelloImportPreview, TrelloImportMapping, TrelloUnmappableKind } from "../../../types";

export const TRELLO_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_SWIMLANE_NAME = "Unassigned";

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatMinutes(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null || Number.isNaN(retryAfterSeconds)) return "a little while";
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return plural(minutes, "minute", "minutes");
}

const UNMAPPABLE_NOUNS: Record<TrelloUnmappableKind, [string, string]> = {
  attachment_files: ["attachment file", "attachment files"],
  custom_fields: ["custom field value", "custom field values"],
  power_up_data: ["Power-Up data entry", "Power-Up data entries"],
  start_dates: ["start date", "start dates"],
  stickers: ["sticker", "stickers"],
};

export function unmappableLine(kind: string, count: number): string {
  const nouns = UNMAPPABLE_NOUNS[kind as TrelloUnmappableKind];
  const fallback = kind.replace(/_/g, " ");
  const phrase = nouns ? plural(count, nouns[0], nouns[1]) : `${count} ${fallback}`;
  const suffix = kind === "attachment_files" ? " (links are added to card descriptions)" : "";
  return `${phrase} won't be imported${suffix}`;
}

export type TrelloErrorTone = "danger" | "warning";
export interface TrelloErrorMessage {
  text: string;
  tone: TrelloErrorTone;
}

interface AxiosLikeError {
  code?: string;
  name?: string;
  response?: {
    status?: number;
    data?: unknown;
    headers?: Record<string, string | undefined>;
  };
}

/** Map a failed preview/confirm request to user-facing copy. Returns null for
 *  401 (the client interceptor handles session expiry) and for aborts. */
export function describeTrelloError(err: unknown, mode: "preview" | "confirm"): TrelloErrorMessage | null {
  const e = (err ?? {}) as AxiosLikeError;
  if (e.code === "ERR_CANCELED" || e.name === "CanceledError" || e.name === "AbortError") return null;
  const res = e.response;
  if (!res || res.status === undefined) {
    return {
      tone: "danger",
      text:
        mode === "preview"
          ? "Couldn't reach the server. Check your connection and try again."
          : "Couldn't confirm the import. The board may have been created, so check your boards before trying again.",
    };
  }
  const detail =
    res.data && typeof res.data === "object" && typeof (res.data as { detail?: unknown }).detail === "string"
      ? (res.data as { detail: string }).detail
      : null;
  switch (res.status) {
    case 400:
      return {
        tone: "danger",
        text:
          detail ??
          (mode === "preview"
            ? "We couldn't read this file. Make sure it's a Trello JSON export."
            : "Import failed. Check your settings and try again."),
      };
    case 401:
      return null;
    case 403:
      return { tone: "danger", text: "You don't have permission to create boards in this group." };
    case 413:
      // Never read the body: a proxy 413 may not be JSON.
      return { tone: "danger", text: "File is too large. Maximum size is 25 MB." };
    case 429: {
      const header = res.headers?.["retry-after"];
      const wait = formatMinutes(header !== undefined ? Number(header) : null);
      return {
        tone: "warning",
        text:
          mode === "preview"
            ? `Too many previews. Try again in ${wait}.`
            : `Import limit reached (10 per hour). Try again in ${wait}.`,
      };
    }
    default:
      return { tone: "danger", text: "Something went wrong on our side. Try again in a moment." };
  }
}

/** Client-side validation run when a file is picked. */
export function validateTrelloFile(file: File): string | null {
  const isJson = file.name.toLowerCase().endsWith(".json") || file.type.includes("json");
  if (!isJson) return "Unsupported file format. Please upload the .json file exported from Trello.";
  if (file.size > TRELLO_MAX_BYTES) return "File is too large. Maximum size is 25 MB.";
  return null;
}

/** Columns and cards the import will create for the given options. Mirrors
 *  build_plan() so toggling "Include archived lists" needs no new request. */
export function deriveTotals(preview: TrelloImportPreview, config: TrelloImportMapping) {
  const included = preview.mapping.columns.filter((c) => !c.archived || config.include_archived_lists);
  return {
    columns: included.length,
    cards: included.reduce((sum, c) => sum + c.card_count, 0),
  };
}

/** Warnings from the preview that still apply under the current options. */
export function visibleWarnings(preview: TrelloImportPreview, config: TrelloImportMapping) {
  return preview.warnings.filter((w) => {
    if (config.include_archived_lists && (w.code === "archived_lists_skipped" || w.code === "cards_in_archived_lists_skipped")) {
      return false;
    }
    if (config.add_matched_members && w.code === "matched_members_not_added") return false;
    return true;
  });
}

/** The default swimlane must not share a name with a label promoted to a swimlane. */
export function defaultSwimlaneCollides(preview: TrelloImportPreview, config: TrelloImportMapping): boolean {
  const name = (config.default_swimlane_name.trim() || DEFAULT_SWIMLANE_NAME).toLowerCase();
  return preview.mapping.labels.some(
    (l) => config.swimlane_label_ids.includes(l.trello_id) && l.name.toLowerCase() === name,
  );
}
