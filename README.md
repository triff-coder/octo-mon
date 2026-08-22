# octo-mon

An iPhone home-screen widget (built with [Scriptable](https://scriptable.app/)) showing:

- **Current cost**: live demand from your Octopus Home Mini × the current Octopus
  Agile unit rate, as £/hr
- **Today's total**: running spend so far today, in £
- **This month's total**: running spend since the start of the current Octopus
  billing period (the 20th of each month), in £

A small [Cloudflare Worker](https://workers.cloudflare.com/) sits in between the
widget and Octopus: it holds your Octopus credentials as secrets, polls Octopus
every 5 minutes via a Cron Trigger, keeps running "today" and "this month"
totals in Workers KV, and exposes one small JSON endpoint (`GET /status`) that
the widget polls, protected by a shared-secret token.

## How it works

```
Octopus Kraken GraphQL API (live telemetry)  ─┐
Octopus REST API (Agile unit rates)          ─┼─▶ Cloudflare Worker ─▶ Scriptable widget
                                               │      (cron + KV)         (iPhone home screen)
```

- Live consumption comes from the Kraken GraphQL API's `smartMeterTelemetry`
  query for your Home Mini's device id, not the older half-hourly REST
  consumption endpoint (which lags too much to be "current").
- Agile unit rates come from the standard REST rates endpoint
  (`/products/{product_code}/electricity-tariffs/{tariff_code}/standard-unit-rates/`).
- A Cron Trigger runs every 5 minutes, pricing new telemetry against the rate
  in effect at the time and accumulating it into a "today" total that resets
  at local (Europe/London) midnight.
- `GET /status` normally just reads the latest cached snapshot from KV (fast,
  no external calls); if the snapshot is missing or stale it falls back to
  computing live.

## 1. Get your Octopus credentials

From your [Octopus Energy account dashboard](https://octopus.energy/dashboard/) →
**Personal Details** → **API access**, you'll find:

- **API key** — `OCTOPUS_API_KEY`
- **Account number** (e.g. `A-1234ABCD`) — `OCTOPUS_ACCOUNT_NUMBER`

Your **MPAN** (meter point number) and **meter serial number** are on the same
page or on a bill.

Your Home Mini's **device id** isn't shown in the dashboard. Find it with a
one-off GraphQL query using your API key:

```bash
# 1. Get a Kraken token
curl -s https://api.octopus.energy/v1/graphql/ \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($apiKey:String!){obtainKrakenToken(input:{APIKey:$apiKey}){token}}","variables":{"apiKey":"<YOUR_API_KEY>"}}'

# 2. Use the returned token to list your smart devices
curl -s https://api.octopus.energy/v1/graphql/ \
  -H "Content-Type: application/json" \
  -H "Authorization: JWT <TOKEN_FROM_STEP_1>" \
  -d '{"query":"query($accountNumber:String!){account(accountNumber:$accountNumber){electricityAgreements(active:true){meterPoint{meters(includeInactive:false){smartDevices{deviceId}}}}}}","variables":{"accountNumber":"<YOUR_ACCOUNT_NUMBER>"}}'
```

The `deviceId` in the response is your `OCTOPUS_DEVICE_ID`.

You'll also need your Agile **product code** and **tariff code** (e.g.
`AGILE-24-10-01` / `E-1R-AGILE-24-10-01-{region letter}`) — these are visible on
your account's tariff details, or check https://api.octopus.energy/v1/products/
for the current Agile product. Octopus periodically rolls new Agile product
versions, so revisit this occasionally.

## 2. Deploy the Cloudflare Worker

```bash
npm install
npx wrangler kv namespace create OCTOMON_KV
```

Paste the returned namespace `id` into `wrangler.jsonc`'s `kv_namespaces[0].id`,
and update `OCTOPUS_PRODUCT_CODE` / `OCTOPUS_TARIFF_CODE` in the `vars` section
if they differ from the defaults.

Set the secrets (you'll be prompted for each value):

```bash
npx wrangler secret put OCTOPUS_API_KEY
npx wrangler secret put OCTOPUS_ACCOUNT_NUMBER
npx wrangler secret put OCTOPUS_MPAN
npx wrangler secret put OCTOPUS_METER_SERIAL
npx wrangler secret put OCTOPUS_DEVICE_ID
npx wrangler secret put WIDGET_SHARED_SECRET   # make up a long random string
```

Deploy:

```bash
npx wrangler deploy
```

Note the `https://octo-mon.<your-subdomain>.workers.dev` URL it prints.

Smoke test:

```bash
curl -H "X-Widget-Secret: <your WIDGET_SHARED_SECRET>" \
  https://octo-mon.<your-subdomain>.workers.dev/status
```

You should get back JSON like:

```json
{
  "generatedAt": "2026-08-21T14:32:10.000Z",
  "currentRate": { "pencePerKwh": 23.4, "validFrom": "...", "validTo": "..." },
  "currentDemandKw": 0.842,
  "currentCostPerHourGbp": 0.197,
  "todayTotalKwh": 14.2,
  "todayTotalCostGbp": 3.87,
  "thisMonthTotalKwh": 187.4,
  "thisMonthTotalCostGbp": 41.92,
  "billingPeriodStart": "2026-08-20",
  "stale": false,
  "snapshotAgeSeconds": 42
}
```

`thisMonthTotalKwh`/`thisMonthTotalCostGbp` track spend since `billingPeriodStart` —
Octopus billing months run from the 20th of one calendar month to the 19th of
the next, not the calendar month. `todayTotalKwh`/`todayTotalCostGbp` only ever
cover today (built purely from live telemetry, no backfill). The month total is
different: on a cold start (first run, KV loss, or a new billing period), the
Worker backfills every already-completed day since `billingPeriodStart` from
Octopus's historical consumption REST endpoint before continuing forward with
live telemetry — so it reflects the whole billing period so far, not just
however long the Worker happens to have been running. A day the meter has no
data for (e.g. before a Home Mini was installed) simply contributes zero.

If it's the very first request, the Worker computes live (a bit slower); after
that, the 5-minute cron keeps a warm snapshot so requests are fast.

### Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in real values, then:

```bash
npm run dev      # wrangler dev, local Worker with live-reload
npm run typecheck
npm test
```

## 3. Install the widget in Scriptable

1. Install [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) from
   the App Store if you don't have it.
2. Create a new script named **OctoMon** in Scriptable and paste in the
   contents of [`scriptable/OctoMon.js`](./scriptable/OctoMon.js). This is
   the only time you'll paste it in — see "Staying up to date" below.
3. Run the script once by tapping it in the app (not as a widget yet). It'll
   prompt for your Worker URL (`https://octo-mon.<your-subdomain>.workers.dev/status`)
   and your `WIDGET_SHARED_SECRET`, then save them locally alongside the
   status cache — not in the script file itself. (Earlier versions used the
   iOS Keychain for this, but it turned out not to be reliably readable from
   a widget's own process, only from the app — hence the plain local file.)
4. Long-press your home screen → **+** → search **Scriptable** → add a widget,
   choose the small or medium size, then edit the widget and select the
   OctoMon script.

The widget shows current £/hr (colour-coded by rate band), today's running
total, and (medium size only) this month's running total. If the Worker is
briefly unreachable, it falls back to the last successfully fetched data and
shows a "STALE" badge with the time it's stale since, rather than going blank.

### Staying up to date

The script checks `scriptable/OctoMon.js` on the repo's `main` branch each
time it runs and silently updates its own copy if it's changed (the update
takes effect on the *next* refresh, not immediately). Your Worker URL and
secret live in a separate local config file, not in the script text, so an
update never overwrites them. To edit those values later, just open and run OctoMon in
the app again — it'll show the same setup prompt, pre-filled, for you to
change and re-save. Set `AUTO_UPDATE_ENABLED = false` at the top of the
script if you'd rather pin it to whatever version is currently installed.

## Development

- `npm run typecheck` — TypeScript, no emit
- `npm test` — Vitest unit/integration tests (via
  [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/),
  Miniflare-backed, no real network calls)
- `npm run dev` — local Worker via `wrangler dev`
- `npm run deploy` — deploy to Cloudflare

## Notes / caveats

- Octopus's Kraken GraphQL schema (`obtainKrakenToken`, `smartMeterTelemetry`)
  isn't formally versioned public API — if telemetry stops working, check
  https://developer.octopus.energy/ for schema changes and adjust
  `src/octopus.ts` accordingly.
- This is a personal, single-user project — the Worker trusts anyone who has
  the shared secret, and there's no multi-tenant account handling.
