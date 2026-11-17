import type { CardTrackState } from "../../utils/stages";
import { trackStateLabel } from "../../utils/stages";

/**
 * Track chips (#1920, spec § Sub-columns and tracks): one chip per track on
 * the card's stage. State is carried by icon AND fill, never color alone
 * (WCAG 1.4.1): done = check on `bg-success/20`, open = hollow circle with a
 * border, not applicable = dash on a neutral fill. Every chip's accessible
 * name spells the state out ("Technical: done"); `spelledOut` also prints it
 * (phone width).
 */
export default function TrackChips({ tracks, spelledOut = false }: { tracks: CardTrackState[]; spelledOut?: boolean }) {
  if (tracks.length === 0) return null;
  return (
    <ul data-testid="card-track-chips" aria-label="Tracks" className="mt-1 flex flex-wrap gap-1">
      {tracks.map((t) => {
        const words = `${t.name}: ${trackStateLabel(t.state)}`;
        const tone = t.state === "done"
          ? "bg-success/20 text-success-on-tint border-transparent"
          : t.state === "open"
            ? "bg-transparent text-fg-secondary border-line-strong"
            : "bg-surface-hover text-fg-tertiary border-transparent";
        return (
          <li
            key={t.id}
            data-track-state={t.state}
            title={t.fromLane ? `${words} (for this swimlane)` : words}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-xs font-semibold leading-4 ${tone}`}
          >
            <TrackIcon state={t.state} />
            <span className="sr-only">{words}</span>
            <span aria-hidden="true">{spelledOut ? words : t.name}</span>
          </li>
        );
      })}
    </ul>
  );
}

function TrackIcon({ state }: { state: CardTrackState["state"] }) {
  if (state === "done") {
    return (
      <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="M2.5 6.5l2.25 2.25L9.5 3.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (state === "open") {
    return (
      <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="6" cy="6" r="3.75" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M3 6h6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Segmented gate progress (#1102) for a split stage rendered at normal width
 * ("Show sub-columns" off): one segment per sub-column, filled through the
 * card's own. Its text alternative names the sub-column.
 */
export function GateProgress({ index, names }: { index: number; names: string[] }) {
  if (names.length < 2) return null;
  const label = `Sub-column ${index + 1} of ${names.length}: ${names[index] ?? ""}`;
  return (
    <div data-testid="card-gate-progress" role="img" aria-label={label} title={label} className="mt-1 flex gap-0.5">
      {names.map((n, i) => (
        <span key={n + i} className={`h-1 flex-1 rounded-full ${i <= index ? "bg-primary" : "bg-surface-hover"}`} />
      ))}
    </div>
  );
}
