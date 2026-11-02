import { useEscapeStack } from '../hooks/useEscapeStack'

/**
 * Stands in for BoardView's lower Escape handlers (view-toggle 15, focus-exit 12,
 * selection-clear 10) so a test can prove an element-level Escape is consumed by
 * the field and never reaches them (#1860). `onLower` is called for each lower
 * handler that would have acted.
 */
export function EscapeLowerHandlers({ onLower }: { onLower: () => void }) {
  useEscapeStack(() => { onLower() }, 15)
  useEscapeStack(() => { onLower() }, 12)
  useEscapeStack(() => { onLower() }, 10)
  return null
}
