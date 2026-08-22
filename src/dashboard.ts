/**
 * A browser-facing view of the same data as the large Scriptable widget —
 * current cost, last hour / today / this month, and the 24-hour chart with
 * 7-day-average marks — but not subject to iOS's home-screen widget refresh
 * throttling. The page polls GET /status?refresh=true itself every 30s,
 * which forces a live Octopus fetch rather than reading the cron's cached
 * snapshot — a few hundred ms to a couple of seconds slower per request,
 * traded for a reading that's never older than the smart meter's own last
 * report (a browser reload, or just waiting for the next 30s tick, gets you
 * live data on demand rather than waiting on the 5-minute cron).
 *

 * `token` is the already-authenticated shared secret for this request (the
 * same one that authorized loading this page), embedded so the page's own
 * client-side polling can call /status without prompting for it again. This
 * matches the project's existing single-user security model (see the
 * "Notes / caveats" section of the README) — treat this page's URL with the
 * same care as the shared secret itself.
 */
export function renderDashboardHtml(token: string): string {
  // Escapes "<" so a token containing "</script>" can't break out of the
  // inline <script> block below (defensive — the token is normally a
  // random secret the user generated themselves, not untrusted input).
  const tokenJson = JSON.stringify(token).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OctoMon</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: #111318;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex;
    justify-content: center;
    padding: 32px 16px;
  }
  main { width: 100%; max-width: 480px; }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  header h1 { font-size: 14px; font-weight: 600; color: #9aa0a8; margin: 0; }
  #staleBadge {
    font-size: 10px; font-weight: 700; color: #EF5350;
    border: 1px solid #EF5350; border-radius: 4px; padding: 2px 6px;
    display: none;
  }
  #staleBadge.visible { display: inline-block; }
  #currentCost { font-size: 40px; font-weight: 700; line-height: 1.1; margin: 0; }
  #currentDetail { font-size: 13px; color: #9aa0a8; margin: 4px 0 24px; }
  .stats-row { display: flex; justify-content: space-between; margin-bottom: 24px; }
  .stat-label { font-size: 11px; font-weight: 600; color: #9aa0a8; margin: 0 0 4px; }
  .stat-value { font-size: 20px; font-weight: 700; margin: 0; }
  #chartLabel { font-size: 11px; color: #9aa0a8; margin-bottom: 8px; }
  canvas { width: 100%; height: 140px; display: block; }
  #footer { font-size: 11px; color: #9aa0a8; margin-top: 16px; }
  #errorBanner {
    display: none; background: #3a1d1d; border: 1px solid #EF5350;
    color: #ffb4b0; border-radius: 8px; padding: 10px 12px; font-size: 12px;
    margin-bottom: 16px;
  }
  #errorBanner.visible { display: block; }
</style>
</head>
<body>
<main>
  <div id="errorBanner"></div>
  <header>
    <h1>&#9889; Octopus</h1>
    <span id="staleBadge"></span>
  </header>

  <p id="currentCost">&mdash;</p>
  <p id="currentDetail">&mdash;</p>

  <div class="stats-row">
    <div>
      <p class="stat-label">LAST HR</p>
      <p class="stat-value" id="lastHourCost">&mdash;</p>
    </div>
    <div>
      <p class="stat-label">TODAY</p>
      <p class="stat-value" id="todayCost">&mdash;</p>
    </div>
    <div>
      <p class="stat-label">THIS MONTH</p>
      <p class="stat-value" id="monthCost">&mdash;</p>
    </div>
  </div>

  <p id="chartLabel">LAST 24 HOURS &middot; mark = 7-day avg</p>
  <canvas id="chart" width="960" height="280"></canvas>

  <p id="footer">Loading&hellip;</p>
</main>

<script>
(function () {
  var TOKEN = ${tokenJson};
  var POLL_INTERVAL_MS = 30000;
  var STALE_THRESHOLD_SECONDS = 15 * 60;

  var currentCostEl = document.getElementById("currentCost");
  var currentDetailEl = document.getElementById("currentDetail");
  var lastHourCostEl = document.getElementById("lastHourCost");
  var todayCostEl = document.getElementById("todayCost");
  var monthCostEl = document.getElementById("monthCost");
  var staleBadgeEl = document.getElementById("staleBadge");
  var footerEl = document.getElementById("footer");
  var errorBannerEl = document.getElementById("errorBanner");
  var canvas = document.getElementById("chart");
  var ctx = canvas.getContext("2d");

  function formatPounds(value) {
    return "\\u00a3" + Number(value).toFixed(2);
  }

  function formatPence(value) {
    return Number(value).toFixed(1) + "p";
  }

  function colorForRate(pencePerKwh) {
    if (pencePerKwh < 15) return "#4CAF50";
    if (pencePerKwh < 30) return "#FFA726";
    return "#EF5350";
  }

  function formatTime(isoString) {
    return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function drawChart(buckets) {
    var width = canvas.width;
    var height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    if (!buckets || buckets.length === 0) return;

    var maxCost = 0.01;
    for (var i = 0; i < buckets.length; i++) {
      maxCost = Math.max(maxCost, buckets[i].costGbp || 0, buckets[i].weeklyAvgCostGbp || 0);
    }

    var gap = Math.max(2, width / buckets.length / 8);
    var barWidth = (width - gap * (buckets.length - 1)) / buckets.length;
    var markHeight = Math.max(2, Math.round(height / 40));

    for (var j = 0; j < buckets.length; j++) {
      var bucket = buckets[j];
      var x = j * (barWidth + gap);
      var barHeight = Math.max(3, (bucket.costGbp / maxCost) * height);
      ctx.fillStyle = "#4FC3F7";
      ctx.fillRect(x, height - barHeight, barWidth, barHeight);

      if (bucket.weeklyAvgCostGbp > 0) {
        var markCenterY = height - (bucket.weeklyAvgCostGbp / maxCost) * height;
        var markY = Math.min(height - markHeight, Math.max(0, markCenterY - markHeight / 2));
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillRect(x, markY, barWidth, markHeight);
      }
    }
  }

  function render(status, stale) {
    currentCostEl.textContent = formatPounds(status.currentCostPerHourGbp) + "/hr";
    currentCostEl.style.color = colorForRate(status.currentRate.pencePerKwh);
    currentDetailEl.textContent =
      Number(status.currentDemandKw).toFixed(2) + " kW @ " + formatPence(status.currentRate.pencePerKwh) + "/kWh";

    lastHourCostEl.textContent = formatPounds(status.lastHourCostGbp || 0);
    todayCostEl.textContent = formatPounds(status.todayTotalCostGbp);
    monthCostEl.textContent = formatPounds(status.thisMonthTotalCostGbp);

    drawChart(Array.isArray(status.hourlyBuckets) ? status.hourlyBuckets : []);

    staleBadgeEl.classList.toggle("visible", !!stale);
    staleBadgeEl.textContent = "STALE";
    footerEl.textContent = (stale ? "Stale since " : "Updated ") + formatTime(status.generatedAt);
    footerEl.style.color = stale ? "#EF5350" : "#9aa0a8";
  }

  function showError(message) {
    errorBannerEl.textContent = message;
    errorBannerEl.classList.add("visible");
  }

  function hideError() {
    errorBannerEl.classList.remove("visible");
  }

  function poll() {
    fetch("/status?refresh=true&token=" + encodeURIComponent(TOKEN))
      .then(function (response) {
        if (!response.ok) throw new Error("Worker returned HTTP " + response.status);
        return response.json();
      })
      .then(function (status) {
        hideError();
        var ageSeconds = status.snapshotAgeSeconds || 0;
        render(status, status.stale === true || ageSeconds > STALE_THRESHOLD_SECONDS);
      })
      .catch(function (error) {
        showError("Couldn't refresh: " + error.message);
      });
  }

  poll();
  setInterval(poll, POLL_INTERVAL_MS);
})();
</script>
</body>
</html>
`;
}
