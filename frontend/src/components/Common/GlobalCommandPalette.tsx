import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useOptionalBoardContext } from "../../contexts/BoardContext";
import CommandPalette from "./CommandPalette";
import type { Card } from "../../types";

// Shell-level owner for the ⌘K command palette. Hoisted from BoardView
// (#869) so the shortcut fires on every authenticated route and the palette
// itself is scoped per surface:
//
// - Board routes: board-scoped (cards + boards + board actions)
// - Off-board (Dashboard, Group, Settings, Admin): boards + global actions only
//
// Action dispatch is delegated via window custom events so this shell-level
// component never needs to know BoardView internals. BoardView subscribes to
// the subset that makes sense in board context.
export default function GlobalCommandPalette() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const boardCtx = useOptionalBoardContext();

  const inBoardRoute = pathname.startsWith("/boards/");
  const board = inBoardRoute ? boardCtx?.board ?? null : null;
  const boardMode = board !== null;
  const isAdmin = board?.current_user_role === "admin" || board?.current_user_role === "site_admin";

  // Global keydown for ⌘K / Ctrl+K. Fires even when focus is inside an
  // input — the palette itself is a typing surface, so opening it from a
  // search box or editor is intentional. shouldIgnoreShortcut is reserved
  // for bare-key shortcuts like `f` / `/` / `?`.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Row 1 search button in Navbar dispatches this event on click — the single
  // bridge between the visible chrome trigger and the palette state.
  useEffect(() => {
    const openListener = () => setOpen(true);
    window.addEventListener("visiban:open-palette", openListener);
    return () => window.removeEventListener("visiban:open-palette", openListener);
  }, []);

  // Adaptive placeholder per surface. Matches the navbar trigger copy so the
  // user sees the same words before and after the palette opens.
  const placeholder = (() => {
    if (inBoardRoute) return "Search cards, boards, actions…";
    if (pathname === "/" || pathname.startsWith("/groups/")) return "Jump to board…";
    return "Jump to…";
  })();

  const handleClose = useCallback(() => setOpen(false), []);

  const handleOpenCard = useCallback((card: Card) => {
    window.dispatchEvent(new CustomEvent("visiban:open-card", { detail: { cardId: card.id } }));
  }, []);

  const handleAction = useCallback((actionId: string) => {
    if (actionId === "shortcuts") {
      window.dispatchEvent(new Event("visiban:open-shortcuts"));
      return;
    }
    if (actionId === "my-cards") {
      window.dispatchEvent(new Event("visiban:filter-my-cards"));
      return;
    }
    if (actionId === "history") {
      window.dispatchEvent(new Event("visiban:show-history"));
      return;
    }
    if (actionId === "settings") {
      window.dispatchEvent(new Event("visiban:open-settings"));
      return;
    }
  }, []);

  if (boardMode && board) {
    return (
      <CommandPalette
        open={open}
        boardCards={board.cards}
        columns={board.columns}
        isAdmin={isAdmin}
        placeholder={placeholder}
        onClose={handleClose}
        onOpenCard={handleOpenCard}
        onAction={handleAction}
      />
    );
  }

  // Off-board surfaces — no board context available or the board route is
  // mid-load. Palette renders in jump mode: boards + global actions. Board
  // navigation is handled inside CommandPalette via react-router.
  return (
    <CommandPalette
      open={open}
      placeholder={placeholder}
      onClose={handleClose}
      onAction={handleAction}
    />
  );
}
