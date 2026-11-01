# Marketing screenshots

Deterministic product screenshots for the marketing site, docs, and pitch deck (#1039).
This is opt-in tooling: `playwright.config.ts` ignores `e2e/marketing/`, so these specs
never run in the regular E2E suite or in CI.

Every API call is answered from `fixtures.ts` (no backend or dev database needed), the
clock is pinned, animations are disabled, and the viewport is 1440x900 at 2x, so the
output is the same on any machine on any day.

## Run it

```bash
cd frontend
npm run dev                  # terminal 1: serves http://localhost:5173
npm run shots:marketing      # terminal 2
```

Six PNGs are written to `~/Downloads`:

| File | Surface |
|---|---|
| `visiban-01-dashboard.png` | Dashboard: groups, favorite boards, my boards |
| `visiban-02-board.png` | Board: customer swimlanes across pipeline columns |
| `visiban-03-card-detail.png` | Card drawer, Activity tab showing column moves |
| `visiban-04-group-settings.png` | Group settings |
| `visiban-05-share-board.png` | Public read-only share page |
| `visiban-06-admin.png` | Site admin, Users tab |

### Environment overrides

| Variable | Default | Purpose |
|---|---|---|
| `MARKETING_BASE_URL` | `http://localhost:5173` | Dev server origin. Under `scripts/wt`, use `http://localhost:$WT_E2E_PORT` and start the server with `npm run dev -- --port $WT_E2E_PORT`. |
| `MARKETING_SHOTS_DIR` | `~/Downloads` | Output directory. |
| `MARKETING_DEBUG` | unset | Set to `1` to log API requests that no fixture answered. |

## Add a shot

1. Add any new fixture data to `fixtures.ts`, typed with the interfaces from `src/types`
   so `npx tsc -p tsconfig.e2e.json --noEmit` flags drift. Derive dates from `CLOCK`; never
   use `new Date()`.
2. If the page calls an endpoint `mockApi()` in `marketing-shots.spec.ts` does not answer,
   add a branch for it (run with `MARKETING_DEBUG=1` to find it).
3. Add a `test('NN — Name', ...)` that navigates, waits for a visible landmark, and calls
   `shoot(page, 'NN-name')`.
4. Update the table above.

Keep the story consistent: one agency, many customer accounts, one shared pipeline. No
lorem ipsum.
