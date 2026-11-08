/**
 * Change-feed client (EXPERIMENTAL, 0.x). Covers only the feed contract in
 * docs/api/events.md. Delivery is at-least-once: the cursor advances only
 * after the consumer's loop body returned for an item, so a crash replays that
 * item. Handlers must be idempotent; exactly-once is not offered.
 */
import { MemoryCursorStore, type CursorStore } from "./cursor.js";
import {
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  ProtocolError,
  ResyncUnsupported,
  RetriesExhausted,
} from "./errors.js";

/** A feed row, passed through verbatim: unknown fields and redactions included. */
export interface BoardEvent {
  id: number;
  event: string;
  data: unknown;
  redacted_at?: string | null;
  [key: string]: unknown;
}

/**
 * The consumer's cursor expired (410 cursor_expired). `snapshot` is the /full/
 * board state fetched after the 410; `cursor` is the 410's `next_cursor`, where
 * the feed resumes. Events written around the re-sync can arrive both in the
 * snapshot and on the resumed feed: apply them idempotently.
 */
export class Resync {
  constructor(
    readonly boardId: number,
    readonly snapshot: Record<string, unknown>,
    readonly cursor: number,
  ) {}
}

export type FeedItem = BoardEvent | Resync;

export interface ClientOptions {
  baseUrl: string;
  /** A scoped personal access token with the `read` scope. */
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  jitter?: boolean;
  allowInsecure?: boolean;
  /** Resolves after ms. Receives the iteration's AbortSignal; should resolve early when it aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface IterEventsOptions {
  /** Start after this event id. Default: the store's value, else 0. */
  cursor?: number;
  /**
   * Default: a fresh MemoryCursorStore created per iterEvents call, so a bare
   * call replays from 0 every time. Keep one store across calls, or pass
   * `cursor`, to resume.
   */
  store?: CursorStore;
  /** 1-500. Default 100. */
  limit?: number;
  /** Unset: return once caught up. A number of ms: sleep and poll until aborted. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Internal: the caller's AbortSignal fired. iterEvents turns it into a clean return. */
class Aborted extends Error {}

class Gone {
  constructor(readonly body: unknown) {}
}

const MAX_CONSECUTIVE_RESYNCS = 3;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function errorFor(status: number, body: unknown): Error | Gone {
  const rec = asRecord(body);
  const detail = typeof rec?.detail === "string" ? rec.detail : "";
  const code = typeof rec?.code === "string" ? rec.code : null;
  if (status === 410 && code === "cursor_expired") return new Gone(body);
  if (status === 401 || status === 403) return new AuthenticationError(status, detail, code, body);
  if (status === 404) return new NotFoundError(status, detail, code, body);
  if (status === 400) return new BadRequestError(status, detail, code, body);
  return new APIError(status, detail, code, body);
}

export class Client {
  private readonly base: string;
  private readonly origin: string;
  private readonly opts: Required<Omit<ClientOptions, "baseUrl" | "token">>;
  private readonly token: string;

  constructor(options: ClientOptions) {
    if (!options.token) throw new TypeError("token is required (a scoped personal access token)");
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (/[\s\x00-\x1f\x7f]/.test(options.token)) {
      // Fixed message: never echo the token. A trailing newline from a token file is the usual cause.
      throw new TypeError("token contains whitespace or control characters");
    }
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new TypeError("baseUrl must be an http(s) URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("baseUrl must be an http(s) URL");
    }
    if (url.protocol === "http:" && !LOOPBACK.has(url.hostname) && !options.allowInsecure) {
      throw new TypeError("refusing to send a token over plain http to a non-loopback host; use https or allowInsecure");
    }
    if (url.username !== "" || url.password !== "") {
      // Fixed message: the credentials must not appear in any error.
      throw new TypeError("baseUrl must not contain credentials; pass the token separately");
    }
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.origin = url.origin;
    this.token = options.token;
    this.opts = {
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 5,
      backoffBaseMs: options.backoffBaseMs ?? 500,
      backoffMaxMs: options.backoffMaxMs ?? 30_000,
      jitter: options.jitter ?? true,
      allowInsecure: options.allowInsecure ?? false,
      sleep:
        options.sleep ??
        ((ms, signal) =>
          new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            const done = () => {
              clearTimeout(timer);
              signal?.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, ms);
            signal?.addEventListener("abort", done, { once: true });
          })),
    };
  }

  private delayMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) {
      return Math.min(Number(retryAfter.trim()) * 1000, this.opts.backoffMaxMs);
    }
    let delay = Math.min(this.opts.backoffBaseMs * 2 ** attempt, this.opts.backoffMaxMs);
    if (this.opts.jitter) delay *= 0.5 + Math.random() / 2;
    return delay;
  }

  /** GET with retry on 429, 5xx and network errors. Throws Gone for a cursor_expired 410. */
  private async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    let last: APIError | null = null;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (signal?.aborted) throw new Aborted();
      let status: number;
      let body: unknown;
      let retryAfter: string | null = null;
      try {
        const res = await this.opts.fetch(url, {
          headers: { Authorization: `Token ${this.token}`, Accept: "application/json" },
          // Never follow: a redirect would re-send the Authorization header elsewhere.
          redirect: "manual",
          // Aborts on the request timeout or the caller's signal, whichever is first.
          signal: signal ? AbortSignal.any([AbortSignal.timeout(this.opts.timeoutMs), signal]) : AbortSignal.timeout(this.opts.timeoutMs),
        });
        status = res.status;
        retryAfter = res.headers.get("Retry-After");
        const text = await res.text();
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
      } catch (exc) {
        if (signal?.aborted) throw new Aborted();
        last = new RetriesExhausted(0, `network error: ${exc instanceof Error ? exc.message : String(exc)}`);
        if (attempt < this.opts.maxRetries) await this.opts.sleep(this.delayMs(attempt, null), signal);
        continue;
      }
      if (status >= 200 && status < 300) return body;
      if (status === 429 || status >= 500) {
        const rec = asRecord(body);
        last = new RetriesExhausted(
          status,
          typeof rec?.detail === "string" ? rec.detail : "",
          typeof rec?.code === "string" ? rec.code : null,
          body,
        );
        if (attempt < this.opts.maxRetries) await this.opts.sleep(this.delayMs(attempt, retryAfter), signal);
        continue;
      }
      throw errorFor(status, body);
    }
    throw last as APIError;
  }

  /**
   * Resolve the 410's resync_url against baseUrl, keeping only its path: the
   * server builds that URL from the Host header (an internal name behind a
   * proxy), and following it verbatim could send the token to another host.
   */
  private sameOriginUrl(resyncUrl: string): string {
    let parsed: URL;
    try {
      parsed = new URL(resyncUrl, this.origin);
    } catch {
      throw new ProtocolError("resync_url is not a URL");
    }
    return this.origin + parsed.pathname + parsed.search;
  }

  /** One raw events page, as parsed JSON. Prefer iterEvents. */
  async fetchPage(boardId: number, after = 0, limit = 100): Promise<unknown> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    try {
      return await this.getJson(`${this.base}/api/v1/boards/${Math.trunc(boardId)}/events/?${query}`);
    } catch (exc) {
      if (exc instanceof Gone) throw new ProtocolError("unexpected 410 outside iterEvents");
      throw exc;
    }
  }

  private async resync(boardId: number, body: unknown, signal?: AbortSignal): Promise<Resync> {
    const rec = asRecord(body) ?? {};
    const nextCursor = rec.next_cursor;
    const resyncUrl = rec.resync_url;
    if (isInt(nextCursor) && nextCursor < 0) throw new ProtocolError("410 next_cursor is negative");
    if (!isInt(nextCursor)) {
      throw new ResyncUnsupported(
        "410 cursor_expired without next_cursor: the server predates 1.3 and offers no safe resume point; upgrade the server to 1.3 or later",
        typeof resyncUrl === "string" ? resyncUrl : null,
      );
    }
    if (typeof resyncUrl !== "string") throw new ProtocolError("410 cursor_expired without resync_url");
    let snapshot: unknown;
    try {
      snapshot = await this.getJson(this.sameOriginUrl(resyncUrl), signal);
    } catch (exc) {
      if (exc instanceof Gone) throw new ProtocolError("unexpected 410 fetching the snapshot");
      throw exc;
    }
    const snap = asRecord(snapshot);
    if (!snap) throw new ProtocolError("resync snapshot is not a JSON object");
    return new Resync(boardId, snap, nextCursor);
  }

  /**
   * Yield events in feed order, and a Resync when the cursor expired. The
   * stored cursor moves to an item's id when you ask for the *next* item, i.e.
   * after your loop body returned; `break` or a throw leaves it uncommitted.
   * After a throw call iterEvents again for a new generator: calling next() on
   * the old one would treat the failed item as handled and commit it.
   * "Caught up" means the server's next_cursor was null; the client never
   * counts rows. There is no overlap option and none is needed against a 1.3
   * or later server: ids follow insert order, not commit order, but the server
   * never hands out a page past an event still committing (#2053), so reads
   * are gap-free. Against an earlier server they are not.
   */
  async *iterEvents(boardId: number, options: IterEventsOptions = {}): AsyncGenerator<FeedItem, void, undefined> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError("limit must be between 1 and 500");
    const store = options.store ?? new MemoryCursorStore();
    let current = options.cursor ?? (await store.get(boardId)) ?? 0;
    let resyncs = 0; // consecutive, reset by any successful page

    for (;;) {
      let after = current;
      for (;;) {
        if (options.signal?.aborted) return;
        let page: unknown;
        try {
          page = await this.getJson(`${this.base}/api/v1/boards/${Math.trunc(boardId)}/events/?${new URLSearchParams({ after: String(after), limit: String(limit) })}`, options.signal);
        } catch (exc) {
          if (exc instanceof Aborted) return;
          if (!(exc instanceof Gone)) throw exc;
          if (++resyncs > MAX_CONSECUTIVE_RESYNCS) throw new ProtocolError("server keeps answering 410 after re-syncing; giving up");
          let resync: Resync;
          try {
            resync = await this.resync(boardId, exc.body, options.signal);
          } catch (inner) {
            if (inner instanceof Aborted) return;
            throw inner;
          }
          yield resync;
          await store.set(boardId, resync.cursor);
          current = resync.cursor;
          after = current;
          continue;
        }
        const { results, nextCursor } = validatePage(page, after);
        resyncs = 0;
        for (const event of results) {
          yield event;
          if (event.id > current) {
            current = event.id;
            await store.set(boardId, current);
          }
        }
        if (nextCursor === null) break;
        after = nextCursor;
      }
      if (options.pollIntervalMs === undefined || options.signal?.aborted) return;
      await this.opts.sleep(options.pollIntervalMs, options.signal);
      if (options.signal?.aborted) return;
    }
  }
}

function validatePage(page: unknown, after: number): { results: BoardEvent[]; nextCursor: number | null } {
  const rec = asRecord(page);
  if (!rec || !Array.isArray(rec.results)) throw new ProtocolError("events response has no results list");
  const next = rec.next_cursor ?? null;
  if (next !== null && !isInt(next)) throw new ProtocolError("next_cursor is not an integer or null");
  for (const event of rec.results) {
    if (asRecord(event) === null || !isInt((event as Record<string, unknown>).id)) {
      throw new ProtocolError("event row without an integer id");
    }
  }
  if (next !== null && next <= after) throw new ProtocolError("next_cursor did not advance; refusing to loop");
  return { results: rec.results as BoardEvent[], nextCursor: next };
}
