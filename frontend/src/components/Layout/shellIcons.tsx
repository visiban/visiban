// The app shell's icon set (#2473): 16px stroke icons drawn in currentColor,
// shared by the header, the navigation drawer, the board switcher and the
// account menu so the four never drift apart. No emoji anywhere in the shell.
import type { ReactNode } from "react";

function Icon({ children, className = "w-4 h-4" }: { children: ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

type P = { className?: string };

export const MenuIcon = (p: P) => <Icon {...p}><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></Icon>;
export const CloseIcon = (p: P) => <Icon {...p}><path d="M4 4l8 8M12 4l-8 8" /></Icon>;
export const HomeIcon = (p: P) => <Icon {...p}><path d="M2.5 7.5L8 3l5.5 4.5M4 6.5V13h8V6.5" /></Icon>;
export const StarIcon = (p: P) => <Icon {...p}><path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8-2.8-2.6 3.8-.5z" /></Icon>;
export const FolderIcon = (p: P) => <Icon {...p}><path d="M2 4.5h4l1.5 1.5H14v6.5H2z" /></Icon>;
export const BoardIcon = (p: P) => <Icon {...p}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M6 3v10M10 3v10" /></Icon>;
export const GearIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </Icon>
);
export const ShieldIcon = (p: P) => <Icon {...p}><path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" /></Icon>;
export const KeyboardIcon = (p: P) => <Icon {...p}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6" /></Icon>;
export const HelpIcon = (p: P) => <Icon {...p}><circle cx="8" cy="8" r="6" /><path d="M6.3 6.2a1.8 1.8 0 113 1.4c-.8.5-1.3.9-1.3 1.7M8 11.3h.01" /></Icon>;
export const ExternalIcon = (p: P) => <Icon {...p}><path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v4H2.5V4h4" /></Icon>;
export const MoonIcon = (p: P) => <Icon {...p}><path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" /></Icon>;
export const SunIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
  </Icon>
);
export const MonitorIcon = (p: P) => <Icon {...p}><rect x="2" y="3" width="12" height="8" rx="1" /><path d="M6 14h4M8 11v3" /></Icon>;
export const SignOutIcon = (p: P) => <Icon {...p}><path d="M6.5 2.5h-4v11h4M10.5 5l3 3-3 3M13.5 8H6" /></Icon>;
export const ChevronDownIcon = (p: P) => <Icon {...p}><path d="M4.5 6.5L8 10l3.5-3.5" /></Icon>;
export const PencilIcon = (p: P) => <Icon {...p}><path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z" /></Icon>;
export const SearchIcon = (p: P) => <Icon {...p}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5l3 3" /></Icon>;

/** The 26px logo tile used by the menu button and the drawer header. */
export function LogoTile({ className = "w-[26px] h-[26px]" }: { className?: string }) {
  return (
    <img
      src="/brand/visiban_fullbleed_pulse_light.png"
      alt=""
      aria-hidden="true"
      className={`${className} object-contain rounded-md shrink-0`}
    />
  );
}
