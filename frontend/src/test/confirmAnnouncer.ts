/** Text currently held by useConfirmAnnouncement's persistent live region (#1435). */
export function announced(): string {
  return document.querySelector('[data-confirm-announcer]')?.textContent ?? ''
}
