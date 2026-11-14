import { joinBoard, resolveBoardJoinToken } from "./boards";
import { joinGroup, resolveJoinToken } from "./groups";

/**
 * The one place the SPA maps an invite token's prefix to the API that resolves
 * and redeems it (#1491). Mirrors `backend/accounts/registration_tokens.py`,
 * which does the same on the server.
 *
 * Why a table: JoinPage and the OAuth-return handler in App.tsx each used to
 * branch on the prefix by hand, so a new kind honored in one and missed in the
 * other produced a silent 404 (the bug #1444 had to fix in App.tsx). Both now
 * call `inviteKindOf` / `joinInvite`, and `inviteKinds.test.ts` fails when the
 * backend's prefix list and this table disagree.
 */
export type InviteKindName = "site" | "group" | "board";

/** Where to send the browser once an invite has been redeemed. */
export interface InviteJoinOutcome {
  path: string;
  state: Record<string, unknown>;
}

export interface InviteKind {
  name: InviteKindName;
  prefix: string;
  /** Public preview call. Absent for site invites, which only authorize sign-up. */
  resolve?: (token: string) => Promise<unknown>;
  /** Redeem for the signed-in user. Absent for site invites. */
  join?: (token: string) => Promise<InviteJoinOutcome>;
}

export const SITE_INVITE: InviteKind = { name: "site", prefix: "vbnl_" };

export const GROUP_INVITE = {
  name: "group",
  prefix: "vbng_",
  resolve: (token: string) => resolveJoinToken(token),
  join: (token) =>
    joinGroup(token).then((group) => ({
      path: `/groups/${group.id}`,
      state: { joinedGroup: group.name },
    })),
} satisfies InviteKind;

export const BOARD_INVITE = {
  name: "board",
  prefix: "vbnb_",
  resolve: (token: string) => resolveBoardJoinToken(token),
  join: (token) =>
    joinBoard(token).then((res) => ({
      path: `/boards/${res.board_id}`,
      state: { joinedBoard: res.board_name, joinedRole: res.role, created: res.created },
    })),
} satisfies InviteKind;

export const INVITE_KINDS: readonly InviteKind[] = [SITE_INVITE, GROUP_INVITE, BOARD_INVITE];

/**
 * The kind for `token` by prefix. Unlike the backend (whose fallback is the
 * site kind) an unrecognized token here falls back to a group invite, which
 * preserves the pre-#1491 behavior for legacy unprefixed group links.
 */
export function inviteKindOf(token: string): InviteKind {
  return INVITE_KINDS.find((kind) => token.startsWith(kind.prefix)) ?? GROUP_INVITE;
}

/** Redeem `token` through its kind's join endpoint; rejects for site invites. */
export function joinInvite(token: string): Promise<InviteJoinOutcome> {
  const { join } = inviteKindOf(token);
  if (!join) return Promise.reject(new Error("Site invites are redeemed at registration"));
  return join(token);
}
