import { useState, useEffect, useCallback, useRef } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { completeTour } from "../../api/auth";

interface TourStep {
  selector: string;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    selector: '[data-tour-step="swimlane"]',
    title: "Swimlanes are your clients",
    body: "Each row on the board represents a client or workstream. Cards move across columns within a swimlane so you always know where each client stands.",
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

export default function OnboardingTour({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const completingRef = useRef(false);

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

  // Locate the target element for the current step
  useEffect(() => {
    const findTarget = () => {
      const el = document.querySelector(STEPS[step].selector);
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
      const el = document.querySelector(STEPS[step].selector);
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

  if (!targetRect) return null;

  const pos = getTooltipPosition(targetRect);
  const currentStep = STEPS[step];
  const padding = 8;

  return (
    <div className="fixed inset-0 z-50" data-testid="onboarding-tour">
      {/* Backdrop with cutout — uses CSS clip-path to create a spotlight effect */}
      <div
        className="absolute inset-0 bg-black/60"
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
        onClick={finish}
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
            className="text-xs text-fg-tertiary hover:text-white transition"
          >
            Skip tour
          </button>
        </div>
        <h3 className="text-sm font-medium text-fg mb-1">{currentStep.title}</h3>
        <p className="text-sm text-fg-tertiary mb-4">{currentStep.body}</p>
        <div className="flex justify-end">
          <button
            onClick={handleNext}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {step < STEPS.length - 1 ? "Next" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
