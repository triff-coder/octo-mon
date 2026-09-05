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
  #currentDetail { font-size: 13px; color: #9aa0a8; margin: 4px 0 12px; }
  #upcomingSection { display: none; }
  #upcomingSection.visible { display: block; }
  #upcomingLabel { font-size: 11px; font-weight: 600; color: #9aa0a8; margin: 0 0 6px; }
  .upcoming-row { display: flex; gap: 10px; margin-bottom: 24px; overflow-x: auto; }
  .upcoming-chip { display: flex; flex-direction: column; align-items: center; flex: none; }
  .upcoming-chip .time { font-size: 11px; color: #9aa0a8; }
  .upcoming-chip .price { font-size: 13px; font-weight: 700; }
  .stats-row { display: flex; justify-content: space-between; margin-bottom: 24px; }
  .stat-label { font-size: 11px; font-weight: 600; color: #9aa0a8; margin: 0 0 4px; }
  .stat-value { font-size: 20px; font-weight: 700; margin: 0; }
  .stat-kwh { font-size: 11px; color: #9aa0a8; margin: 2px 0 0; }
  #predictedLabel { font-size: 11px; font-weight: 600; color: #9aa0a8; margin: 0 0 8px; }
  .predicted-row { display: flex; gap: 32px; margin-bottom: 24px; }
  #chartLabel { font-size: 11px; color: #9aa0a8; margin-bottom: 8px; }
  canvas { width: 100%; height: 160px; display: block; }
  .history-header {
    display: flex; align-items: center; justify-content: space-between;
    margin: 24px 0 8px;
  }
  #historyLabel { font-size: 11px; color: #9aa0a8; margin: 0; }
  #refreshHistoryBtn {
    font: inherit; font-size: 10px; font-weight: 600; color: #9aa0a8;
    background: transparent; border: 1px solid #3a3f47; border-radius: 6px;
    padding: 4px 10px; cursor: pointer;
  }
  #refreshHistoryBtn:hover:not(:disabled) { border-color: #4FC3F7; color: #4FC3F7; }
  #refreshHistoryBtn:disabled { opacity: 0.5; cursor: default; }
  .history-empty { font-size: 12px; color: #9aa0a8; }
  .history-boundary {
    display: flex; align-items: center; gap: 8px;
    margin: 10px 0 6px; color: #9aa0a8; font-size: 9px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .history-boundary::before, .history-boundary::after {
    content: ""; flex: 1; height: 1px; background: #3a3f47;
  }
  .history-row {
    position: relative;
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 8px; border-radius: 6px; overflow: hidden; margin-bottom: 2px;
  }
  .history-bar {
    position: absolute; left: 0; top: 0; bottom: 0;
    background: rgba(79, 195, 247, 0.18); z-index: 0;
  }
  .history-date { font-size: 12px; color: #cfd3d8; z-index: 1; }
  .history-values { font-size: 12px; z-index: 1; white-space: nowrap; }
  .history-values .cost { font-weight: 700; color: #fff; }
  .history-values .kwh { color: #9aa0a8; margin-left: 8px; }
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

  <div id="upcomingSection">
    <p id="upcomingLabel">NEXT AGILE</p>
    <div class="upcoming-row" id="upcomingRow"></div>
  </div>

  <div class="stats-row">
    <div>
      <p class="stat-label">LAST HR</p>
      <p class="stat-value" id="lastHourCost">&mdash;</p>
      <p class="stat-kwh" id="lastHourKwh">&mdash;</p>
    </div>
    <div>
      <p class="stat-label">TODAY</p>
      <p class="stat-value" id="todayCost">&mdash;</p>
      <p class="stat-kwh" id="todayKwh">&mdash;</p>
    </div>
    <div>
      <p class="stat-label">YESTERDAY</p>
      <p class="stat-value" id="yesterdayCost">&mdash;</p>
      <p class="stat-kwh" id="yesterdayKwh">&mdash;</p>
    </div>
    <div>
      <p class="stat-label">THIS MONTH</p>
      <p class="stat-value" id="monthCost">&mdash;</p>
      <p class="stat-kwh" id="monthKwh">&mdash;</p>
    </div>
  </div>

  <p id="predictedLabel">PREDICTED</p>
  <div class="predicted-row" id="predictedRow">
    <div>
      <p class="stat-label">TODAY TOTAL</p>
      <p class="stat-value" id="predictedTodayCost">&mdash;</p>
    </div>
    <div>
      <p class="stat-label">MONTH TOTAL</p>
      <p class="stat-value" id="predictedMonthCost">&mdash;</p>
    </div>
  </div>

  <p id="chartLabel">LAST 24 HOURS &middot; mark = 7-day avg</p>
  <canvas id="chart" width="960" height="320"></canvas>

  <div class="history-header">
    <p id="historyLabel">LAST 30 DAYS</p>
    <button id="refreshHistoryBtn" type="button">&#8635; Recalculate</button>
  </div>
  <div class="history-list" id="historyList"></div>

  <p id="footer">Loading&hellip;</p>
</main>

<script>
(function () {
  var TOKEN = ${tokenJson};
  var POLL_INTERVAL_MS = 30000;
  var STALE_THRESHOLD_SECONDS = 15 * 60;

  var currentCostEl = document.getElementById("currentCost");
  var currentDetailEl = document.getElementById("currentDetail");
  var upcomingSectionEl = document.getElementById("upcomingSection");
  var upcomingRowEl = document.getElementById("upcomingRow");
  var lastHourCostEl = document.getElementById("lastHourCost");
  var lastHourKwhEl = document.getElementById("lastHourKwh");
  var todayCostEl = document.getElementById("todayCost");
  var todayKwhEl = document.getElementById("todayKwh");
  var yesterdayCostEl = document.getElementById("yesterdayCost");
  var yesterdayKwhEl = document.getElementById("yesterdayKwh");
  var monthCostEl = document.getElementById("monthCost");
  var monthKwhEl = document.getElementById("monthKwh");
  var predictedTodayCostEl = document.getElementById("predictedTodayCost");
  var predictedMonthCostEl = document.getElementById("predictedMonthCost");
  var staleBadgeEl = document.getElementById("staleBadge");
  var historyListEl = document.getElementById("historyList");
  var refreshHistoryBtn = document.getElementById("refreshHistoryBtn");
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

  function formatKwh(value) {
    return Number(value).toFixed(2) + " kWh";
  }

  // Low/medium/high cost bands -- mirrors scriptable/OctoMon.js's
  // colorForRate exactly (see CLAUDE.md).
  function colorForRate(pencePerKwh) {
    if (pencePerKwh < 20) return "#4CAF50"; // low
    if (pencePerKwh < 30) return "#FFA726"; // medium
    return "#EF5350"; // high
  }

  function formatTime(isoString) {
    return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // dateKey is a plain YYYY-MM-DD Europe/London calendar date -- parsed as
  // UTC noon so no local timezone offset can shift it onto the wrong day.
  function formatShortDate(dateKey) {
    return new Date(dateKey + "T12:00:00Z").toLocaleDateString([], {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  }

  // The local (Europe/London) clock hour for a bucket's UTC hourStart, e.g.
  // "14" — mirrors the medium widget's chart axis labels.
  function formatHourLabel(isoString) {
    var parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(isoString));
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === "hour") return parts[i].value;
    }
    return "";
  }

  // Whether a bucket's hour overlaps the typical overnight off-peak window
  // (23:30-05:30 local) -- used to shade those bars lighter on the chart.
  // Bars are whole clock hours, so the 23:00 and 05:00 bars (each only
  // half in the window) are included too rather than left an odd one out.
  function isOvernightHour(isoString) {
    var localHour = Number(formatHourLabel(isoString));
    return localHour >= 23 || localHour < 6;
  }

  var HOUR_LABEL_INTERVAL = 3;
  var UPCOMING_SLOT_COUNT = 6;

  function renderUpcoming(rates) {
    var slots = rates || [];
    // Only shown when Octopus has actually granted a dispatch slot -- most
    // of the time there are none, so the whole section stays hidden.
    upcomingSectionEl.classList.toggle("visible", slots.length > 0);

    upcomingRowEl.innerHTML = "";
    slots.slice(0, UPCOMING_SLOT_COUNT).forEach(function (rate) {
      var chip = document.createElement("div");
      chip.className = "upcoming-chip";

      var time = document.createElement("span");
      time.className = "time";
      time.textContent = formatTime(rate.validFrom);

      var price = document.createElement("span");
      price.className = "price";
      price.textContent = Math.round(rate.pencePerKwh) + "p";
      price.style.color = colorForRate(rate.pencePerKwh);

      chip.appendChild(time);
      chip.appendChild(price);
      upcomingRowEl.appendChild(chip);
    });
  }

  function drawChart(buckets) {
    var width = canvas.width;
    var height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    if (!buckets || buckets.length === 0) return;

    var labelHeight = 40;
    // Headroom above the bars for the peak hour's cost label, so the
    // tallest bar never has to fight the top edge of the canvas for it.
    var peakLabelHeight = 34;
    var baselineY = height - labelHeight;
    var chartHeight = baselineY - peakLabelHeight;

    var maxCost = 0.01;
    var peakIndex = 0;
    for (var i = 0; i < buckets.length; i++) {
      maxCost = Math.max(maxCost, buckets[i].costGbp || 0, buckets[i].weeklyAvgCostGbp || 0);
      if ((buckets[i].costGbp || 0) > (buckets[peakIndex].costGbp || 0)) peakIndex = i;
    }

    var gap = Math.max(2, width / buckets.length / 8);
    var barWidth = (width - gap * (buckets.length - 1)) / buckets.length;
    var markHeight = Math.max(2, Math.round(chartHeight / 40));

    ctx.font = "24px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (var j = 0; j < buckets.length; j++) {
      var bucket = buckets[j];
      var x = j * (barWidth + gap);
      var barHeight = Math.max(3, (bucket.costGbp / maxCost) * chartHeight);
      ctx.fillStyle = isOvernightHour(bucket.hourStart) ? "#8FD8FA" : "#4FC3F7";
      ctx.fillRect(x, baselineY - barHeight, barWidth, barHeight);

      if (bucket.weeklyAvgCostGbp > 0) {
        var markCenterY = baselineY - (bucket.weeklyAvgCostGbp / maxCost) * chartHeight;
        var markY = Math.min(baselineY - markHeight, Math.max(0, markCenterY - markHeight / 2));
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillRect(x, markY, barWidth, markHeight);
      }

      if (j % HOUR_LABEL_INTERVAL === 0) {
        ctx.fillStyle = "#9aa0a8";
        ctx.fillText(formatHourLabel(bucket.hourStart), x + barWidth / 2, baselineY + 6);
      }
    }

    // The priciest hour of the 24, called out with its actual cost -- the
    // bars alone show the shape but leave the scale to guesswork. Drawn
    // after the loop so it sits over any neighbouring bar it overhangs.
    var peakCost = buckets[peakIndex].costGbp || 0;
    if (peakCost > 0) {
      var peakLabel = formatPounds(peakCost);
      var peakBarHeight = Math.max(3, (peakCost / maxCost) * chartHeight);
      ctx.font = "bold 26px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textBaseline = "bottom";
      // Keep the label inside the canvas when the peak is the first or last bar.
      var halfLabelWidth = ctx.measureText(peakLabel).width / 2;
      var peakCenterX = peakIndex * (barWidth + gap) + barWidth / 2;
      var peakLabelX = Math.min(width - halfLabelWidth, Math.max(halfLabelWidth, peakCenterX));
      ctx.fillStyle = "#fff";
      ctx.fillText(peakLabel, peakLabelX, baselineY - peakBarHeight - 8);
    }
  }

  // Octopus's billing cycle rolls over on the 20th of each month, so the
  // 19th is always the last day of a cycle -- draw a divider right before
  // it (the list renders newest first, so walking down through the 20th
  // and on to the 19th is exactly where a cycle boundary is crossed).
  function isBillingCycleEnd(dateKey) {
    return dateKey.slice(8, 10) === "19";
  }

  function renderHistory(days) {
    historyListEl.innerHTML = "";
    if (!days || days.length === 0) {
      historyListEl.textContent = "No history yet.";
      historyListEl.classList.add("history-empty");
      return;
    }
    historyListEl.classList.remove("history-empty");

    var maxCost = 0.01;
    for (var i = 0; i < days.length; i++) {
      maxCost = Math.max(maxCost, days[i].costGbp || 0);
    }

    // The API returns oldest first; show most recent at the top.
    var newestFirst = days.slice().reverse();

    newestFirst.forEach(function (day) {
      if (isBillingCycleEnd(day.dateKey)) {
        var boundary = document.createElement("div");
        boundary.className = "history-boundary";
        boundary.textContent = "Billing cycle ends";
        historyListEl.appendChild(boundary);
      }

      var row = document.createElement("div");
      row.className = "history-row";

      var bar = document.createElement("div");
      bar.className = "history-bar";
      bar.style.width = Math.max(2, (day.costGbp / maxCost) * 100) + "%";

      var date = document.createElement("span");
      date.className = "history-date";
      date.textContent = formatShortDate(day.dateKey);

      var values = document.createElement("span");
      values.className = "history-values";

      var cost = document.createElement("span");
      cost.className = "cost";
      cost.textContent = formatPounds(day.costGbp);

      var kwh = document.createElement("span");
      kwh.className = "kwh";
      kwh.textContent = formatKwh(day.kwh);

      values.appendChild(cost);
      values.appendChild(kwh);

      row.appendChild(bar);
      row.appendChild(date);
      row.appendChild(values);
      historyListEl.appendChild(row);
    });
  }

  function fetchHistory(forceRefresh) {
    var url = "/history?token=" + encodeURIComponent(TOKEN) + (forceRefresh ? "&refresh=true" : "");
    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error("Worker returned HTTP " + response.status);
      return response.json();
    });
  }

  function loadHistory() {
    fetchHistory(false)
      .then(function (data) {
        renderHistory(data.days);
      })
      .catch(function () {
        // Secondary/best-effort section -- fail quietly rather than
        // triggering the primary error banner used for /status.
        historyListEl.textContent = "Couldn't load history.";
        historyListEl.classList.add("history-empty");
      });
  }

  // Bypasses the 12h /history cache so a stale cached snapshot -- e.g. one
  // computed before a pricing change like the standing charge being added
  // to these totals -- can be replaced on demand rather than waiting it out.
  function recalculateHistory() {
    refreshHistoryBtn.disabled = true;
    refreshHistoryBtn.textContent = "Recalculating\\u2026";

    fetchHistory(true)
      .then(function (data) {
        renderHistory(data.days);
        refreshHistoryBtn.textContent = "Updated \\u2713";
      })
      .catch(function () {
        refreshHistoryBtn.textContent = "Failed \\u2013 retry";
      })
      .then(function () {
        setTimeout(function () {
          refreshHistoryBtn.textContent = "\\u21bb Recalculate";
          refreshHistoryBtn.disabled = false;
        }, 2500);
      });
  }

  refreshHistoryBtn.addEventListener("click", recalculateHistory);

  function render(status, stale) {
    currentCostEl.textContent = formatPounds(status.currentCostPerHourGbp) + "/hr";
    currentCostEl.style.color = colorForRate(status.currentRate.pencePerKwh);
    currentDetailEl.textContent =
      Number(status.currentDemandKw).toFixed(2) + " kW @ " + formatPence(status.currentRate.pencePerKwh) + "/kWh";

    renderUpcoming(status.nextAgileSlots);

    lastHourCostEl.textContent = formatPounds(status.lastHourCostGbp || 0);
    lastHourKwhEl.textContent = formatKwh(status.lastHourKwh || 0);
    todayCostEl.textContent = formatPounds(status.todayTotalCostGbp);
    todayKwhEl.textContent = formatKwh(status.todayTotalKwh);
    yesterdayCostEl.textContent = formatPounds(status.yesterdayTotalCostGbp || 0);
    yesterdayKwhEl.textContent = formatKwh(status.yesterdayTotalKwh || 0);
    monthCostEl.textContent = formatPounds(status.thisMonthTotalCostGbp);
    monthKwhEl.textContent = formatKwh(status.thisMonthTotalKwh);
    predictedTodayCostEl.textContent = formatPounds(status.predictedTodayCostGbp || 0);
    predictedMonthCostEl.textContent = formatPounds(status.predictedMonthCostGbp || 0);

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
  loadHistory();
})();
</script>
</body>
</html>
`;
}
