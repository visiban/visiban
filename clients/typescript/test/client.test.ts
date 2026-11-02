import { describe, expect, it } from "vitest";
import { Client, MemoryCursorStore, ProtocolError, ResyncUnsupported } from "../src/index.js";
import { scriptedFetch } from "./helpers.js";

const make = (responses: { status: number; headers?: Record<string, string>; body: unknown }[], extra = {}) => {
  const { fn, requests } = scriptedFetch(responses);
  const sleeps: number[] = [];
  const client = new Client({ baseUrl: "http://127.0.0.1:9", token: "vbn_x", fetch: fn, jitter: false, sleep: async (ms) => void sleeps.push(ms), ...extra });
  return { client, requests, sleeps };
};
const drain = async (it: AsyncIterable<unknown>) => {
  const out: unknown[] = [];
  for await (const x of it) out.push(x);
  return out;
};
const ok = (results: unknown[], next: number | null = null) => ({ status: 200, body: { results, next_cursor: next } });

describe("constructor", () => {
  it("validates token and url", () => {
    expect(() => new Client({ baseUrl: "http://127.0.0.1:1", token: "" })).toThrow(TypeError);
    expect(() => new Client({ baseUrl: "file:///x", token: "t" })).toThrow(TypeError);
    expect(() => new Client({ baseUrl: "not a url", token: "t" })).toThrow(TypeError);
    expect(() => new Client({ baseUrl: "http://example.com", token: "t" })).toThrow(TypeError);
    expect(() => new Client({ baseUrl: "http://example.com", token: "t", allowInsecure: true })).not.toThrow();
    expect(() => new Client({ baseUrl: "https://example.com", token: "t" })).not.toThrow();
  });

  it("rejects a token with whitespace without echoing it", () => {
    for (const token of ["vbn_secret\n", "vbn secret", "vbn_\u0000x"]) {
      expect(() => new Client({ baseUrl: "http://127.0.0.1:1", token })).toThrow(/whitespace or control/);
      try {
        new Client({ baseUrl: "http://127.0.0.1:1", token });
      } catch (e) {
        expect((e as Error).message).not.toContain("vbn");
      }
    }
  });

  it("rejects credentials in baseUrl without echoing them", () => {
    expect(() => new Client({ baseUrl: "https://user:" + "hunter2" + "@example.com", token: "t" })).toThrow(/credentials/);
    try {
      new Client({ baseUrl: "https://user:" + "hunter2" + "@example.com", token: "t" });
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
    }
    expect(() => new Client({ baseUrl: "https://user@example.com", token: "t" })).toThrow(TypeError);
  });

  it("uses global fetch by default", () => {
    expect(() => new Client({ baseUrl: "https://example.com", token: "t" })).not.toThrow();
  });

  it("validates limit", async () => {
    const { client } = make([]);
    await expect(drain(client.iterEvents(1, { limit: 0 }))).rejects.toThrow(RangeError);
    await expect(drain(client.iterEvents(1, { limit: 501 }))).rejects.toThrow(RangeError);
  });
});

describe("transport", () => {
  it("does not follow redirects (status surfaces as an APIError)", async () => {
    const { client, requests } = make([{ status: 302, headers: { Location: "http://127.0.0.1:9/x" }, body: null }]);
    await expect(drain(client.iterEvents(1))).rejects.toMatchObject({ status: 302 });
    expect(requests).toHaveLength(1);
    // The mock ignores the option, so assert it is what the client asked for.
    expect(requests[0]?.redirect).toBe("manual");
  });

  it("retries network errors then raises RetriesExhausted", async () => {
    const sleeps: number[] = [];
    const client = new Client({
      baseUrl: "http://127.0.0.1:9",
      token: "vbn_x",
      maxRetries: 2,
      jitter: false,
      sleep: async (ms) => void sleeps.push(ms),
      fetch: (async () => {
        throw new Error("boom");
      }) as typeof fetch,
    });
    await expect(drain(client.iterEvents(1))).rejects.toMatchObject({ name: "RetriesExhausted" });
    expect(sleeps).toEqual([500, 1000]);
  });

  it("caps backoff and Retry-After", async () => {
    const a = make([{ status: 500, body: null }, { status: 500, body: null }, { status: 500, body: null }, { status: 500, body: null }], { maxRetries: 3, backoffBaseMs: 1000, backoffMaxMs: 2000 });
    await expect(drain(a.client.iterEvents(1))).rejects.toBeTruthy();
    expect(a.sleeps).toEqual([1000, 2000, 2000]);
    const b = make([{ status: 429, headers: { "Retry-After": "9999" }, body: null }, ok([])], { backoffMaxMs: 7000 });
    await drain(b.client.iterEvents(1));
    expect(b.sleeps).toEqual([7000]);
  });

  it("jittered backoff stays in bounds", async () => {
    const j = make([{ status: 500, body: null }, { status: 500, body: null }, { status: 500, body: null }], { maxRetries: 2, jitter: true, backoffBaseMs: 1000 });
    await expect(drain(j.client.iterEvents(1))).rejects.toBeTruthy();
    expect(j.sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(j.sleeps[0]).toBeLessThanOrEqual(1000);
    expect(j.sleeps[1]).toBeGreaterThanOrEqual(1000);
    expect(j.sleeps[1]).toBeLessThanOrEqual(2000);
  });

  it("treats non-JSON error bodies as empty", async () => {
    const { client } = make([{ status: 400, body: null }]);
    await expect(drain(client.iterEvents(1))).rejects.toMatchObject({ name: "BadRequestError", detail: "" });
  });
});

describe("truncated bodies and abort", () => {
  const truncated = () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"results": ['));
        controller.error(new Error("socket closed"));
      },
    });
    return new Response(stream, { status: 200 });
  };

  it("retries a body that fails mid-stream", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = new Client({
      baseUrl: "http://127.0.0.1:9",
      token: "vbn_x",
      jitter: false,
      sleep: async (ms) => void sleeps.push(ms),
      fetch: (async () => (++calls === 1 ? truncated() : new Response(JSON.stringify({ results: [{ id: 1 }], next_cursor: null })))) as typeof fetch,
    });
    expect(await drain(client.iterEvents(1))).toHaveLength(1);
    expect(sleeps).toEqual([500]);
  });

  it("a 200 body that is not a page is a ProtocolError", async () => {
    const { client } = make([{ status: 200, body: "not-a-page" }]);
    await expect(drain(client.iterEvents(1))).rejects.toBeInstanceOf(ProtocolError);
  });

  it("aborts an in-flight request without retrying", async () => {
    const ac = new AbortController();
    let calls = 0;
    const client = new Client({
      baseUrl: "http://127.0.0.1:9",
      token: "vbn_x",
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          calls++;
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch,
    });
    const run = drain(client.iterEvents(1, { signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect(await run).toEqual([]);
    expect(calls).toBe(1);
  });

  it("the default sleep wakes immediately on abort", async () => {
    const ac = new AbortController();
    const { fn } = scriptedFetch([ok([]), ok([])]);
    const client = new Client({ baseUrl: "http://127.0.0.1:9", token: "vbn_x", fetch: fn });
    const started = Date.now();
    const run = drain(client.iterEvents(1, { pollIntervalMs: 60_000, signal: ac.signal }));
    setTimeout(() => ac.abort(), 20);
    expect(await run).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("passes the signal to a custom sleep", async () => {
    const ac = new AbortController();
    let received: AbortSignal | undefined;
    const { client } = make([ok([])], { sleep: async (_ms: number, s?: AbortSignal) => { received = s; ac.abort(); } });
    await drain(client.iterEvents(1, { pollIntervalMs: 10, signal: ac.signal }));
    expect(received).toBe(ac.signal);
  });
});

describe("protocol", () => {
  it("rejects malformed pages", async () => {
    for (const body of [[], { results: "x" }, { results: [], next_cursor: "5" }, { results: [{ event: "no id" }] }, { results: [3] }]) {
      const { client } = make([{ status: 200, body }]);
      await expect(drain(client.iterEvents(1))).rejects.toBeInstanceOf(ProtocolError);
    }
  });

  it("needs a resync_url on a 410", async () => {
    const { client } = make([{ status: 410, body: { code: "cursor_expired", next_cursor: 4 } }]);
    await expect(drain(client.iterEvents(1, { cursor: 1 }))).rejects.toBeInstanceOf(ProtocolError);
  });

  it("needs the snapshot to be an object", async () => {
    const gone = { code: "cursor_expired", next_cursor: 4, resync_url: "http://x/api/v1/boards/1/full/" };
    const { client } = make([{ status: 410, body: gone }, { status: 200, body: [1] }]);
    await expect(drain(client.iterEvents(1, { cursor: 1 }))).rejects.toBeInstanceOf(ProtocolError);
  });

  it("keeps resync_url on ResyncUnsupported", async () => {
    const gone = { code: "cursor_expired", resync_url: "http://x/api/v1/boards/1/full/" };
    const { client } = make([{ status: 410, body: gone }]);
    await expect(drain(client.iterEvents(1, { cursor: 1 }))).rejects.toMatchObject({ resyncUrl: gone.resync_url });
    const again = make([{ status: 410, body: gone }]);
    await expect(drain(again.client.iterEvents(1, { cursor: 1 }))).rejects.toBeInstanceOf(ResyncUnsupported);
  });

  it("gives up after repeated 410s", async () => {
    const gone = { code: "cursor_expired", next_cursor: 4, resync_url: "http://x/api/v1/boards/1/full/" };
    const { client } = make(Array.from({ length: 4 }, () => [{ status: 410, body: gone }, { status: 200, body: { id: 1 } }]).flat());
    let seen = 0;
    await expect(
      (async () => {
        for await (const _ of client.iterEvents(1, { cursor: 1 })) seen++;
      })(),
    ).rejects.toBeInstanceOf(ProtocolError);
    expect(seen).toBe(3);
  });

  it("rejects a negative resync cursor", async () => {
    const gone = { code: "cursor_expired", next_cursor: -1, resync_url: "http://x/api/v1/boards/1/full/" };
    const { client } = make([{ status: 410, body: gone }]);
    await expect(drain(client.iterEvents(1, { cursor: 1 }))).rejects.toBeInstanceOf(ProtocolError);
  });

  it("a 410 that is not cursor_expired is an APIError", async () => {
    const { client } = make([{ status: 410, body: { detail: "gone", code: "other" } }]);
    await expect(drain(client.iterEvents(1))).rejects.toMatchObject({ status: 410 });
  });

  it("fetchPage maps a stray cursor_expired 410 to ProtocolError", async () => {
    const { client } = make([{ status: 410, body: { code: "cursor_expired" } }]);
    await expect(client.fetchPage(1)).rejects.toBeInstanceOf(ProtocolError);
  });

  it("fetchPage returns the parsed page", async () => {
    const { client, requests } = make([ok([{ id: 1 }])]);
    expect(await client.fetchPage(1, 3, 5)).toEqual({ results: [{ id: 1 }], next_cursor: null });
    expect(requests[0]?.query).toEqual({ after: "3", limit: "5" });
  });
});

describe("redelivery and default store", () => {
  it("a new iterator after a handler throw redelivers the failed item", async () => {
    const page = { status: 200, body: { results: [{ id: 1 }, { id: 2 }], next_cursor: null } };
    const { client } = make([page, page]);
    const store = new MemoryCursorStore();
    await expect(
      (async () => {
        for await (const _ of client.iterEvents(1, { store })) throw new Error("handler failed");
      })(),
    ).rejects.toThrow("handler failed");
    expect(store.get(1)).toBeUndefined();
    const again = (await drain(client.iterEvents(1, { store }))) as { id: number }[];
    expect(again.map((e) => e.id)).toEqual([1, 2]);
  });

  it("the default store is per call, so a bare call replays from 0", async () => {
    const page = { status: 200, body: { results: [{ id: 1 }], next_cursor: null } };
    const { client, requests } = make([page, page]);
    await drain(client.iterEvents(1));
    await drain(client.iterEvents(1));
    expect(requests.map((r) => r.query.after)).toEqual(["0", "0"]);
  });
});

describe("iteration", () => {
  it("stops polling when the signal aborts", async () => {
    const ac = new AbortController();
    const { client } = make([ok([{ id: 1 }]), ok([])], { sleep: async () => ac.abort() });
    const out = await drain(client.iterEvents(1, { pollIntervalMs: 10, signal: ac.signal }));
    expect(out).toHaveLength(1);
  });

  it("returns immediately when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { client, requests } = make([]);
    expect(await drain(client.iterEvents(1, { signal: ac.signal }))).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("works with an async store", async () => {
    const data = new Map<number, number>([[1, 7]]);
    const store = { get: async (b: number) => data.get(b), set: async (b: number, c: number) => void data.set(b, c) };
    const { client, requests } = make([ok([{ id: 8 }])]);
    await drain(client.iterEvents(1, { store }));
    expect(requests[0]?.query.after).toBe("7");
    expect(data.get(1)).toBe(8);
  });

  it("MemoryCursorStore round-trips", () => {
    const s = new MemoryCursorStore();
    expect(s.get(1)).toBeUndefined();
    s.set(1, 3);
    expect(s.get(1)).toBe(3);
  });
});
