import type { AutosaveStatus } from "../../hooks/useAutosaveStatus";

interface Props {
  status: AutosaveStatus;
  fadingOut?: boolean;
}

export default function AutosaveIndicator({ status, fadingOut = false }: Props) {
  return (
    <p className="text-xs h-4 flex items-center gap-1" aria-live="polite">
      {status === "saving" && (
        <>
          <span
            className="w-3 h-3 border border-primary border-t-transparent rounded-full animate-spin shrink-0"
            aria-hidden="true"
          />
          <span className="text-fg-muted">Saving…</span>
        </>
      )}
      {status === "saved" && (
        <>
          <span
            className={`text-success transition-opacity duration-300 ${fadingOut ? "opacity-0" : "opacity-100"}`}
            aria-hidden="true"
          >
            ✓
          </span>
          <span className={`text-success transition-opacity duration-300 ${fadingOut ? "opacity-0" : "opacity-100"}`}>
            Saved
          </span>
        </>
      )}
      {status === "error" && (
        <>
          <span className="text-danger" aria-hidden="true">!</span>
          <span className="text-danger">Couldn't save</span>
        </>
      )}
    </p>
  );
}
