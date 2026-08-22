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

async function fetchStatus(workerUrl, sharedSecret) {
  const url = `${workerUrl}?token=${encodeURIComponent(sharedSecret)}`;
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

function formatPounds(value) {
  return `£${value.toFixed(2)}`;
}

function formatPence(value) {
  return `${value.toFixed(1)}p`;
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function colorForRate(pencePerKwh) {
  if (pencePerKwh < 15) return new Color("#4CAF50");
  if (pencePerKwh < 30) return new Color("#FFA726");
  return new Color("#EF5350");
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
    dc.setFillColor(barColor);
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

function buildStatusWidget(status, stale, dashboardUrl) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#111318");
  widget.setPadding(12, 14, 12, 14);
  if (dashboardUrl) widget.url = dashboardUrl;

  const header = widget.addStack();
  header.centerAlignContent();
  const title = header.addText("⚡ Octopus");
  title.font = Font.mediumSystemFont(12);
  title.textColor = Color.gray();
  header.addSpacer();
  if (stale) {
    const badge = header.addText("STALE");
    badge.font = Font.boldSystemFont(10);
    badge.textColor = new Color("#EF5350");
  }

  widget.addSpacer(4);

  const hourlyBuckets = Array.isArray(status.hourlyBuckets) ? status.hourlyBuckets : [];

  const addCurrentUsageLines = (container) => {
    const currentCostLine = container.addText(`${formatPounds(status.currentCostPerHourGbp)}/hr`);
    currentCostLine.font = Font.boldSystemFont(22);
    currentCostLine.textColor = colorForRate(status.currentRate.pencePerKwh);

    const detailLine = container.addText(
      `${status.currentDemandKw.toFixed(2)} kW @ ${formatPence(status.currentRate.pencePerKwh)}/kWh`,
    );
    detailLine.font = Font.systemFont(11);
    detailLine.textColor = Color.gray();
  };

  if (config.widgetFamily === "medium" && hourlyBuckets.length > 0) {
    // Medium doesn't have room for a full-width chart below the stats row
    // (that's what large size is for), but there's spare width up top next
    // to the current-usage numbers — a miniature chart fits nicely there,
    // with a compact "next few slots" list between the two.
    const topRow = widget.addStack();
    topRow.layoutHorizontally();
    topRow.centerAlignContent();

    const usageColumn = topRow.addStack();
    usageColumn.layoutVertically();
    addCurrentUsageLines(usageColumn);

    topRow.addSpacer();

    const upcomingRates = Array.isArray(status.upcomingRates) ? status.upcomingRates : [];
    if (upcomingRates.length > 0) {
      const upcomingColumn = topRow.addStack();
      upcomingColumn.layoutVertically();
      upcomingColumn.spacing = 1;

      const upcomingLabel = upcomingColumn.addText("NEXT");
      upcomingLabel.font = Font.mediumSystemFont(8);
      upcomingLabel.textColor = Color.gray();

      upcomingRates.slice(0, 3).forEach((rate) => {
        const row = upcomingColumn.addText(`${formatTime(rate.validFrom)} ${Math.round(rate.pencePerKwh)}p`);
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

  // Medium gets extra breathing room here — with the mini chart's new axis
  // labels sitting right above, the stats row was reading as cramped.
  widget.addSpacer(config.widgetFamily === "medium" ? 16 : 8);

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
    // widget's height and getting clipped at the bottom. Three columns (down
    // to label + value only, no subtext) keeps each one legible.
    const statsRow = widget.addStack();
    statsRow.layoutHorizontally();

    const addStatColumn = (label, valueText) => {
      const column = statsRow.addStack();
      column.layoutVertically();
      const labelText = column.addText(label);
      labelText.font = Font.mediumSystemFont(10);
      labelText.textColor = Color.gray();
      const valueText_ = column.addText(valueText);
      valueText_.font = Font.boldSystemFont(17);
      valueText_.textColor = Color.white();
    };

    addStatColumn("LAST HR", formatPounds(status.lastHourCostGbp ?? 0));
    statsRow.addSpacer();
    addStatColumn("TODAY", formatPounds(status.todayTotalCostGbp));
    statsRow.addSpacer();
    addStatColumn("THIS MONTH", formatPounds(status.thisMonthTotalCostGbp));

    if (config.widgetFamily === "large" && hourlyBuckets.length > 0) {
      widget.addSpacer(10);

      const chartLabel = widget.addText("LAST 24 HOURS · mark = 7-day avg");
      chartLabel.font = Font.mediumSystemFont(10);
      chartLabel.textColor = Color.gray();
      widget.addSpacer(4);

      const chartWidth = 300;
      const chartHeight = 70;
      const chartImage = buildHourlyChartImage(hourlyBuckets, chartWidth, chartHeight);
      const imageStack = widget.addImage(chartImage);
      imageStack.imageSize = new Size(chartWidth, chartHeight);
    }
  }

  widget.addSpacer();

  const footer = widget.addText(
    stale ? `Stale since ${formatTime(status.generatedAt)}` : `Updated ${formatTime(status.generatedAt)}`,
  );
  footer.font = Font.systemFont(9);
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

async function run() {
  await selfUpdateIfNeeded();

  let widget;

  try {
    const { workerUrl, sharedSecret } = await getConfig();
    const dashboardUrl = dashboardUrlFor(workerUrl, sharedSecret);

    try {
      const status = await fetchStatus(workerUrl, sharedSecret);
      saveCachedStatus(status);
      widget = buildStatusWidget(status, status.stale === true, dashboardUrl);
    } catch (fetchError) {
      const cached = loadCachedStatus();
      widget = cached
        ? buildStatusWidget(cached, true, dashboardUrl)
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
