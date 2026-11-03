import { createContext, useContext } from "react";
import type { ToastInput } from "../utils/toastQueue";

/** The shared toast API (#2060, #1438). Provider: `ToastProvider` in ToastContext.tsx. */
export interface ToastApi {
  /** Raise (or, with a matching `key`, replace) a toast. Returns its id. */
  notify: (input: ToastInput) => number;
  /** Owner-initiated removal by key or id. Does not call `onDismiss`. */
  dismiss: (keyOrId: string | number) => void;
}

const NOOP_API: ToastApi = { notify: () => -1, dismiss: () => {} };

export const ToastContext = createContext<ToastApi | null>(null);
export const SlotContext = createContext<((el: HTMLElement | null) => void) | null>(null);

/**
 * The toast API. Outside a `ToastProvider` (an isolated component test) it is
 * a no-op, so a component never has to guard for a missing provider.
 */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP_API;
}

/** Escape on a focused toast. Above the command palette (60): it returns `false` unless focus is in the region. */
export const TOAST_ESCAPE_PRIORITY = 61;
