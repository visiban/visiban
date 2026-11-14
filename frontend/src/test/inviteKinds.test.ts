import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/groups", () => ({
  resolveJoinToken: vi.fn(),
  joinGroup: vi.fn(),
}));
vi.mock("../api/boards", () => ({
  resolveBoardJoinToken: vi.fn(),
  joinBoard: vi.fn(),
}));

import { joinGroup } from "../api/groups";
import { joinBoard } from "../api/boards";
import { INVITE_KINDS, inviteKindOf, joinInvite } from "../api/inviteKinds";

// The backend's table is the source of truth for which prefixes exist (#1491).
function backendPrefixes(): string[] {
  const src = readFileSync(
    resolve(__dirname, "../../../backend/accounts/registration_tokens.py"),
    "utf8",
  );
  return [...src.matchAll(/RegistrationTokenKind\("\w+", "(vbn[a-z]_)"/g)].map((m) => m[1]);
}

describe("inviteKinds", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps every prefix the backend registers (fails when one is unmapped)", () => {
    const prefixes = backendPrefixes();
    expect(prefixes.sort()).toEqual(["vbnb_", "vbng_", "vbnl_"]);
    for (const prefix of prefixes) {
      expect(INVITE_KINDS.some((k) => k.prefix === prefix), `${prefix} unmapped`).toBe(true);
    }
    expect(INVITE_KINDS.map((k) => k.prefix).sort()).toEqual(prefixes.sort());
  });

  it("gives every non-site kind both a resolve and a join function", () => {
    for (const kind of INVITE_KINDS) {
      if (kind.name === "site") {
        expect(kind.join).toBeUndefined();
      } else {
        expect(kind.resolve, kind.name).toBeTypeOf("function");
        expect(kind.join, kind.name).toBeTypeOf("function");
      }
    }
  });

  it("dispatches by prefix, falling back to group", () => {
    expect(inviteKindOf("vbnl_abc").name).toBe("site");
    expect(inviteKindOf("vbng_abc").name).toBe("group");
    expect(inviteKindOf("vbnb_abc").name).toBe("board");
    expect(inviteKindOf("legacytoken").name).toBe("group");
  });

  it("joins a board invite through the board endpoint", async () => {
    vi.mocked(joinBoard).mockResolvedValue({ board_id: 4, board_name: "B", role: "member", created: true });
    await expect(joinInvite("vbnb_x")).resolves.toEqual({
      path: "/boards/4",
      state: { joinedBoard: "B", joinedRole: "member", created: true },
    });
    expect(joinGroup).not.toHaveBeenCalled();
  });

  it("joins a group invite through the group endpoint", async () => {
    vi.mocked(joinGroup).mockResolvedValue({ id: 9, name: "G" } as never);
    await expect(joinInvite("vbng_x")).resolves.toEqual({ path: "/groups/9", state: { joinedGroup: "G" } });
    expect(joinBoard).not.toHaveBeenCalled();
  });

  it("refuses to redeem a site invite", async () => {
    await expect(joinInvite("vbnl_x")).rejects.toThrow();
  });

  it("keeps prefix literals out of JoinPage and App (one dispatch table)", () => {
    for (const file of ["pages/JoinPage.tsx", "App.tsx"]) {
      const src = readFileSync(resolve(__dirname, "..", file), "utf8");
      // Comments may name a prefix; code must not branch on one.
      const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, file).not.toMatch(/["'`]vbn[a-z]_/);
    }
  });
});
