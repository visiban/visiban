import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useOptionalBoardContext } from "../../contexts/BoardContext";
import CommandPalette, { type StaticAction } from "./CommandPalette";
import type { BoardPresetId, Card } from "../../types";
import { listBoardPresets } from "../../boardPresets/registry";
import { PRESET_COMMAND_EVENT, useActivePreset, type PresetCommand } from "../../boardPresets/activePresetStore";
import {
  CARD_ACTION_EVENT, CARD_TARGET_QUERY_EVENT, focusedCardFaceId,
  type CardActionDetail, type CardTargetInfo, type CardTargetQueryDetail,
} from "../../utils/cardActions";

/** Asks the board (BoardView) for a card target over the window-event contract (#2059). */
function queryCardTarget(detail: CardTargetQueryDetail): CardTargetInfo | null {
  window.dispatchEvent(new CustomEvent(CARD_TARGET_QUERY_EVENT, { detail }));
  return detail.response ?? null;
}

/** Action-id prefix for "Apply preset: …" (#1146); the preset id follows the colon. */
const PRESET_APPLY_PREFIX = "preset-apply:";
const PRESET_RESET_ID = "preset-reset";

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
export default function GlobalCommandPalette({ userId }: { userId?: number | null } = {}) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  // Card-scoped commands (#2059): the target is resolved once, as the palette
  // opens, while the card that had keyboard focus still has it. Hover is
  // never a target.
  const [cardTarget, setCardTarget] = useState<CardTargetInfo | null>(null);
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
  const openPalette = useCallback(() => {
    const focusedCardId = focusedCardFaceId(document.activeElement);
    setCardTarget(inBoardRoute ? queryCardTarget({ focusedCardId }) : null);
    setOpen(true);
  }, [inBoardRoute]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (openRef.current) setOpen(false);
        else openPalette();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [openPalette]);

  // Row 1 search button in Navbar dispatches this event on click — the single
  // bridge between the visible chrome trigger and the palette state.
  useEffect(() => {
    const openListener = () => openPalette();
    window.addEventListener("visiban:open-palette", openListener);
    return () => window.removeEventListener("visiban:open-palette", openListener);
  }, [openPalette]);

  // Adaptive placeholder per surface. Matches the navbar trigger copy so the
  // user sees the same words before and after the palette opens.
  const placeholder = (() => {
    if (inBoardRoute) return "Search cards, boards, actions…";
    if (pathname === "/" || pathname.startsWith("/groups/")) return "Jump to board…";
    return "Jump to…";
  })();

  // #1146 — the open board's active preset, published by BoardView. The active
  // preset is never offered as "Apply": unmodified it would do nothing, and
  // modified it is offered as "Reset to preset: …" instead.
  const activePreset = useActivePreset();
  const presetActions = useMemo((): StaticAction[] => {
    if (!board) return [];
    const snap = activePreset && activePreset.boardId === board.id ? activePreset : null;
    const actions: StaticAction[] = listBoardPresets()
      .filter((p) => p.id !== snap?.activePresetId)
      .map((p) => ({ id: `${PRESET_APPLY_PREFIX}${p.id}`, label: `Apply preset: ${p.name}`, boardOnly: true }));
    const active = snap?.modified ? listBoardPresets().find((p) => p.id === snap.activePresetId) : undefined;
    if (active) actions.push({ id: PRESET_RESET_ID, label: `Reset to preset: ${active.name}`, boardOnly: true });
    return actions;
  }, [board, activePreset]);

  const handleClose = useCallback(() => setOpen(false), []);

  const handleOpenCard = useCallback((card: Card) => {
    window.dispatchEvent(new CustomEvent("visiban:open-card", { detail: { cardId: card.id } }));
  }, []);

  const resolveCardActions = useCallback((cardIds: number[]) => queryCardTarget({ cardIds }), []);
  const handleCardAction = useCallback((detail: CardActionDetail) => {
    window.dispatchEvent(new CustomEvent(CARD_ACTION_EVENT, { detail }));
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
    if (actionId === PRESET_RESET_ID || actionId.startsWith(PRESET_APPLY_PREFIX)) {
      const detail: PresetCommand = actionId === PRESET_RESET_ID
        ? { kind: "reset" }
        : { kind: "apply", presetId: actionId.slice(PRESET_APPLY_PREFIX.length) as BoardPresetId };
      window.dispatchEvent(new CustomEvent<PresetCommand>(PRESET_COMMAND_EVENT, { detail }));
      return;
    }
  }, []);

  if (boardMode && board) {
    return (
      <CommandPalette
        open={open}
        userId={userId}
        boardCards={board.cards}
        columns={board.columns}
        members={board.members}
        cardTarget={cardTarget}
        resolveCardActions={resolveCardActions}
        onCardAction={handleCardAction}
        isAdmin={isAdmin}
        placeholder={placeholder}
        onClose={handleClose}
        onOpenCard={handleOpenCard}
        onAction={handleAction}
        presetActions={presetActions}
      />
    );
  }

  // Off-board surfaces — no board context available or the board route is
  // mid-load. Palette renders in jump mode: boards + global actions. Board
  // navigation is handled inside CommandPalette via react-router.
  return (
    <CommandPalette
      open={open}
      userId={userId}
      placeholder={placeholder}
      onClose={handleClose}
      onAction={handleAction}
    />
  );
}
