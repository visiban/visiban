import { useState, useEffect, useCallback, useRef } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { completeTour } from "../../api/auth";

interface TourStep {
  selector: string;
  title: string;
  body: string;
  fullScreen?: true;
}

const STEPS: TourStep[] = [
  {
    selector: '[data-tour-step="view-tabs"]',
    title: "Switch between views",
    body: "Board, Summary, History, and Analytics give you different lenses on the same data. Use History to trace every card movement.",
  },
  {
    selector: '[data-tour-step="swimlane"]',
    title: "Swimlanes are your clients",
    body: "Each row on the board represents a client or workstream. Cards move across columns within a swimlane so you always know where each client stands.",
  },
  {
    selector: '[data-tour-step="swimlane-collapse"]',
    title: "Collapse lanes to focus",
    body: "Click the chevron on any swimlane to collapse it. Press C while hovering a row to collapse it with the keyboard.",
  },
  {
    selector: '[data-tour-step="card"]',
    title: "Drag cards to track progress",
    body: "Drag a card from one column to another to update its status. The board saves the move automatically.",
  },
  {
    selector: '[data-tour-step="history"]',
    title: "Every move is recorded",
    body: "Switch to the History view to see a complete audit trail of every card movement across the board.",
  },
  {
    selector: '[data-tour-step="filter"]',
    title: "Filter to focus",
    body: "Use the filter bar to narrow the board by assignee, label, priority, or due date. Press F to toggle filters quickly.",
  },
  {
    selector: '[data-tour-step="live-indicator"]',
    title: "Real-time updates",
    body: "The Live indicator shows your connection to the board. Changes from teammates appear instantly without a page reload.",
  },
  {
    selector: "",
    fullScreen: true,
    title: "Pan the board",
    body: "Hold Space and drag to pan across a wide board. This works anywhere on the board surface — no scrollbars needed.",
  },
];

interface TooltipPosition {
  top: number;
  left: number;
  arrowSide: "top" | "bottom";
}

function getTooltipPosition(rect: DOMRect): TooltipPosition {
  const tooltipWidth = 320;
  const tooltipHeight = 180;
  const gap = 12;

  // Prefer placing below the target element
  let top = rect.bottom + gap;
  let arrowSide: "top" | "bottom" = "top";

  // If not enough room below, place above
  if (top + tooltipHeight > window.innerHeight) {
    top = rect.top - tooltipHeight - gap;
    arrowSide = "bottom";
  }

  // Center horizontally relative to the target, clamped to viewport
  let left = rect.left + rect.width / 2 - tooltipWidth / 2;
  left = Math.max(16, Math.min(left, window.innerWidth - tooltipWidth - 16));

  return { top, left, arrowSide };
}

interface Props {
  onComplete: () => void;
}

// Centered card layout for full-screen steps (no specific DOM target to spotlight)
function FullScreenStep({
  step,
  currentStep,
  skip,
  finish,
}: {
  step: number;
  currentStep: TourStep;
  skip: () => void;
  finish: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={currentStep.title}
      className="fixed inset-0 z-50 bg-backdrop/60 flex items-center justify-center p-4"
      data-testid="onboarding-tour"
    >
      <div ref={panelRef} className="bg-surface border border-line rounded-lg shadow-xl w-full max-w-sm p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-tertiary">Step {step + 1} of {STEPS.length}</span>
          <button onClick={skip} className="text-xs text-fg-tertiary hover:text-fg transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded">Skip tour</button>
        </div>
        <div className="w-full h-28 bg-canvas rounded-lg flex items-center justify-center border border-line">
          <span className="text-4xl select-none" aria-hidden="true">✋</span>
        </div>
        <div>
          <h3 className="text-sm font-medium text-fg mb-1">{currentStep.title}</h3>
          <p className="text-sm text-fg-muted">{currentStep.body}</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <kbd className="inline-block bg-surface-hover text-fg font-mono px-1.5 py-0.5 rounded border border-line text-xs">Space</kbd>
          <span>+</span>
          <span>drag</span>
        </div>
        <div className="flex justify-end">
          <button autoFocus onClick={finish} className="bg-button-primary hover:bg-button-primary-hover text-on-primary text-sm font-medium px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Got it</button>
        </div>
      </div>
    </div>
  );
}

export default function OnboardingTour({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const completingRef = useRef(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  useFocusTrap(tooltipRef, !STEPS[step]?.fullScreen);

  const finish = useCallback(async () => {
    // Guard against double-fire (Escape + click racing)
    if (completingRef.current) return;
    completingRef.current = true;
    try {
      await completeTour();
    } catch {
      // Best-effort — tour still dismisses locally even if the API call fails.
      // The user will see the tour again on next page load, which is acceptable.
    }
    onComplete();
  }, [onComplete]);

  // skip is an alias for finish — both call the API and dismiss
  const skip = finish;

  // Locate the target element for the current step
  useEffect(() => {
    const currentStepDef = STEPS[step];

    // Full-screen steps bypass DOM target lookup
    if (currentStepDef.fullScreen) {
      setTargetRect(null);
      return;
    }

    const findTarget = () => {
      const el = document.querySelector(currentStepDef.selector);
      if (el) {
        setTargetRect(el.getBoundingClientRect());
      } else {
        // If target not found (e.g. board has no cards yet), skip to next step
        // or finish if this was the last step.
        if (step < STEPS.length - 1) {
          setStep((s) => s + 1);
        } else {
          finish();
        }
      }
    };

    findTarget();

    // Recalculate position on scroll or resize
    const recalc = () => {
      const el = document.querySelector(currentStepDef.selector);
      if (el) setTargetRect(el.getBoundingClientRect());
    };
    window.addEventListener("resize", recalc);
    window.addEventListener("scroll", recalc, true);
    return () => {
      window.removeEventListener("resize", recalc);
      window.removeEventListener("scroll", recalc, true);
    };
  }, [step, finish]);

  // Escape dismisses the tour — priority 40 (modal level)
  useEscapeStack(() => {
    finish();
  }, 40);

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      finish();
    }
  };

  const currentStep = STEPS[step];

  // Render centered card layout for full-screen steps
  if (currentStep.fullScreen) {
    return (
      <FullScreenStep
        step={step}
        currentStep={currentStep}
        skip={skip}
        finish={finish}
      />
    );
  }

  if (!targetRect) return null;

  const pos = getTooltipPosition(targetRect);
  const padding = 8;

  return (
    <div className="fixed inset-0 z-50" data-testid="onboarding-tour">
      {/* Backdrop with cutout — uses CSS clip-path to create a spotlight effect */}
      <div
        className="absolute inset-0 bg-backdrop/60"
        style={{
          clipPath: `polygon(
            0% 0%, 0% 100%, 100% 100%, 100% 0%,
            ${targetRect.left - padding}px 0%,
            ${targetRect.left - padding}px ${targetRect.top - padding}px,
            ${targetRect.right + padding}px ${targetRect.top - padding}px,
            ${targetRect.right + padding}px ${targetRect.bottom + padding}px,
            ${targetRect.left - padding}px ${targetRect.bottom + padding}px,
            ${targetRect.left - padding}px 0%
          )`,
        }}
        onClick={handleNext}
      />

      {/* Spotlight border around the target element */}
      <div
        className="absolute border-2 border-info rounded-lg pointer-events-none"
        style={{
          top: targetRect.top - padding,
          left: targetRect.left - padding,
          width: targetRect.width + padding * 2,
          height: targetRect.height + padding * 2,
        }}
      />

      {/* Tooltip */}
      <div
        ref={tooltipRef}
        role="dialog"
        aria-modal="true"
        aria-label={currentStep.title}
        className="absolute bg-surface border border-line rounded-lg shadow-xl p-4 z-50"
        style={{ top: pos.top, left: pos.left, width: 320 }}
        data-testid="tour-tooltip"
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-fg-tertiary">
            Step {step + 1} of {STEPS.length}
          </span>
          <button
            onClick={finish}
            className="text-xs text-fg-tertiary hover:text-fg transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
          >
            Skip tour
          </button>
        </div>
        <h3 className="text-sm font-medium text-fg mb-1">{currentStep.title}</h3>
        <p className="text-sm text-fg-tertiary mb-4">{currentStep.body}</p>
        <div className="flex justify-end">
          <button
            onClick={handleNext}
            className="bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium text-sm px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {step < STEPS.length - 1 ? "Next" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
