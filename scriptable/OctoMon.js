// @octomon-widget v1
// Octopus Home Mini widget for Scriptable.
//
// One-time setup:
//   1. Paste this whole file into a new Scriptable script (name it "OctoMon").
//   2. Run it once by tapping it in the Scriptable app (not as a widget) —
//      it'll prompt for your Worker URL and shared secret and save them
//      locally. Re-run it anytime in-app to view/change them.
//   3. Long-press your home screen -> add a Scriptable widget -> pick this
//      script.
//
// After that, this script keeps itself up to date from GitHub automatically
// (see AUTO_UPDATE_URL below) — no more copy-pasting when the repo changes.
// Set AUTO_UPDATE_ENABLED to false to freeze it at the current version.
//
// icon-color: orange; icon-glyph: bolt;

const AUTO_UPDATE_ENABLED = true;
const AUTO_UPDATE_URL =
  "https://raw.githubusercontent.com/triff-coder/octo-mon/main/scriptable/OctoMon.js";
const AUTO_UPDATE_TIMEOUT_SECONDS = 5;
const AUTO_UPDATE_MARKER = "@octomon-widget";

const REQUEST_TIMEOUT_SECONDS = 8;
// iOS throttles home-screen widget refreshes for battery regardless of what
// we request here — this is roughly the practical floor, not a guarantee.
const REFRESH_INTERVAL_MINUTES = 15;

const CONFIG_PATH = FileManager.local().joinPath(
  FileManager.local().documentsDirectory(),
  "octomon-config.json",
);
const CACHE_PATH = FileManager.local().joinPath(
  FileManager.local().documentsDirectory(),
  "octomon-status-cache.json",
);
const HISTORY_CACHE_PATH = FileManager.local().joinPath(
  FileManager.local().documentsDirectory(),
  "octomon-history-cache.json",
);

// Best-effort: overwrites this script's own file with the latest version
// from GitHub if it has changed. This run keeps executing the code already
// loaded into memory — the update takes effect on the *next* refresh.
async function selfUpdateIfNeeded() {
  if (!AUTO_UPDATE_ENABLED) return;
  try {
    const req = new Request(AUTO_UPDATE_URL);
    req.timeoutInterval = AUTO_UPDATE_TIMEOUT_SECONDS;
    const latest = await req.loadString();
    if (!latest || !latest.includes(AUTO_UPDATE_MARKER)) return;

    const fm = FileManager.local();
    const current = fm.readString(module.filename);
    if (latest !== current) {
      fm.writeString(module.filename, latest);
    }
  } catch (error) {
    // Offline, GitHub unreachable, etc. — just run with the current code.
  }
}

function loadSavedConfig() {
  const fm = FileManager.local();
  if (!fm.fileExists(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fm.readString(CONFIG_PATH));
  } catch (error) {
    return null;
  }
}

function saveConfig(workerUrl, sharedSecret) {
  FileManager.local().writeString(CONFIG_PATH, JSON.stringify({ workerUrl, sharedSecret }));
}

// Reads the Worker URL + shared secret from local storage (a JSON file
// alongside the status cache — deliberately not the iOS Keychain, which in
// practice isn't reliably readable from a Scriptable widget's own process
// even after being set from the app). If they're missing and we're running
// interactively in-app (not as a widget), prompts for them and saves.
// Widgets can't show prompts, so a widget with no saved config throws and
// the caller shows a setup-needed message.
async function getConfig() {
  const saved = loadSavedConfig();
  let workerUrl = saved?.workerUrl ?? null;
  let sharedSecret = saved?.sharedSecret ?? null;

  const needsSetup = !workerUrl || !sharedSecret;

  if (needsSetup && config.runsInWidget) {
    throw new Error("Not configured. Open OctoMon in the Scriptable app once to finish setup.");
  }

  if (needsSetup || !config.runsInWidget) {
    const alert = new Alert();
    alert.title = "OctoMon Setup";
    alert.message = "Enter your Worker URL and shared secret (see the octo-mon README).";
    alert.addTextField("Worker URL", workerUrl || "https://octo-mon.YOUR-SUBDOMAIN.workers.dev/status");
    alert.addSecureTextField("Shared secret", sharedSecret || "");
    alert.addAction("Save");
    alert.addCancelAction("Cancel");

    const buttonIndex = await alert.presentAlert();
    if (buttonIndex === -1) {
      if (needsSetup) throw new Error("Setup cancelled.");
      // Cancelled while just reviewing existing settings — keep them as-is.
    } else {
      workerUrl = alert.textFieldValue(0).trim();
      sharedSecret = alert.textFieldValue(1).trim();
      saveConfig(workerUrl, sharedSecret);
    }
  }

  return { workerUrl, sharedSecret };
}

// The web dashboard (GET /dashboard) shows the same data as the large
// widget but forces a live refresh on every load, so it's a better tap
// target than linking straight to the raw /status JSON endpoint.
function dashboardUrlFor(workerUrl, sharedSecret) {
  const base = workerUrl.replace(/\/status\/?$/, "");
  return `${base}/dashboard?token=${encodeURIComponent(sharedSecret)}`;
}

// GET /history — same endpoint the dashboard's "LAST 30 DAYS" list uses,
// also fetched by the large widget for its compact daily-history chart.
function historyUrlFor(workerUrl, sharedSecret) {
  const base = workerUrl.replace(/\/status\/?$/, "");
  return `${base}/history?token=${encodeURIComponent(sharedSecret)}`;
}

async function fetchJson(url, sharedSecret) {
  const req = new Request(url);
  req.headers = { "X-Widget-Secret": sharedSecret };
  req.timeoutInterval = REQUEST_TIMEOUT_SECONDS;

  const json = await req.loadJSON();
  const statusCode = req.response ? req.response.statusCode : 0;
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Worker returned HTTP ${statusCode}`);
  }
  return json;
}

async function fetchStatus(workerUrl, sharedSecret) {
  const url = `${workerUrl}?token=${encodeURIComponent(sharedSecret)}`;
  return fetchJson(url, sharedSecret);
}

async function fetchHistory(workerUrl, sharedSecret) {
  const json = await fetchJson(historyUrlFor(workerUrl, sharedSecret), sharedSecret);
  return Array.isArray(json.days) ? json.days : [];
}

function loadCachedStatus() {
  const fm = FileManager.local();
  if (!fm.fileExists(CACHE_PATH)) return null;
  try {
    return JSON.parse(fm.readString(CACHE_PATH));
  } catch (error) {
    return null;
  }
}

function saveCachedStatus(status) {
  FileManager.local().writeString(CACHE_PATH, JSON.stringify(status));
}

function loadCachedHistory() {
  const fm = FileManager.local();
  if (!fm.fileExists(HISTORY_CACHE_PATH)) return null;
  try {
    return JSON.parse(fm.readString(HISTORY_CACHE_PATH));
  } catch (error) {
    return null;
  }
}

function saveCachedHistory(days) {
  FileManager.local().writeString(HISTORY_CACHE_PATH, JSON.stringify(days));
}

function formatPounds(value) {
  return `£${value.toFixed(2)}`;
}

function formatPence(value) {
  return `${value.toFixed(1)}p`;
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// dateKey is a plain YYYY-MM-DD Europe/London calendar date -- parsed as
// UTC noon so no local timezone offset can shift it onto the wrong day.
function formatShortDate(dateKey) {
  return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

// Low/medium/high cost bands.
function colorForRate(pencePerKwh) {
  if (pencePerKwh < 20) return new Color("#4CAF50"); // low
  if (pencePerKwh < 30) return new Color("#FFA726"); // medium
  return new Color("#EF5350"); // high
}

// The local (Europe/London) clock hour for a bucket's UTC hourStart, e.g.
// "14" — used for the chart's time-of-day axis labels.
function formatHourLabel(isoString) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(isoString));
  const hourPart = parts.find((p) => p.type === "hour");
  return hourPart ? hourPart.value : "";
}

// Whether a bucket's hour overlaps the typical overnight off-peak window
// (23:30-05:30 local) — used to shade those bars lighter on the chart.
// Bars are whole clock hours, so the 23:00 and 05:00 bars (each only half
// in the window) are included too rather than left an odd one out.
function isOvernightHour(hourStartIso) {
  const localHour = Number(formatHourLabel(hourStartIso));
  return localHour >= 23 || localHour < 6;
}

// Renders a 24-bar chart (bar height proportional to that hour's cost vs.
// the most expensive hour/weekly-average in the window) as an image for
// addImage() — ListWidget has no native chart element. Each bar also gets a
// short horizontal mark at the height of that hour-of-day's 7-day average
// (when there's enough history for one), so today's real-time shape can be
// compared at a glance against what that hour usually costs.
//
// `hourLabelInterval`, if given, reserves a strip below the bars and labels
// every Nth bar with its local clock hour (e.g. 3 -> every 3 hours), so the
// chart reads as a time axis rather than just 24 unlabeled bars.
function buildHourlyChartImage(buckets, width, height, hourLabelInterval) {
  const labelHeight = hourLabelInterval ? 12 : 0;
  const chartHeight = height - labelHeight;

  const dc = new DrawContext();
  dc.size = new Size(width, height);
  dc.opaque = false;
  dc.respectScreenScale = true;

  const maxCost = Math.max(
    ...buckets.map((b) => b.costGbp),
    ...buckets.map((b) => b.weeklyAvgCostGbp || 0),
    0.01,
  );
  const gap = Math.max(1, width / buckets.length / 8);
  const barWidth = (width - gap * (buckets.length - 1)) / buckets.length;
  const barColor = new Color("#4FC3F7");
  const overnightBarColor = new Color("#8FD8FA"); // lighter tint for the 23:30-05:30 off-peak window
  const avgMarkColor = new Color("#FFFFFF", 0.9);
  const avgMarkHeight = Math.max(1, Math.round(chartHeight / 40));
  const labelColor = new Color("#9aa0a8");
  const labelFont = Font.systemFont(9);

  buckets.forEach((bucket, i) => {
    const x = i * (barWidth + gap);

    const barHeight = Math.max(2, (bucket.costGbp / maxCost) * chartHeight);
    const barPath = new Path();
    barPath.addRoundedRect(new Rect(x, chartHeight - barHeight, barWidth, barHeight), 1, 1);
    dc.addPath(barPath);
    dc.setFillColor(isOvernightHour(bucket.hourStart) ? overnightBarColor : barColor);
    dc.fillPath();

    if (bucket.weeklyAvgCostGbp > 0) {
      const markCenterY = chartHeight - (bucket.weeklyAvgCostGbp / maxCost) * chartHeight;
      const markY = Math.min(chartHeight - avgMarkHeight, Math.max(0, markCenterY - avgMarkHeight / 2));
      const markPath = new Path();
      markPath.addRect(new Rect(x, markY, barWidth, avgMarkHeight));
      dc.addPath(markPath);
      dc.setFillColor(avgMarkColor);
      dc.fillPath();
    }

    if (hourLabelInterval && i % hourLabelInterval === 0) {
      dc.setFont(labelFont);
      dc.setTextColor(labelColor);
      dc.setTextAlignedCenter();
      dc.drawText(formatHourLabel(bucket.hourStart), new Point(x + barWidth / 2, chartHeight + 1));
    }
  });

  return dc.getImage();
}

// One bar per day (oldest on the left, most recent on the right, matching
// the hourly chart's own left-to-right time flow), same styling family as
// buildHourlyChartImage -- the large widget's compact equivalent of the web
// dashboard's "LAST 30 DAYS" list, which has room for a per-day row with a
// date/£/kWh label that a widget just doesn't have. A thin vertical rule
// marks where a billing cycle ends (the 19th -> 20th boundary), and the
// oldest/newest dates are labelled at either end so the axis still reads as
// a timeline rather than an unlabeled sparkline.
function buildDailyHistoryChartImage(days, width, height) {
  const labelHeight = 12;
  const chartHeight = height - labelHeight;

  const dc = new DrawContext();
  dc.size = new Size(width, height);
  dc.opaque = false;
  dc.respectScreenScale = true;

  const maxCost = Math.max(...days.map((d) => d.costGbp), 0.01);
  const gap = Math.max(1, width / days.length / 6);
  const barWidth = (width - gap * (days.length - 1)) / days.length;
  const barColor = new Color("#4FC3F7");
  const boundaryColor = new Color("#FFFFFF", 0.35);
  const labelColor = new Color("#9aa0a8");
  const labelFont = Font.systemFont(9);

  days.forEach((day, i) => {
    const x = i * (barWidth + gap);
    const barHeight = Math.max(2, (day.costGbp / maxCost) * chartHeight);
    const barPath = new Path();
    barPath.addRoundedRect(new Rect(x, chartHeight - barHeight, barWidth, barHeight), 1, 1);
    dc.addPath(barPath);
    dc.setFillColor(barColor);
    dc.fillPath();

    // Octopus's billing cycle rolls over on the 20th -- draw the divider
    // just after the 19th's bar, i.e. right at the cycle boundary.
    if (day.dateKey.slice(8, 10) === "19" && i < days.length - 1) {
      const linePath = new Path();
      linePath.addRect(new Rect(x + barWidth + gap / 2 - 0.5, 0, 1, chartHeight));
      dc.addPath(linePath);
      dc.setFillColor(boundaryColor);
      dc.fillPath();
    }
  });

  dc.setFont(labelFont);
  dc.setTextColor(labelColor);
  dc.setTextAlignedLeft();
  dc.drawText(formatShortDate(days[0].dateKey), new Point(0, chartHeight + 1));
  dc.setTextAlignedRight();
  dc.drawText(formatShortDate(days[days.length - 1].dateKey), new Point(width, chartHeight + 1));

  return dc.getImage();
}

function buildStatusWidget(status, stale, dashboardUrl, dailyHistory) {
  // Large has more room to breathe than medium/small, which are already
  // tightly fitted to their fixed sizes -- so it alone gets a bump across
  // the board rather than resizing every family's shared helpers.
  const isLarge = config.widgetFamily === "large";

  const widget = new ListWidget();
  widget.backgroundColor = new Color("#111318");
  widget.setPadding(12, 14, 12, 14);
  if (dashboardUrl) widget.url = dashboardUrl;

  const header = widget.addStack();
  header.centerAlignContent();
  const title = header.addText("⚡ Octopus");
  title.font = Font.mediumSystemFont(isLarge ? 13 : 12);
  title.textColor = Color.gray();
  header.addSpacer();
  if (stale) {
    const badge = header.addText("STALE");
    badge.font = Font.boldSystemFont(isLarge ? 11 : 10);
    badge.textColor = new Color("#EF5350");
  }

  widget.addSpacer(4);

  const hourlyBuckets = Array.isArray(status.hourlyBuckets) ? status.hourlyBuckets : [];

  const addCurrentUsageLines = (container) => {
    const currentCostLine = container.addText(`${formatPounds(status.currentCostPerHourGbp)}/hr`);
    currentCostLine.font = Font.boldSystemFont(isLarge ? 26 : 22);
    currentCostLine.textColor = colorForRate(status.currentRate.pencePerKwh);

    const detailLine = container.addText(
      `${status.currentDemandKw.toFixed(2)} kW @ ${formatPence(status.currentRate.pencePerKwh)}/kWh`,
    );
    detailLine.font = Font.systemFont(isLarge ? 13 : 11);
    detailLine.textColor = Color.gray();
  };

  if (config.widgetFamily === "medium" && hourlyBuckets.length > 0) {
    // Medium doesn't have room for a full-width chart below the stats row
    // (that's what large size is for), but there's spare width up top next
    // to the current-usage numbers — a miniature chart fits nicely there,
    // with a compact "next Agile dispatch slots" list between the two
    // (only shown when Octopus has actually granted any — most of the
    // time there are none, so this column just doesn't appear).
    const topRow = widget.addStack();
    topRow.layoutHorizontally();
    topRow.centerAlignContent();

    const usageColumn = topRow.addStack();
    usageColumn.layoutVertically();
    addCurrentUsageLines(usageColumn);

    topRow.addSpacer();

    const nextAgileSlots = Array.isArray(status.nextAgileSlots) ? status.nextAgileSlots : [];
    if (nextAgileSlots.length > 0) {
      const nextAgileColumn = topRow.addStack();
      nextAgileColumn.layoutVertically();
      nextAgileColumn.spacing = 1;

      const nextAgileLabel = nextAgileColumn.addText("NEXT AGILE");
      nextAgileLabel.font = Font.mediumSystemFont(8);
      nextAgileLabel.textColor = Color.gray();

      nextAgileSlots.slice(0, 3).forEach((rate) => {
        const row = nextAgileColumn.addText(`${formatTime(rate.validFrom)} ${Math.round(rate.pencePerKwh)}p`);
        row.font = Font.systemFont(9);
        row.textColor = colorForRate(rate.pencePerKwh);
      });

      topRow.addSpacer();
    }

    const miniChartWidth = 100;
    const miniChartHourLabelInterval = 3;
    const miniChartHeight = 46 + 12; // bars + a labeled-every-3-hours axis strip
    const miniChartImage = buildHourlyChartImage(
      hourlyBuckets,
      miniChartWidth,
      miniChartHeight,
      miniChartHourLabelInterval,
    );
    const miniChartStack = topRow.addImage(miniChartImage);
    miniChartStack.imageSize = new Size(miniChartWidth, miniChartHeight);
  } else {
    addCurrentUsageLines(widget);
  }

  // Medium gets a bit of breathing room here — with the mini chart's axis
  // labels sitting right above — but kept fairly tight since the stats row
  // now has a kWh line under each value and needs the vertical room.
  widget.addSpacer(config.widgetFamily === "medium" ? 10 : 8);

  if (config.widgetFamily === "small") {
    const todayLabel = widget.addText("TODAY");
    todayLabel.font = Font.mediumSystemFont(10);
    todayLabel.textColor = Color.gray();

    const todayCost = widget.addText(formatPounds(status.todayTotalCostGbp));
    todayCost.font = Font.boldSystemFont(18);
    todayCost.textColor = Color.white();
  } else {
    // Side-by-side columns make far better use of a medium/large widget's
    // width than stacking stats vertically, which was overflowing the
    // widget's height and getting clipped at the bottom. Four columns
    // (label, cost, then the equivalent kWh below it) with a smaller font
    // than the original three-column version needed keeps each one legible.
    const statsRow = widget.addStack();
    statsRow.layoutHorizontally();

    const addStatColumn = (label, valueText, kwh) => {
      const column = statsRow.addStack();
      column.layoutVertically();
      const labelText = column.addText(label);
      labelText.font = Font.mediumSystemFont(isLarge ? 10 : 9);
      labelText.textColor = Color.gray();
      const valueText_ = column.addText(valueText);
      valueText_.font = Font.boldSystemFont(isLarge ? 18 : 15);
      valueText_.textColor = Color.white();
      const kwhText = column.addText(`${kwh.toFixed(2)} kWh`);
      kwhText.font = Font.systemFont(isLarge ? 9 : 8);
      kwhText.textColor = Color.gray();
    };

    addStatColumn("LAST HR", formatPounds(status.lastHourCostGbp ?? 0), status.lastHourKwh ?? 0);
    statsRow.addSpacer();
    addStatColumn("TODAY", formatPounds(status.todayTotalCostGbp), status.todayTotalKwh);
    statsRow.addSpacer();
    addStatColumn("YESTERDAY", formatPounds(status.yesterdayTotalCostGbp ?? 0), status.yesterdayTotalKwh ?? 0);
    statsRow.addSpacer();
    addStatColumn("MONTH", formatPounds(status.thisMonthTotalCostGbp), status.thisMonthTotalKwh);

    if (isLarge && hourlyBuckets.length > 0) {
      widget.addSpacer(10);

      const chartLabel = widget.addText("LAST 24 HOURS · mark = 7-day avg");
      chartLabel.font = Font.mediumSystemFont(11);
      chartLabel.textColor = Color.gray();
      widget.addSpacer(4);

      const chartWidth = 300;
      const chartHourLabelInterval = 3;
      const chartHeight = 70 + 12; // bars + a labeled-every-3-hours axis strip
      const chartImage = buildHourlyChartImage(hourlyBuckets, chartWidth, chartHeight, chartHourLabelInterval);
      const chartRow = widget.addStack();
      chartRow.layoutHorizontally();
      chartRow.addSpacer();
      const imageStack = chartRow.addImage(chartImage);
      imageStack.imageSize = new Size(chartWidth, chartHeight);
      chartRow.addSpacer();

      if (Array.isArray(dailyHistory) && dailyHistory.length > 0) {
        widget.addSpacer(6);

        const historyLabel = widget.addText("LAST 30 DAYS");
        historyLabel.font = Font.mediumSystemFont(11);
        historyLabel.textColor = Color.gray();
        widget.addSpacer(4);

        const historyChartWidth = 300;
        const historyChartHeight = 40 + 12; // bars + a start/end date label strip
        const historyChartImage = buildDailyHistoryChartImage(dailyHistory, historyChartWidth, historyChartHeight);
        const historyRow = widget.addStack();
        historyRow.layoutHorizontally();
        historyRow.addSpacer();
        const historyImageStack = historyRow.addImage(historyChartImage);
        historyImageStack.imageSize = new Size(historyChartWidth, historyChartHeight);
        historyRow.addSpacer();
      }
    }
  }

  widget.addSpacer();

  const footer = widget.addText(
    stale ? `Stale since ${formatTime(status.generatedAt)}` : `Updated ${formatTime(status.generatedAt)}`,
  );
  footer.font = Font.systemFont(isLarge ? 10 : 9);
  footer.textColor = stale ? new Color("#EF5350") : Color.gray();

  widget.refreshAfterDate = new Date(Date.now() + REFRESH_INTERVAL_MINUTES * 60 * 1000);
  return widget;
}

function buildErrorWidget(message) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#111318");
  widget.setPadding(12, 14, 12, 14);

  const title = widget.addText("⚡ Octopus");
  title.font = Font.mediumSystemFont(12);
  title.textColor = Color.gray();

  widget.addSpacer(8);

  const errorTitle = widget.addText("No data available");
  errorTitle.font = Font.boldSystemFont(14);
  errorTitle.textColor = new Color("#EF5350");

  const detail = widget.addText(message);
  detail.font = Font.systemFont(9);
  detail.textColor = Color.gray();

  widget.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  return widget;
}

// Only the large widget shows the daily-history chart, so only it pays for
// this extra request — small/medium skip it entirely. A failure here (or a
// genuinely empty response) just means that section of the widget is
// omitted; it never blocks the main status widget from rendering, and falls
// back to the last successful response rather than an outright empty chart.
async function getDailyHistoryForWidget(workerUrl, sharedSecret) {
  if (config.widgetFamily !== "large") return null;
  try {
    const days = await fetchHistory(workerUrl, sharedSecret);
    saveCachedHistory(days);
    return days;
  } catch (error) {
    return loadCachedHistory();
  }
}

async function run() {
  await selfUpdateIfNeeded();

  let widget;

  try {
    const { workerUrl, sharedSecret } = await getConfig();
    const dashboardUrl = dashboardUrlFor(workerUrl, sharedSecret);

    try {
      const status = await fetchStatus(workerUrl, sharedSecret);
      saveCachedStatus(status);
      const dailyHistory = await getDailyHistoryForWidget(workerUrl, sharedSecret);
      widget = buildStatusWidget(status, status.stale === true, dashboardUrl, dailyHistory);
    } catch (fetchError) {
      const cached = loadCachedStatus();
      const dailyHistory = cached ? await getDailyHistoryForWidget(workerUrl, sharedSecret) : null;
      widget = cached
        ? buildStatusWidget(cached, true, dashboardUrl, dailyHistory)
        : buildErrorWidget(String(fetchError.message ?? fetchError));
    }
  } catch (configError) {
    // Not configured yet (widget context, never set up in-app) — no
    // workerUrl/sharedSecret to build a dashboard link from.
    widget = buildErrorWidget(String(configError.message ?? configError));
  }

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else if (config.widgetFamily === "large") {
    await widget.presentLarge();
  } else if (config.widgetFamily === "medium") {
    await widget.presentMedium();
  } else {
    await widget.presentSmall();
  }

  Script.complete();
}

await run();
