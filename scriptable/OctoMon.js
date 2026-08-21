// Octopus Home Mini widget for Scriptable.
// Fill in WORKER_URL and SHARED_SECRET below with the values from your
// `wrangler deploy` output and `wrangler secret put WIDGET_SHARED_SECRET`
// (see the main repo README for full setup instructions), then add a
// Scriptable widget on your home screen pointing at this script.
//
// icon-color: orange; icon-glyph: bolt;

const WORKER_URL = "https://octo-mon.YOUR-SUBDOMAIN.workers.dev/status";
const SHARED_SECRET = "REPLACE_WITH_WIDGET_SHARED_SECRET";

const REQUEST_TIMEOUT_SECONDS = 8;
const REFRESH_INTERVAL_MINUTES = 20;

const CACHE_PATH = FileManager.local().joinPath(
  FileManager.local().documentsDirectory(),
  "octomon-status-cache.json",
);

async function fetchStatus() {
  const url = `${WORKER_URL}?token=${encodeURIComponent(SHARED_SECRET)}`;
  const req = new Request(url);
  req.headers = { "X-Widget-Secret": SHARED_SECRET };
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

function formatShortDate(isoDateString) {
  return new Date(`${isoDateString}T00:00:00Z`).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function colorForRate(pencePerKwh) {
  if (pencePerKwh < 15) return new Color("#4CAF50");
  if (pencePerKwh < 30) return new Color("#FFA726");
  return new Color("#EF5350");
}

function buildStatusWidget(status, stale) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#111318");
  widget.setPadding(12, 14, 12, 14);

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

  widget.addSpacer(6);

  const currentCostLine = widget.addText(`${formatPounds(status.currentCostPerHourGbp)}/hr`);
  currentCostLine.font = Font.boldSystemFont(22);
  currentCostLine.textColor = colorForRate(status.currentRate.pencePerKwh);

  const detailLine = widget.addText(
    `${status.currentDemandKw.toFixed(2)} kW @ ${formatPence(status.currentRate.pencePerKwh)}/kWh`,
  );
  detailLine.font = Font.systemFont(11);
  detailLine.textColor = Color.gray();

  widget.addSpacer(10);

  const todayLabel = widget.addText("TODAY");
  todayLabel.font = Font.mediumSystemFont(10);
  todayLabel.textColor = Color.gray();

  const todayCost = widget.addText(formatPounds(status.todayTotalCostGbp));
  todayCost.font = Font.boldSystemFont(18);
  todayCost.textColor = Color.white();

  if (config.widgetFamily !== "small") {
    const todayKwh = widget.addText(`${status.todayTotalKwh.toFixed(2)} kWh so far`);
    todayKwh.font = Font.systemFont(11);
    todayKwh.textColor = Color.gray();

    widget.addSpacer(8);

    const monthLabel = widget.addText(`THIS MONTH (since ${formatShortDate(status.billingPeriodStart)})`);
    monthLabel.font = Font.mediumSystemFont(10);
    monthLabel.textColor = Color.gray();

    const monthCost = widget.addText(formatPounds(status.thisMonthTotalCostGbp));
    monthCost.font = Font.boldSystemFont(16);
    monthCost.textColor = Color.white();
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
  let widget;

  try {
    const status = await fetchStatus();
    saveCachedStatus(status);
    widget = buildStatusWidget(status, status.stale === true);
  } catch (error) {
    const cached = loadCachedStatus();
    widget = cached ? buildStatusWidget(cached, true) : buildErrorWidget(String(error));
  }

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else if (config.widgetFamily === "medium") {
    await widget.presentMedium();
  } else {
    await widget.presentSmall();
  }

  Script.complete();
}

await run();
