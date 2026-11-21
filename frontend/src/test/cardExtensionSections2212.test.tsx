import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import CardExtensionSections from "../components/Card/CardExtensionSections";
import { MAX_FIELDS, MAX_SECTIONS, parseCardExtensionSections } from "../components/Card/parseCardExtensionSections";
import * as cardsApi from "../api/cards";

vi.mock("../api/cards", () => ({ getCardExtensions: vi.fn() }));

const field = (over: Record<string, unknown> = {}) => ({ key: "amount", label: "Amount", type: "number", value: 12, ...over });
const section = (over: Record<string, unknown> = {}) => ({ id: "deal", title: "Deal", fields: [field()], ...over });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(cardsApi.getCardExtensions).mockReset();
});
afterEach(() => warn.mockRestore());

describe("parseCardExtensionSections (#2212)", () => {
  it("keeps a valid section of every field type", () => {
    const out = parseCardExtensionSections({
      sections: [section({ fields: [
        field(),
        field({ key: "stage", label: "Stage", type: "choice", value: "Won", choices: ["Open", "Won"] }),
        field({ key: "close", label: "Close", type: "date", value: "2026-12-01" }),
        field({ key: "notes", label: "Notes", type: "text", value: "hi", display: "Hi there" }),
        field({ key: "none", label: "None", type: "text", value: null }),
        field({ key: "blank", label: "Blank", type: "text", value: "" }),
      ] })],
    });
    expect(out).toHaveLength(1);
    expect(out[0].fields.map((f) => f.key)).toEqual(["amount", "stage", "close", "notes", "none", "blank"]);
    expect(out[0].fields[3].display).toBe("Hi there");
    expect(out[0].fields[5].value).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["bad key", field({ key: "Bad" })],
    ["unknown type", field({ type: "url" })],
    ["empty label", field({ label: "  " })],
    ["long label", field({ label: "x".repeat(81) })],
    ["NaN number", field({ value: Number.NaN })],
    ["string number", field({ value: "12" })],
    ["bool number", field({ value: true })],
    ["long text", field({ type: "text", value: "x".repeat(501) })],
    ["bad date", field({ type: "date", value: "12/01/2026" })],
    ["non-string date", field({ type: "date", value: 3 })],
    ["choice not listed", field({ type: "choice", value: "Lost", choices: ["Won"] })],
    ["choices not array", field({ type: "choice", value: "Won", choices: "Won" })],
    ["long display", field({ display: "x".repeat(201) })],
    ["not an object", "field"],
  ])("drops the whole section for a %s field, keeping the others", (_name, bad) => {
    const out = parseCardExtensionSections({ sections: [section({ id: "bad", fields: [field({ key: "ok" }), bad] }), section({ id: "good" })] });
    expect(out.map((s) => s.id)).toEqual(["good"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/Amount|Deal/);
  });

  it("drops bad sections: id, title, empty or too many fields, duplicate keys and ids", () => {
    const out = parseCardExtensionSections({ sections: [
      section({ id: "Bad id" }),
      section({ id: "t1", title: "" }),
      section({ id: "t2", title: "x".repeat(121) }),
      section({ id: "e", fields: [] }),
      section({ id: "m", fields: Array.from({ length: MAX_FIELDS + 1 }, (_, i) => field({ key: `f${i}` })) }),
      section({ id: "d", fields: [field(), field()] }),
      section({ id: "deal" }),
      section({ id: "deal" }),
      null,
    ] });
    expect(out.map((s) => s.id)).toEqual(["deal"]);
  });

  it("keeps at most MAX_SECTIONS sections, skipping (not truncating) the rest", () => {
    const sections = Array.from({ length: MAX_SECTIONS + 2 }, (_, i) => section({ id: `s${i}` }));
    expect(parseCardExtensionSections({ sections })).toHaveLength(MAX_SECTIONS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns nothing for an unexpected payload", () => {
    expect(parseCardExtensionSections(null)).toEqual([]);
    expect(parseCardExtensionSections({ sections: "x" })).toEqual([]);
    expect(parseCardExtensionSections([])).toEqual([]);
  });
});

describe("CardExtensionSections (#2212)", () => {
  it("renders nothing while loading", () => {
    vi.mocked(cardsApi.getCardExtensions).mockReturnValue(new Promise(() => {}));
    const { container } = render(<CardExtensionSections boardId={1} cardId={2} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there are no sections", async () => {
    vi.mocked(cardsApi.getCardExtensions).mockResolvedValue({ sections: [] });
    const { container } = render(<CardExtensionSections boardId={1} cardId={2} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing and warns once without content when the fetch fails", async () => {
    vi.mocked(cardsApi.getCardExtensions).mockRejectedValue(new Error("secret value"));
    const { container } = render(<CardExtensionSections boardId={1} cardId={2} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("secret");
  });

  it("renders a region labeled by its heading, with plain-text rows and Not set", async () => {
    vi.mocked(cardsApi.getCardExtensions).mockResolvedValue({ sections: [section({ fields: [
      field({ display: "$12.00" }),
      field({ key: "close", label: "Close", type: "date", value: "2026-12-01" }),
      field({ key: "stage", label: "Stage", type: "choice", value: "Won", choices: ["Won"] }),
      field({ key: "count", label: "Count", type: "number", value: 0 }),
      field({ key: "notes", label: "Notes", type: "text", value: "<b>bold</b>" }),
      field({ key: "owner", label: "Owner", type: "text", value: null }),
    ] })] });
    render(<CardExtensionSections boardId={1} cardId={2} userDateFormat="YYYY-MM-DD" />);
    const region = await screen.findByRole("region", { name: "Deal" });
    expect(region).toHaveTextContent("$12.00");
    expect(region).toHaveTextContent("2026-12-01");
    expect(region).toHaveTextContent("Won");
    expect(region).toHaveTextContent("0");
    expect(screen.getByText("<b>bold</b>")).toBeInTheDocument();
    expect(region.querySelector("b")).toBeNull();
    expect(screen.getByText("Not set")).toHaveClass("text-fg-muted");
    expect(screen.getByText("Stage").tagName).toBe("DT");
    expect(cardsApi.getCardExtensions).toHaveBeenCalledWith(1, 2);
  });

  it("refetches when the card changes and drops the old card's sections", async () => {
    vi.mocked(cardsApi.getCardExtensions).mockResolvedValueOnce({ sections: [section()] });
    const { rerender } = render(<CardExtensionSections boardId={1} cardId={2} />);
    await screen.findByRole("region", { name: "Deal" });
    vi.mocked(cardsApi.getCardExtensions).mockReturnValueOnce(new Promise(() => {}));
    rerender(<CardExtensionSections boardId={1} cardId={3} />);
    expect(screen.queryByRole("region", { name: "Deal" })).not.toBeInTheDocument();
    expect(cardsApi.getCardExtensions).toHaveBeenLastCalledWith(1, 3);
  });
});
