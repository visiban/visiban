import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useEscapeStack } from "../../hooks/useEscapeStack";

export interface FlyoutItem {
  id: number;
  name: string;
  href: string;
  active: boolean;
  /** Tree depth — drives left padding: 12 + depth * 12 px. Defaults to 0. */
  depth?: number;
  /** Icon to render. Defaults to 'board'. */
  icon?: "group" | "board";
}

export interface FlyoutSection {
  title: string;
  items: FlyoutItem[];
}

interface Props {
  /** Title shown at the top of the flyout panel. */
  title: string;
  /** One or more item groups, each with their own section heading. */
  sections: FlyoutSection[];
  /**
   * Anchor coordinates captured at click time via getBoundingClientRect().
   * top  — aligns the panel top with the trigger button top.
   * left — placed at the right edge of the trigger (i.e. sidebar right edge).
   */
  anchor: { top: number; left: number };
  onClose: () => void;
  onNavigate: () => void;
}

/**
 * Click-anchored flyout panel for the collapsed sidebar rail.
 *
 * Rendered via createPortal so it escapes the sidebar's overflow-hidden
 * container. Closed on outside mousedown or Escape key.
 */
export default function CollapsedFlyout({
  title,
  sections,
  anchor,
  onClose,
  onNavigate,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside mousedown
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  useEscapeStack(onClose, 25);

  const panel = (
    <div
      ref={panelRef}
      role="menu"
      data-testid="collapsed-flyout"
      className="fixed z-50 w-56 bg-surface border border-line rounded-lg shadow-xl py-1 max-h-80 overflow-y-auto"
      style={{ top: anchor.top, left: anchor.left + 4 }}
    >
      {/* Flyout header */}
      <div className="px-3 py-1.5 text-xs font-semibold text-fg-muted uppercase tracking-wider border-b border-line mb-1">
        {title}
      </div>

      {sections.map((section, si) => (
        <div key={section.title}>
          {/* Section separator + heading when there are multiple sections */}
          {si > 0 && (
            <div className="mx-4 my-1">
              <div className="h-px bg-sunken" />
              <div className="h-px bg-surface-active/50" />
            </div>
          )}
          {sections.length > 1 && (
            <div className="px-3 pt-1 pb-0.5 text-xs text-fg-faint uppercase tracking-wider">
              {section.title}
            </div>
          )}

          {section.items.map((item) => {
            const depth = item.depth ?? 0;
            const isGroup = (item.icon ?? "board") === "group";
            return (
              <Link
                key={item.id}
                to={item.href}
                role="menuitem"
                title={item.name}
                onClick={() => { onClose(); onNavigate(); }}
                style={{ paddingLeft: 12 + depth * 12 }}
                className={`flex items-center gap-2 py-1.5 pr-3 text-sm transition truncate ${
                  item.active
                    ? "bg-info/20 text-info font-medium"
                    : depth > 0
                      ? "text-fg-tertiary hover:text-white hover:bg-surface-hover"
                      : "text-fg-secondary hover:text-white hover:bg-surface-hover"
                }`}
              >
                {isGroup ? (
                  // Folder icon for group items
                  <svg className="w-3.5 h-3.5 shrink-0 text-fg-muted" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                  </svg>
                ) : (
                  // Clipboard icon for board items
                  <svg className="w-3.5 h-3.5 shrink-0 text-fg-muted" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
                    <path fillRule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clipRule="evenodd" />
                  </svg>
                )}
                <span className="truncate">{item.name}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );

  return createPortal(panel, document.body);
}
