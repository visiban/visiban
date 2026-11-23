/**
 * Colored dropdown and multi-select choices (#1391, MR C): the palette and its
 * contrast, the resolve/payload helpers, every read-only render site, the
 * settings swatch picker, and the settings payload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CHOICE_COLOR_KEYS,
  CHOICE_COLORS,
  choiceBadgeStyle,
  choiceColorBase,
  choiceColorLabel,
  choiceColorName,
  isChoiceColorKey,
  resolveChoiceColor,
} from "../constants/choiceColors";
import { colorChipStyle } from "../utils/colorContrast";
import { hasOpenDismissLayer } from "../utils/dismissLayer";
import { PALETTE_COLORS } from "../constants/colors";
import {
  choiceColor,
  choiceColorsPayload,
  draftChoiceColor,
  explicitChoiceColor,
  withChoiceColor,
  withoutChoiceColor,
} from "../utils/customFieldValue";
import CustomFieldValueDisplay from "../components/Card/CustomFieldValueDisplay";
import MultiSelectChips from "../components/Card/MultiSelectChips";
import ChoiceColorPicker, { CHOICE_COLOR_ESCAPE_PRIORITY } from "../components/Board/ChoiceColorPicker";
import ModalWrapper from "../components/shared/ModalWrapper";
import BoardSettingsFieldsTab from "../components/Board/BoardSettingsFieldsTab";
import type { BoardFull, CustomFieldDefinition, FieldDefinitionShape, User } from "../types";
import * as boardsApi from "../api/boards";

vi.mock("../api/boards", () => ({
  createCustomFieldDefinition: vi.fn(),
  updateCustomFieldDefinition: vi.fn(),
  deleteCustomFieldDefinition: vi.fn(),
  reorderCustomFields: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

function channels(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` mixed `alpha` over `under`, rounded per channel — how the badge bgs were derived. */
function mix(top: string, under: string, alpha: number): string {
  const t = channels(top);
  const u = channels(under);
  return "#" + t.map((v, i) => Math.round(alpha * v + (1 - alpha) * u[i]).toString(16).padStart(2, "0").toUpperCase()).join("");
}

describe("choice color palette (#1391)", () => {
  it("is exactly the eight agreed keys, in order", () => {
    expect([...CHOICE_COLOR_KEYS]).toEqual(["slate", "blue", "green", "amber", "red", "violet", "pink", "teal"]);
    expect(Object.keys(CHOICE_COLORS)).toEqual([...CHOICE_COLOR_KEYS]);
  });

  // Parity with the backend allowlist (boards/custom_field_types.py) is
  // asserted from the backend side — ChoiceColorKeyParityTests reads this
  // module's CHOICE_COLOR_KEYS line — because Vite's fs sandbox will not
  // import a file outside frontend/.

  it("uses the PALETTE_COLORS value of each hue as its swatch base", () => {
    expect(CHOICE_COLOR_KEYS.map((k) => CHOICE_COLORS[k].base)).toEqual(PALETTE_COLORS);
  });

  it("derives each badge background from its base (14% over white, 22% over slate-800)", () => {
    for (const key of CHOICE_COLOR_KEYS) {
      const spec = CHOICE_COLORS[key];
      expect(spec.light.bg, key).toBe(mix(spec.base, "#FFFFFF", 0.14));
      expect(spec.dark.bg, key).toBe(mix(spec.base, "#1E293B", 0.22));
    }
  });

  it.each(CHOICE_COLOR_KEYS.map((k) => [k]))("%s clears 4.5:1 (designed: 6.0:1) in both themes", (key) => {
    const spec = CHOICE_COLORS[key as keyof typeof CHOICE_COLORS];
    for (const pair of [spec.light, spec.dark]) {
      const ratio = contrast(pair.fg, pair.bg);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      expect(ratio).toBeGreaterThanOrEqual(6.0);
    }
  });

  it("exposes both theme pairs as custom properties, never as a fixed color", () => {
    const style = choiceBadgeStyle("red") as Record<string, string>;
    expect(style).toEqual({
      "--cf-bg-light": "#FDE5E5", "--cf-fg-light": "#991B1B",
      "--cf-bg-dark": "#4C2F3D", "--cf-fg-dark": "#FCA5A5",
    });
  });

  it("narrows only known keys and names them for screen readers", () => {
    expect(isChoiceColorKey("teal")).toBe(true);
    for (const bad of ["magenta", "", "#FF0000", "constructor", "__proto__", undefined, 3]) {
      expect(isChoiceColorKey(bad)).toBe(false);
    }
    expect(choiceColorName("violet")).toBe("Violet");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shape(overrides: Partial<FieldDefinitionShape> = {}): FieldDefinitionShape {
  return {
    name: "Severity", field_type: "dropdown", choices: ["Low", "High"], help_text: "",
    choice_colors: { High: "red" }, ...overrides,
  };
}

describe("choice color helpers (#1391)", () => {
  it("explicitChoiceColor returns a key only for a current choice with a known key", () => {
    expect(explicitChoiceColor(shape(), "High")).toBe("red");
    expect(explicitChoiceColor(shape(), "Low")).toBeNull(); // unset
    expect(explicitChoiceColor(shape({ choices: ["Low"] }), "High")).toBeNull(); // orphan
    expect(explicitChoiceColor(shape({ choice_colors: { High: "magenta" } }), "High")).toBeNull(); // unknown key
    expect(explicitChoiceColor(shape({ choice_colors: undefined }), "High")).toBeNull();
    expect(explicitChoiceColor(shape({ choices: ["constructor"], choice_colors: {} }), "constructor")).toBeNull();
  });

  it("choiceColorsPayload trims keys and drops blank choices, unknown keys and stale entries", () => {
    expect(choiceColorsPayload([" Low ", "High", ""], { " Low ": "green", High: "nope", "": "red", Gone: "blue" }))
      .toEqual({ Low: "green" });
  });

  it.each(["__proto__", "constructor", "toString"])("a choice named %s keeps its color through draft and payload", (name) => {
    const draft = withChoiceColor({}, name, "red");
    expect(Object.hasOwn(draft, name)).toBe(true);
    expect(draftChoiceColor(draft, name)).toBe("red");
    const payload = choiceColorsPayload([name, "Other"], draft);
    expect(Object.hasOwn(payload, name)).toBe(true);
    // What axios sends: the key survives serialization and parses back as own.
    const wire = JSON.stringify(payload);
    expect(wire).toBe(`{"${name}":"red"}`);
    expect(JSON.parse(wire)[name]).toBe("red");
    expect(Object.keys(JSON.parse(wire))).toEqual([name]);
    // Reading back from a server definition (JSON.parse gives an own key).
    expect(explicitChoiceColor(shape({ choices: [name], choice_colors: JSON.parse(wire) }), name)).toBe("red");
    expect(withoutChoiceColor(draft, name)).toEqual({});
    expect(Object.prototype).not.toHaveProperty("red");
    expect(({} as Record<string, unknown>).red).toBeUndefined();
  });

  it("an unset choice named like an Object.prototype member reads as no color", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(draftChoiceColor({}, name)).toBeUndefined();
      expect(choiceColorsPayload([name], {})).toEqual({});
      expect(explicitChoiceColor(shape({ choices: [name], choice_colors: {} }), name)).toBeNull();
      expect(withoutChoiceColor({ a: "red" }, name)).toEqual({ a: "red" });
    }
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it("withoutChoiceColor removes one entry and leaves the draft untouched otherwise", () => {
    const draft = { Low: "green", High: "red" };
    expect(withoutChoiceColor(draft, "High")).toEqual({ Low: "green" });
    expect(withoutChoiceColor(draft, "Missing")).toBe(draft);
  });
});

// ---------------------------------------------------------------------------
// Read-only renderers (row header + detail; the card face lives in
// cardItemCustomFields.test.tsx)
// ---------------------------------------------------------------------------

function badgeIn(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".cf-choice-badge");
}

describe("CustomFieldValueDisplay — colored choices (#1391)", () => {
  it.each(["chip", "row-chip", "detail"] as const)("%s: an explicit color renders a tinted badge with its label", (variant) => {
    const { container } = render(<CustomFieldValueDisplay definition={shape()} value="High" variant={variant} />);
    const badge = badgeIn(container);
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent("High");
    expect(badge).toHaveAttribute("data-choice-color", "red");
    expect(badge!.style.getPropertyValue("--cf-bg-light")).toBe("#FDE5E5");
    expect(badge!.style.getPropertyValue("--cf-fg-dark")).toBe("#FCA5A5");
    expect(badge!.className).toContain("rounded px-1.5 py-0.5 text-xs");
    // No automatic dot alongside an explicit color.
    expect(container.querySelector(".rounded-full")).toBeNull();
  });

  it.each(["chip", "row-chip"] as const)("%s: an unset color keeps the neutral chip and the hash dot, unchanged", (variant) => {
    const { container } = render(<CustomFieldValueDisplay definition={shape()} value="Low" variant={variant} />);
    expect(badgeIn(container)).toBeNull();
    const dot = container.querySelector<HTMLElement>(".rounded-full");
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute("aria-hidden", "true");
    // jsdom normalizes the hex to rgb(); compare against the same hash color.
    const probe = document.createElement("span");
    probe.style.backgroundColor = choiceColor("Low");
    expect(dot!.style.backgroundColor).toBe(probe.style.backgroundColor);
    expect(screen.getByText("Low")).toHaveClass("text-fg-secondary");
  });

  it("detail: an unset color stays plain text", () => {
    const { container } = render(<CustomFieldValueDisplay definition={shape()} value="Low" variant="detail" />);
    expect(badgeIn(container)).toBeNull();
    expect(screen.getByText("Low")).toHaveClass("text-fg-secondary");
  });

  it.each(["chip", "row-chip", "detail"] as const)("%s: an orphan or an unknown key renders neutral with its label", (variant) => {
    const orphan = render(<CustomFieldValueDisplay definition={shape({ choices: ["Low"] })} value="High" variant={variant} />);
    expect(badgeIn(orphan.container)).toBeNull();
    expect(orphan.container).toHaveTextContent("High");
    orphan.unmount();
    const unknown = render(
      <CustomFieldValueDisplay definition={shape({ choice_colors: { High: "chartreuse" } })} value="High" variant={variant} />,
    );
    expect(badgeIn(unknown.container)).toBeNull();
    expect(unknown.container).toHaveTextContent("High");
  });

  it("never tints a non-choice type, even with a stray map", () => {
    const { container } = render(
      <CustomFieldValueDisplay
        definition={shape({ field_type: "text", choices: [], choice_colors: { High: "red" } })}
        value="High"
        variant="chip"
      />,
    );
    expect(badgeIn(container)).toBeNull();
  });

  it("row-chip: multi-select entries tint per choice and the rest stay neutral", () => {
    const def = shape({ field_type: "multi_select", choices: ["web", "ios", "android"], choice_colors: { ios: "blue" } });
    const { container } = render(<CustomFieldValueDisplay definition={def} value='["web","ios","gone"]' variant="row-chip" />);
    const badges = container.querySelectorAll(".cf-choice-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("ios");
    expect(screen.getByTitle("web")).toHaveClass("bg-surface-hover");
    expect(screen.getByTitle("gone")).toHaveClass("bg-surface-hover");
  });
});

describe("CustomFieldValueDisplay — hideName (#1418)", () => {
  it("row-chip: a colored choice keeps its tinted badge with the name hidden", () => {
    const { container } = render(<CustomFieldValueDisplay definition={shape()} value="High" variant="row-chip" hideName />);
    expect(badgeIn(container)).toHaveTextContent("High");
    expect(screen.getByText("Severity:")).toHaveClass("sr-only");
    expect(screen.getByTitle("Severity: High")).toBeInTheDocument();
  });

  it("row-chip: an uncolored choice keeps its hash dot with the name hidden", () => {
    const { container } = render(<CustomFieldValueDisplay definition={shape()} value="Low" variant="row-chip" hideName />);
    expect(container.querySelector(".rounded-full")).not.toBeNull();
    expect(screen.getByText("Severity:")).toHaveClass("sr-only");
  });

  it("row-chip: multi-select sub-chips are unchanged with the name hidden", () => {
    const def = shape({ field_type: "multi_select", choices: ["web", "ios"], choice_colors: {} });
    render(<CustomFieldValueDisplay definition={def} value='["web","ios"]' variant="row-chip" hideName />);
    expect(screen.getByTitle("web")).toHaveClass("bg-surface-hover");
    expect(screen.getByTitle("ios")).toHaveClass("bg-surface-hover");
    expect(screen.getByText("Severity:")).toHaveClass("sr-only");
  });

  it("chip: the card face ignores hideName and always shows the name", () => {
    render(<CustomFieldValueDisplay definition={shape()} value="Low" variant="chip" hideName />);
    expect(screen.getByText("Severity:")).not.toHaveClass("sr-only");
  });
});

describe("MultiSelectChips — colored choices (#1391)", () => {
  it("without a definition every chip is neutral (pre-#1391 rendering)", () => {
    const { container } = render(<MultiSelectChips entries={["web", "ios"]} />);
    expect(container.querySelector(".cf-choice-badge")).toBeNull();
    expect(screen.getByTitle("web")).toHaveClass("bg-surface-hover", "text-fg-secondary");
  });

  it("keeps the card-face width cap and the full text on a tinted chip", () => {
    const def = shape({ field_type: "multi_select", choices: ["web", "ios"], choice_colors: { web: "green" } });
    render(<MultiSelectChips entries={["web", "ios"]} definition={def} max={2} />);
    const tinted = screen.getByTitle("web");
    expect(tinted).toHaveClass("cf-choice-badge", "max-w-[6rem]", "truncate", "min-w-0");
    expect(tinted).toHaveTextContent("web");
    expect(screen.getByTitle("ios")).toHaveClass("bg-surface-hover");
  });
});

// ---------------------------------------------------------------------------
// The swatch picker
// ---------------------------------------------------------------------------

describe("ChoiceColorPicker (#1391)", () => {
  it("shows Automatic for an unset choice and opens a radiogroup of the eight swatches", async () => {
    const user = userEvent.setup();
    render(<ChoiceColorPicker choice="Low" colorKey={undefined} onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Color for Low: Automatic" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Automatic is a hollow dashed circle — never a fill that reads as a pick.
    const swatch = trigger.querySelector("[data-swatch]") as HTMLElement;
    expect(swatch).toHaveAttribute("data-swatch", "automatic");
    expect(swatch).toHaveClass("border-dashed", "border-line-boundary");
    expect(swatch.style.backgroundColor).toBe("");
    expect(trigger).toHaveClass("p-0.5");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Color for Low" });
    expect(within(dialog).getByText("Automatic")).toBeInTheDocument();
    expect(within(dialog).getByRole("radiogroup", { name: "Palette" })).toBeInTheDocument();
    const radios = within(dialog).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(
      ["Slate", "Blue", "Green", "Amber", "Red", "Violet", "Pink", "Teal"],
    );
    expect(radios.every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    // Focus lands on the first swatch, the only tab stop.
    expect(radios[0]).toHaveFocus();
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it("marks the current color checked and focuses it", async () => {
    const user = userEvent.setup();
    render(<ChoiceColorPicker choice="High" colorKey="red" onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Color for High: Red" }));
    const trigger = screen.getByRole("button", { name: "Color for High: Red" });
    expect(trigger.querySelector("[data-swatch]")).toHaveAttribute("data-swatch", "red");
    expect(trigger.querySelector("[data-swatch]")).not.toHaveClass("border-dashed");
    const red = screen.getByRole("radio", { name: "Red" });
    expect(red).toHaveAttribute("aria-checked", "true");
    expect(red).toHaveFocus();
    expect(red.querySelector("svg")).not.toBeNull();
    // Selection is a ring as well as the check (the check is < 3:1 on light hues).
    expect(red).toHaveClass("ring-2", "ring-fg", "ring-offset-1");
    expect(screen.getByRole("radio", { name: "Amber" })).not.toHaveClass("ring-fg");
  });

  it("arrows move focus without selecting; Space and Enter select and close", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChoiceColorPicker choice="Low" colorKey={undefined} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /Color for Low/ }));
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Green" })).toHaveFocus();
    await user.keyboard("{ArrowDown}"); // next row of the 4-column grid
    expect(screen.getByRole("radio", { name: "Pink" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Violet" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("radio", { name: "Blue" })).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenCalledWith("blue");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Color for Low/ })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: /Color for Low/ }));
    await user.keyboard("{End}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("teal");
  });

  it("text buttons lift to 44px on phones and coarse pointers (#2096)", async () => {
    const user = userEvent.setup();
    render(<ChoiceColorPicker choice="High" colorKey="red" onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Color for High/ }));
    for (const name of ["Custom color", "Reset to automatic"]) {
      const cls = screen.getByRole("button", { name }).className;
      expect(cls).toContain("max-sm:min-h-11");
      expect(cls).toContain("[@media(pointer:coarse)]:min-h-11");
    }
  });

  it("Reset to automatic clears the color", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChoiceColorPicker choice="High" colorKey="red" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /Color for High/ }));
    await user.click(screen.getByRole("button", { name: "Reset to automatic" }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("an unknown stored key reads as Automatic", () => {
    render(<ChoiceColorPicker choice="High" colorKey="chartreuse" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Color for High: Automatic" })).toBeInTheDocument();
  });

  it("is disabled for a blank choice", () => {
    render(<ChoiceColorPicker choice="  " colorKey={undefined} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Color: type a choice first" })).toBeDisabled();
  });

  it("Tab out of the popover closes it without pulling focus back", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<div><ChoiceColorPicker choice="Low" colorKey={undefined} onChange={onChange} /><input aria-label="next" /></div>);
    await user.click(screen.getByRole("button", { name: /Color for Low/ }));
    expect(screen.getByRole("radio", { name: "Slate" })).toHaveFocus();
    await user.tab(); // + Custom (#2096) — still inside
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.tab(); // Reset to automatic — still inside
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.tab(); // out of the wrapper
    expect(screen.getByRole("textbox", { name: "next" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("default-prevents a press on its label or padding inside a focusable host (#2240)", () => {
    // The settings modal's dialog is tabIndex=-1: without the guard a press on a
    // non-control part of the popover focused it and the wrapper's blur closed the popover.
    render(
      <div role="region" aria-label="Host" tabIndex={-1}>
        <ChoiceColorPicker choice="Low" colorKey={undefined} onChange={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Color for Low/ }));
    const dialog = screen.getByRole("dialog", { name: "Color for Low" });
    // fireEvent returns false when the handler called preventDefault().
    expect(fireEvent.mouseDown(within(dialog).getByText("Automatic"))).toBe(false);
    expect(fireEvent.mouseDown(dialog)).toBe(false);
    expect(fireEvent.mouseDown(within(dialog).getByRole("radiogroup", { name: "Palette" }))).toBe(false);
    // Controls inside keep their own focus behavior.
    expect(fireEvent.mouseDown(within(dialog).getByRole("radio", { name: "Slate" }))).toBe(true);
    expect(fireEvent.mouseDown(within(dialog).getByRole("button", { name: "Reset to automatic" }))).toBe(true);
    expect(screen.getByRole("dialog", { name: "Color for Low" })).toBeInTheDocument();
  });

  it("opens below by default and flips above when there is little room below", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ChoiceColorPicker choice="Low" colorKey={undefined} onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /Color for Low/ });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ bottom: window.innerHeight - 400 } as DOMRect);
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toHaveClass("top-full", "mt-1");
    unmount();

    render(<ChoiceColorPicker choice="Low" colorKey={undefined} onChange={vi.fn()} />);
    const low = screen.getByRole("button", { name: /Color for Low/ });
    vi.spyOn(low, "getBoundingClientRect").mockReturnValue({ bottom: window.innerHeight - 120 } as DOMRect);
    await user.click(low);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("bottom-full", "mb-1");
    expect(dialog).not.toHaveClass("top-full");
  });

  it("scrolls the opened popover into view (nearest)", () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<ChoiceColorPicker choice="Low" colorKey={undefined} onChange={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /Color for Low/ }));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole("dialog"));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("a blur with a null relatedTarget keeps the popover open; an outside mousedown closes it (#2240)", async () => {
    const user = userEvent.setup();
    render(<div><p>outside</p><ChoiceColorPicker choice="Low" colorKey={undefined} onChange={vi.fn()} /></div>);
    await user.click(screen.getByRole("button", { name: /Color for Low/ }));
    fireEvent.blur(screen.getByRole("radio", { name: "Slate" }), { relatedTarget: null });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a click outside closes the popover without changing anything", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<div><p>outside</p><ChoiceColorPicker choice="Low" colorKey={undefined} onChange={onChange} /></div>);
    await user.click(screen.getByRole("button", { name: /Color for Low/ }));
    await user.click(screen.getByText("outside"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  describe("Escape inside the settings modal", () => {
    function renderInModal(escapePriority?: number) {
      const onModalClose = vi.fn();
      render(
        <ModalWrapper open onClose={onModalClose} title="Board settings">
          <ChoiceColorPicker choice="Low" colorKey={undefined} onChange={vi.fn()} escapePriority={escapePriority} />
        </ModalWrapper>,
      );
      return onModalClose;
    }

    it("registers above the modal (40) and its value editors (45, 46)", () => {
      expect(CHOICE_COLOR_ESCAPE_PRIORITY).toBe(47);
    });

    it("the first Escape closes only the popover; the second closes the modal", async () => {
      const user = userEvent.setup();
      const onModalClose = renderInModal();
      await user.click(screen.getByRole("button", { name: /Color for Low/ }));
      expect(screen.getByRole("dialog", { name: "Color for Low" })).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Color for Low" })).not.toBeInTheDocument();
      expect(onModalClose).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /Color for Low/ })).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(onModalClose).toHaveBeenCalledTimes(1);
    });

    it("guard: below the modal's priority, Escape would close the modal instead", async () => {
      // Proves the test above discriminates: at 39 the modal (40) wins.
      const user = userEvent.setup();
      const onModalClose = renderInModal(39);
      await user.click(screen.getByRole("button", { name: /Color for Low/ }));
      await user.keyboard("{Escape}");
      expect(onModalClose).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Board Settings → Card fields: the draft and the save payload
// ---------------------------------------------------------------------------

const fakeUser: User = {
  id: 1, username: "admin", email: "admin@example.com", first_name: "Admin", last_name: "User",
  avatar_url: "", display_name: "Admin User", is_site_admin: false,
  must_change_password: false, must_change_username: false, has_usable_password: true,
};

function makeDefinition(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: 1, uid: "cfuid001", name: "Severity", field_type: "dropdown", choices: ["Low", "High"],
    position: 0, show_on_card: false, is_required: false, help_text: "",
    number_prefix: "", number_suffix: "", number_decimals: null, choice_colors: { Low: "green" },
    threshold_direction: "", threshold_warn: null, threshold_alert: null, threshold_warn_days: null, threshold_alert_days: null, created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeBoard(fields: CustomFieldDefinition[]): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null, health_status_changed_at: null, health_status_changed_by: null, health_status_note: null, health_review_days: null, health_review_due_at: null, health_auto_enabled: false, health_off_track_cards: 3, computed_health_status: null, health_computed_at: null, health_computed_counts: null, health_status_origin: null, default_preset: null,
    swimlane_rollup_field: null,
    commitment_column_uid: null,
    cards_can_have_children: false,
    default_child_board: null,
    parent_name_singular: "",
    parent_name_plural: "",
    id: 1, uid: "boarduid0001", name: "Board", description: "", group: null, group_name: null,
    archived_card_count: 0,
    columns: [], swimlanes: [], cards: [], labels: [],
    members: [{ id: 10, user: fakeUser, role: "admin", is_moderator: false, joined_at: "" }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false,
    show_wip_at_limit: false, show_row_chip_field_names: true, lane_details_cap: 6, export_min_role: "viewer", card_density: "comfortable",
    is_starred: false, created_at: "", updated_at: "", current_user_role: "admin",
    custom_field_definitions: fields, swimlane_custom_field_definitions: [],
    owner: fakeUser, capabilities: { movement_export: false },
    share_token: null, share_token_expires_at: null, share_link_active: false,
  };
}

describe("BoardSettingsFieldsTab — choice colors (#1391)", () => {
  async function openEditor(def = makeDefinition()) {
    const user = userEvent.setup();
    vi.mocked(boardsApi.updateCustomFieldDefinition).mockResolvedValue(def);
    render(<BoardSettingsFieldsTab board={makeBoard([def])} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByLabelText("Edit Severity"));
    return user;
  }

  it("shows a swatch per choice, the stored color, and the rename note", async () => {
    await openEditor();
    expect(screen.getByRole("button", { name: "Color for Low: Green" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Color for High: Automatic" })).toBeInTheDocument();
    expect(screen.getByText("Renaming a choice resets its color.")).toHaveClass("text-xs", "text-fg-muted");
  });

  it("shows the rename note only while some choice has a color", async () => {
    const user = await openEditor(makeDefinition({ choice_colors: {} }));
    expect(screen.queryByText("Renaming a choice resets its color.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Color for High: Automatic" }));
    await user.click(screen.getByRole("radio", { name: "Teal" }));
    expect(screen.getByText("Renaming a choice resets its color.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Color for High: Teal" }));
    await user.click(screen.getByRole("button", { name: "Reset to automatic" }));
    expect(screen.queryByText("Renaming a choice resets its color.")).not.toBeInTheDocument();
  });

  it("a choice named __proto__ is saved with its color", async () => {
    const user = await openEditor(makeDefinition({ choices: ["__proto__", "High"], choice_colors: {} }));
    await user.click(screen.getByRole("button", { name: "Color for __proto__: Automatic" }));
    await user.click(screen.getByRole("radio", { name: "Red" }));
    expect(screen.getByRole("button", { name: "Color for __proto__: Red" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save field" }));
    await waitFor(() => expect(boardsApi.updateCustomFieldDefinition).toHaveBeenCalled());
    const payload = vi.mocked(boardsApi.updateCustomFieldDefinition).mock.calls[0][2];
    expect(JSON.parse(JSON.stringify(payload)).choice_colors).toEqual(JSON.parse('{"__proto__":"red"}'));
    expect(Object.hasOwn(payload.choice_colors!, "__proto__")).toBe(true);
  });

  it("a picked color is saved with the field, not on its own", async () => {
    const user = await openEditor();
    await user.click(screen.getByRole("button", { name: "Color for High: Automatic" }));
    await user.click(screen.getByRole("radio", { name: "Red" }));
    expect(boardsApi.updateCustomFieldDefinition).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Color for High: Red" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save field" }));
    await waitFor(() => expect(boardsApi.updateCustomFieldDefinition).toHaveBeenCalledWith(1, 1, expect.objectContaining({
      choices: ["Low", "High"], choice_colors: { Low: "green", High: "red" },
    })));
  });

  it("Reset to automatic drops the entry from the payload", async () => {
    const user = await openEditor();
    await user.click(screen.getByRole("button", { name: "Color for Low: Green" }));
    await user.click(screen.getByRole("button", { name: "Reset to automatic" }));
    await user.click(screen.getByRole("button", { name: "Save field" }));
    await waitFor(() => expect(boardsApi.updateCustomFieldDefinition).toHaveBeenCalledWith(1, 1, expect.objectContaining({
      choice_colors: {},
    })));
  });

  it("renaming a choice resets its color in the draft and the payload", async () => {
    const user = await openEditor();
    const lowInput = screen.getByDisplayValue("Low");
    await user.clear(lowInput);
    await user.type(lowInput, "Minor");
    expect(screen.getByRole("button", { name: "Color for Minor: Automatic" })).toBeInTheDocument();
    // Typing the old name back does not resurrect the color.
    await user.clear(lowInput);
    await user.type(lowInput, "Low");
    expect(screen.getByRole("button", { name: "Color for Low: Automatic" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save field" }));
    await waitFor(() => expect(boardsApi.updateCustomFieldDefinition).toHaveBeenCalledWith(1, 1, expect.objectContaining({
      choice_colors: {},
    })));
  });

  it("removing a choice drops its color from the payload", async () => {
    const user = await openEditor(makeDefinition({ choice_colors: { Low: "green", High: "red" } }));
    const row = screen.getByDisplayValue("Low").parentElement!;
    await user.click(within(row).getByRole("button", { name: "Remove choice Low" }));
    await user.click(screen.getByRole("button", { name: "Save field" }));
    await waitFor(() => expect(boardsApi.updateCustomFieldDefinition).toHaveBeenCalledWith(1, 1, expect.objectContaining({
      choices: ["High"], choice_colors: { High: "red" },
    })));
  });

  it("retyping away from a choice type hides the swatches and sends no colors", async () => {
    const user = await openEditor(makeDefinition({ choice_colors: { Low: "green" } }));
    await user.click(screen.getByRole("button", { name: /Text/ }));
    await user.click(screen.getByRole("button", { name: "Change type" }));
    expect(screen.queryByRole("button", { name: /Color for/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save field" }));
    await waitFor(() => expect(boardsApi.updateCustomFieldDefinition).toHaveBeenCalled());
    const payload = vi.mocked(boardsApi.updateCustomFieldDefinition).mock.calls[0][2];
    expect(payload.field_type).toBe("text");
    expect(payload.choice_colors).toBeUndefined();
  });

  it("a new multi-select field sends its colors on create", async () => {
    const user = userEvent.setup();
    vi.mocked(boardsApi.createCustomFieldDefinition).mockResolvedValue(makeDefinition({ id: 2, name: "Platforms" }));
    render(<BoardSettingsFieldsTab board={makeBoard([])} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "+ Add field" }));
    await user.type(screen.getByPlaceholderText("e.g. Sprint"), "Platforms");
    await user.click(screen.getByRole("button", { name: /Multi-select/ }));
    await user.click(screen.getByRole("button", { name: "+ Add choice" }));
    await user.type(screen.getAllByRole("textbox")[2], "web");
    await user.click(screen.getByRole("button", { name: "Color for web: Automatic" }));
    await user.click(screen.getByRole("radio", { name: "Violet" }));
    await user.click(screen.getByRole("button", { name: "Save field" }));
    await waitFor(() => expect(boardsApi.createCustomFieldDefinition).toHaveBeenCalledWith(1, expect.objectContaining({
      field_type: "multi_select", choices: ["web"], choice_colors: { web: "violet" },
    })));
  });
});

// #1413 — truncation inside nested flex chips (frontend/CLAUDE.md). jsdom does
// no layout, so these pin the classes that make `truncate` engage.
describe("CustomFieldValueDisplay — chip truncation classes (#1413)", () => {
  const longDef = shape({ name: "A very long custom field name that must clip", field_type: "text", choices: [] });

  it.each(["row-chip", "chip"] as const)("%s: chip clips its overflow and every truncating span has min-w-0", (variant) => {
    const { container } = render(
      <CustomFieldValueDisplay definition={longDef} value="some value" variant={variant} />,
    );
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.className).toContain("overflow-hidden");
    const truncating = Array.from(chip.querySelectorAll("span")).filter((el) => el.className.includes("truncate"));
    expect(truncating.length).toBeGreaterThanOrEqual(2);
    for (const el of truncating) expect(el.className).toContain("min-w-0");
  });

  it("chip: the single-value chip is no longer shrink-0 (it must shrink into its parent row)", () => {
    const { container } = render(<CustomFieldValueDisplay definition={longDef} value="x" variant="chip" />);
    expect((container.firstElementChild as HTMLElement).className).not.toContain("shrink-0");
  });
});

describe("CustomFieldValueDisplay — chip truncation, other field types (#1413)", () => {
  const msShape = shape({ name: "Platforms", field_type: "multi_select", choices: ["web", "ios"], choice_colors: undefined });

  it("row-chip multi-select: the name span yields space first (shrink-[3]) and keeps min-w-0", () => {
    render(<CustomFieldValueDisplay definition={msShape} value='["web","ios"]' variant="row-chip" />);
    const name = screen.getByText("Platforms:");
    expect(name.className).toContain("shrink-[3]");
    expect(name.className).toContain("min-w-0");
  });

  it.each(["row-chip", "chip"] as const)("%s: a url value's host link truncates with min-w-0", (variant) => {
    render(<CustomFieldValueDisplay definition={shape({ name: "Docs", field_type: "url", choices: [], choice_colors: undefined })} value="https://example.com/x" variant={variant} />);
    const link = screen.getByRole("link");
    expect(link.className).toContain("truncate");
    expect(link.className).toContain("min-w-0");
  });

  it("a non-http url value falls back to a truncating span with min-w-0", () => {
    render(<CustomFieldValueDisplay definition={shape({ name: "Docs", field_type: "url", choices: [], choice_colors: undefined })} value="not a url" variant="row-chip" />);
    const el = screen.getByText("not a url");
    expect(el.className).toContain("truncate");
    expect(el.className).toContain("min-w-0");
  });

  it("row-chip hideName and dropdown keep the clip classes", () => {
    const { container } = render(<CustomFieldValueDisplay definition={shape()} value="Low" variant="row-chip" hideName />);
    expect((container.firstElementChild as HTMLElement).className).toContain("overflow-hidden");
    const value = screen.getByText("Low");
    expect(value.className).toContain("min-w-0");
  });

  it("chip floors match the card face (3.5rem single, 4rem multi)", () => {
    const a = render(<CustomFieldValueDisplay definition={shape({ field_type: "text", choices: [] })} value="x" variant="chip" />);
    expect((a.container.firstElementChild as HTMLElement).className).toContain("min-w-[3.5rem]");
    a.unmount();
    const b = render(<CustomFieldValueDisplay definition={msShape} value='["web"]' variant="chip" />);
    expect((b.container.firstElementChild as HTMLElement).className).toContain("min-w-[4rem]");
  });
});

// ---------------------------------------------------------------------------
// Custom hex choice colors (#2096)
// ---------------------------------------------------------------------------

describe("custom hex choice colors (#2096): the resolver", () => {
  it("resolves a palette key as is and a 6-digit hex upper-cased; anything else is null", () => {
    expect(resolveChoiceColor("teal")).toBe("teal");
    expect(resolveChoiceColor("#a1b2c3")).toBe("#A1B2C3");
    expect(resolveChoiceColor("#A1B2C3")).toBe("#A1B2C3");
    for (const bad of ["RED", "#FFF", "#FF00001", "FF0000", " #FF0000", "rgb(1, 2, 3)", "", "magenta", undefined, null, 3]) {
      expect(resolveChoiceColor(bad)).toBeNull();
    }
  });

  it("gives a hex its own base, label and contrast-derived badge pair; keys are unchanged", () => {
    expect(choiceColorBase("#123456")).toBe("#123456");
    expect(choiceColorBase("red")).toBe(CHOICE_COLORS.red.base);
    expect(choiceColorLabel("#123456")).toBe("Custom color");
    expect(choiceColorLabel("violet")).toBe("Violet");
    expect(choiceBadgeStyle("#FAFAFA")).toEqual(colorChipStyle("#FAFAFA"));
    expect(choiceBadgeStyle("red")).not.toHaveProperty("--cf-border-light");
  });

  it("explicitChoiceColor and choiceColorsPayload keep hex (a settings save must not erase it)", () => {
    expect(explicitChoiceColor(shape({ choice_colors: { High: "#00ff88" } }), "High")).toBe("#00FF88");
    expect(explicitChoiceColor(shape({ choices: ["Low"], choice_colors: { High: "#00FF88" } }), "High")).toBeNull();
    expect(choiceColorsPayload(["Low", "High", "Mid"], { Low: "#00ff88", High: "red", Mid: "#FFF" }))
      .toEqual({ Low: "#00FF88", High: "red" });
  });

  it.each(["chip", "row-chip", "detail"] as const)("%s: a hex choice renders a badge through the contrast helper", (variant) => {
    const { container } = render(
      <CustomFieldValueDisplay definition={shape({ choice_colors: { High: "#FAFAFA" } })} value="High" variant={variant} />,
    );
    const badge = badgeIn(container);
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute("data-choice-color", "#FAFAFA");
    // Near-white still gets a dark legible fg in light theme, never the raw hex as text.
    expect(badge!.style.getPropertyValue("--cf-fg-light")).toBe(String(colorChipStyle("#FAFAFA")["--cf-fg-light" as keyof object]));
    expect(badge!.style.getPropertyValue("--cf-fg-light")).not.toBe("#FAFAFA");
    expect(container).toHaveTextContent("High");
  });

  it("a multi-select entry with a hex renders a badge", () => {
    const def = shape({ field_type: "multi_select", choices: ["web", "ios"], choice_colors: { ios: "#336699" } });
    const { container } = render(<MultiSelectChips entries={["web", "ios"]} definition={def} />);
    expect(container.querySelectorAll(".cf-choice-badge")).toHaveLength(1);
    expect(container.querySelector(".cf-choice-badge")).toHaveTextContent("ios");
  });
});

describe("ChoiceColorPicker — custom colors (#2096)", () => {
  function setHex(value: string) {
    fireEvent.input(screen.getByRole("textbox", { name: "Hex value" }), { target: { value } });
  }

  it("offers + Custom as its own tab stop under the palette, then Reset", async () => {
    const user = userEvent.setup();
    render(<ChoiceColorPicker choice="Low" colorKey={undefined} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Color for Low: Automatic" }));
    const dialog = screen.getByRole("dialog", { name: "Color for Low" });
    const custom = within(dialog).getByRole("button", { name: "Custom color" });
    expect(custom).toHaveTextContent("+ Custom");
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.indexOf(custom)).toBe(buttons.findIndex((b) => b.textContent === "Reset to automatic") - 1);
    expect(custom.tabIndex).toBe(0);
    // Opts in to one-press-one-layer, so a backdrop press inside Board Settings closes only this.
    expect(hasOpenDismissLayer(document.body)).toBe(true);
  });

  it("+ Custom swaps the grid for the panel; Apply saves upper-case hex, closes, and focuses the swatch", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChoiceColorPicker choice="Low" colorKey="blue" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Color for Low: Blue" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Custom color" }));
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset to automatic" })).not.toBeInTheDocument();
    setHex("#a1b2c3");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledWith("#A1B2C3");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("Cancel and Escape go back to the grid with focus on + Custom, without a change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChoiceColorPicker choice="Low" colorKey={undefined} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Color for Low: Automatic" }));
    await user.click(screen.getByRole("button", { name: "Custom color" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("radiogroup", { name: "Palette" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Custom color" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Custom color" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Color for Low" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Custom color" })).toHaveFocus();
    // A second Escape closes the popover itself.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a custom value fills the swatch, checks no radio, and opens focused on + Custom", async () => {
    const user = userEvent.setup();
    render(<ChoiceColorPicker choice="High" colorKey="#336699" onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Color for High: Custom color" });
    const swatch = trigger.querySelector("[data-swatch]") as HTMLElement;
    expect(swatch).toHaveAttribute("data-swatch", "custom");
    expect(swatch.style.backgroundColor).toBe("rgb(51, 102, 153)");
    await user.click(trigger);
    expect(screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    const custom = screen.getByRole("button", { name: "Custom color, selected" });
    expect(custom).toHaveFocus();
    expect(custom).toHaveTextContent("Custom");
    // The panel seeds from the stored hex.
    await user.click(custom);
    expect(screen.getByRole("textbox", { name: "Hex value" })).toHaveValue("#336699");
  });

  it("re-measures the flip for the taller custom body", async () => {
    const user = userEvent.setup();
    render(<ChoiceColorPicker choice="Low" colorKey={undefined} onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Color for Low: Automatic" });
    // 300px below the trigger: room for the grid (200), not for the custom body.
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ bottom: window.innerHeight - 300 } as DOMRect);
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toHaveClass("top-full");
    await user.click(screen.getByRole("button", { name: "Custom color" }));
    expect(screen.getByRole("dialog")).toHaveClass("bottom-full");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog")).toHaveClass("top-full");
  });
});

describe("BoardSettingsFieldsTab — custom choice colors (#2096)", () => {
  it("saves a stored hex untouched and a newly applied hex with the field", async () => {
    const user = userEvent.setup();
    const def = makeDefinition({ choice_colors: { Low: "#00FF88" } });
    vi.mocked(boardsApi.updateCustomFieldDefinition).mockResolvedValue(def);
    render(<BoardSettingsFieldsTab board={makeBoard([def])} isAdmin onFieldsUpdated={vi.fn()} />);
    await user.click(screen.getByLabelText("Edit Severity"));
    expect(screen.getByText("Renaming a choice resets its color.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Color for High: Automatic" }));
    await user.click(screen.getByRole("button", { name: "Custom color" }));
    fireEvent.input(screen.getByRole("textbox", { name: "Hex value" }), { target: { value: "#123abc" } });
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(boardsApi.updateCustomFieldDefinition).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save field" }));
    await waitFor(() => expect(boardsApi.updateCustomFieldDefinition).toHaveBeenCalledWith(1, 1, expect.objectContaining({
      choice_colors: { Low: "#00FF88", High: "#123ABC" },
    })));
  });
});
