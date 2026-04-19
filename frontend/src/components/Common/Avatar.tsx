import type { User } from "../../types";

const PALETTE = [
  "bg-palette-teal",
  "bg-warning-bg",
  "bg-palette-violet",
  "bg-palette-rose",
  "bg-primary",
  "bg-palette-emerald",
  "bg-warning-bg",
  "bg-palette-cyan",
];

function hashUsername(username: string): number {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getInitials(user: AvatarUser): string {
  const name = user.display_name?.trim() || `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim();
  if (name) {
    return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  }
  return (user.username ?? "?").slice(0, 2).toUpperCase();
}

type AvatarUser = Pick<User, "avatar_url" | "display_name" | "username"> &
  Partial<Pick<User, "first_name" | "last_name">>;

const SIZE_CLASSES = {
  xs: "w-5 h-5 text-[10px]",
  sm: "w-6 h-6 text-xs",
  md: "w-8 h-8 text-sm",
  lg: "w-10 h-10 text-base",
};

interface Props {
  user: AvatarUser | null | undefined;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}

export default function Avatar({ user, size = "md", className = "" }: Props) {
  const sizeClass = SIZE_CLASSES[size];
  const base = `rounded-full flex items-center justify-center overflow-hidden shrink-0 font-medium ${sizeClass} ${className}`;

  if (!user) {
    return <div className={`${base} bg-fg-muted text-on-primary`}>?</div>;
  }

  if (user.avatar_url) {
    return (
      <img
        src={user.avatar_url}
        alt={user.display_name ?? user.username ?? ""}
        className={`${base} object-cover`}
      />
    );
  }

  const initials = getInitials(user);
  const colorClass = PALETTE[hashUsername(user.username ?? "") % PALETTE.length];
  const displayName = user.display_name?.trim() || `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.username;
  return (
    <div className={`${base} ${colorClass} text-on-primary`} title={displayName}>
      {initials}
    </div>
  );
}
