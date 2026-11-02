/**
 * Contract tests against a real Visiban backend (skipped unless configured).
 *
 * Environment: VISIBAN_CONTRACT_BASE_URL, VISIBAN_CONTRACT_TOKEN_FILE (a PAT with
 * read and write scopes), VISIBAN_CONTRACT_STATE, VISIBAN_CONTRACT_PHASE
 * ("feed" by default, or "expired"). CI runs "feed", prunes the board's events on
 * the server, then runs "expired".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BadRequestError, Client, MemoryCursorStore, Resync } from "../src/index.js";

const BASE = process.env.VISIBAN_CONTRACT_BASE_URL;
const TOKEN_FILE = process.env.VISIBAN_CONTRACT_TOKEN_FILE;
const PHASE = process.env.VISIBAN_CONTRACT_PHASE ?? "feed";
const STATE = process.env.VISIBAN_CONTRACT_STATE ?? "/tmp/visiban-contract-state-typescript.json";
const configured = Boolean(BASE && TOKEN_FILE);

const token = () => readFileSync(TOKEN_FILE as string, "utf8").trim();

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Token ${token()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe.skipIf(!configured)("live backend", () => {
  const client = () => new Client({ baseUrl: BASE as string, token: token(), allowInsecure: true });
  const boardId = async () =>
    Number(process.env.VISIBAN_CONTRACT_BOARD_ID ?? (await api("GET", "/api/v1/boards/")).results[0].id);

  it.skipIf(PHASE !== "feed")("pages in order and reports caught up", async () => {
    const id = await boardId();
    let head = 0;
    for await (const e of client().iterEvents(id, { limit: 500 })) head = (e as { id: number }).id;
    const full = await api("GET", `/api/v1/boards/${id}/full/`);
    for (let n = 0; n < 3; n++) {
      await api("POST", `/api/v1/boards/${id}/cards/`, { title: `contract ts ${n}`, column: full.columns[0].id, swimlane: full.swimlanes[0].id });
    }
    const store = new MemoryCursorStore();
    // limit=1 forces one request per row, exercising every page boundary.
    const events = (await drain(client().iterEvents(id, { cursor: head, store, limit: 1 }))) as { id: number; event: string }[];
    const ids = events.map((e) => e.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b));
    expect(ids.every((i) => i > head)).toBe(true);
    expect(events.some((e) => e.event === "card.created")).toBe(true);
    expect(store.get(id)).toBe(ids[ids.length - 1]);
    expect(await drain(client().iterEvents(id, { store }))).toEqual([]);
    const again = (await drain(client().iterEvents(id, { cursor: head, limit: 2, overlap: 5 }))) as { id: number }[];
    const againIds = again.map((e) => e.id);
    expect(new Set(againIds).size).toBe(againIds.length);
    for (const i of ids) expect(againIds).toContain(i);
    writeFileSync(STATE, JSON.stringify({ board_id: id, cursor: ids[0] }));
  });

  it.skipIf(PHASE !== "feed")("an out-of-range limit is a 400", async () => {
    await expect(client().fetchPage(await boardId(), 0, 501)).rejects.toBeInstanceOf(BadRequestError);
  });

  it.skipIf(PHASE !== "expired")("an expired cursor resyncs, then resumes", async () => {
    const state = JSON.parse(readFileSync(STATE, "utf8")) as { board_id: number; cursor: number };
    const store = new MemoryCursorStore();
    const items = await drain(client().iterEvents(state.board_id, { cursor: state.cursor, store }));
    const first = items[0];
    expect(first).toBeInstanceOf(Resync);
    const resync = first as Resync;
    expect((resync.snapshot as { id: number }).id).toBe(state.board_id);
    expect(Number.isInteger(resync.cursor)).toBe(true);
    expect(resync.cursor).toBeGreaterThanOrEqual(state.cursor);
    expect(items.slice(1).some((i) => i instanceof Resync)).toBe(false);
    const ids = items.slice(1).map((i) => (i as { id: number }).id);
    expect(store.get(state.board_id)).toBe(Math.max(resync.cursor, ...ids));
  });
});
