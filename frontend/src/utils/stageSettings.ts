// Stage settings constants and error mapping (#2278), kept out of the panel so it exports only a component.

export const SUB_COLUMN_MIN = 2;
export const SUB_COLUMN_MAX = 4;
/** "Add track" creates a dimension dropdown with these choices (#1921). */
export const NEW_TRACK_CHOICES = ["Done", "Not applicable"] as const;
export const NEW_TRACK_RESOLUTIONS = { Done: "satisfied", "Not applicable": "not_applicable" } as const;

/** A server refusal, by string code first; field messages second (#2278). */
export function stageErrorMessage(err: unknown): string {
  const data = (err as { response?: { status?: number; data?: unknown } })?.response?.data as
    | { code?: string; detail?: string } & Record<string, unknown>
    | undefined;
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (data?.code === "version_conflict") return "Someone changed this stage or its cards while you were editing. Close and try again.";
  if (data?.code === "column_not_found") return "This column was deleted.";
  if (status === 403) return "Only board admins can change stage settings.";
  if (data && typeof data === "object") {
    // name / choices / field_type come from creating a new track's field first.
    for (const key of ["sub_columns", "tracks", "not_applicable", "name", "choices", "field_type", "non_field_errors", "detail"]) {
      const v = data[key];
      const msg = typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : null;
      if (msg) return key === "name" ? `Track name: ${msg}` : msg;
    }
    if (status !== undefined && status >= 400 && status < 500) return "The stage didn't save. Check the settings and try again.";
  }
  return "The stage didn't save. Check your connection and try again.";
}
