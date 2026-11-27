import { describe, expect, it } from "vitest";
import { locateSettingTarget } from "../components/Board/boardSettingsSections";

function rootWith(label: string): { root: HTMLElement; el: HTMLElement } {
  const root = document.createElement("div");
  const el = document.createElement("button");
  el.setAttribute("aria-label", label);
  root.appendChild(el);
  return { root, el };
}

describe("locateSettingTarget prefix rule (#2661)", () => {
  it("resolves a select trigger named '<label>: <value>'", () => {
    const { root, el } = rootWith("Who can export: Members and above");
    expect(locateSettingTarget(root, "Who can export")).toBe(el);
  });

  it.each(["Who can exporter", "Who can export now"])("does not resolve %s via the prefix rule", (label) => {
    const { root } = rootWith(label);
    expect(locateSettingTarget(root, "Who can export")).toBeNull();
  });
});
