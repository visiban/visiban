import { useState, useRef } from "react";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export function useAutosaveStatus(): {
  status: AutosaveStatus;
  fadingOut: boolean;
  runSave: (p: Promise<void>) => Promise<void>;
} {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [fadingOut, setFadingOut] = useState(false);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    if (resetTimer.current) clearTimeout(resetTimer.current);
  };

  const runSave = async (p: Promise<void>) => {
    clearTimers();
    setFadingOut(false);
    setStatus("saving");
    try {
      await p;
      setStatus("saved");
      fadeTimer.current = setTimeout(() => setFadingOut(true), 1700);
      resetTimer.current = setTimeout(() => {
        setStatus("idle");
        setFadingOut(false);
      }, 2000);
    } catch {
      setStatus("error");
    }
  };

  return { status, fadingOut, runSave };
}
