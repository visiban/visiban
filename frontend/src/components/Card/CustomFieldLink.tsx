import type { SyntheticEvent } from "react";
import { normalizeUrl, urlDisplayHostname } from "../../utils/customFieldValue";
import { isHttpUrl } from "../../utils/externalRef";

interface Props {
  /** The stored value. Rendered as a link only when it normalizes to an http(s) URL. */
  value: string;
  /**
   * `host` — pinned chip (card face, swimlane row header): hostname only,
   * `www.` stripped, truncated to `maxHostChars`. `full` — card detail /
   * read-only views: the whole URL plus an external-link icon. `action` — the
   * `Open link ↗` line under an editable URL input; renders nothing (not
   * plain text) when the value is not a safe link, since the input beside it
   * already shows the text.
   */
  variant: "host" | "full" | "action";
  /** `host` only: characters of hostname shown before an ellipsis. */
  maxHostChars?: number;
  /**
   * Stop click/pointer/mouse/touch/key events from reaching the surface the
   * link sits in — a draggable card or a selectable row (frontend/CLAUDE.md
   * § URL custom-field links). Never `preventDefault`: the link must open,
   * including cmd/middle-click.
   */
  stopPropagation?: boolean;
  className?: string;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

/** Inline external-link icon; tracks the link's text color. */
function ExternalLinkIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={`${className} shrink-0 inline-block align-baseline`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The single renderer for a URL custom field value (#1390), shared by the
 * card-detail read view, the card-face chip, the swimlane row chip and the
 * row fields popover so the safety rules live in one place:
 *
 * - an `<a>` is rendered only when the value normalizes to an http(s) URL
 *   *and* passes `isHttpUrl` — a legacy `javascript:` value, or anything an
 *   older writer stored, renders as plain text with no `href`;
 * - always `target="_blank" rel="noopener noreferrer"`;
 * - the value is a text node, never HTML.
 */
export default function CustomFieldLink({ value, variant, maxHostChars, stopPropagation, className = "" }: Props) {
  const normalized = normalizeUrl(value);
  const href = normalized.ok && isHttpUrl(normalized.url) ? normalized.url : null;

  if (!href) {
    if (variant === "action") return null;
    return <span className={`text-fg-secondary ${variant === "host" ? "truncate" : "break-all"} ${className}`}>{value}</span>;
  }

  const stopHandlers = stopPropagation
    ? { onClick: stop, onDoubleClick: stop, onPointerDown: stop, onMouseDown: stop, onTouchStart: stop, onKeyDown: stop }
    : {};

  if (variant === "action") {
    // The accessible name must contain the visible text (WCAG 2.5.3), so it
    // is "Open link in new tab", not the URL; the URL is in `title`.
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open link in new tab"
        title={href}
        className={`text-info hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${className}`}
        {...stopHandlers}
      >
        Open link ↗
      </a>
    );
  }

  if (variant === "host") {
    const host = urlDisplayHostname(href);
    const shown = maxHostChars !== undefined && host.length > maxHostChars ? `${host.slice(0, maxHostChars)}…` : host;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${host} in new tab`}
        className={`text-info hover:underline truncate rounded-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${className}`}
        {...stopHandlers}
      >
        {shown}
      </a>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${href} in new tab`}
      className={`text-sm text-info hover:underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded break-all ${className}`}
      {...stopHandlers}
    >
      {href}
      {" "}
      <ExternalLinkIcon />
    </a>
  );
}
