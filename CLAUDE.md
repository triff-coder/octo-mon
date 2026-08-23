# octo-mon

Cloudflare Worker + Scriptable iPhone widget showing Octopus Energy usage
costs from a Home Mini smart meter. Works with any Octopus electricity
tariff (Agile, Intelligent Octopus Go, a fixed rate, ...) via configurable
product/tariff codes — don't assume the account is on Agile specifically;
verify against the account's own tariff before relying on that assumption.
See README.md for the full architecture and setup guide.

## Keep the medium widget and the web dashboard in sync

`scriptable/OctoMon.js` (the medium-size widget, in `buildStatusWidget`) and
`src/dashboard.ts` (the `GET /dashboard` web page) intentionally show the
same information in a similar layout — current cost, last hour/today/month
stats, and the 24-hour bar chart with 7-day-average marks and hourly time
labels. They're built with completely different rendering APIs (Scriptable's
`ListWidget`/`DrawContext` vs. HTML/`<canvas>`), so the code can't be shared
directly, but the two should stay visually and functionally equivalent.

**When a change is requested for the medium widget's look, layout, or the
data it shows, also apply the equivalent change to the web dashboard —
and vice versa — without being asked separately, whenever the dashboard's
HTML/canvas can reasonably express it.** Skip it only when something is
genuinely widget-only (e.g. `widget.url` tap-to-open behavior, iOS refresh
scheduling) or dashboard-only (e.g. the live-refresh polling loop, the STALE
network-error banner) — call that out explicitly rather than silently
diverging. The large widget's full-width chart is the closest existing
analog to the dashboard's chart if a medium-specific tweak doesn't map
cleanly; use judgement about which one the dashboard should mirror.

Concretely: the medium mini chart in `buildHourlyChartImage` (JS,
`scriptable/OctoMon.js`) and `drawChart` (JS, `src/dashboard.ts`) should be
kept in step — same bar/mark logic, same hour-label interval, same
overnight-hour bar shading (`isOvernightHour`) — resized for each surface's
own dimensions rather than copy-pasted verbatim. Likewise `colorForRate`
(the low/medium/high £/hr colour bands) is duplicated in both files and
must stay numerically identical — change the thresholds in one, change them
in the other.
