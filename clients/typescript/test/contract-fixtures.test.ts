/**
 * Runs every scenario in clients/contract/fixtures.json. The Python suite runs
 * the same scenarios and expectations, so a behavior difference between the two
 * languages fails one of them.
 */
import { describe, expect, it } from "vitest";
import { Client, MemoryCursorStore, Resync, VisibanError } from "../src/index.js";
import { fixtures, scriptedFetch, type Scenario } from "./helpers.js";

class Stop extends Error {}

class RecordingStore extends MemoryCursorStore {
  commits: number[] = [];
  override set(boardId: number, cursor: number): void {
    this.commits.push(cursor);
    super.set(boardId, cursor);
  }
}

async function run(scenario: Scenario): Promise<void> {
  const { options: opts, expected } = scenario;
  const store = new RecordingStore();
  if (opts.store_initial !== undefined) MemoryCursorStore.prototype.set.call(store, opts.board_id, opts.store_initial);
  const sleeps: number[] = [];
  const { fn, requests } = scriptedFetch(scenario.responses);
  const client = new Client({
    baseUrl: "http://127.0.0.1:9",
    token: "vbn_test_token",
    fetch: fn,
    jitter: false,
    maxRetries: opts.max_retries ?? 5,
    sleep: async (ms) => {
      sleeps.push(ms / 1000);
      if (opts.stop_after_sleeps !== undefined && sleeps.length >= opts.stop_after_sleeps) throw new Stop();
    },
  });

  const items: Awaited<ReturnType<AsyncGenerator<unknown>["next"]>>["value"][] = [];
  let error: string | null = null;
  try {
    for await (const item of client.iterEvents(opts.board_id, {
      store,
      limit: opts.limit,
      cursor: opts.cursor,
      overlap: opts.overlap,
      pollIntervalMs: opts.poll_interval_s === undefined ? undefined : opts.poll_interval_s * 1000,
    })) {
      items.push(item);
      if (opts.break_after && items.length >= opts.break_after) break;
    }
  } catch (exc) {
    if (exc instanceof Stop) {
      // expected end of a poll scenario
    } else if (exc instanceof VisibanError) {
      error = exc.constructor.name;
    } else throw exc;
  }

  const summary = items.map((i) => (i instanceof Resync ? ["resync", i.cursor] : ["event", (i as { id: number }).id]));
  expect(summary).toEqual(expected.items);
  expect(requests.map((r) => ({ path: r.path, query: r.query }))).toEqual(expected.requests);
  expect(store.commits).toEqual(expected.commits);
  expect(sleeps).toEqual(expected.sleeps_s);
  expect(error).toBe(expected.error);
  for (const r of requests) expect(r.authorization).toBe("Token vbn_test_token");

  const sent = new Map<number, unknown>();
  for (const r of scenario.responses) {
    const body = r.body as { results?: { id: number }[] } | null;
    for (const e of body?.results ?? []) sent.set(e.id, e);
  }
  for (const item of items) {
    if (item instanceof Resync) expect(item.snapshot).toEqual(expected.resync_snapshot);
    else expect(item).toEqual(sent.get((item as { id: number }).id));
  }
}

describe("contract fixtures", () => {
  for (const scenario of fixtures.scenarios) {
    it(scenario.name, () => run(scenario));
  }
});
