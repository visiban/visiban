// Shared guard for global keyboard shortcuts. Returns true when the event's
// target is a typing surface (input, textarea, select, contenteditable) and
// the shortcut should therefore be suppressed. Co-located here because the
// same check is consumed by the shell-level GlobalCommandPalette and the
// board-scoped handler in BoardView — any future drift between the two would
// reintroduce the class of bug that #868 set out to kill.

export function shouldIgnoreShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  if (target.closest?.('[contenteditable="true"]')) return true;
  return false;
}
