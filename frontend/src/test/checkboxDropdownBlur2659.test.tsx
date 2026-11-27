import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CheckboxDropdown from "../components/Common/CheckboxDropdown";

// #2659 — an inline checklist must survive the focus loss a Safari checkbox click causes
// (relatedTarget null) and close only when focus lands outside the wrapper.
const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

function Harness({ onChange }: { onChange?: (v: string[]) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  return (
    <div>
      <button type="button">outside</button>
      <CheckboxDropdown label="Stack" options={OPTIONS} selected={sel} menuMode="inline" onChange={(v) => { setSel(v); onChange?.(v); }} />
    </div>
  );
}

describe("CheckboxDropdown inline blur (#2659)", () => {
  it("stays open when focus is lost with no related target", async () => {
    render(<Harness />);
    await userEvent.setup().click(screen.getByRole("button", { name: /stack/i }));
    fireEvent.blur(screen.getByRole("checkbox", { name: /alpha/i }), { relatedTarget: null });
    expect(screen.getByRole("group")).toBeInTheDocument();
  });

  it("closes when focus moves to an element outside the wrapper", async () => {
    render(<Harness />);
    await userEvent.setup().click(screen.getByRole("button", { name: /stack/i }));
    fireEvent.blur(screen.getByRole("checkbox", { name: /alpha/i }), { relatedTarget: screen.getByRole("button", { name: "outside" }) });
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("keeps the list open across a second checkbox click with both ticked", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /stack/i }));
    await user.click(screen.getByRole("checkbox", { name: /alpha/i }));
    fireEvent.blur(screen.getByRole("checkbox", { name: /alpha/i }), { relatedTarget: null });
    await user.click(screen.getByRole("checkbox", { name: /beta/i }));
    expect(screen.getByRole("group")).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(["a", "b"]);
    expect(screen.getByRole("checkbox", { name: /alpha/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /beta/i })).toBeChecked();
  });
});
