import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SetURLSearchParams } from "react-router-dom";
import type { CardDensity } from "../types";
import {
  effectiveDisplay,
  getBoardPreset,
  parsePresetParam,
  planPresetApply,
  presetDifferences,
  resolveActivePresetId,
  type BoardPreset,
  type BoardPresetId,
  type PresetApplyPlan,
  type PresetBoard,
  type PresetDifference,
  type PresetDisplay,
} from "../boardPresets/registry";
import { publishActivePreset } from "../boardPresets/activePresetStore";

/** The URL parameter that makes a preset link-shareable, like `?view=`. */
export const PRESET_PARAM = "preset";

/**
 * Per-user marker of the preset that last wrote this board's density and overlay
 * keys. It is what tells a preset the member applied apart from the member's own
 * 1.2 settings, which may hold the same values. Absent = the keys, if any, are the
 * member's own (or the board default applies).
 */
export function presetMarkerKey(boardId: number): string {
  return `board:${boardId}:preset`;
}

function loadMarker(boardId: number): BoardPresetId | null {
  try {
    return getBoardPreset(localStorage.getItem(presetMarkerKey(boardId)))?.id ?? null;
  } catch {
    return null;
  }
}

function saveMarker(boardId: number, id: BoardPresetId | null): void {
  try {
    if (id === null) localStorage.removeItem(presetMarkerKey(boardId));
    else localStorage.setItem(presetMarkerKey(boardId), id);
  } catch {
    // localStorage unavailable (private browsing, quota exceeded) — fail silently
  }
}

/** The marker an apply of `preset` records: none for the board default. */
function markerFor(preset: BoardPreset, board: PresetBoard): BoardPresetId | null {
  return preset.id === board.default_preset ? null : preset.id;
}

interface Args {
  boardId: number;
  board: PresetBoard;
  densityOverride: CardDensity | null;
  setDensityOverride: (value: CardDensity | null) => void;
  localOverlay: string | null;
  setLocalOverlay: (overlayId: string | null) => void;
  clearLocalOverlay: () => void;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
}

/** What one apply replaced, so its notice can undo it. */
interface Snapshot {
  /** The board the apply wrote to; Undo never writes anywhere else. */
  boardId: number;
  densityOverride: CardDensity | null;
  localOverlay: string | null;
  marker: BoardPresetId | null;
  linkPresetId: BoardPresetId | null;
  urlPresetId: BoardPresetId | null;
}

export interface PresetNotice {
  /** Bumped on every apply, so a second apply restarts the notice's timer. */
  id: number;
  message: string;
  /** `link` = applied by opening a `?preset=` link, which the member did not start. */
  reason: "apply" | "reset" | "link";
  snapshot: Snapshot;
}

/**
 * Where the density on screen comes from, when a preset supplies it: `own-key` when
 * a preset this member applied wrote their personal density key, `board-default`
 * when the board's default preset sets it and the member has no key. `null` when
 * the density is the member's own choice or the board's own setting.
 */
export type PresetDensitySource =
  | {
      presetName: string;
      via: "own-key" | "board-default";
      /** `own-key` only: whether removing the key changes the density, which is
       *  when "turn this off" would leave the preset modified. */
      offChangesDensity?: boolean;
      /** `own-key` only: what the density falls back to without the key — the
       *  board default preset's density, or the board's own `card_density`. */
      offFallsBackTo?: "board-default-preset" | "board";
    }
  | null;

export interface BoardPresetState {
  /** Density and overlay the board renders. The one place they are resolved. */
  display: PresetDisplay;
  activePreset: BoardPreset | null;
  /** What differs from `activePreset`; empty when unmodified or none is active. */
  differences: PresetDifference[];
  densitySource: PresetDensitySource;
  applyPreset: (id: BoardPresetId, reason: "apply" | "reset") => void;
  notice: PresetNotice | null;
  undoNotice: () => void;
  dismissNotice: () => void;
}

function noticeMessage(preset: BoardPreset, reason: "apply" | "reset" | "link"): string {
  if (reason === "reset") return `Reset to “${preset.name}”`;
  if (reason === "link") return `Applied “${preset.name}” from the link`;
  return `Applied “${preset.name}”`;
}

/**
 * Board presets in the board view (#1146).
 *
 * Precedence, from the 2026-11-01 architect ruling: `?preset=`, then the member's
 * own choice, then the board's default preset. Opening a `?preset=` link *applies*
 * that preset (writes the two per-user keys, with the same Undo notice as the
 * picker), so it beats whatever the member had; a member's keys beat the board
 * default element by element (`effectiveDisplay`).
 *
 * The active preset is the one recorded by the per-user marker (`presetMarkerKey`),
 * else the board default, resolved from those current inputs on every render, so a
 * tab and a reload always agree. Applying the board default records no marker, so
 * a member who chose it follows the board default when an admin changes it. It is
 * never guessed from the keys' values, which a member may have set themselves in
 * 1.2. No server state beyond `Board.default_preset`; the marker was accepted by
 * the owner ruling on #1146 (2026-11-03).
 *
 * All of this state belongs to one board. `App` remounts `BoardView` per board id,
 * and the hook also resets itself if `boardId` changes under it, so a preset, a
 * notice or an Undo can never cross from one board to another.
 *
 * Once the active preset is modified, `?preset=` is dropped from the URL: the link
 * would no longer describe the board on screen, and a reload must not silently
 * throw the member's changes away by applying the preset again.
 */
export function useBoardPreset({
  boardId,
  board,
  densityOverride,
  setDensityOverride,
  localOverlay,
  setLocalOverlay,
  clearLocalOverlay,
  searchParams,
  setSearchParams,
}: Args): BoardPresetState {
  const urlPresetId = parsePresetParam(searchParams.get(PRESET_PARAM));
  // The preset the current `?preset=` value stands for, once applied in this tab
  // (by the link itself or by the picker writing it). Drives dropping the param
  // once the preset is modified; never used to decide which preset is active.
  const [linkPresetId, setLinkPresetId] = useState<BoardPresetId | null>(null);
  const [marker, setMarkerState] = useState<BoardPresetId | null>(() => loadMarker(boardId));
  const [notice, setNotice] = useState<PresetNotice | null>(null);
  const noticeSeq = useRef(0);
  // The `?preset=` value already applied in this tab, so the same link value is
  // applied once, not on every render (or twice under StrictMode).
  const appliedUrlRef = useRef<BoardPresetId | null>(null);

  // Board switched under a mounted hook: drop everything that belonged to the
  // previous board (React's adjust-state-on-prop-change pattern).
  const [stateBoardId, setStateBoardId] = useState(boardId);
  if (stateBoardId !== boardId) {
    setStateBoardId(boardId);
    setLinkPresetId(null);
    setMarkerState(loadMarker(boardId));
    setNotice(null);
    appliedUrlRef.current = null;
  }

  const user = { densityOverride, localOverlay };
  const display = effectiveDisplay(board, user);
  const activePresetId = resolveActivePresetId(board, marker);
  const activePreset = getBoardPreset(activePresetId);
  const differences = activePreset ? presetDifferences(activePreset, board, display) : [];
  const isModified = differences.length > 0;

  const densityModified = differences.some((d) => d.element === "density");
  const boardDefault = getBoardPreset(board.default_preset);
  let densitySource: PresetDensitySource = null;
  if (activePreset && !densityModified) {
    if (densityOverride !== null && marker === activePreset.id) {
      const withoutKey = effectiveDisplay(board, { densityOverride: null, localOverlay }).density;
      densitySource = {
        presetName: activePreset.name,
        via: "own-key",
        offChangesDensity: withoutKey !== display.density,
        offFallsBackTo: boardDefault?.bundle.density != null ? "board-default-preset" : "board",
      };
    } else if (densityOverride === null && boardDefault?.id === activePreset.id && boardDefault.bundle.density !== null) {
      densitySource = { presetName: activePreset.name, via: "board-default" };
    }
  }

  // Setters from the density hook are recreated every render; read them and the
  // current values from a ref so the callbacks and effects below stay stable.
  const latestRef = useRef({ setDensityOverride, setLocalOverlay, clearLocalOverlay, board, boardId, densityOverride, localOverlay, marker, linkPresetId, urlPresetId });
  latestRef.current = { setDensityOverride, setLocalOverlay, clearLocalOverlay, board, boardId, densityOverride, localOverlay, marker, linkPresetId, urlPresetId };

  const setMarker = useCallback(
    (id: BoardPresetId | null) => {
      setMarkerState(id);
      saveMarker(boardId, id);
    },
    [boardId],
  );

  const writePlan = useCallback((plan: PresetApplyPlan) => {
    const w = latestRef.current;
    w.setDensityOverride(plan.densityOverride);
    if (plan.localOverlay === null) w.clearLocalOverlay();
    else w.setLocalOverlay(plan.localOverlay);
  }, []);

  const setUrlPreset = useCallback(
    (id: BoardPresetId | null) => {
      appliedUrlRef.current = id;
      setSearchParams(
        (prev) => {
          if (id === null) prev.delete(PRESET_PARAM);
          else prev.set(PRESET_PARAM, id);
          return prev;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  /**
   * Writes the preset's values and records it as applied. The board default is
   * recorded as no marker: its keys are cleared, so the member follows the board
   * default, and a later change of board default is followed too.
   */
  const commitApply = useCallback(
    (preset: BoardPreset, reason: "apply" | "reset" | "link", snapshotUrl: BoardPresetId | null) => {
      const w = latestRef.current;
      const snapshot: Snapshot = {
        boardId: w.boardId,
        densityOverride: w.densityOverride,
        localOverlay: w.localOverlay,
        marker: w.marker,
        linkPresetId: w.linkPresetId,
        urlPresetId: snapshotUrl,
      };
      writePlan(planPresetApply(preset, w.board));
      setMarker(markerFor(preset, w.board));
      setLinkPresetId(preset.id);
      noticeSeq.current += 1;
      setNotice({ id: noticeSeq.current, message: noticeMessage(preset, reason), reason, snapshot });
    },
    [writePlan, setMarker],
  );

  // A `?preset=` link (on load, or arriving by navigation) applies its preset.
  // Layout effect: the board must not paint one frame of the previous settings.
  useLayoutEffect(() => {
    if (urlPresetId === null) {
      appliedUrlRef.current = null;
      return;
    }
    if (appliedUrlRef.current === urlPresetId) return;
    appliedUrlRef.current = urlPresetId;
    const preset = getBoardPreset(urlPresetId);
    if (!preset) return;
    const w = latestRef.current;
    const plan = planPresetApply(preset, w.board);
    // The link already describes this member's stored state (typically: they
    // picked the preset, which wrote the param, then reloaded). Nothing changes,
    // so nothing is announced and there is nothing to undo.
    if (
      plan.densityOverride === w.densityOverride &&
      plan.localOverlay === w.localOverlay &&
      markerFor(preset, w.board) === w.marker
    ) {
      setLinkPresetId(preset.id);
      return;
    }
    // Undo drops the link too: the restored settings are not what it describes.
    commitApply(preset, "link", null);
  }, [urlPresetId, commitApply]);

  useEffect(() => {
    // Only once this tab has applied the preset the param names (linkPresetId is
    // state, so on the render before the layout effect above it is still unset
    // and says nothing about the link).
    if (isModified && urlPresetId !== null && linkPresetId === urlPresetId) {
      setLinkPresetId(null);
      setUrlPreset(null);
    }
  }, [isModified, urlPresetId, linkPresetId, setUrlPreset]);

  // The ⌘K palette lives outside the board view; tell it what is active. The card
  // face reads it too (`useClassicCardFace`, #871), so publish in a layout effect:
  // a passive one runs after paint, and a Default-preset board would flash the
  // Classic face for a frame on load. The cleanup is a layout effect as well, so
  // on a `key={board.id}` remount the old board's null runs before the new
  // board's publish instead of clobbering it.
  useLayoutEffect(() => {
    publishActivePreset({ boardId, activePresetId: activePreset?.id ?? null, modified: isModified });
  }, [boardId, activePreset, isModified]);
  useLayoutEffect(() => () => publishActivePreset(null), []);

  const applyPreset = useCallback(
    (id: BoardPresetId, reason: "apply" | "reset") => {
      const preset = getBoardPreset(id);
      if (!preset) return;
      commitApply(preset, reason, latestRef.current.urlPresetId);
      setUrlPreset(id);
    },
    [commitApply, setUrlPreset],
  );

  const undoNotice = useCallback(() => {
    if (!notice) return;
    const { snapshot } = notice;
    setNotice(null);
    // Defensive: a notice never outlives its board (see the reset above), but an
    // Undo must never write one board's snapshot into another board's keys.
    if (snapshot.boardId !== latestRef.current.boardId) return;
    writePlan({ densityOverride: snapshot.densityOverride, localOverlay: snapshot.localOverlay });
    setMarker(snapshot.marker);
    setLinkPresetId(snapshot.linkPresetId);
    setUrlPreset(snapshot.urlPresetId);
  }, [notice, writePlan, setMarker, setUrlPreset]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { display, activePreset, differences, densitySource, applyPreset, notice, undoNotice, dismissNotice };
}
