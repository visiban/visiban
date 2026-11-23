import type { User } from "../../types";

export type AvatarUser = Pick<User, "avatar_url" | "display_name" | "username"> &
  Partial<Pick<User, "first_name" | "last_name">>;

export function getInitials(user: AvatarUser): string {
  const name = user.display_name?.trim() || `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim();
  if (name) {
    return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  }
  return (user.username ?? "?").slice(0, 2).toUpperCase();
}

/**
 * The text an Avatar paints, or "" when it shows a photo. A button whose accessible name is
 * set with aria-label must contain this text (WCAG 2.5.3 Label in Name, #2467): speech-input
 * users say the words they see on the button.
 */
export function avatarVisibleText(user: AvatarUser | null | undefined): string {
  if (!user) return "?";
  return user.avatar_url ? "" : getInitials(user);
}
