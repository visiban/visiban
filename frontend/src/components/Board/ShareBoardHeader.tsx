import { Link } from "react-router-dom";
import { BrandTile, buttonClasses } from "../Page";

interface Props {
  boardName: string;
}

/**
 * The cut-down public header of a shared board (#2480): logo tile (not a button: there is no
 * drawer here), board name, a "Shared view, read-only" pill and Sign in. The page never loads
 * the viewer's session, so Sign in always shows. No edit controls, settings or member actions.
 * The board name is the page's `h1`: the shared board is outside the app shell.
 */
export default function ShareBoardHeader({ boardName }: Props) {
  return (
    <header className="h-14 bg-sunken border-b border-line flex items-center px-4 gap-3 shrink-0">
      <BrandTile size="sm" />
      <h1 className="truncate min-w-0 text-sm font-semibold text-fg" title={boardName}>
        {boardName}
      </h1>
      <span className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full bg-primary-emphasis/10 text-info-on-tint text-xs font-medium shrink-0 whitespace-nowrap">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-info" />
        Shared view, read-only
      </span>
      <div className="flex-1" />
      <Link to="/" className={buttonClasses("secondary", { className: "shrink-0" })}>
        Sign in
      </Link>
    </header>
  );
}
