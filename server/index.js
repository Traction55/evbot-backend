/**
 * EVBot backend (Express + YAML fault library + Telegram bot)
 * - Works locally (polling) and on Railway (webhook)
 * - Manufacturer menu first (Autel + Kempower)
 * - Autel faults (YAML) + YAML decision_tree
 * - Kempower faults (YAML) + YAML decision_tree
 * - /report generates a client-ready service report
 *
 * New additions (Jan 2026):
 * - "Create report for this fault" from any fault card (autofills manufacturer + fault)
 * - Removed visible "evidence captured" checklist (per request)
 * - Added optional "Upload photos" step (silent capture, referenced as attachments count)
 * - Report fields: Site name, Asset ID, Tech name, Client reference / ticket #
 *
 * New additions (Images):
 * - Serves static images from /images -> assets/images
 * - YAML decision_tree node can include: image: autel/ac_contactor_location
 *   and bot will sendPhoto(PUBLIC_URL/images/autel/ac_contactor_location.jpg)
 *
 * IMPORTANT ENV:
 *   TELEGRAM_BOT_TOKEN=...
 *   PUBLIC_URL=https://your-railway-domain.up.railway.app
 *   USE_WEBHOOK=true   (Railway)
 *   USE_WEBHOOK=false  (Local)
 *   TELEGRAM_WEBHOOK_SECRET=optional_secret
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const TelegramBot = require("node-telegram-bot-api");

// ------------------- ENV -------------------
const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_WEBHOOK_SECRET = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();

// Normalize PUBLIC_URL:
// - if PUBLIC_URL is "myapp.up.railway.app" (no scheme), convert to "https://myapp.up.railway.app"
function normalizePublicUrl(raw) {
  const v = (raw || "").trim();
  if (!v) return "";
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  return `https://${v}`;
}

const PUBLIC_URL = normalizePublicUrl(
  process.env.PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? process.env.RAILWAY_PUBLIC_DOMAIN : "")
);

// Force mode via USE_WEBHOOK (prevents local code from accidentally breaking prod webhook)
const USE_WEBHOOK = String(process.env.USE_WEBHOOK || "").toLowerCase() === "true";

// Telegram webhook path + full URL
const WEBHOOK_PATH = "/telegram";
const WEBHOOK_URL = PUBLIC_URL ? `${PUBLIC_URL}${WEBHOOK_PATH}` : "";

// Decide mode: only use webhook if USE_WEBHOOK=true AND we have a valid WEBHOOK_URL
const useWebhook = USE_WEBHOOK && !!WEBHOOK_URL;

// --------- Validate env ----------
if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN missing in environment (.env locally / Railway vars in prod)");
  process.exit(1);
}

// ------------------- YAML LOADING (ROBUST) -------------------
const FAULTS_DIR = path.join(__dirname, "..", "faults");
const AUTEL_FILE = path.join(FAULTS_DIR, "autel.yml");
const KEMPOWER_FILE = path.join(FAULTS_DIR, "kempower.yml");

function loadYamlSafe(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return yaml.load(raw) || {};
  } catch (e) {
    console.error(`❌ YAML load failed: ${file}`, e?.message || e);
    return {};
  }
}

function normalizeFaultPack(obj) {
  // Accept either { faults: [...] } or just [...]
  const faults = Array.isArray(obj) ? obj : Array.isArray(obj?.faults) ? obj.faults : [];

  // Ensure each fault has id + title (fallbacks supported)
  const fixed = faults.map((f, idx) => {
    const title = f?.title || f?.name || f?.fault || `Fault ${idx + 1}`;
    const id = String(f?.id || f?.code || f?.faultId || idx + 1);
    return { ...f, id, title };
  });

  return { faults: fixed };
}

function loadAutel() {
  if (!fs.existsSync(AUTEL_FILE)) {
    console.error(`❌ Missing autel.yml at: ${AUTEL_FILE}`);
    return { faults: [] };
  }
  return normalizeFaultPack(loadYamlSafe(AUTEL_FILE));
}

function loadKempower() {
  if (!fs.existsSync(KEMPOWER_FILE)) {
    console.error(`❌ Missing kempower.yml at: ${KEMPOWER_FILE}`);
    return { faults: [] };
  }
  return normalizeFaultPack(loadYamlSafe(KEMPOWER_FILE));
}

// Boot log (shows in Railway Deploy Logs)
try {
  const bootAutel = loadAutel();
  console.log(`✅ Autel file path: ${AUTEL_FILE}`);
  console.log(`✅ Autel faults loaded: ${bootAutel.faults.length}`);
} catch (_) {}

try {
  const bootKp = loadKempower();
  console.log(`✅ Kempower file path: ${KEMPOWER_FILE}`);
  console.log(`✅ Kempower faults loaded: ${bootKp.faults.length}`);
} catch (_) {}

// ------------------- EXPRESS -------------------
const app = express();
app.use(cors());
app.use(express.json());

// ✅ STATIC IMAGES
// Maps /images/... -> ../assets/images/...
const IMAGES_DIR = path.join(__dirname, "..", "assets", "images");
app.use("/images", express.static(IMAGES_DIR));

// ✅ DEBUG: show what the server thinks the images folder is
app.get("/debug/images-dir", (req, res) => {
  let files = [];
  try {
    const autelDir = path.join(IMAGES_DIR, "autel");
    files = fs.existsSync(autelDir) ? fs.readdirSync(autelDir) : [];
  } catch (e) {}
  res.json({
    IMAGES_DIR,
    exists: fs.existsSync(IMAGES_DIR),
    autelDirExists: fs.existsSync(path.join(IMAGES_DIR, "autel")),
    autelFiles: files,
  });
});

app.get("/", (req, res) => res.send("EVBot OK"));
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    port: PORT,
    mode: useWebhook ? "webhook" : "polling",
    publicUrl: PUBLIC_URL || null,
    webhook: WEBHOOK_URL || null,
    useWebhookEnv: USE_WEBHOOK,
    secretEnabled: !!TELEGRAM_WEBHOOK_SECRET,
    imagesDir: IMAGES_DIR,
  })
);

// Debug endpoints
app.get("/debug/autel", (req, res) => {
  const data = loadAutel();
  res.json({
    file: AUTEL_FILE,
    exists: fs.existsSync(AUTEL_FILE),
    count: data.faults.length,
    titles: data.faults.slice(0, 30).map((f) => f.title),
  });
});

app.get("/debug/kempower", (req, res) => {
  const data = loadKempower();
  res.json({
    file: KEMPOWER_FILE,
    exists: fs.existsSync(KEMPOWER_FILE),
    count: data.faults.length,
    titles: data.faults.slice(0, 30).map((f) => f.title),
  });
});

// Optional: verify image file exists via API
app.get("/debug/images", (req, res) => {
  const rel = String(req.query.path || "");
  const full = path.join(IMAGES_DIR, rel);
  res.json({
    query: rel,
    full,
    exists: rel ? fs.existsSync(full) : null,
  });
});

// ------------------- TELEGRAM BOT (ONE instance) -------------------
const bot = new TelegramBot(
  BOT_TOKEN,
  useWebhook
    ? { webHook: true }
    : {
        polling: {
          interval: 1000,
          params: { timeout: 20 },
        },
      }
);

bot.on("polling_error", (e) => console.error("❌ polling_error:", e?.message || e));
bot.on("webhook_error", (e) => console.error("❌ webhook_error:", e?.message || e));

// ------------------- HELPERS -------------------
function escapeHtml(str) {
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function kb(rows) {
  return { inline_keyboard: rows };
}

function cap(s) {
  const v = String(s || "");
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : "";
}

// Edit message if possible (clean UX), else send a new one
async function upsertMessage(chatId, opts) {
  const { text, parse_mode, reply_markup, messageId } = opts;
  if (messageId) {
    try {
      return await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode,
        reply_markup,
      });
    } catch (_) {
      // fallback below
    }
  }
  return bot.sendMessage(chatId, text, { parse_mode, reply_markup });
}

/**
 * If node has image, we must sendPhoto().
 * Editing an existing text message into a photo is not possible, so we:
 * - try editMessageCaption if it was already a photo (may fail)
 * - otherwise sendPhoto as a fresh message
 */
async function upsertPhotoOrText(chatId, opts) {
  const { messageId, text, parse_mode, reply_markup, imageUrl } = opts;

  if (imageUrl) {
    // Attempt to edit caption first (only works if prior message is a photo)
    if (messageId) {
      try {
        await bot.editMessageCaption(text, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode,
          reply_markup,
        });
        return;
      } catch (_) {
        // fall through to sendPhoto
      }
    }

    return bot.sendPhoto(chatId, imageUrl, {
      caption: text,
      parse_mode,
      reply_markup,
    });
  }

  return upsertMessage(chatId, { chatId, messageId, text, parse_mode, reply_markup });
}

// ------------------- STATE -------------------
const reportState = new Map();

// ✅ Decision-tree state with HISTORY
// chatId -> { pack: "autel"|"kempower", faultId: string, history: string[] }
const dtState = new Map();

// ------------------- YAML DECISION TREE SUPPORT -------------------
function dtCallback(pack, faultId, nodeId) {
  return `DT|${pack}|${faultId}|${nodeId}`;
}
function dtBackCallback(pack, faultId) {
  return `DTB|${pack}|${faultId}`;
}

function getFaultById(pack, id) {
  const data = pack === "kempower" ? loadKempower() : loadAutel();
  return (data.faults || []).find((x) => String(x.id) === String(id));
}

function resetDt(chatId) {
  dtState.delete(chatId);
}

// Push node into history (avoid duplicates)
function pushDtHistory(chatId, pack, faultId, nodeId) {
  const cur = dtState.get(chatId);

  if (!cur || cur.pack !== pack || String(cur.faultId) !== String(faultId)) {
    dtState.set(chatId, { pack, faultId: String(faultId), history: [String(nodeId)] });
    return;
  }

  const hist = cur.history || [];
  const last = hist[hist.length - 1];

  if (String(last) !== String(nodeId)) {
    hist.push(String(nodeId));
    dtState.set(chatId, { ...cur, history: hist });
  }
}

// Pop current node and return previous (or null)
function popDtHistory(chatId, pack, faultId) {
  const cur = dtState.get(chatId);
  if (!cur || cur.pack !== pack || String(cur.faultId) !== String(faultId)) return null;

  const hist = Array.isArray(cur.history) ? [...cur.history] : [];
  if (hist.length <= 1) return null; // nothing to go back to

  hist.pop();
  const prev = hist[hist.length - 1] || null;

  dtState.set(chatId, { ...cur, history: hist });
  return prev;
}

// Legacy HTML renderer (keeps older YAML shapes working)
function buildLegacyFaultHtml(f) {
  const lines = [];
  lines.push(`🧰 <b>${escapeHtml(f.title || "Fault")}</b>`);

  if (f.symptoms?.length) {
    lines.push(`\n<b>Symptoms:</b>`);
    f.symptoms.forEach((s) => lines.push(`• ${escapeHtml(String(s))}`));
  }
  if (f.safety?.length) {
    lines.push(`\n<b>Safety:</b>`);
    f.safety.forEach((s) => lines.push(`• ${escapeHtml(String(s))}`));
  }
  if (f.checks?.length) {
    lines.push(`\n<b>Checks:</b>`);
    f.checks.forEach((s) => lines.push(`• ${escapeHtml(String(s))}`));
  }
  if (f.actions?.length) {
    lines.push(`\n<b>Actions:</b>`);
    f.actions.forEach((s) => lines.push(`• ${escapeHtml(String(s))}`));
  }
  if (f.escalation?.length) {
    lines.push(`\n<b>Escalation:</b>`);
    f.escalation.forEach((s) => lines.push(`• ${escapeHtml(String(s))}`));
  }

  lines.push("\n");
  return lines.join("\n");
}

// Callback helpers for starting report from a fault
function reportFromFaultCallback(pack, faultId) {
  return `RF|${pack}|${faultId}`;
}

async function showFaultCard({ chatId, messageId, pack, fault }) {
  resetDt(chatId);

  const rows = [];

  // Start DT (if present)
  if (fault?.decision_tree?.start_node && fault?.decision_tree?.nodes) {
    rows.push([
      {
        text: "🧭 Start troubleshooting",
        callback_data: dtCallback(pack, fault.id, fault.decision_tree.start_node),
      },
    ]);
  }

  // Report from this fault (autofill)
  rows.push([
    {
      text: "🧾 Create report for this fault",
      callback_data: reportFromFaultCallback(pack, fault.id),
    },
  ]);

  // Back to menu
  rows.push([{ text: "⬅️ Back", callback_data: pack === "kempower" ? "kempower:menu" : "autel:menu" }]);

  // Preferred: YAML field response.telegram_markdown
  if (fault?.response?.telegram_markdown) {
    return upsertMessage(chatId, {
      messageId,
      text: fault.response.telegram_markdown,
      parse_mode: "Markdown",
      reply_markup: kb(rows),
    });
  }

  // Fallback: old schema rendered to HTML
  const html = buildLegacyFaultHtml(fault);
  return upsertMessage(chatId, {
    messageId,
    text: html,
    parse_mode: "HTML",
    reply_markup: kb(rows),
  });
}

function imageKeyToUrl(imageKey) {
  // YAML: image: autel/ac_contactor_location   (no extension)
  // Will serve whichever exists: .png, .jpg, .jpeg, .webp
  if (!imageKey) return "";

  const key = String(imageKey).trim().replace(/^\/+/, "");
  const relBase = key.replace(/^\/*/, ""); // e.g. "autel/ac_contactor_location"

  // If YAML already includes an extension, respect it
  const hasExt = /\.[a-z0-9]+$/i.test(relBase);
  const candidates = hasExt
    ? [relBase]
    : [`${relBase}.png`, `${relBase}.jpg`, `${relBase}.jpeg`, `${relBase}.webp`];

  // If we can check local filesystem, pick the first that exists
  for (const rel of candidates) {
    const localPath = path.join(IMAGES_DIR, rel);
    if (fs.existsSync(localPath)) {
      // Telegram needs a public URL to fetch
      return PUBLIC_URL ? `${PUBLIC_URL}/images/${rel}` : "";
    }
  }

  // Fall back (if nothing exists)
  return PUBLIC_URL ? `${PUBLIC_URL}/images/${candidates[0]}` : "";
}


async function renderYamlDecisionNode({ chatId, messageId, pack, fault, nodeId }) {
  const tree = fault?.decision_tree;
  const node = tree?.nodes?.[nodeId];

  // Special internal jump back to menu (from YAML)
  if (nodeId === "__MENU_KEMPOWER__") return showKempowerMenu(chatId, messageId);
  if (nodeId === "__MENU_AUTEL__") return showAutelMenu(chatId, messageId);

  if (!node) {
    return upsertMessage(chatId, {
      messageId,
      text: `⚠️ Decision node not found: ${nodeId}`,
      parse_mode: "Markdown",
      reply_markup: kb([
        [{ text: "⬅️ Back", callback_data: pack === "kempower" ? "kempower:menu" : "autel:menu" }],
      ]),
    });
  }

  pushDtHistory(chatId, pack, fault.id, nodeId);

  const text = node.prompt || "…";

  // 1 button per row
  const rows = (node.options || []).map((opt) => [
    { text: opt.label, callback_data: dtCallback(pack, fault.id, opt.next) },
  ]);

  // Report from within the tree too
  rows.push([{ text: "🧾 Create report for this fault", callback_data: reportFromFaultCallback(pack, fault.id) }]);

  rows.push([{ text: "⬅️ Back", callback_data: dtBackCallback(pack, fault.id) }]);
  rows.push([
    {
      text: pack === "kempower" ? "🏠 Kempower menu" : "🏠 Autel menu",
      callback_data: pack === "kempower" ? "kempower:menu" : "autel:menu",
    },
  ]);

  const imageUrl = node.image ? imageKeyToUrl(node.image) : "";

  // If node has image but PUBLIC_URL is blank, we still show text (local)
  if (node.image && !imageUrl) {
    return upsertMessage(chatId, {
      messageId,
      text: `${text}\n\n⚠️ (Image available, but PUBLIC_URL is blank so Telegram can’t fetch it in this mode.)`,
      parse_mode: "Markdown",
      reply_markup: kb(rows),
    });
  }

  // Prefer photo when image is defined
  return upsertPhotoOrText(chatId, {
    messageId,
    text,
    parse_mode: "Markdown",
    reply_markup: kb(rows),
    imageUrl: imageUrl || "",
  });
}

// ------------------- /report WIZARD -------------------
function setReport(chatId, patch) {
  const cur =
    reportState.get(chatId) || {
      step: "site",
      data: {
        actions: [],
        manufacturer: "",
        faultTitle: "",
        prefilled: false,

        // NEW report fields
        assetId: "",
        technician: "",
        clientRef: "",

        // NEW: optional photos (silent capture)
        photos: [],
        notes: "",
      },
    };

  const next = {
    ...cur,
    ...patch,
    data: { ...cur.data, ...(patch.data || {}) },
  };

  reportState.set(chatId, next);
  return next;
}

function clearReport(chatId) {
  reportState.delete(chatId);
}

function formatReportHtml(data) {
  const site = escapeHtml(data.site || "");
  const assetId = escapeHtml(data.assetId || "");
  const technician = escapeHtml(data.technician || "");
  const clientRef = escapeHtml(data.clientRef || "");

  const manufacturer = escapeHtml((data.manufacturer || "").toUpperCase());
  const faultTitle = escapeHtml(data.faultTitle || "");
  const resolution = escapeHtml(data.resolution || "");
  const notes = escapeHtml(data.notes || "");

  const actions = Array.isArray(data.actions) ? data.actions : [];
  const actionsLines = actions.length ? actions.map((a) => `• ${escapeHtml(a)}`).join("\n") : "• (none recorded)";

  const photos = Array.isArray(data.photos) ? data.photos : [];
  const attachmentsLine = photos.length ? `• Photos uploaded (${photos.length})` : "• None";

  return (
    `🧾 <b>EVBot Service Report</b>\n\n` +
    `<b>Site:</b> ${site}\n` +
    `<b>Asset ID:</b> ${assetId}\n` +
    `<b>Technician:</b> ${technician}\n` +
    `<b>Client reference / ticket #:</b> ${clientRef}\n` +
    (manufacturer ? `<b>Manufacturer:</b> ${manufacturer}\n` : "") +
    `<b>Fault:</b> ${faultTitle}\n\n` +
    `<b>Actions Taken:</b>\n${actionsLines}\n\n` +
    `<b>Status / Outcome:</b> ${resolution}\n\n` +
    `<b>Attachments:</b>\n${attachmentsLine}\n` +
    (notes ? `\n<b>Notes:</b>\n${notes}\n` : "")
  );
}

async function startReport(chatId) {
  setReport(chatId, {
    step: "site",
    data: {
      actions: [],
      manufacturer: "",
      faultTitle: "",
      prefilled: false,
      assetId: "",
      technician: "",
      clientRef: "",
      photos: [],
      notes: "",
    },
  });

  return bot.sendMessage(chatId, "🧾 <b>Report Builder</b>\n\nWhat is the <b>site name</b>?\n\n(Reply with text)", {
    parse_mode: "HTML",
  });
}

// Start report with manufacturer+fault prefilled
async function startReportFromFault(chatId, pack, fault) {
  setReport(chatId, {
    step: "site",
    data: {
      actions: [],
      manufacturer: pack,
      faultTitle: fault?.title || "",
      prefilled: true,
      assetId: "",
      technician: "",
      clientRef: "",
      photos: [],
      notes: "",
    },
  });

  return bot.sendMessage(
    chatId,
    `🧾 <b>Report Builder</b>\n\nPrefilled:\n<b>Manufacturer:</b> ${escapeHtml(cap(pack))}\n<b>Fault:</b> ${escapeHtml(
      fault?.title || ""
    )}\n\nWhat is the <b>site name</b>?\n\n(Reply with text)`,
    { parse_mode: "HTML" }
  );
}

async function askAssetId(chatId) {
  setReport(chatId, { step: "assetId" });
  return bot.sendMessage(chatId, "What is the <b>asset ID</b>?\n\n(Reply with text)", { parse_mode: "HTML" });
}

async function askTechnician(chatId) {
  setReport(chatId, { step: "technician" });
  return bot.sendMessage(chatId, "What is the <b>technician name</b>?\n\n(Reply with text)", { parse_mode: "HTML" });
}

async function askClientRef(chatId) {
  setReport(chatId, { step: "clientRef" });
  return bot.sendMessage(chatId, "What is the <b>client reference / ticket #</b>?\n\n(Reply with text)", {
    parse_mode: "HTML",
  });
}

async function askReportManufacturer(chatId) {
  setReport(chatId, { step: "mfr" });

  const rows = [
    [{ text: "🔵 Autel", callback_data: "r:mfr:autel" }],
    [{ text: "🟢 Kempower", callback_data: "r:mfr:kempower" }],
    [{ text: "Cancel", callback_data: "r:cancel" }],
  ];

  return bot.sendMessage(chatId, "Select the <b>manufacturer</b>:", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
}

async function askFault(chatId) {
  setReport(chatId, { step: "fault" });

  const st = reportState.get(chatId);
  const pack = (st?.data?.manufacturer || "autel").toLowerCase();
  const isKp = pack === "kempower";

  const data = isKp ? loadKempower() : loadAutel();
  const faults = data.faults || [];

  const rows = [];

  if (!faults.length) {
    rows.push([
      {
        text: `⚠️ No ${isKp ? "Kempower" : "Autel"} faults loaded (check /debug/${isKp ? "kempower" : "autel"})`,
        callback_data: "noop",
      },
    ]);
  } else {
    faults.forEach((f) => {
      rows.push([{ text: f.title, callback_data: `r:fault:${isKp ? "KEMPOWER" : "AUTEL"}:${f.id}` }]);
    });
  }

  rows.push([{ text: "⬅️ Back", callback_data: "r:back:mfr" }]);
  rows.push([{ text: "Cancel", callback_data: "r:cancel" }]);

  return bot.sendMessage(chatId, `Select the <b>${isKp ? "Kempower" : "Autel"} fault</b>:`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
}

const REPORT_ACTION_OPTIONS = [
  "Firmware update performed",
  "Power cycle performed",
  "Checked charger configuration (site specific)",
  "Checked historical logs",
  "Checked passthrough / backend comms",
  "Reseated modules / connections",
  "Replaced component/part",
  "On-site visit required",
  "Escalated to OEM / vendor support",
  "Other (add in notes)",
];

function buildActionsKeyboard(selected = []) {
  const rows = REPORT_ACTION_OPTIONS.map((label, idx) => {
    const isOn = selected.includes(label);
    return [{ text: `${isOn ? "✅" : "⬜️"} ${label}`, callback_data: `r:act:${idx}` }];
  });

  rows.push([
    { text: "Done ➡️", callback_data: "r:act:done" },
    { text: "Cancel", callback_data: "r:cancel" },
  ]);

  return rows;
}

async function askActions(chatId) {
  setReport(chatId, { step: "actions" });
  const st = reportState.get(chatId);
  const selected = st?.data?.actions || [];

  const title = st?.data?.faultTitle ? `\n\n<b>Fault:</b> ${escapeHtml(st.data.faultTitle)}` : "";
  const mfr = st?.data?.manufacturer ? `\n<b>Manufacturer:</b> ${escapeHtml(cap(st.data.manufacturer))}` : "";

  return bot.sendMessage(chatId, `Select <b>actions performed</b>:${mfr}${title}`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildActionsKeyboard(selected) },
  });
}

async function askResolution(chatId) {
  setReport(chatId, { step: "resolution" });

  const rows = [
    [{ text: "✅ Resolved (operational, no active faults)", callback_data: "r:res:Resolved" }],
    [{ text: "👀 Monitoring (intermittent / watch)", callback_data: "r:res:Monitoring" }],
    [{ text: "🧰 Site visit required for diagnostics", callback_data: "r:res:Site visit required" }],
    [{ text: "📈 Escalated to OEM / vendor", callback_data: "r:res:Escalated to OEM" }],
    [{ text: "Cancel", callback_data: "r:cancel" }],
  ];

  return bot.sendMessage(chatId, "Select <b>status/outcome</b>:", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
}

async function askUploadPhotos(chatId) {
  setReport(chatId, { step: "UPLOAD_PHOTOS" });

  return bot.sendMessage(
    chatId,
    "📸 <b>Upload photos (optional)</b>\n\nRecommended:\n• Fault screen / alarm\n• Internal condition (if opened)\n• Filters, connectors, modules\n• Before / after photos\n\nYou can upload multiple photos.\nTap <b>Done uploading</b> when finished, or <b>Skip</b> to continue.",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Skip", callback_data: "PHOTOS_SKIP" }],
          [{ text: "Done uploading", callback_data: "PHOTOS_DONE" }],
          [{ text: "Cancel", callback_data: "r:cancel" }],
        ],
      },
    }
  );
}

async function askNotes(chatId) {
  setReport(chatId, { step: "notes" });

  return bot.sendMessage(chatId, "Optional — Add any <b>notes</b> (or press Skip):", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Skip", callback_data: "r:notes:skip" }],
        [{ text: "Cancel", callback_data: "r:cancel" }],
      ],
    },
  });
}

async function finishReport(chatId) {
  const st = reportState.get(chatId);
  const data = st?.data || {};
  const reportText = formatReportHtml(data);

  setReport(chatId, { step: "done" });

  await bot.sendMessage(chatId, reportText, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Start a new report", callback_data: "r:new" }],
        [{ text: "⬅️ Back to Manufacturer", callback_data: "menu:mfr" }],
      ],
    },
  });
}

// ------------------- MENUS -------------------
function showManufacturerMenu(chatId, messageId) {
  resetDt(chatId);

  const rows = [
    [{ text: "🔵 Autel", callback_data: "mfr:autel" }],
    [{ text: "🟢 Kempower", callback_data: "mfr:kempower" }],
    [{ text: "🧾 Build a report (/report)", callback_data: "r:new" }],
    [{ text: "🔁 Reset", callback_data: "reset" }],
  ];

  return upsertMessage(chatId, {
    messageId,
    text: "⚡ <b>EVBot – Troubleshooting</b>\n\nSelect the charger manufacturer:",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
}

function buildAutelMenuKeyboard() {
  const data = loadAutel();
  const faults = data.faults || [];

  const rows = [];

  if (!faults.length) {
    rows.push([{ text: "⚠️ No Autel faults loaded (check /debug/autel)", callback_data: "noop" }]);
  } else {
    faults.forEach((f) => {
      rows.push([{ text: f.title, callback_data: `AUTEL:${f.id}` }]);
    });
  }

  rows.push([{ text: "🧾 Build a report (/report)", callback_data: "r:new" }]);
  rows.push([{ text: "⬅️ Back to Manufacturer", callback_data: "menu:mfr" }]);
  rows.push([{ text: "🔁 Reset", callback_data: "reset" }]);

  return rows;
}

async function showAutelMenu(chatId, messageId) {
  const rows = buildAutelMenuKeyboard();
  return upsertMessage(chatId, {
    messageId,
    text: "Autel Troubleshooting 📋\n\nChoose an Autel fault:",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
}

function buildKempowerMenuKeyboard() {
  const data = loadKempower();
  const faults = data.faults || [];

  const rows = [];
  if (!faults.length) {
    rows.push([{ text: "⚠️ No Kempower faults loaded (check /debug/kempower)", callback_data: "noop" }]);
  } else {
    faults.forEach((f) => {
      rows.push([{ text: f.title, callback_data: `KEMPOWER:${f.id}` }]);
    });
  }

  rows.push([{ text: "🧾 Build a report (/report)", callback_data: "r:new" }]);
  rows.push([{ text: "⬅️ Back to Manufacturer", callback_data: "menu:mfr" }]);
  rows.push([{ text: "🔁 Reset", callback_data: "reset" }]);

  return rows;
}

async function showKempowerMenu(chatId, messageId) {
  const rows = buildKempowerMenuKeyboard();
  return upsertMessage(chatId, {
    messageId,
    text: "Kempower Troubleshooting 🟢\n\nChoose a Kempower fault:",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
}

// ------------------- COMMANDS -------------------
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  clearReport(chatId);
  resetDt(chatId);
  await showManufacturerMenu(chatId);
});

bot.onText(/^\/ping$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "✅ pong");
});

bot.onText(/^\/reset$/, async (msg) => {
  const chatId = msg.chat.id;
  clearReport(chatId);
  resetDt(chatId);
  await showManufacturerMenu(chatId);
  await bot.sendMessage(chatId, "🔄 Reset complete.");
});

bot.onText(/^\/autel$/, async (msg) => {
  resetDt(msg.chat.id);
  await showAutelMenu(msg.chat.id);
});

bot.onText(/^\/kempower$/, async (msg) => {
  resetDt(msg.chat.id);
  await showKempowerMenu(msg.chat.id);
});

bot.onText(/^\/report$/, async (msg) => {
  await startReport(msg.chat.id);
});

bot.onText(/^\/cancel$/, async (msg) => {
  clearReport(msg.chat.id);
  resetDt(msg.chat.id);
  await bot.sendMessage(msg.chat.id, "✅ Cancelled.");
});

// Capture text replies during report wizard
bot.on("message", async (msg) => {
  const chatId = msg?.chat?.id;
  const text = (msg?.text || "").trim();
  if (!chatId) return;

  // If it's a photo message, photo handler below will deal with it
  if (!text) return;

  if (text.startsWith("/")) return;

  const st = reportState.get(chatId);
  if (!st) return;

  if (st.step === "site") {
    setReport(chatId, { data: { site: text } });
    return askAssetId(chatId);
  }

  if (st.step === "assetId") {
    setReport(chatId, { data: { assetId: text } });
    return askTechnician(chatId);
  }

  if (st.step === "technician") {
    setReport(chatId, { data: { technician: text } });
    return askClientRef(chatId);
  }

  if (st.step === "clientRef") {
    setReport(chatId, { data: { clientRef: text } });

    // If report started from a fault card, manufacturer+fault are already set, so skip selection
    if (st.data?.prefilled) return askActions(chatId);

    return askReportManufacturer(chatId);
  }

  if (st.step === "notes") {
    setReport(chatId, { data: { notes: text } });
    return finishReport(chatId);
  }
});

// NEW: Capture photo uploads during the photo step (silent)
bot.on("photo", async (msg) => {
  const chatId = msg?.chat?.id;
  if (!chatId) return;

  const st = reportState.get(chatId);
  if (!st || st.step !== "UPLOAD_PHOTOS") return;

  const photos = msg.photo || [];
  if (!photos.length) return;

  const best = photos[photos.length - 1]; // highest res
  const caption = (msg.caption || "").trim();

  const curPhotos = Array.isArray(st.data.photos) ? st.data.photos : [];
  curPhotos.push({ file_id: best.file_id, caption });

  setReport(chatId, { data: { photos: curPhotos } });

  // Keep UX clean: acknowledge once per upload
  return bot.sendMessage(chatId, "📸 Photo added. Upload more, or tap Done.");
});

// ------------------- SINGLE CALLBACK HANDLER -------------------
bot.on("callback_query", async (q) => {
  const chatId = q?.message?.chat?.id;
  const messageId = q?.message?.message_id;
  const data = q?.data || "";

  try {
    await bot.answerCallbackQuery(q.id);
  } catch (_) {}

  if (!chatId) return;
  if (data === "noop") return;

  // Global reset -> go to manufacturer menu
  if (data === "reset") {
    clearReport(chatId);
    resetDt(chatId);
    return showManufacturerMenu(chatId, messageId);
  }

  // Back to manufacturer menu
  if (data === "menu:mfr") {
    clearReport(chatId);
    resetDt(chatId);
    return showManufacturerMenu(chatId, messageId);
  }

  // Manufacturer selection
  if (data.startsWith("mfr:")) {
    const mfr = data.split(":")[1];
    if (mfr === "autel") return showAutelMenu(chatId, messageId);
    if (mfr === "kempower") return showKempowerMenu(chatId, messageId);
    return showManufacturerMenu(chatId, messageId);
  }

  // Report from fault card / decision tree (autofill)
  if (data.startsWith("RF|")) {
    const [, pack, faultId] = data.split("|");
    const fault = getFaultById(pack, faultId);
    if (!fault) {
      return bot.sendMessage(chatId, "⚠️ Could not start report: fault not found.");
    }
    clearReport(chatId);
    return startReportFromFault(chatId, pack, fault);
  }

  // ✅ DT BACK ONE STEP
  if (data.startsWith("DTB|")) {
    const [, pack, faultId] = data.split("|");
    const fault = getFaultById(pack, faultId);
    if (!fault) {
      resetDt(chatId);
      return pack === "kempower" ? showKempowerMenu(chatId, messageId) : showAutelMenu(chatId, messageId);
    }

    const prevNode = popDtHistory(chatId, pack, faultId);
    if (!prevNode) return showFaultCard({ chatId, messageId, pack, fault });

    return renderYamlDecisionNode({ chatId, messageId, pack, fault, nodeId: prevNode });
  }

  // YAML decision tree next node
  if (data.startsWith("DT|")) {
    const [, pack, faultId, nodeId] = data.split("|");
    const fault = getFaultById(pack, faultId);

    if (!fault) {
      resetDt(chatId);
      return upsertMessage(chatId, {
        messageId,
        text: "⚠️ Fault not found.",
        parse_mode: "HTML",
        reply_markup: kb([[{ text: "⬅️ Back", callback_data: pack === "kempower" ? "kempower:menu" : "autel:menu" }]]),
      });
    }

    return renderYamlDecisionNode({ chatId, messageId, pack, fault, nodeId });
  }

  // ------------------- REPORT CALLBACKS -------------------
  if (data === "r:cancel") {
    clearReport(chatId);
    return bot.sendMessage(chatId, "✅ Report cancelled.");
  }

  if (data === "r:new") {
    clearReport(chatId);
    return startReport(chatId);
  }

  if (data === "r:back:mfr") {
    return askReportManufacturer(chatId);
  }

  if (data.startsWith("r:mfr:")) {
    const mfr = data.split(":")[2]; // autel | kempower
    setReport(chatId, { data: { manufacturer: mfr } });
    return askFault(chatId);
  }

  if (data.startsWith("r:fault:")) {
    const parts = data.split(":"); // r:fault:AUTEL:<id> OR r:fault:KEMPOWER:<id>
    const type = parts[2];
    const id = parts[3];

    if (type === "AUTEL") {
      const f = getFaultById("autel", id);
      setReport(chatId, { data: { manufacturer: "autel", faultTitle: f ? f.title : `Autel Fault (${id})` } });
      return askActions(chatId);
    }

    if (type === "KEMPOWER") {
      const f = getFaultById("kempower", id);
      setReport(chatId, { data: { manufacturer: "kempower", faultTitle: f ? f.title : `Kempower Fault (${id})` } });
      return askActions(chatId);
    }

    return;
  }

  if (data.startsWith("r:act:")) {
    const st = reportState.get(chatId);
    if (!st) return;

    if (data === "r:act:done") return askResolution(chatId);

    const idx = Number(data.split(":")[2]);
    if (Number.isNaN(idx) || idx < 0 || idx >= REPORT_ACTION_OPTIONS.length) return;

    const label = REPORT_ACTION_OPTIONS[idx];
    const selected = new Set(st.data.actions || []);
    if (selected.has(label)) selected.delete(label);
    else selected.add(label);

    setReport(chatId, { data: { actions: Array.from(selected) } });

    return upsertMessage(chatId, {
      messageId,
      text: "Select <b>actions performed</b>:",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildActionsKeyboard(Array.from(selected)) },
    });
  }

  if (data.startsWith("r:res:")) {
    const res = data.split(":").slice(2).join(":");
    setReport(chatId, { data: { resolution: res } });
    return askUploadPhotos(chatId);
  }

  // Photo step buttons
  if (data === "PHOTOS_SKIP" || data === "PHOTOS_DONE") {
    return askNotes(chatId);
  }

  if (data === "r:notes:skip") {
    setReport(chatId, { data: { notes: "" } });
    return finishReport(chatId);
  }

  // ------------------- MENUS -------------------
  if (data === "autel:menu") {
    resetDt(chatId);
    return showAutelMenu(chatId, messageId);
  }

  if (data === "kempower:menu") {
    resetDt(chatId);
    return showKempowerMenu(chatId, messageId);
  }

  // ------------------- FAULT SELECTION -------------------
  if (data.startsWith("AUTEL:")) {
    const id = data.split(":")[1];
    const fault = getFaultById("autel", id);

    if (!fault) {
      resetDt(chatId);
      return upsertMessage(chatId, {
        messageId,
        text: "Fault not found.",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "autel:menu" }]] },
      });
    }

    return showFaultCard({ chatId, messageId, pack: "autel", fault });
  }

  if (data.startsWith("KEMPOWER:")) {
    const id = data.split(":")[1];
    const fault = getFaultById("kempower", id);

    if (!fault) {
      resetDt(chatId);
      return upsertMessage(chatId, {
        messageId,
        text: "Fault not found.",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "kempower:menu" }]] },
      });
    }

    return showFaultCard({ chatId, messageId, pack: "kempower", fault });
  }

  // ignore unknown callback data
});

// ------------------- WEBHOOK ROUTE (Railway) -------------------
if (useWebhook) {
  app.post(WEBHOOK_PATH, (req, res) => {
    if (TELEGRAM_WEBHOOK_SECRET) {
      const got = req.get("x-telegram-bot-api-secret-token");
      if (got !== TELEGRAM_WEBHOOK_SECRET) return res.sendStatus(401);
    }

    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

// ------------------- START SERVER + WEBHOOK SETUP -------------------
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`Mode: ${useWebhook ? "WEBHOOK" : "POLLING"}`);
  console.log(`PUBLIC_URL: ${PUBLIC_URL || "(blank)"}`);
  console.log(`WEBHOOK_URL: ${WEBHOOK_URL || "(blank)"}`);
  console.log(`USE_WEBHOOK env: ${USE_WEBHOOK}`);
  console.log(`Images: /images -> ${IMAGES_DIR}`);

  if (useWebhook) {
    try {
      if (TELEGRAM_WEBHOOK_SECRET) {
        await bot.setWebHook(WEBHOOK_URL, { secret_token: TELEGRAM_WEBHOOK_SECRET });
      } else {
        await bot.setWebHook(WEBHOOK_URL);
      }
      console.log(`✅ Webhook set: ${WEBHOOK_URL}`);
    } catch (e) {
      console.error("❌ Failed to set webhook:", e?.message || e);
    }
  } else {
    console.log("ℹ️ Local polling mode. (Not touching the Railway webhook.)");
  }
});
