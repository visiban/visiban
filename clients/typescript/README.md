# @visiban/client (TypeScript)

**Experimental (0.x), not published.** A thin client for the Visiban change feed
([`docs/api/events.md`](../../docs/api/events.md)): it holds a cursor, pages
`GET /api/v1/boards/{id}/events/`, and turns a `410 cursor_expired` into a typed
`Resync`. It is not a general REST SDK. Zero runtime dependencies; Node 20.3+
(global `fetch`, `AbortSignal.any`); ESM with types.

Requires **Visiban server 1.3 or later**. A 1.2 server's `410` has no
`next_cursor`, so the client throws `ResyncUnsupported` instead of guessing.

## Install

The package is not on npm, and **npm cannot install from a Git subdirectory**, so a
consumer outside this repository needs a tarball (or a future 0.x release):

```bash
cd clients/typescript
npm ci && npm run build && npm pack      # writes visiban-client-0.1.0.tgz
cd /path/to/your/project && npm install /path/to/visiban-client-0.1.0.tgz
```

## Use

```typescript
import { Client, MemoryCursorStore, Resync } from "@visiban/client";

const client = new Client({ baseUrl: "https://visiban.example.com", token }); // PAT with `read`
const store = new MemoryCursorStore(); // or your own CursorStore (sync or async)

for await (const item of client.iterEvents(boardId, { store, pollIntervalMs: 5000, signal })) {
  if (item instanceof Resync) replaceLocalState(item.snapshot); // the /full/ board state
  else handle(item); // a feed row, passed through verbatim
}
```

- **At-least-once.** The stored cursor advances when the loop asks for the *next*
  item, after your body returned. A `break` or a throw leaves that item
  uncommitted. To redeliver it, call `iterEvents` again (a new iterator over the
  same store); do not resume the old generator after a throw, because it would
  treat the failed item as handled and commit it. Make handlers idempotent; there
  is no exactly-once mode.
- **Resync.** On `410` the client keeps the response's `next_cursor`, fetches
  `/full/` (using only the path of `resync_url`, against your configured origin),
  and yields `Resync { boardId, snapshot, cursor }`. The cursor moves to it after
  your body returns. An event can appear in both the snapshot and the resumed feed.
- **Reconnect cursor.** Resume only from a cursor the feed handed you
  (`next_cursor`), never from the `event_id` of a WebSocket frame. Frames can
  arrive out of `event_id` order, so a frame's id can be past an event that is
  still committing; the feed's cursor never is ([#2159](https://gitlab.com/visiban/visiban/-/issues/2159)).
  This client has no socket code and only ever resumes from the feed cursor.
- **Bootstrap a first cursor.** `/full/` carries no event id and `after=0`
  never returns `410`. For a socket consumer, drain the feed first and discard
  the rows (`for await (const _ of client.iterEvents(boardId, { store })) {}`), so the
  store holds the newest id; then open the socket and fetch `/full/`. Do not
  apply 30 days of history over a fresh snapshot. Events committed after that
  cursor may repeat over the snapshot; de-duplicate by event id.
- **Caught up** means the server's `next_cursor` was `null`; the client never
  counts rows.
- **Polling.** Without `pollIntervalMs` the iterator ends once caught up; with it,
  the iterator sleeps and polls until `signal` aborts.
- **Retries.** 429, 5xx and network errors back off exponentially (`Retry-After`
  honored, capped by `backoffMaxMs`); 400/401/403/404 throw typed errors at once.
- **Late-committing rows.** Event ids follow insertion order, not commit order.
  A Visiban 1.3 or later server never hands out a page that reaches past an
  event still committing ([#2053](https://gitlab.com/visiban/visiban/-/issues/2053)),
  so reads against it are gap-free with no overlap option. Against an earlier
  server a read can step past a row that commits a moment later.
- **Auth.** A scoped personal access token (`read` is enough; the client only
  issues GETs), sent only to the host in `baseUrl`. Redirects are never followed,
  and plain `http://` to a non-loopback host is refused unless
  `allowInsecure: true`. Node's built-in `fetch` does not read proxy environment
  variables by default; if you route it through a proxy, the token travels
  through it, so use `https`.
- **Default store.** Without `store`, each `iterEvents` call gets a fresh
  `MemoryCursorStore`, so a bare call replays from 0. Reuse one store (or pass
  `cursor`) to resume.

## Webhook signatures (experimental)

Separate entry point, so the main entry stays browser-safe (it uses `node:crypto`):

```typescript
import { verifySignature } from "@visiban/client/webhooks";

const ok = verifySignature(secret, req.headers, rawBodyBuffer); // false on any failure
```

During a secret rotation the signature header can list two values
(`v1=<new>,v1=<old>`); the check accepts a request when any value matches, so a
receiver holds one secret and needs no second setting. Earlier copies of this
package compared the whole header and reject those requests: upgrade before
rotating with an overlap.

Pass the unparsed request body (for Express, `express.raw()`). Experimental until
the webhooks API is stable ([#2070](https://gitlab.com/visiban/visiban/-/issues/2070)).

## Tests

```bash
cd clients/typescript
npm ci
npm test            # vitest with coverage (80% threshold)
npm run typecheck && npm run lint && npm run build
```

`test/contract-fixtures.test.ts` and `test/webhooks.test.ts` run the shared cases
in [`clients/contract/fixtures.json`](../contract/fixtures.json); the Python suite
runs the same file. `test/live.test.ts` runs against a real backend when
`VISIBAN_CONTRACT_BASE_URL` and `VISIBAN_CONTRACT_TOKEN_FILE` are set (CI does
this in the `clients-contract` job).

Apache 2.0, same as Visiban.
