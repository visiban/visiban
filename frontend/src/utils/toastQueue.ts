import type { ReactNode } from "react";

/**
 * The shared toast model (#2060, #1438; frontend/CLAUDE.md § Toasts).
 *
 * Pure functions only: which toasts are visible, which wait, which one a
 * newcomer evicts, and the order the region shows them in. Timers, focus and
 * announcements live in `ToastProvider`; everything here takes `now`-free
 * inputs so it can be unit-tested without fake timers.
 */

export type ToastVariant = "success" | "info" | "warning" | "blocked" | "danger";

export interface ToastAction {
  label: string;
  /** Label while a promise returned by `onAction` is pending ("Undoing…"). */
  pendingLabel?: string;
  /**
   * Runs the action. An action never dismisses its own toast: the caller
   * replaces it (same `key`) or dismisses it by key once the outcome is known.
   * A returned promise freezes the timer and marks the action `aria-disabled`
   * until it settles.
   */
  onAction: () => void | Promise<unknown>;
  /**
   * The toast holds the only path to an exact-state Undo: 12 s, and for its
   * first 5 s it cannot be dismissed or evicted.
   */
  undo?: boolean;
}

export type ToastDismissReason = "user" | "timeout" | "evicted";

export interface ToastInput {
  /**
   * Coalescing key (`move`, `unblock:42`). A new toast with the same key
   * replaces the old one in place and restarts its timer.
   */
  key?: string;
  variant: ToastVariant;
  /** The lead words: the result, the fact, or the refusal ("WIP limit reached"). */
  title: string;
  /** Body sentence after the title (`title — message`). */
  message?: string;
  /** Extra visible content under the message: hints, numbers, a list. Never announced. */
  details?: ReactNode;
  action?: ToastAction;
  /** Only `blocked` uses it: `⛔` for a hard limit, which stays reserved there. */
  hardGlyph?: boolean;
  /** Overrides the variant duration; `null` persists until dismissed. */
  durationMs?: number | null;
  /**
   * `false` when the surface that raised it already reported the outcome in
   * its own live region (a toast raised inside an `aria-modal` surface):
   * one live announcement per action.
   */
  announce?: boolean;
  /** Replaces the default announcement (title, message, action count). */
  announceText?: string;
  /** Runs when the toast leaves for any reason other than `dismiss(key)` by its owner. */
  onDismiss?: (reason: ToastDismissReason) => void;
  testId?: string;
}

export interface ToastRecord extends ToastInput {
  id: number;
  /** Insertion order; kept on an in-place replacement so the toast does not move. */
  seq: number;
  /** Bumped on each replacement so the provider restarts the timer. */
  rev: number;
  /** Inside the 5 s Undo guard. */
  guarded: boolean;
}

export interface ToastState {
  visible: ToastRecord[];
  queued: ToastRecord[];
}

export const EMPTY_TOAST_STATE: ToastState = { visible: [], queued: [] };

export const TOAST_CAP = 3;
export const UNDO_GUARD_MS = 5_000;

/** Auto-dismiss per variant; `null` persists. */
export const TOAST_DURATION_MS: Record<ToastVariant, number | null> = {
  success: 4_000,
  info: 6_000,
  warning: 8_000,
  blocked: null,
  danger: null,
};
export const UNDO_TOAST_MS = 12_000;

export function toastDuration(t: ToastInput): number | null {
  if (t.durationMs !== undefined) return t.durationMs;
  if (t.action?.undo && (t.variant === "warning" || t.variant === "info")) return UNDO_TOAST_MS;
  return TOAST_DURATION_MS[t.variant];
}

/**
 * Priority, high to low: danger = blocked > warning with action > warning >
 * info with action > info > success.
 */
export function toastRank(t: ToastInput): number {
  switch (t.variant) {
    case "danger":
    case "blocked":
      return 5;
    case "warning":
      return t.action ? 4 : 3;
    case "info":
      return t.action ? 2 : 1;
    default:
      return 0;
  }
}

/** Assertive for a refusal or a failure; polite for everything else. */
export function isAssertive(t: ToastInput): boolean {
  return t.variant === "blocked" || t.variant === "danger";
}

/** Never evicted: a refusal, a failure, or a toast inside its Undo guard. */
export function isProtected(t: ToastRecord): boolean {
  return t.variant === "blocked" || t.variant === "danger" || t.guarded;
}

function endWithStop(s: string): string {
  const trimmed = s.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Title, message, and how many actions the toast offers. Never a list or a URL. */
export function toastAnnouncement(t: ToastInput): string {
  if (t.announceText !== undefined) return t.announceText;
  const parts = [endWithStop(t.title)];
  if (t.message) parts.push(endWithStop(t.message));
  if (t.action) parts.push(`${t.action.label} available.`);
  return parts.join(" ");
}

/** Bottom of the stack first: highest priority, then newest. DOM order = Tab order. */
export function orderForDisplay(visible: ToastRecord[]): ToastRecord[] {
  return [...visible].sort((a, b) => toastRank(b) - toastRank(a) || b.seq - a.seq);
}

function pickVictim(visible: ToastRecord[]): ToastRecord | null {
  let victim: ToastRecord | null = null;
  for (const t of visible) {
    if (isProtected(t)) continue;
    if (!victim || toastRank(t) < toastRank(victim) || (toastRank(t) === toastRank(victim) && t.seq < victim.seq)) {
      victim = t;
    }
  }
  return victim;
}

function nextQueued(queued: ToastRecord[]): ToastRecord | null {
  let best: ToastRecord | null = null;
  for (const t of queued) {
    if (!best || toastRank(t) > toastRank(best) || (toastRank(t) === toastRank(best) && t.seq < best.seq)) best = t;
  }
  return best;
}

export interface ToastTransition {
  state: ToastState;
  /** Became visible in this step (added or promoted): announce, start timers. */
  entered: ToastRecord[];
  /** Replaced in place: announce only if the text changed, restart the timer. */
  replaced: { prev: ToastRecord; next: ToastRecord }[];
  /** Left the stack without the user asking. */
  evicted: ToastRecord[];
}

/**
 * Fill free slots from the queue; when the stack is full, a queued toast
 * evicts the lowest-priority, oldest unprotected visible one, provided that
 * one does not outrank it.
 */
export function rebalance(state: ToastState): ToastTransition {
  let { visible, queued } = state;
  const entered: ToastRecord[] = [];
  const evicted: ToastRecord[] = [];
  for (;;) {
    const head = nextQueued(queued);
    if (!head) break;
    if (visible.length >= TOAST_CAP) {
      const victim = pickVictim(visible);
      // Never trade a toast for a lower-priority one: it waits instead.
      if (!victim || toastRank(victim) > toastRank(head)) break;
      visible = visible.filter((t) => t !== victim);
      evicted.push(victim);
    }
    queued = queued.filter((t) => t !== head);
    visible = [...visible, head];
    entered.push(head);
  }
  return { state: { visible, queued }, entered, replaced: [], evicted };
}

/** Add a toast, coalescing by key, then apply the cap. */
export function addToast(state: ToastState, rec: ToastRecord): ToastTransition {
  if (rec.key !== undefined) {
    const vi = state.visible.findIndex((t) => t.key === rec.key);
    if (vi !== -1) {
      const prev = state.visible[vi];
      const next: ToastRecord = { ...rec, id: prev.id, seq: prev.seq, rev: prev.rev + 1 };
      const visible = [...state.visible];
      visible[vi] = next;
      return { state: { ...state, visible }, entered: [], replaced: [{ prev, next }], evicted: [] };
    }
    const qi = state.queued.findIndex((t) => t.key === rec.key);
    if (qi !== -1) {
      const prev = state.queued[qi];
      const queued = [...state.queued];
      queued[qi] = { ...rec, id: prev.id, seq: prev.seq, rev: prev.rev + 1 };
      return { state: { ...state, queued }, entered: [], replaced: [], evicted: [] };
    }
  }
  return rebalance({ ...state, queued: [...state.queued, rec] });
}

/** Remove a visible or queued toast by id, then promote from the queue. */
export function removeToast(state: ToastState, id: number): ToastTransition {
  const visible = state.visible.filter((t) => t.id !== id);
  const queued = state.queued.filter((t) => t.id !== id);
  return rebalance({ visible, queued });
}

/** Clear a toast's Undo guard, which may let a waiting toast evict it. */
export function releaseGuard(state: ToastState, id: number): ToastTransition {
  const visible = state.visible.map((t) => (t.id === id ? { ...t, guarded: false } : t));
  const queued = state.queued.map((t) => (t.id === id ? { ...t, guarded: false } : t));
  return rebalance({ visible, queued });
}
