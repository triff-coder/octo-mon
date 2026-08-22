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
const REFRESH_INTERVAL_MINUTES = 20;

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

  widget.addSpacer(4);

  const currentCostLine = widget.addText(`${formatPounds(status.currentCostPerHourGbp)}/hr`);
  currentCostLine.font = Font.boldSystemFont(22);
  currentCostLine.textColor = colorForRate(status.currentRate.pencePerKwh);

  const detailLine = widget.addText(
    `${status.currentDemandKw.toFixed(2)} kW @ ${formatPence(status.currentRate.pencePerKwh)}/kWh`,
  );
  detailLine.font = Font.systemFont(11);
  detailLine.textColor = Color.gray();

  widget.addSpacer(8);

  if (config.widgetFamily === "small") {
    const todayLabel = widget.addText("TODAY");
    todayLabel.font = Font.mediumSystemFont(10);
    todayLabel.textColor = Color.gray();

    const todayCost = widget.addText(formatPounds(status.todayTotalCostGbp));
    todayCost.font = Font.boldSystemFont(18);
    todayCost.textColor = Color.white();
  } else {
    // Side-by-side columns make far better use of a medium/large widget's
    // width than stacking today + this-month vertically, which was
    // overflowing the widget's height and getting clipped at the bottom.
    const statsRow = widget.addStack();
    statsRow.layoutHorizontally();

    const todayColumn = statsRow.addStack();
    todayColumn.layoutVertically();
    const todayLabel = todayColumn.addText("TODAY");
    todayLabel.font = Font.mediumSystemFont(10);
    todayLabel.textColor = Color.gray();
    const todayCost = todayColumn.addText(formatPounds(status.todayTotalCostGbp));
    todayCost.font = Font.boldSystemFont(17);
    todayCost.textColor = Color.white();
    const todayKwh = todayColumn.addText(`${status.todayTotalKwh.toFixed(2)} kWh`);
    todayKwh.font = Font.systemFont(9);
    todayKwh.textColor = Color.gray();

    statsRow.addSpacer();

    const monthColumn = statsRow.addStack();
    monthColumn.layoutVertically();
    const monthLabel = monthColumn.addText("THIS MONTH");
    monthLabel.font = Font.mediumSystemFont(10);
    monthLabel.textColor = Color.gray();
    const monthCost = monthColumn.addText(formatPounds(status.thisMonthTotalCostGbp));
    monthCost.font = Font.boldSystemFont(17);
    monthCost.textColor = Color.white();
    const monthSince = monthColumn.addText(`since ${formatShortDate(status.billingPeriodStart)}`);
    monthSince.font = Font.systemFont(9);
    monthSince.textColor = Color.gray();
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
    const status = await fetchStatus(workerUrl, sharedSecret);
    saveCachedStatus(status);
    widget = buildStatusWidget(status, status.stale === true);
  } catch (error) {
    const cached = loadCachedStatus();
    widget = cached ? buildStatusWidget(cached, true) : buildErrorWidget(String(error.message ?? error));
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
