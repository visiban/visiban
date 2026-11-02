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
  sleep?: (ms: number) => Promise<void>;
}

export interface IterEventsOptions {
  /** Start after this event id. Default: the store's value, else 0. */
  cursor?: number;
  store?: CursorStore;
  /** 1-500. Default 100. */
  limit?: number;
  /** Unset: return once caught up. A number of ms: sleep and poll until aborted. */
  pollIntervalMs?: number;
  /**
   * Default 0 (off). Ids follow insert order, not commit order (#2053), so a
   * late-committing row can land below an id already passed. With overlap N each
   * poll re-reads from cursor - N and drops ids already delivered. Narrows the
   * window; does not make reads gap-free.
   */
  overlap?: number;
  signal?: AbortSignal;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

class Gone {
  constructor(readonly body: unknown) {}
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
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
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
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
  private async getJson(url: string): Promise<unknown> {
    let last: APIError | null = null;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      let status: number;
      let body: unknown;
      let retryAfter: string | null = null;
      try {
        const res = await this.opts.fetch(url, {
          headers: { Authorization: `Token ${this.token}`, Accept: "application/json" },
          // Never follow: a redirect would re-send the Authorization header elsewhere.
          redirect: "manual",
          signal: AbortSignal.timeout(this.opts.timeoutMs),
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
        last = new RetriesExhausted(0, `network error: ${exc instanceof Error ? exc.message : String(exc)}`);
        if (attempt < this.opts.maxRetries) await this.opts.sleep(this.delayMs(attempt, null));
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
        if (attempt < this.opts.maxRetries) await this.opts.sleep(this.delayMs(attempt, retryAfter));
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

  private async resync(boardId: number, body: unknown): Promise<Resync> {
    const rec = asRecord(body) ?? {};
    const nextCursor = rec.next_cursor;
    const resyncUrl = rec.resync_url;
    if (!isInt(nextCursor)) {
      throw new ResyncUnsupported(
        "410 cursor_expired without next_cursor: the server predates 1.3 and offers no safe resume point; upgrade the server to 1.3 or later",
        typeof resyncUrl === "string" ? resyncUrl : null,
      );
    }
    if (typeof resyncUrl !== "string") throw new ProtocolError("410 cursor_expired without resync_url");
    let snapshot: unknown;
    try {
      snapshot = await this.getJson(this.sameOriginUrl(resyncUrl));
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
   * "Caught up" means next_cursor was null, never a short page.
   */
  async *iterEvents(boardId: number, options: IterEventsOptions = {}): AsyncGenerator<FeedItem, void, undefined> {
    const limit = options.limit ?? 100;
    const overlap = options.overlap ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError("limit must be between 1 and 500");
    if (!Number.isInteger(overlap) || overlap < 0) throw new RangeError("overlap must not be negative");
    const store = options.store ?? new MemoryCursorStore();
    let current = options.cursor ?? (await store.get(boardId)) ?? 0;
    let delivered = new Set<number>();

    for (;;) {
      let after = Math.max(0, current - overlap);
      for (;;) {
        if (options.signal?.aborted) return;
        let page: unknown;
        try {
          page = await this.getJson(`${this.base}/api/v1/boards/${Math.trunc(boardId)}/events/?${new URLSearchParams({ after: String(after), limit: String(limit) })}`);
        } catch (exc) {
          if (!(exc instanceof Gone)) throw exc;
          const resync = await this.resync(boardId, exc.body);
          yield resync;
          await store.set(boardId, resync.cursor);
          current = resync.cursor;
          delivered = new Set();
          after = Math.max(0, current - overlap);
          continue;
        }
        const { results, nextCursor } = validatePage(page, after);
        for (const event of results) {
          if (delivered.has(event.id)) continue;
          yield event;
          if (overlap) delivered.add(event.id);
          if (event.id > current) {
            current = event.id;
            await store.set(boardId, current);
          }
        }
        if (nextCursor === null) break;
        after = nextCursor;
      }
      if (overlap) delivered = new Set([...delivered].filter((i) => i > current - overlap));
      if (options.pollIntervalMs === undefined || options.signal?.aborted) return;
      await this.opts.sleep(options.pollIntervalMs);
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
