import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SetURLSearchParams } from "react-router-dom";
import type { CardDensity } from "../types";
import {
  effectiveDisplay,
  getBoardPreset,
  inferActivePresetId,
  parsePresetParam,
  planPresetApply,
  presetDifferences,
  type BoardPreset,
  type BoardPresetId,
  type PresetApplyPlan,
  type PresetBoard,
  type PresetDifference,
  type PresetDisplay,
} from "../boardPresets/registry";

/** The URL parameter that makes a preset link-shareable, like `?view=`. */
export const PRESET_PARAM = "preset";

interface Args {
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
  sessionPresetId: BoardPresetId | null;
  urlPresetId: BoardPresetId | null;
}

export interface PresetNotice {
  /** Bumped on every apply, so a second apply restarts the notice's timer. */
  id: number;
  message: string;
  snapshot: Snapshot;
}

export interface BoardPresetState {
  /** Density and overlay the board renders. The one place they are resolved. */
  display: PresetDisplay;
  activePreset: BoardPreset | null;
  /** What differs from `activePreset`; empty when unmodified or none is active. */
  differences: PresetDifference[];
  applyPreset: (id: BoardPresetId, reason: "apply" | "reset") => void;
  notice: PresetNotice | null;
  undoNotice: () => void;
  dismissNotice: () => void;
}

/**
 * Board presets in the board view (#1146).
 *
 * Precedence, from the 2026-11-01 architect ruling: `?preset=`, then the member's
 * own choice, then the board's default preset. Opening a `?preset=` link *applies*
 * that preset (writes the two per-user keys), so it beats whatever the member had;
 * a member's keys beat the board default element by element (`effectiveDisplay`).
 *
 * Which preset is "active" comes from this tab's choice when there is one (a link
 * or the picker), otherwise from `inferActivePresetId`. The choice is held in memory
 * only: the architect ruling allows no new persisted state beyond the two keys and
 * `Board.default_preset`.
 *
 * Once the active preset is modified, `?preset=` is dropped from the URL: the link
 * would no longer describe the board on screen, and a reload must not silently
 * throw the member's changes away by applying the preset again.
 */
export function useBoardPreset({
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
  const [notice, setNotice] = useState<PresetNotice | null>(null);
  const noticeSeq = useRef(0);
  // The `?preset=` value already applied in this tab, so the same link value is
  // applied once, not on every render (or twice under StrictMode).
  const appliedUrlRef = useRef<BoardPresetId | null>(null);

  const user = { densityOverride, localOverlay };
  const display = effectiveDisplay(board, user);
  const activePresetId = sessionPresetId ?? inferActivePresetId(board, user);
  const activePreset = getBoardPreset(activePresetId);
  const differences = activePreset ? presetDifferences(activePreset, board, display) : [];

  // Setters from the density hook are recreated every render; read them from a
  // ref so the effects below need not re-run for that.
  const writersRef = useRef({ setDensityOverride, setLocalOverlay, clearLocalOverlay, board });
  writersRef.current = { setDensityOverride, setLocalOverlay, clearLocalOverlay, board };

  const writePlan = useCallback((plan: PresetApplyPlan) => {
    const w = writersRef.current;
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
    writePlan(planPresetApply(preset, writersRef.current.board));
    setSessionPresetId(urlPresetId);
  }, [urlPresetId, writePlan]);

  const isModified = differences.length > 0;
  useEffect(() => {
    // Only for the preset the link applied: before the layout effect above has run,
    // the active preset is still the inferred one and its state says nothing about
    // the link.
    if (isModified && urlPresetId !== null && sessionPresetId === urlPresetId) setUrlPreset(null);
  }, [isModified, urlPresetId, sessionPresetId, setUrlPreset]);

  const applyPreset = useCallback(
    (id: BoardPresetId, reason: "apply" | "reset") => {
      const preset = getBoardPreset(id);
      if (!preset) return;
      const snapshot: Snapshot = { densityOverride, localOverlay, sessionPresetId, urlPresetId };
      writePlan(planPresetApply(preset, board));
      setSessionPresetId(id);
      setUrlPreset(id);
      noticeSeq.current += 1;
      setNotice({
        id: noticeSeq.current,
        message: reason === "reset" ? `Reset to “${preset.name}”` : `Applied “${preset.name}”`,
        snapshot,
      });
    },
    [board, densityOverride, localOverlay, sessionPresetId, urlPresetId, writePlan, setUrlPreset],
  );

  const undoNotice = useCallback(() => {
    if (!notice) return;
    const { snapshot } = notice;
    writePlan({ densityOverride: snapshot.densityOverride, localOverlay: snapshot.localOverlay });
    setSessionPresetId(snapshot.sessionPresetId);
    setUrlPreset(snapshot.urlPresetId);
    setNotice(null);
  }, [notice, writePlan, setUrlPreset]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { display, activePreset, differences, applyPreset, notice, undoNotice, dismissNotice };
}
