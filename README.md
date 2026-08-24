# octo-mon

An iPhone home-screen widget (built with [Scriptable](https://scriptable.app/)) showing:

- **Current cost**: live demand from your Octopus Home Mini × the current
  Octopus unit rate, as £/hr — works with any Octopus electricity tariff
  (Agile, Intelligent Octopus Go, a plain fixed rate, ...), configured via
  your product/tariff codes
- **Last hour's cost**: spend in the most recently completed clock hour, in £
- **Today's total**: running spend so far today, in £
- **This month's total**: running spend since the start of the current Octopus
  billing period (the 20th of each month), in £
- **24-hour chart** (medium and large widgets): a bar chart of spend per hour
  over the last 24 complete hours, with a small mark on each bar showing what
  that hour-of-day has cost on average over the preceding week — so you can
  see at a glance whether right now is running above or below usual

A small [Cloudflare Worker](https://workers.cloudflare.com/) sits in between the
widget and Octopus: it holds your Octopus credentials as secrets, polls Octopus
every 5 minutes via a Cron Trigger, keeps running "today" and "this month"
totals in Workers KV, and exposes one small JSON endpoint (`GET /status`) that
the widget polls, protected by a shared-secret token.

## How it works

```
Octopus Kraken GraphQL API (live telemetry)  ─┐
Octopus REST API (unit rates)                ─┼─▶ Cloudflare Worker ─▶ Scriptable widget
                                               │      (cron + KV)         (iPhone home screen)
```

- Live consumption comes from the Kraken GraphQL API's `smartMeterTelemetry`
  query for your Home Mini's device id, not the older half-hourly REST
  consumption endpoint (which lags too much to be "current").
- Unit rates come from the standard REST rates endpoint
  (`/products/{product_code}/electricity-tariffs/{tariff_code}/standard-unit-rates/`),
  which works the same for any Octopus tariff — set `OCTOPUS_PRODUCT_CODE` /
  `OCTOPUS_TARIFF_CODE` to whatever's actually on your account (check your
  [account dashboard](https://octopus.energy/dashboard/) — don't assume it's
  Agile just because that's this project's most common use case).
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

You'll also need your **product code** and **tariff code** (e.g.
`AGILE-24-10-01` / `E-1R-AGILE-24-10-01-{region letter}` for Agile,
`INTELLI-VAR-24-10-29` / `E-1R-INTELLI-VAR-24-10-29-{region letter}` for
Intelligent Octopus Go). Don't assume which tariff you're on — verify it
directly against your account rather than guessing from what you signed up
for originally (accounts do get migrated to newer product versions):

```bash
curl -s https://api.octopus.energy/v1/graphql/ \
  -H "Content-Type: application/json" \
  -H "Authorization: JWT <TOKEN_FROM_STEP_1>" \
  -d '{"query":"query($accountNumber:String!){account(accountNumber:$accountNumber){electricityAgreements(active:true){tariff{... on StandardTariff{tariffCode productCode displayName} ... on DayNightTariff{tariffCode productCode displayName} ... on ThreeRateTariff{tariffCode productCode displayName} ... on HalfHourlyTariff{tariffCode productCode displayName}}}}}","variables":{"accountNumber":"<YOUR_ACCOUNT_NUMBER>"}}'
```

`productCode` and `tariffCode` in the response are exactly what
`OCTOPUS_PRODUCT_CODE`/`OCTOPUS_TARIFF_CODE` want. Octopus periodically rolls
new product versions even for the same named tariff, so it's worth
re-checking this occasionally rather than assuming it never changes.

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
  "yesterdayTotalKwh": 15.9,
  "yesterdayTotalCostGbp": 4.21,
  "thisMonthTotalKwh": 187.4,
  "thisMonthTotalCostGbp": 41.92,
  "billingPeriodStart": "2026-08-20",
  "monthBackfillError": null,
  "lastHourCostGbp": 0.21,
  "lastHourKwh": 0.9,
  "hourlyBuckets": [
    { "hourStart": "2026-08-20T15:00:00.000Z", "costGbp": 0.18, "kwh": 0.8, "weeklyAvgCostGbp": 0.22 },
    { "hourStart": "2026-08-20T16:00:00.000Z", "costGbp": 0.24, "kwh": 1.0, "weeklyAvgCostGbp": 0.19 }
  ],
  "nextAgileSlots": [
    { "pencePerKwh": 6.9, "validFrom": "2026-08-21T21:02:49.000Z", "validTo": "2026-08-21T21:32:49.000Z" }
  ],
  "stale": false,
  "snapshotAgeSeconds": 42
}
```

`thisMonthTotalKwh`/`thisMonthTotalCostGbp` track spend since `billingPeriodStart` —
Octopus billing months run from the 20th of one calendar month to the 19th of
the next, not the calendar month. `todayTotalKwh`/`todayTotalCostGbp` only ever
cover today (built purely from live telemetry, no backfill).
`yesterdayTotalKwh`/`yesterdayTotalCostGbp` are derived by summing the
previous calendar day's entries out of the same hour-bucket data backing the
24-hour chart, rather than being a separately-tracked total — so, like the
chart, it fills in gradually (nothing to show until the feature's been
running a full day) and simply undercounts any hour with a telemetry gap
rather than failing. The month total is
different: on a cold start (first run, KV loss, or a new billing period), the
Worker backfills every already-completed day since `billingPeriodStart` from
Octopus's historical consumption REST endpoint before continuing forward with
live telemetry — so it reflects the whole billing period so far, not just
however long the Worker happens to have been running. A day the meter has no
data for (e.g. before a Home Mini was installed) simply contributes zero.

`hourlyBuckets` always has exactly 24 entries, oldest first, one per complete
UTC clock hour (the sample above is truncated for brevity) — the current,
still-in-progress hour is deliberately excluded so the chart never shows a
misleadingly short final bar. `lastHourCostGbp`/`lastHourKwh` are that
array's last entry. `weeklyAvgCostGbp` on each entry is the average cost of that same hour-of-day
(e.g. "15:00 UTC") over however many of the preceding 7 days actually have
data (0 until at least one has landed). Unlike the month total, hour buckets
are built purely from live telemetry going forward, with no historical
backfill, so both the hourly chart and the weekly averages fill in gradually
— the chart takes 24 hours to fully populate, and the weekly-average marks
take a further 7 days to become meaningful (they're 0/absent until then).

`nextAgileSlots` lists upcoming "smart charging" dispatch windows — the
occasional extra periods Octopus grants at the tariff's off-peak rate outside
(or extending) its normal scheduled window, e.g. Intelligent Octopus Go's
"bump charge" boosts — chopped into 30-minute slots, earliest first, capped
at 6. This is empty most of the time (it's *not* the everyday scheduled
off-peak window, just the occasional bonus ones), and always empty on a
tariff/account with no dispatch mechanism at all — a failed or unsupported
dispatch lookup degrades to an empty list rather than failing the request.

If it's the very first request, the Worker computes live (a bit slower); after
that, the 5-minute cron keeps a warm snapshot so requests are fast.

### Web dashboard

```
https://octo-mon.<your-subdomain>.workers.dev/dashboard?token=<your WIDGET_SHARED_SECRET>
```

A plain browser page showing the same information as the medium/large widget
(current £/hr, any upcoming "NEXT AGILE" dispatch slots, last hour/today/
yesterday/this month, and the 24-hour chart with 7-day average marks and
3-hourly time labels) — bookmark it, or open it any time you want a reading
that's more
current than the widget. It's not subject to iOS's home-screen widget
refresh throttling: every 30 seconds (and on every page load/reload) it calls
`/status?refresh=true`, which skips the cached snapshot and fetches live from
Octopus — so what you see is never older than your Home Mini's own last
report, not bounded by the 5-minute cron either. That costs a bit of latency
per request (typically well under a second, since the Kraken auth token and
the day's unit rates are both already cached — only the telemetry reading
itself is fetched fresh each time) in exchange for accuracy. Octopus doesn't
publish a hard rate limit for this API, and a single lightweight request
every 30 seconds from one personal script is well within normal use.

The `token` query parameter is your `WIDGET_SHARED_SECRET` and gets embedded
in the returned page so its own polling can re-authenticate — treat this
URL with the same care as the secret itself (don't share it, don't post it
publicly).

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
   choose small, medium, or large, then edit the widget and select the
   OctoMon script. Medium and large both show the 24-hour chart (medium as a
   miniature next to the current-usage numbers, large full-width); small
   sticks to just current £/hr and today's total — there's no room for more.

The widget shows current £/hr (colour-coded low/medium/high: green under
20p, amber 20-30p, red 30p+) and today's running total on every size. Medium
and large widgets add last hour's, yesterday's, and this month's running
total as extra columns, each with the equivalent kWh figure underneath, plus
a 24-hour bar chart — medium fits a miniature version next to
the current-usage numbers, large gets a full-width one underneath the stats
row. Each bar also carries a small mark at that hour-of-day's 7-day average,
so you can see whether the current hour is running above or below what's
typical, and every 3rd bar is labelled with its local clock hour so the
chart reads as a time axis rather than 24 unlabeled bars. Bars for the
overnight off-peak window (23:30-05:30 local) are shaded a lighter blue —
since bars are whole clock hours, the 23:00 and 05:00 bars (each only half
in the window) are included too rather than left an odd one out. When Octopus has
granted any upcoming "smart charging" dispatch slots (occasional off-peak
bonus windows, e.g. Intelligent Octopus Go's "bump charge" boosts), the
medium widget lists them as "NEXT AGILE" between the current-usage numbers
and the mini chart — this is empty, and the column just doesn't appear,
most of the time. If the Worker is briefly
unreachable, it falls back to the last successfully fetched data and shows a
"STALE" badge with the time it's stale since, rather than going blank.

Tapping the widget opens the [web dashboard](#web-dashboard) in Safari —
useful exactly when the widget looks out of date, since the dashboard forces
a live refresh rather than showing whatever iOS last let it cache.

**On refresh frequency:** the Worker itself refreshes every 5 minutes, but
the widget won't visibly update that often. iOS throttles home-screen widget
refreshes for battery life, independent of any app's own code — this is a
platform limit, not something this project can work around. In practice
expect updates roughly every 15–20 minutes, sometimes longer if you haven't
looked at the widget in a while (iOS budgets refreshes partly based on how
often you actually check it). For an instant, on-demand reading, open the
OctoMon script in Scriptable and run it directly — that always fetches live.

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
- `smartMeterTelemetry` silently returns zero results (no error) for an
  overly wide `TEN_SECONDS`-grouped time window — empirically somewhere
  north of ~16 hours' worth of readings on this account, likely an
  undocumented result cap rather than a real "no data" answer. A cold start
  (first deploy, a KV reset, crash recovery) caps its telemetry fetch to the
  last 6 hours rather than "since local midnight" to stay well clear of
  this — see the `fetchSince` comment in `src/compute.ts`. If demand/cost
  ever get stuck at exactly £0 after being fine before, this is the first
  thing to suspect.
- This is a personal, single-user project — the Worker trusts anyone who has
  the shared secret, and there's no multi-tenant account handling.
