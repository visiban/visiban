/**
 * #2475: the shared layouts and parts (components/Page). Wave-2 page redesigns build on these,
 * so the contract each exports is pinned here: variant classes, the absent/disabled states,
 * the Settings layout's `?tab=` deep link, and that no part hard-codes a color.
 */
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BUTTON_VARIANT_CLASSES, buttonClasses, Button, PageHeading, CardHeading, SectionLabel,
  StatusPill, StatusControl, FilterPill, ListWell, ListRow, SettingsCard, Switch, SettingSwitchRow,
  SettingTwoSwitchHeader, SettingTwoSwitchRow, SaveBar, InlineConfirm, EmptyState, Field, OrDivider,
  WorkspaceLayout, OverviewLayout, SettingsLayout, filterSettingsSections, CenteredLayout,
  CenteredHeader, StatusCard, BrandTile,
} from "../components/Page";

function HistoryLen() {
  // REPLACE navigations keep one entry per visit; PUSH would show "PUSH".
  return <span data-testid="hist">{useNavigationType() === "REPLACE" ? "1" : "2"}</span>
}

describe("buttonClasses", () => {
  it("gives every variant 36px (44px on phones), rounded and a focus ring", () => {
    for (const v of ["primary", "secondary", "quiet", "danger", "warning", "icon"] as const) {
      const c = buttonClasses(v);
      expect(c).toContain("h-9");
      expect(c).toContain("max-sm:h-11");
      expect(c).toMatch(/\brounded\b/);
      expect(c).toMatch(/focus:ring-(primary|danger|warning)-emphasis/);
      expect(c).toContain("disabled:opacity-40");
    }
  });

  it("Quiet is the bare-text variant every Cancel uses; Secondary is bordered on the panel color", () => {
    expect(BUTTON_VARIANT_CLASSES.quiet).toBe("px-3 text-fg-secondary hover:text-fg hover:bg-surface-hover focus:ring-primary-emphasis");
    expect(BUTTON_VARIANT_CLASSES.secondary).toContain("border border-line-strong");
    expect(BUTTON_VARIANT_CLASSES.secondary).toContain("bg-surface");
    expect(BUTTON_VARIANT_CLASSES.primary).toContain("text-on-primary");
    expect(BUTTON_VARIANT_CLASSES.danger).toContain("focus:ring-danger-emphasis");
    expect(BUTTON_VARIANT_CLASSES.warning).toContain("text-on-warning");
  });

  it("sizes the icon variant square and supports lg, full width and extra classes", () => {
    expect(buttonClasses("icon")).toContain("w-9 max-sm:w-11");
    expect(buttonClasses("icon", { size: "lg" })).toContain("max-sm:w-12");
    const c = buttonClasses("primary", { size: "lg", fullWidth: true, className: "mt-2" });
    expect(c).toContain("max-sm:h-12");
    expect(c).toContain("w-full");
    expect(c).toContain("mt-2");
  });

  it("Button defaults to type=button and the secondary variant", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    const b = screen.getByRole("button", { name: "Go" });
    expect(b).toHaveAttribute("type", "button");
    expect(b.className).toContain("border-line-strong");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalled();
  });
});

describe("headings", () => {
  it("PageHeading is an h2 at 24/650 with its description, accessory and actions", () => {
    render(<PageHeading title="Home" description="One line." accessory={<span>star</span>} actions={<button>New</button>} />);
    const h = screen.getByRole("heading", { level: 2, name: "Home" });
    expect(h.className).toContain("text-2xl font-semibold");
    expect(screen.getByText("One line.")).toBeInTheDocument();
    expect(screen.getByText("star")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("PageHeading level prop renders an h3 for in-page sections and defaults to h2", () => {
    render(<><PageHeading title="Page" /><PageHeading level="h3" title="Section" /></>);
    expect(screen.getByRole("heading", { level: 2, name: "Page" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Section" })).toBeInTheDocument();
  });

  it("PageHeading without description or actions renders only the heading", () => {
    const { container } = render(<PageHeading title="Bare" />);
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("CardHeading is 15/650 and SectionLabel is 13px uppercase tracked fg-tertiary", () => {
    render(<><CardHeading>Card</CardHeading><SectionLabel as="p">Section</SectionLabel></>);
    expect(screen.getByRole("heading", { level: 3, name: "Card" }).className).toContain("text-[15px]");
    const label = screen.getByText("Section");
    expect(label.tagName).toBe("P");
    expect(label.className).toContain("uppercase tracking-[0.06em] text-fg-tertiary");
  });
});

describe("status pills", () => {
  it("pairs tint, dot and word for each listing tone", () => {
    render(<>
      <StatusPill tone="on_track" /><StatusPill tone="at_risk" /><StatusPill tone="off_track" /><StatusPill tone="pending" label="Pending invite" />
    </>);
    expect(screen.getByText("On track").className).toContain("text-success-on-tint");
    expect(screen.getByText("At risk").className).toContain("text-warning-on-tint");
    expect(screen.getByText("Off track").className).toContain("text-danger-on-tint");
    const pending = screen.getByText("Pending invite");
    expect(pending.className).toContain("text-info-on-tint");
    expect(pending.className).toContain("h-6 px-2 rounded-full text-xs");
    expect(pending.querySelector("[aria-hidden='true']")).not.toBeNull();
  });

  it("the interactive control is a 30px button at 13px and can show the hollow No status", () => {
    const onClick = vi.fn();
    render(<StatusControl tone="none" onClick={onClick} aria-haspopup="dialog" aria-expanded={false} />);
    const b = screen.getByRole("button", { name: "No status" });
    expect(b.className).toContain("h-[30px]");
    expect(b.className).toContain("text-[13px]");
    expect(b.className).toContain("border-line-boundary");
    expect(b).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalled();
  });
});

describe("FilterPill", () => {
  it("marks the selected pill with tint, border, weight and aria-pressed, with a count in every pill", () => {
    const onClick = vi.fn();
    render(<><FilterPill label="All" count={4} selected onClick={onClick} /><FilterPill label="Mine" count={0} selected={false} onClick={onClick} /></>);
    const all = screen.getByRole("button", { name: "All 4" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(all.className).toContain("bg-primary/[0.22] border-info font-semibold");
    const mine = screen.getByRole("button", { name: "Mine 0" });
    expect(mine).toHaveAttribute("aria-pressed", "false");
    expect(mine.className).toContain("bg-surface border-line-strong font-medium");
    expect(mine.className).toContain("h-[34px]");
    fireEvent.click(mine);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("list well, settings card", () => {
  it("ListWell is the canvas well that scrolls wide content; rows are 8px and highlight on hover", () => {
    render(<ListWell as="ul" label="Boards"><ListRow as="li">Row</ListRow></ListWell>);
    const well = screen.getByRole("list", { name: "Boards" });
    expect(well.className).toContain("bg-canvas");
    expect(well.className).toContain("overflow-x-auto");
    expect(screen.getByRole("listitem").className).toContain("rounded-lg");
    expect(screen.getByRole("listitem").className).toContain("hover:bg-surface");
  });

  it("SettingsCard is a labeled panel at 10px radius and 18px padding; untitled has no name", () => {
    const { rerender } = render(<SettingsCard title="Email" description="Outgoing mail.">body</SettingsCard>);
    const region = screen.getByRole("region", { name: "Email" });
    expect(region.className).toContain("rounded-[10px] p-[18px]");
    expect(screen.getByText("Outgoing mail.")).toBeInTheDocument();
    rerender(<SettingsCard>only body</SettingsCard>);
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByText("only body")).toBeInTheDocument();
  });
});

describe("switches", () => {
  it("Switch is 44×26 and reports the toggled value", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} aria-label="Dark" />);
    const s = screen.getByRole("switch", { name: "Dark" });
    expect(s).toHaveAttribute("aria-checked", "false");
    expect(s.className).toContain("h-[26px] w-11");
    fireEvent.click(s);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("SettingSwitchRow names the switch by its label and describes it", () => {
    const onChange = vi.fn();
    render(<SettingSwitchRow label="Allow sign-up" description="Anyone can create an account." checked onChange={onChange} />);
    const s = screen.getByRole("switch", { name: "Allow sign-up" });
    expect(s).toHaveAccessibleDescription("Anyone can create an account.");
    fireEvent.click(s);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("SettingSwitchRow without a description has no describedby", () => {
    render(<SettingSwitchRow label="Plain" checked={false} onChange={() => {}} disabled />);
    const s = screen.getByRole("switch", { name: "Plain" });
    expect(s).not.toHaveAttribute("aria-describedby");
    expect(s).toBeDisabled();
  });

  it("two-switch row: each switch named per channel; Email is off and disabled while in-app is off", () => {
    const onInApp = vi.fn();
    const onEmail = vi.fn();
    const { rerender } = render(<><SettingTwoSwitchHeader /><SettingTwoSwitchRow event="Card assigned" inApp={false} email onInAppChange={onInApp} onEmailChange={onEmail} /></>);
    expect(screen.getByText("In-app")).toBeInTheDocument();
    const email = screen.getByRole("switch", { name: "Card assigned, email" });
    expect(email).toBeDisabled();
    expect(email).toHaveAccessibleDescription("Turn on in-app to get email.");
    expect(email).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("switch", { name: "Card assigned, in-app" }));
    expect(onInApp).toHaveBeenCalledWith(true);
    rerender(<SettingTwoSwitchRow event="Card assigned" description="When someone assigns you." inApp email onInAppChange={onInApp} onEmailChange={onEmail} />);
    const enabled = screen.getByRole("switch", { name: "Card assigned, email" });
    expect(enabled).not.toBeDisabled();
    expect(enabled).toHaveAttribute("aria-checked", "true");
    fireEvent.click(enabled);
    expect(onEmail).toHaveBeenCalledWith(false);
  });
});

describe("SaveBar and InlineConfirm", () => {
  it("SaveBar shows only while dirty, with the status message, Discard (Quiet) and Save <thing>", () => {
    const onDiscard = vi.fn();
    const onSave = vi.fn();
    const { rerender } = render(<SaveBar thing="email" dirty={false} onDiscard={onDiscard} onSave={onSave} />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<SaveBar thing="email" dirty onDiscard={onDiscard} onSave={onSave} />);
    expect(screen.getByRole("status")).toHaveTextContent("You have unsaved email changes.");
    const discard = screen.getByRole("button", { name: "Discard" });
    expect(discard.className).toContain(BUTTON_VARIANT_CLASSES.quiet);
    fireEvent.click(discard);
    fireEvent.click(screen.getByRole("button", { name: "Save email" }));
    expect(onDiscard).toHaveBeenCalled();
    expect(onSave).toHaveBeenCalled();
    rerender(<SaveBar thing="email" dirty saving onDiscard={onDiscard} onSave={onSave} />);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("SaveBar takes a custom button label and a ref to the Save button (#2476)", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<SaveBar thing="email" saveLabel="Save email settings" dirty onDiscard={vi.fn()} onSave={vi.fn()} saveRef={ref} />);
    expect(screen.getByRole("status")).toHaveTextContent("You have unsaved email changes.");
    expect(screen.getByRole("button", { name: "Save email settings" })).toBe(ref.current);
  });

  it("FilterPill omits the count when the server cannot supply one; PageHeading can take focus (#2476)", () => {
    render(<FilterPill label="Used" selected={false} onClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Used" }).querySelectorAll("span")).toHaveLength(1);
    const ref = createRef<HTMLHeadingElement>();
    render(<PageHeading title="Board invites" headingRef={ref} />);
    expect(ref.current).toHaveAttribute("tabindex", "-1");
    expect(ref.current?.tagName).toBe("H2");
  });

  it("InlineConfirm holds the sentence, Cancel (Quiet) and the Danger action", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<InlineConfirm message="Remove Sam from Design? Sam loses access to its boards." actionLabel="Remove Sam" onConfirm={onConfirm} onCancel={onCancel} />);
    const box = screen.getByRole("group", { name: "Remove Sam" });
    expect(box.className).toContain("bg-danger/10");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    expect(cancel.className).toContain(BUTTON_VARIANT_CLASSES.quiet);
    const action = screen.getByRole("button", { name: "Remove Sam" });
    expect(action.className).toContain(BUTTON_VARIANT_CLASSES.danger);
    fireEvent.click(cancel);
    fireEvent.click(action);
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalled();
  });
});

describe("EmptyState, Field, OrDivider", () => {
  it("EmptyState names what is missing and its one action", () => {
    render(<EmptyState title="No boards yet" description="Create one to start." action={<button>New board</button>} icon={<svg />} headingLevel="h3" testId="es" />);
    expect(screen.getByRole("heading", { level: 3, name: "No boards yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New board" })).toBeInTheDocument();
    expect(screen.getByTestId("es")).toBeInTheDocument();
  });

  it("EmptyState with only a title", () => {
    render(<EmptyState title="Nothing" />);
    expect(screen.getByRole("heading", { level: 2, name: "Nothing" })).toBeInTheDocument();
  });

  it("Field has a visible label, autocomplete, a hint and 48px on phones", () => {
    const onChange = vi.fn();
    render(<Field label="Email" type="email" autoComplete="email" hint="We never share it." labelAccessory={<a href="/x">Help</a>} value="" onChange={onChange} />);
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("autocomplete", "email");
    expect(input).toHaveAccessibleDescription("We never share it.");
    expect(input.className).toContain("max-sm:h-12");
    fireEvent.change(input, { target: { value: "a@b.c" } });
    expect(onChange).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Help" })).toBeInTheDocument();
  });

  it("Field without a hint has no description", () => {
    render(<Field label="Name" autoComplete="name" id="n" />);
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-describedby");
  });

  it("OrDivider is a labeled separator", () => {
    render(<OrDivider label="or continue with" />);
    expect(screen.getByRole("separator", { name: "or continue with" })).toBeInTheDocument();
  });
});

describe("layouts", () => {
  it("Workspace is full width on the page ground with an optional toolbar", () => {
    const { container } = render(<WorkspaceLayout toolbar={<nav aria-label="Tools" />}>grid</WorkspaceLayout>);
    const root = container.querySelector("[data-layout='workspace']")!;
    expect(root.className).toContain("w-full");
    expect(root.className).toContain("bg-page");
    expect(screen.getByRole("navigation", { name: "Tools" })).toBeInTheDocument();
  });

  it("Overview caps at 1200px and drops the side column below on small screens", () => {
    const { container, rerender } = render(<OverviewLayout heading={<PageHeading title="Home" />} aside={<p>side</p>}>main</OverviewLayout>);
    expect(container.querySelector(".max-w-\\[1200px\\]")).not.toBeNull();
    expect(container.querySelector(".lg\\:grid-cols-\\[minmax\\(0\\,1fr\\)_320px\\]")).not.toBeNull();
    expect(screen.getByRole("complementary")).toHaveTextContent("side");
    rerender(<OverviewLayout>only</OverviewLayout>);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  const sections = [
    { id: "general", label: "General & email", keywords: ["SMTP"], render: () => <p>General body</p> },
    { id: "users", label: "Users", render: () => <p>Users body</p> },
  ];

  function Loc() {
    return <span data-testid="loc">{useLocation().search}</span>;
  }

  it("Settings reads the active section from ?tab= so deep links keep working", () => {
    render(<MemoryRouter initialEntries={["/admin?tab=users"]}><SettingsLayout sections={sections} title={<PageHeading title="Site admin" />} /><Loc /></MemoryRouter>);
    expect(screen.getByText("Users body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Users" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "General & email" }));
    expect(screen.getByText("General body")).toBeInTheDocument();
    expect(screen.getByTestId("loc")).toHaveTextContent("?tab=general");
  });

  it("Settings nav shows a group heading once per run of sections and each count (#2476)", () => {
    const grouped = [
      { id: "a", label: "General", group: "Instance", render: () => <p>A</p> },
      { id: "b", label: "Email", group: "Instance", render: () => <p>B</p> },
      { id: "c", label: "Users", group: "People", count: 12, render: () => <p>C</p> },
    ];
    render(<MemoryRouter initialEntries={["/x"]}><SettingsLayout sections={grouped} navLabel="Grouped" /></MemoryRouter>);
    const nav = screen.getByRole("navigation", { name: "Grouped" });
    expect(within(nav).getAllByText("Instance")).toHaveLength(1);
    expect(within(nav).getByText("People")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /^Users\s*12$/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Users (12)" })).toBeInTheDocument();
  });

  it("Settings falls back to the first section for an unknown or absent tab", () => {
    render(<MemoryRouter initialEntries={["/admin?tab=nope"]}><SettingsLayout sections={sections} /></MemoryRouter>);
    expect(screen.getByText("General body")).toBeInTheDocument();
  });

  it("Find a setting narrows the nav by label and keyword; the phone select switches sections", () => {
    render(<MemoryRouter initialEntries={["/admin"]}><SettingsLayout sections={sections} param="section" navLabel="Admin sections" /><Loc /></MemoryRouter>);
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    fireEvent.change(screen.getByLabelText("Find a setting"), { target: { value: "smtp" } });
    expect(nav).toHaveTextContent("General & email");
    expect(nav).not.toHaveTextContent("Users");
    fireEvent.change(screen.getByLabelText("Find a setting"), { target: { value: "zzz" } });
    expect(nav).toHaveTextContent("No settings match.");
    fireEvent.change(screen.getByLabelText("Section"), { target: { value: "users" } });
    expect(screen.getByText("Users body")).toBeInTheDocument();
    expect(screen.getByTestId("loc")).toHaveTextContent("?section=users");
  });

  it("filterSettingsSections returns everything for a blank query", () => {
    expect(filterSettingsSections(sections, "  ")).toHaveLength(2);
    expect(filterSettingsSections(sections, "USE").map((s) => s.id)).toEqual(["users"]);
  });

  it("Centered is one 380px card on the page ground, with no card on phones", () => {
    const { container } = render(<CenteredLayout testId="c"><CenteredHeader title="Sign in to Visiban" subtitle="Hello" /></CenteredLayout>);
    const root = screen.getByTestId("c");
    expect(root.className).toContain("bg-page");
    expect(container.querySelector(".sm\\:max-w-\\[380px\\]")).not.toBeNull();
    // Card chrome only from the sm breakpoint up.
    const card = container.querySelector("main > div")!;
    expect(card.className.split(" ").every((c) => c.startsWith("sm:"))).toBe(true);
    expect(screen.getByRole("heading", { level: 1, name: "Sign in to Visiban" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Visiban" })).toBeInTheDocument();
  });

  it("StatusCard shows the outcome heading, sentence and actions per tone", () => {
    const { rerender } = render(<StatusCard title="Link expired" tone="danger" actions={<a href="/">Go to sign in</a>} testId="s">Ask for a new one.</StatusCard>);
    expect(screen.getByTestId("s")).toHaveAttribute("data-tone", "danger");
    expect(screen.getByRole("heading", { level: 1, name: "Link expired" })).not.toHaveAttribute("tabindex");
    rerender(<StatusCard title="Done" tone="success" />);
    expect(screen.getByText("✓")).toBeInTheDocument();
    rerender(<StatusCard title="Info" />);
    expect(screen.getByText("i")).toBeInTheDocument();
  });

  it("BrandTile can be decorative", () => {
    const { container } = render(<BrandTile size="sm" decorative />);
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
  });
});

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black";
const PREFIX = "bg|text|border|ring|fill|stroke|shadow|from|via|to|outline|divide|decoration|accent|caret";
const HARD_CODED = new RegExp(
  `#[0-9a-fA-F]{3,8}\\b|\\b(rgba?|hsla?)\\(|\\b(${PREFIX})-(${PALETTE})\\b`,
);

describe("no hard-coded colors in the shared parts (#2475 AC4)", () => {
  it("uses tokens only", () => {
    const dir = resolve(__dirname, "../components/Page");
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      // Comments cite issue numbers (#2475), which look like hex; scan code only.
      const src = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (HARD_CODED.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
  it("two-switch row busy flags set aria-busy without disabling; Field takes inputRef and a danger hint; card heading level is selectable (#2477)", () => {
    const ref = { current: null as HTMLInputElement | null };
    render(
      <>
        <SettingTwoSwitchRow event="Mentioned" inApp email inAppBusy emailBusy={false} onInAppChange={vi.fn()} onEmailChange={vi.fn()} />
        <Field label="Email address" autoComplete="email" inputRef={ref} hint="Bad address" hintTone="danger" />
        <SettingsCard title="Card" headingAs="h4">x</SettingsCard>
      </>,
    );
    const inApp = screen.getByRole("switch", { name: "Mentioned, in-app" });
    expect(inApp).toHaveAttribute("aria-busy", "true");
    expect(inApp).not.toBeDisabled();
    expect(screen.getByRole("switch", { name: "Mentioned, email" })).not.toHaveAttribute("aria-busy");
    expect(ref.current).toBe(screen.getByLabelText("Email address"));
    expect(screen.getByText("Bad address")).toHaveClass("text-danger");
    expect(screen.getByRole("heading", { level: 4, name: "Card" })).toBeInTheDocument();
  });

  it("SettingsLayout shows defaultId when the URL names no section, and the URL wins when it does (#2477)", () => {
    const sections = [
      { id: "a", label: "Alpha", render: () => <p>alpha body</p> },
      { id: "b", label: "Beta", render: () => <p>beta body</p> },
    ]
    const { unmount } = render(<MemoryRouter initialEntries={["/x"]}><SettingsLayout sections={sections} defaultId="b" /></MemoryRouter>)
    expect(screen.getByText("beta body")).toBeInTheDocument()
    unmount()
    render(<MemoryRouter initialEntries={["/x?tab=a"]}><SettingsLayout sections={sections} defaultId="b" /></MemoryRouter>)
    expect(screen.getByText("alpha body")).toBeInTheDocument()
  })

  it("SettingsLayout `replace` switches sections without adding history entries (#2477)", () => {
    const sections = [
      { id: "a", label: "Alpha", render: () => <p>alpha body</p> },
      { id: "b", label: "Beta", render: () => <p>beta body</p> },
    ]
    render(<MemoryRouter initialEntries={["/x"]}><SettingsLayout sections={sections} replace /><HistoryLen /></MemoryRouter>)
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Beta" }))
    expect(screen.getByText("beta body")).toBeInTheDocument()
    expect(screen.getByTestId("hist")).toHaveTextContent("1")
  })
});
