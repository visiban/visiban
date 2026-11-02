# @visiban/client (TypeScript)

**Experimental (0.x), not published.** A thin client for the Visiban change feed
([`docs/api/events.md`](../../docs/api/events.md)): it holds a cursor, pages
`GET /api/v1/boards/{id}/events/`, and turns a `410 cursor_expired` into a typed
`Resync`. It is not a general REST SDK. Zero runtime dependencies; Node 20+
(global `fetch`); ESM with types.

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
  uncommitted, so it is delivered again. Make handlers idempotent; there is no
  exactly-once mode.
- **Resync.** On `410` the client keeps the response's `next_cursor`, fetches
  `/full/` (using only the path of `resync_url`, against your configured origin),
  and yields `Resync { boardId, snapshot, cursor }`. The cursor moves to it after
  your body returns. An event can appear in both the snapshot and the resumed feed.
- **Caught up** means `next_cursor` was `null`, never a short page.
- **Polling.** Without `pollIntervalMs` the iterator ends once caught up; with it,
  the iterator sleeps and polls until `signal` aborts.
- **Retries.** 429, 5xx and network errors back off exponentially (`Retry-After`
  honored, capped by `backoffMaxMs`); 400/401/403/404 throw typed errors at once.
- **Late-committing rows.** Event ids follow insertion order, not commit order
  ([#2053](https://gitlab.com/visiban/visiban/-/issues/2053)). `overlap: N`
  (default 0, off) re-reads from `cursor - N` and de-duplicates on `id`. It
  narrows the window; it is not gap-free.
- **Auth.** A scoped personal access token, sent only to `baseUrl`. Redirects are
  never followed, and plain `http://` to a non-loopback host is refused unless
  `allowInsecure: true`.

## Webhook signatures (experimental)

Separate entry point, so the main entry stays browser-safe (it uses `node:crypto`):

```typescript
import { verifySignature } from "@visiban/client/webhooks";

const ok = verifySignature(secret, req.headers, rawBodyBuffer); // false on any failure
```

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
