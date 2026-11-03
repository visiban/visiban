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
  densityOverride: CardDensity | null;
  localOverlay: string | null;
  marker: BoardPresetId | null;
  sessionPresetId: BoardPresetId | null;
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
 * The active preset is this tab's choice when there is one, else the one recorded
 * by the per-user marker (`presetMarkerKey`), else the board default. It is never
 * guessed from the keys' values, which a member may have set themselves in 1.2.
 * No server state beyond `Board.default_preset`.
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
  const [sessionPresetId, setSessionPresetId] = useState<BoardPresetId | null>(null);
  const [marker, setMarkerState] = useState<BoardPresetId | null>(() => loadMarker(boardId));
  const [notice, setNotice] = useState<PresetNotice | null>(null);
  const noticeSeq = useRef(0);
  // The `?preset=` value already applied in this tab, so the same link value is
  // applied once, not on every render (or twice under StrictMode).
  const appliedUrlRef = useRef<BoardPresetId | null>(null);

  const user = { densityOverride, localOverlay };
  const display = effectiveDisplay(board, user);
  const activePresetId = sessionPresetId ?? resolveActivePresetId(board, marker);
  const activePreset = getBoardPreset(activePresetId);
  const differences = activePreset ? presetDifferences(activePreset, board, display) : [];
  const isModified = differences.length > 0;

  const densityModified = differences.some((d) => d.element === "density");
  const boardDefault = getBoardPreset(board.default_preset);
  let densitySource: PresetDensitySource = null;
  if (activePreset && !densityModified) {
    if (densityOverride !== null && marker === activePreset.id) {
      const withoutKey = effectiveDisplay(board, { densityOverride: null, localOverlay }).density;
      densitySource = { presetName: activePreset.name, via: "own-key", offChangesDensity: withoutKey !== display.density };
    } else if (densityOverride === null && boardDefault?.id === activePreset.id && boardDefault.bundle.density !== null) {
      densitySource = { presetName: activePreset.name, via: "board-default" };
    }
  }

  // Setters from the density hook are recreated every render; read them and the
  // current values from a ref so the callbacks and effects below stay stable.
  const latestRef = useRef({ setDensityOverride, setLocalOverlay, clearLocalOverlay, board, densityOverride, localOverlay, marker, sessionPresetId, urlPresetId });
  latestRef.current = { setDensityOverride, setLocalOverlay, clearLocalOverlay, board, densityOverride, localOverlay, marker, sessionPresetId, urlPresetId };

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
        densityOverride: w.densityOverride,
        localOverlay: w.localOverlay,
        marker: w.marker,
        sessionPresetId: w.sessionPresetId,
        urlPresetId: snapshotUrl,
      };
      writePlan(planPresetApply(preset, w.board));
      setMarker(preset.id === w.board.default_preset ? null : preset.id);
      setSessionPresetId(preset.id);
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
    // Undo drops the link too: the restored settings are not what it describes.
    commitApply(preset, "link", null);
  }, [urlPresetId, commitApply]);

  useEffect(() => {
    // Only for the preset the link applied: before the layout effect above has run,
    // the active preset is still the resolved one and its state says nothing about
    // the link.
    if (isModified && urlPresetId !== null && sessionPresetId === urlPresetId) setUrlPreset(null);
  }, [isModified, urlPresetId, sessionPresetId, setUrlPreset]);

  // The ⌘K palette lives outside the board view; tell it what is active.
  useEffect(() => {
    publishActivePreset({ boardId, activePresetId: activePreset?.id ?? null, modified: isModified });
  }, [boardId, activePreset, isModified]);
  useEffect(() => () => publishActivePreset(null), []);

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
    writePlan({ densityOverride: snapshot.densityOverride, localOverlay: snapshot.localOverlay });
    setMarker(snapshot.marker);
    setSessionPresetId(snapshot.sessionPresetId);
    setUrlPreset(snapshot.urlPresetId);
    setNotice(null);
  }, [notice, writePlan, setMarker, setUrlPreset]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { display, activePreset, differences, densitySource, applyPreset, notice, undoNotice, dismissNotice };
}
