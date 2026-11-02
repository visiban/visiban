import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Scenario {
  name: string;
  options: {
    board_id: number;
    limit?: number;
    cursor?: number;
    store_initial?: number;
    poll_interval_s?: number;
    stop_after_sleeps?: number;
    max_retries?: number;
    break_after?: number;
  };
  responses: { status: number; headers?: Record<string, string>; body: unknown }[];
  expected: {
    items: [string, number][];
    requests: { path: string; query: Record<string, string> }[];
    commits: number[];
    sleeps_s: number[];
    error: string | null;
    resync_snapshot?: unknown;
  };
}

export interface SigCase {
  name: string;
  secret: string;
  headers: Record<string, string>;
  body: string;
  now: number;
  expected: boolean;
}

export interface Fixtures {
  scenarios: Scenario[];
  signature: { secret: string; timestamp: string; body: string; signature: string; cases: SigCase[] };
}

export const fixtures: Fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../contract/fixtures.json", import.meta.url)), "utf8"),
);

export interface Recorded {
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  redirect: string | undefined;
}

/** A fetch that replays scripted responses and records each request. */
export function scriptedFetch(responses: Scenario["responses"]) {
  const queue = [...responses];
  const requests: Recorded[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: new Headers(init?.headers).get("Authorization"),
      redirect: init?.redirect,
    });
    const next = queue.shift();
    if (!next) return new Response(null, { status: 599 });
    const body = next.body === null || next.body === undefined ? null : JSON.stringify(next.body);
    return new Response(body, { status: next.status, headers: next.headers });
  };
  return { fn: fn as typeof fetch, requests };
}
