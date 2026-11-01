const INPUT_BASE = "w-full bg-surface border rounded px-3 py-1.5 text-sm text-fg-secondary font-mono focus:outline-none focus:ring-2 placeholder-fg-muted";

/** URL inputs. An invalid field keeps its danger border while focused (frontend/CLAUDE.md § Inputs, rule 4). */
export function urlInputClass(invalid: boolean) {
  return `${INPUT_BASE} ${invalid ? "border-danger focus:ring-danger-emphasis" : "border-line focus:ring-primary-emphasis focus:border-transparent"}`;
}

/** The axios error's response, typed as far as the webhook UI reads it. */
export function axiosResponse(err: unknown): { status?: number; data?: { code?: unknown; reason?: unknown } } | undefined {
  return (err as { response?: { status?: number; data?: { code?: unknown; reason?: unknown } } })?.response;
}
