/** Text currently held by useConfirmAnnouncement's live region(s) (#1435). */
export function announced(): string {
  return Array.from(document.querySelectorAll('[data-confirm-announcer]'))
    .map((el) => el.textContent ?? '')
    .join('')
}
