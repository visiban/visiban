import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import ToastRegion from "../components/Common/ToastRegion";
import { useEscapeStack } from "../hooks/useEscapeStack";
import { SlotContext, TOAST_ESCAPE_PRIORITY, ToastContext } from "./useToast";
import type { ToastApi } from "./useToast";
import {
  EMPTY_TOAST_STATE,
  UNDO_GUARD_MS,
  addToast,
  isAssertive,
  orderForDisplay,
  releaseGuard,
  removeToast,
  toastAnnouncement,
  toastDuration,
} from "../utils/toastQueue";
import type { ToastDismissReason, ToastInput, ToastRecord, ToastState, ToastTransition } from "../utils/toastQueue";

/**
 * Shared toast system (#2060, #1438). One provider at the app root owns the
 * stack; any component raises a toast with `useToast().notify(...)`.
 * Rules: frontend/CLAUDE.md § Toasts.
 */

/**
 * Where the region sits in the DOM, and so in the Tab order. BoardView mounts
 * it as the next sibling after the grid and before BulkActionToolbar, so one
 * Tab from the focused card reaches the first toast action. With no slot the
 * region renders at the end of the provider.
 */
export function ToastRegionSlot() {
  const register = useContext(SlotContext);
  return <div ref={register ?? undefined} data-toast-slot="" />;
}

let nextId = 1;
let nextSeq = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ToastState>(EMPTY_TOAST_STATE);
  const stateRef = useRef<ToastState>(EMPTY_TOAST_STATE);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<number>>(() => new Set());
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [docHidden, setDocHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");

  const regionRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const restoreFocusPending = useRef(false);
  /** Auto-dismiss deadline per toast id; cleared to restart the full delay. */
  const deadlines = useRef(new Map<number, number>());
  const guardTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const pendingAnnouncements = useRef<{ polite: string[]; assertive: string[] }>({ polite: [], assertive: [] });
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  // Both live regions are always mounted and filled one tick after being
  // cleared, so a repeated message is announced again (a region that receives
  // the same text, or mounts already holding it, is not reliably announced).
  const announce = useCallback((text: string, loud: boolean) => {
    const bucket = pendingAnnouncements.current[loud ? "assertive" : "polite"];
    if (!bucket.includes(text)) bucket.push(text);
    if (loud) setAssertive(""); else setPolite("");
    if (flushTimer.current !== null) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      const { polite: p, assertive: a } = pendingAnnouncements.current;
      pendingAnnouncements.current = { polite: [], assertive: [] };
      if (p.length > 0) setPolite(p.join(" "));
      if (a.length > 0) setAssertive(a.join(" "));
    }, 0);
  }, []);

  const clearTimers = useCallback((id: number) => {
    deadlines.current.delete(id);
    const g = guardTimers.current.get(id);
    if (g !== undefined) clearTimeout(g);
    guardTimers.current.delete(id);
  }, []);

  // Declared before `commit` uses it through the ref below.
  const releaseRef = useRef<(id: number) => void>(() => {});

  const startGuard = useCallback((t: ToastRecord) => {
    const old = guardTimers.current.get(t.id);
    if (old !== undefined) clearTimeout(old);
    guardTimers.current.delete(t.id);
    if (!t.guarded) return;
    guardTimers.current.set(t.id, setTimeout(() => {
      guardTimers.current.delete(t.id);
      releaseRef.current(t.id);
    }, UNDO_GUARD_MS));
  }, []);

  const markFocusLoss = (id: number) => {
    const el = regionRef.current?.querySelector(`[data-toast-id="${id}"]`);
    if (el && el.contains(document.activeElement)) restoreFocusPending.current = true;
  };

  const commit = useCallback((tr: ToastTransition) => {
    // Before the re-render: an evicted toast may hold focus.
    for (const t of tr.evicted) markFocusLoss(t.id);
    const waitingBefore = stateRef.current.queued.length;
    stateRef.current = tr.state;
    setState(tr.state);
    if (tr.state.visible.length === 0) {
      // The region unmounts; mouseleave and blur never fire for it.
      setHovered(false);
      setFocusWithin(false);
    }
    for (const t of tr.entered) {
      deadlines.current.delete(t.id);
      startGuard(t);
      if (t.announce !== false) announce(toastAnnouncement(t), isAssertive(t));
    }
    for (const { prev, next } of tr.replaced) {
      deadlines.current.delete(next.id);
      startGuard(next);
      const text = toastAnnouncement(next);
      if (next.announce !== false && text !== toastAnnouncement(prev)) announce(text, isAssertive(next));
    }
    for (const t of tr.evicted) {
      clearTimers(t.id);
      t.onDismiss?.("evicted");
    }
    // The +N waiting line is not live; say when the queue grows. Each waiting
    // toast is announced in full when it enters.
    const waiting = tr.state.queued.length;
    if (waiting > waitingBefore) {
      announce(`${waiting} more ${waiting === 1 ? "notification" : "notifications"} waiting.`, false);
    }
  }, [announce, clearTimers, startGuard]);

  releaseRef.current = (id: number) => {
    if (!mounted.current) return;
    commit(releaseGuard(stateRef.current, id));
  };

  const findToast = (id: number): ToastRecord | undefined =>
    stateRef.current.visible.find((t) => t.id === id) ?? stateRef.current.queued.find((t) => t.id === id);

  const close = useCallback((id: number, reason: ToastDismissReason) => {
    const t = findToast(id);
    if (!t) return;
    markFocusLoss(id);
    clearTimers(id);
    commit(removeToast(stateRef.current, id));
    t.onDismiss?.(reason);
  }, [clearTimers, commit]);

  const notify = useCallback((input: ToastInput) => {
    const rec: ToastRecord = {
      ...input,
      id: nextId++,
      seq: nextSeq++,
      rev: 0,
      guarded: Boolean(input.action?.undo),
    };
    const { visible, queued } = stateRef.current;
    // A replacement keeps the id of the toast it replaces.
    const existing = input.key === undefined ? undefined : [...visible, ...queued].find((t) => t.key === input.key);
    commit(addToast(stateRef.current, rec));
    return existing?.id ?? rec.id;
  }, [commit]);

  const dismiss = useCallback((keyOrId: string | number) => {
    const { visible, queued } = stateRef.current;
    const t = [...visible, ...queued].find((x) => (typeof keyOrId === "number" ? x.id === keyOrId : x.key === keyOrId));
    if (!t) return;
    markFocusLoss(t.id);
    clearTimers(t.id);
    commit(removeToast(stateRef.current, t.id));
  }, [clearTimers, commit]);

  const runAction = useCallback((t: ToastRecord) => {
    if (!t.action) return;
    const result = t.action.onAction();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      // Frozen while pending; the full delay restarts once it settles.
      deadlines.current.delete(t.id);
      setPendingIds((s) => new Set(s).add(t.id));
      void Promise.resolve(result).catch(() => {}).finally(() => {
        if (!mounted.current) return;
        deadlines.current.delete(t.id);
        setPendingIds((s) => {
          const n = new Set(s);
          n.delete(t.id);
          return n;
        });
      });
    }
  }, []);

  const paused = hovered || focusWithin || docHidden;

  // Pausing drops every deadline, so resuming restarts the full delay:
  // reading never costs the user the toast.
  useEffect(() => {
    if (paused) deadlines.current.clear();
  }, [paused]);

  useEffect(() => {
    if (paused) return;
    const handles: ReturnType<typeof setTimeout>[] = [];
    const now = Date.now();
    for (const t of state.visible) {
      if (pendingIds.has(t.id)) continue;
      const duration = toastDuration(t);
      if (duration === null) continue;
      let deadline = deadlines.current.get(t.id);
      if (deadline === undefined) {
        deadline = now + duration;
        deadlines.current.set(t.id, deadline);
      }
      handles.push(setTimeout(() => close(t.id, "timeout"), Math.max(0, deadline - now)));
    }
    return () => handles.forEach(clearTimeout);
  }, [state.visible, paused, pendingIds, close]);

  useEffect(() => {
    const onVisibility = () => setDocHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const guards = guardTimers.current;
    return () => {
      mounted.current = false;
      guards.forEach(clearTimeout);
      guards.clear();
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
    };
  }, []);

  // Dismissing a focused toast returns focus to where the user was before
  // entering the region, else the board grid, never <body>.
  useEffect(() => {
    // A removed node fires no blur, so recompute the focus-within pause from
    // where focus actually is after every change to the stack.
    setFocusWithin(Boolean(regionRef.current?.contains(document.activeElement)));
    if (!restoreFocusPending.current) return;
    restoreFocusPending.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) return;
    const back = returnFocusRef.current;
    if (back instanceof HTMLElement && back.isConnected) {
      back.focus();
      return;
    }
    (document.querySelector("[data-board-scroll]") as HTMLElement | null)?.focus();
  }, [state]);

  useEscapeStack(() => {
    const region = regionRef.current;
    const active = document.activeElement;
    if (!region || !active || !region.contains(active)) return false;
    const item = active.closest("[data-toast-id]") as HTMLElement | null;
    if (!item) return false;
    const t = findToast(Number(item.dataset.toastId));
    if (!t) return false;
    // Inside the Undo guard Escape is consumed but changes nothing.
    if (t.guarded) return;
    close(t.id, "user");
  }, TOAST_ESCAPE_PRIORITY);

  const api = useMemo<ToastApi>(() => ({ notify, dismiss }), [notify, dismiss]);

  const setRegion = useCallback((el: HTMLElement | null) => { regionRef.current = el; }, []);
  const onFocusIn = useCallback((from: Element | null) => {
    returnFocusRef.current = from;
    setFocusWithin(true);
  }, []);

  const region = (
    <ToastRegion
      toasts={orderForDisplay(state.visible)}
      waiting={state.queued.length}
      pendingIds={pendingIds}
      regionRef={setRegion}
      onClose={(id) => close(id, "user")}
      onAction={runAction}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusIn={onFocusIn}
      onFocusOut={() => setFocusWithin(false)}
    />
  );

  return (
    <ToastContext.Provider value={api}>
      <SlotContext.Provider value={setSlotEl}>
        {children}
        {slotEl ? createPortal(region, slotEl) : region}
        {/* Title + action count only, never a list, URL, secret or host. */}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="toast-announcer-polite">
          {polite}
        </div>
        <div role="alert" aria-atomic="true" className="sr-only" data-testid="toast-announcer-assertive">
          {assertive}
        </div>
      </SlotContext.Provider>
    </ToastContext.Provider>
  );
}
