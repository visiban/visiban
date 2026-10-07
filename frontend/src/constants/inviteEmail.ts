// Mirrors the backend's refusal of whitespace and list/display-name characters
// in an invite address (visiban/invite_email.py InviteEmailField). Shared by the
// "Invite by email" form and the Board Settings search → invite bridge (#1444).
export const EMAIL_RE = /^[^\s@",;<>]+@[^\s@",;<>]+\.[^\s@",;<>]+$/;
