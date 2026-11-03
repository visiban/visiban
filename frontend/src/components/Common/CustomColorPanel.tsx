import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { HexColorInput, HexColorPicker } from "react-colorful";
import { normalizeHex } from "../../constants/colors";

const HEX_MESSAGE = "Use 3 or 6 hex digits.";
const RGB_MESSAGE = "R, G and B go from 0 to 255.";
const CHANNELS = [
  { short: "R", name: "Red" },
  { short: "G", name: "Green" },
  { short: "B", name: "Blue" },
] as const;

const INPUT_BASE =
  "w-full min-w-0 bg-surface border rounded px-3 py-1.5 text-sm max-sm:text-base text-fg-secondary placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis [@media(pointer:coarse)]:h-11";

/** A danger border stays visible on focus; otherwise the standard transparent one. */
function inputClass(invalid: boolean): string {
  return `${INPUT_BASE} ${invalid ? "border-danger focus:border-danger" : "border-line focus:border-transparent"}`;
}

function hexToChannels(hex: string): string[] {
  return [1, 3, 5].map((start) => String(parseInt(hex.slice(start, start + 2), 16)));
}

function channelsToHex(channels: string[]): string {
  return `#${channels.map((v) => Number(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const channelOver = (v: string) => v !== "" && Number(v) > 255;

interface Props {
  /** The committed color. Seeds the draft at mount; later changes are ignored. */
  value: string | null | undefined;
  /** Seeds the draft when `value` is not a valid 3- or 6-digit hex. */
  fallbackColor: string;
  /**
   * Fires only on Apply, with canonical `#RRGGBB`. Never on a drag or a keystroke:
   * `CardDetail`'s label row creates a label on every change it hears.
   */
  onChange: (color: string) => void;
  onCancel: () => void;
  /** Wording of the primary button, for a host where applying does more ("Create label"). */
  applyLabel?: string;
  /** Moves focus to the square when this turns true: a host that places itself first passes `top !== null`. */
  focusSquare?: boolean;
}

/**
 * The body of the custom color control (#2095): a saturation square and hue slider
 * with hex and R/G/B fields, holding a draft until Apply. It is deliberately body-only.
 * Positioning, dismissal and Escape belong to the host (`ColorSwatchPicker`'s swatch
 * popover, or an inline host), so one panel fits every surface. The only key handling
 * here is what keeps the draft and the host safe: Enter applies instead of submitting
 * a host form, and keys other than Escape and Tab stay inside, because a document-level
 * shortcut would otherwise fire on an arrow key pressed in a slider.
 */
export default function CustomColorPanel({
  value,
  fallbackColor,
  onChange,
  onCancel,
  applyLabel = "Apply",
  focusSquare = false,
}: Props) {
  const [seed] = useState(() => normalizeHex(value) ?? normalizeHex(fallbackColor) ?? "#000000");
  const [draft, setDraft] = useState(seed);
  // The raw hex digits, which may be partial or 3-digit. Handing them back to
  // HexColorInput as its `color` is what stops its blur handler reverting a partial
  // value: the revert target is the partial value itself, so the field keeps what the
  // user typed while the message explains it.
  const [hexText, setHexText] = useState(seed.slice(1));
  const [channels, setChannels] = useState(() => hexToChannels(seed));
  const [hexRevealed, setHexRevealed] = useState(false);
  const [emptyRevealed, setEmptyRevealed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const messageId = useId();

  const parsedHex = normalizeHex(hexText);
  const hexInvalid = parsedHex === null;
  const anyOver = channels.some(channelOver);
  const anyEmpty = channels.some((v) => v === "");
  const applyBlocked = hexInvalid || anyOver || anyEmpty;
  const showHexError = hexInvalid && hexRevealed;
  const showRgbError = anyOver || (anyEmpty && emptyRevealed);
  const message = showRgbError ? RGB_MESSAGE : showHexError ? HEX_MESSAGE : "";

  const squareEl = () =>
    rootRef.current?.querySelector<HTMLElement>('.react-colorful__saturation [role="slider"]') ?? null;

  // The library names the square "Color" with no prop to change it, and only ever
  // sets that attribute once, so a patch by ref survives its re-renders.
  useLayoutEffect(() => {
    squareEl()?.setAttribute("aria-label", "Saturation and brightness");
  }, []);

  useEffect(() => {
    if (focusSquare) squareEl()?.focus();
  }, [focusSquare]);

  const syncFromValidHex = (hex: string) => {
    setDraft(hex);
    setChannels(hexToChannels(hex));
    setHexRevealed(false);
    setEmptyRevealed(false);
  };

  const onPickerChange = (picked: string) => {
    const hex = normalizeHex(picked);
    if (!hex) return;
    setHexText(hex.slice(1));
    syncFromValidHex(hex);
  };

  const onHexInput = (raw: string) => {
    const digits = raw.replace(/[^0-9a-f]/gi, "").slice(0, 6);
    setHexText(digits);
    const hex = normalizeHex(digits);
    if (hex) syncFromValidHex(hex);
  };

  const onChannelChange = (index: number, raw: string) => {
    const next = channels.map((v, i) => (i === index ? raw.replace(/\D/g, "").slice(0, 3) : v));
    setChannels(next);
    if (next.every((v) => v !== "" && !channelOver(v))) {
      const hex = channelsToHex(next);
      setDraft(hex);
      setHexText(hex.slice(1));
      setHexRevealed(false);
      setEmptyRevealed(false);
    }
  };

  const attemptApply = () => {
    if (hexInvalid) setHexRevealed(true);
    if (anyEmpty) setEmptyRevealed(true);
    if (!applyBlocked && parsedHex) onChange(parsedHex);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Escape belongs to the escape stack and Tab to the host's focus trap, both at
    // document level. Nothing else may leave: see the component comment.
    if (e.key === "Escape" || e.key === "Tab") return;
    e.stopPropagation();
    if (e.key !== "Enter" || e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    // A held Enter that opened the panel from its trigger repeats onto the square.
    if (!e.repeat) attemptApply();
  };

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="Color value"
      onKeyDown={onKeyDown}
      className="custom-color-panel w-[200px] flex flex-col gap-2"
    >
      <HexColorPicker color={draft} onChange={onPickerChange} />
      <div className="flex gap-2">
        <span
          aria-hidden="true"
          data-testid="custom-color-preview"
          className="w-8 h-8 shrink-0 rounded border border-line-strong self-center"
          style={{ backgroundColor: draft }}
        />
        <HexColorInput
          prefixed
          color={hexText}
          onInput={(e) => onHexInput(e.currentTarget.value)}
          onBlur={() => setHexRevealed(true)}
          aria-label="Hex value"
          aria-invalid={showHexError || undefined}
          aria-describedby={showHexError ? messageId : undefined}
          className={`flex-1 uppercase ${inputClass(showHexError)}`}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {CHANNELS.map(({ short, name }, i) => {
          const channel = channels[i] ?? "";
          const invalid = channelOver(channel) || (channel === "" && emptyRevealed);
          return (
            <label key={short} className="text-xs text-fg-tertiary">
              <span aria-hidden="true" className="block mb-1">{short}</span>
              <input
                type="text"
                inputMode="numeric"
                maxLength={3}
                value={channel}
                aria-label={name}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? messageId : undefined}
                onChange={(e) => onChannelChange(i, e.target.value)}
                onBlur={() => { if (channel === "") setEmptyRevealed(true); }}
                className={inputClass(invalid)}
              />
            </label>
          );
        })}
      </div>
      <p id={messageId} role="status" aria-live="polite" aria-atomic="true" className="text-xs min-h-4 text-danger">
        {message}
      </p>
      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Cancel
        </button>
        <button
          type="button"
          aria-disabled={applyBlocked || undefined}
          // Keeps focus in a partial hex field, so the click reports on what was typed.
          onMouseDown={(e) => { if (applyBlocked) e.preventDefault(); }}
          onClick={attemptApply}
          className={`text-sm font-medium bg-button-primary text-on-primary px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
            applyBlocked ? "opacity-40 cursor-not-allowed" : "hover:bg-button-primary-hover"
          }`}
        >
          {applyLabel}
        </button>
      </div>
    </div>
  );
}
