/**
 * EVBot backend (Express + YAML fault library + Telegram bot)
 * - Works locally (polling) and on Railway (webhook)
 * - Manufacturer menu first (General DC + Autel + Kempower + Tritium)
 * - Autel faults (YAML) + YAML decision_tree
 * - Kempower faults (YAML) + YAML decision_tree
 * - Tritium faults (YAML) + YAML decision_tree
 * - General DC faults (YAML) + YAML decision_tree  ✅ NEW
 * - /report generates a client-ready service report
 *
 * ✅ FIX (Jan 2026):
 * - Prevent Railway crash: TelegramError 400 BUTTON_DATA_INVALID
 * - Decision-tree callback_data is now tiny: dt:start / dt:o:0 / dt:bk / dt:mn
 *   (No pack/fault/node strings inside callback_data)
 *
 * ✅ FIX (No “45 sec dead buttons”):
 * - Removed the “ignore callback if message older than 120s” guard.
 * - Always answerCallbackQuery with a small toast (prevents spinner + feels responsive).
 * - Added safe fallback: if Telegram says “message is not modified” or edit fails, we send a new message.
 *
 * IMPORTANT ENV:
 *   TELEGRAM_BOT_TOKEN=...
 *   PUBLIC_URL=https://your-railway-domain.up.railway.app
 *   USE_WEBHOOK=true   (Railway)
 *   USE_WEBHOOK=false  (Local)
 *   TELEGRAM_WEBHOOK_SECRET=optional_secret
 */

require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const TelegramBot = require("node-telegram-bot-api");

/* =========================
   HTML SAFETY (Telegram)
   ========================= */
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Emojis in builder ✅, but strip them in final report ✅
function stripEmojisForFinal(s = "") {
  return String(s)
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, "")
    .replace(/[\u{2600}-\u{26FF}]/gu, "")
    .replace(/[\u{2700}-\u{27BF}]/gu, "")
    .replace(/\uFE0F/gu, "")
    .replace(/\u200D/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/* =========================
   ENV
   ========================= */
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
  process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? process.env.RAILWAY_PUBLIC_DOMAIN : "")
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

/* =========================
   YAML LOADING (ROBUST)
   ========================= */
const FAULTS_DIR = path.join(__dirname, "..", "faults");
const AUTEL_FILE = path.join(FAULTS_DIR, "autel.yml");
const KEMPOWER_FILE = path.join(FAULTS_DIR, "kempower.yml");
const TRITIUM_FILE = path.join(FAULTS_DIR, "tritium.yml");
const GENERAL_DC_FILE = path.join(FAULTS_DIR, "general_dc.yml"); // ✅ NEW

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

function loadTritium() {
  if (!fs.existsSync(TRITIUM_FILE)) {
    console.error(`❌ Missing tritium.yml at: ${TRITIUM_FILE}`);
    return { faults: [] };
  }
  return normalizeFaultPack(loadYamlSafe(TRITIUM_FILE));
}

function loadGeneralDc() {
  if (!fs.existsSync(GENERAL_DC_FILE)) {
    console.error(`❌ Missing general_dc.yml at: ${GENERAL_DC_FILE}`);
    return { faults: [] };
  }
  return normalizeFaultPack(loadYamlSafe(GENERAL_DC_FILE));
}

// Boot log (shows in Railway Deploy Logs)
try {
  const bootGen = loadGeneralDc();
  console.log(`✅ General DC file path: ${GENERAL_DC_FILE}`);
  console.log(`✅ General DC faults loaded: ${bootGen.faults.length}`);
} catch (_) {}

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

try {
  const bootTri = loadTritium();
  console.log(`✅ Tritium file path: ${TRITIUM_FILE}`);
  console.log(`✅ Tritium faults loaded: ${bootTri.faults.length}`);
} catch (_) {}

/* =========================
   EXPRESS
   ========================= */
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
app.get("/debug/general_dc", (req, res) => {
  const data = loadGeneralDc();
  res.json({
    file: GENERAL_DC_FILE,
    exists: fs.existsSync(GENERAL_DC_FILE),
    count: data.faults.length,
    titles: data.faults.slice(0, 30).map((f) => f.title),
  });
});

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

app.get("/debug/tritium", (req, res) => {
  const data = loadTritium();
  res.json({
    file: TRITIUM_FILE,
    exists: fs.existsSync(TRITIUM_FILE),
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

/* =========================
   TELEGRAM BOT (ONE instance)
   ========================= */
const bot = new TelegramBot(
  BOT_TOKEN,
  useWebhook
    ? { webHook: true }
    : {
        polling: {
          interval: 1000,
          // IMPORTANT: Telegram long-poll timeout is server-side. 20–60 is fine.
          params: { timeout: 30 },
        },
      }
);

bot.on("polling_error", (e) => console.error("❌ polling_error:", e?.message || e));
bot.on("webhook_error", (e) => console.error("❌ webhook_error:", e?.message || e));

/* =========================
   HELPERS
   ========================= */
function kb(rows) {
  return { inline_keyboard: rows };
}

function cap(s) {
  const v = String(s || "");
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : "";
}

// Treat “message not modified” and “message can’t be edited” as non-fatal
function isIgnorableTelegramEditError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("message is not modified") ||
    msg.includes("message to edit not found") ||
    msg.includes("message can't be edited") ||
    msg.includes("message_id_invalid") ||
    msg.includes("chat not found")
  );
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
    } catch (e) {
      // If edit fails (old message / already edited / etc), fall back to sending a new message
      if (!isIgnorableTelegramEditError(e)) {
        console.error("❌ editMessageText failed:", e?.message || e);
      }
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
      } catch (e) {
        if (!isIgnorableTelegramEditError(e)) {
          console.error("❌ editMessageCaption failed:", e?.message || e);
        }
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

/* =========================
   REPORT CHECKLIST (MFR + FAULT AWARE)
   ========================= */
const REPORT_CHECKLIST = {
  general_dc: {
    base: [
      { key: "g_loto", label: "🔒 LOTO / isolation applied" },
      { key: "g_visual", label: "👀 Visual inspection (burn marks, water ingress, loose lugs)" },
      { key: "g_power_cycle", label: "🔁 Controlled power cycle performed" },
      { key: "g_logs", label: "🗂️ Alarms/logs reviewed + timestamps captured" },
      { key: "g_comms", label: "📶 Comms checked (LTE/Ethernet, signal, link lights)" },
    ],
  },

  kempower: {
    base: [
      { key: "k_loto", label: "🔒 LOTO / isolation applied" },
      { key: "k_visual", label: "👀 Visual inspection (burn marks, water ingress, loose lugs)" },
      { key: "k_power_cycle", label: "🔁 Controlled power cycle performed" },
      { key: "k_fw_check", label: "🧠 Firmware / versions checked" },
      { key: "k_logs", label: "🗂️ Alarms/logs reviewed + timestamps captured" },
    ],
  },

  autel: {
    base: [
      { key: "a_loto", label: "🔒 LOTO / isolation applied" },
      { key: "a_visual", label: "👀 Visual inspection (wiring, contactors, heat marks)" },
      { key: "a_input_power", label: "⚡ Input power verified (3φ voltage/rotation)" },
      { key: "a_power_cycle", label: "🔁 Power cycle performed" },
      { key: "a_fw_check", label: "🧠 Firmware checked / updated if required" },
      { key: "a_logs", label: "🗂️ Fault logs reviewed + timestamps captured" },
    ],
  },

  tritium: {
    base: [
      { key: "t_loto", label: "🔒 LOTO / isolation applied" },
      { key: "t_visual", label: "👀 Visual inspection (filters, fans, heat marks, lugs)" },
      { key: "t_input_power", label: "⚡ Supply verified (AC/DC as applicable)" },
      { key: "t_power_cycle", label: "🔁 Power cycle performed (with discharge wait)" },
      { key: "t_fw_check", label: "🧠 Firmware / versions checked" },
      { key: "t_logs", label: "🗂️ Alarms/logs reviewed + timestamps captured" },
    ],
  },
};

const REPORT_FAULT_ADDONS = {
  // Kempower merged power module tree
  kempower_power_module_cluster: [
    { key: "kpm_reseat", label: "🔌 Reseated PMCs / checked connectors fully latched" },
    { key: "kpm_swap_slots", label: "🧩 Swapped slots/modules to see if fault follows" },
    { key: "kpm_cb_fuse", label: "⚡ Checked CB/fuses and upstream supply stability" },
    { key: "kpm_burnt_wiring", label: "🔥 Checked for burnt wiring / heat damage in rack" },
    { key: "kpm_config", label: "⚙️ Config checked (PMC/DPDM detected correctly)" },
  ],
};

// ---------- SMART DEDUPE (FIX OVERLAPPING ITEMS) ----------
function stripEmojiAndNormalize(s) {
  return String(s || "")
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, "")
    .replace(/[\u{2600}-\u{26FF}]/gu, "")
    .replace(/[\u{2700}-\u{27BF}]/gu, "")
    .replace(/\uFE0F/gu, "")
    .replace(/\u200D/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Map different wordings to the same "meaning bucket"
function actionSignature(label) {
  const t = stripEmojiAndNormalize(label);

  if (/(loto|isolation|lock\s*out|tag\s*out)/i.test(t)) return "loto";
  if (/(visual|inspection|burn|water ingress|loose lug|heat mark)/i.test(t)) return "visual";
  if (/(input power|3φ|3 phase|three phase|voltage|rotation|phase sequence|supply)/i.test(t))
    return "input_power";
  if (/(power cycle|reboot|restart)/i.test(t)) return "power_cycle";
  if (/(firmware|version|update)/i.test(t)) return "firmware";
  if (/(logs|alarms|timestamps|event log)/i.test(t)) return "logs";
  if (/(comms|ocpp|lte|ethernet|sim|apn|network)/i.test(t)) return "comms";

  return t;
}

function dedupeActionLabelsSmart(labels) {
  const out = [];
  const seen = new Set();
  for (const raw of labels || []) {
    const s = String(raw || "").trim();
    if (!s) continue;
    const sig = actionSignature(s);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(s);
  }
  return out;
}

function getManufacturerChecklistLabels(manufacturer) {
  const mf = String(manufacturer || "").toLowerCase();
  const base = REPORT_CHECKLIST[mf]?.base || [];
  return base.map((x) => x.label);
}

function getFaultAddonLabels(faultId) {
  const fid = String(faultId || "").trim();
  const addons = fid ? REPORT_FAULT_ADDONS[fid] || [] : [];
  return addons.map((x) => x.label);
}

/**
 * Build the actionOptions list used by the report wizard.
 */
function buildReportActionOptions({ manufacturer, faultId, yamlActions }) {
  const mfBase = getManufacturerChecklistLabels(manufacturer);
  const faultAdd = getFaultAddonLabels(faultId);
  const y = Array.isArray(yamlActions) ? yamlActions : [];
  return dedupeActionLabelsSmart([...mfBase, ...faultAdd, ...y]);
}

/* =========================
   STATE
   ========================= */
const reportState = new Map();

/**
 * ✅ Decision Tree state (SAFE: no long callback_data)
 * chatId -> { pack, faultId, history: [nodeId...], messageId }
 */
const dtState = new Map();

function resetDt(chatId) {
  dtState.delete(chatId);
}

function setDt(chatId, patch) {
  const cur = dtState.get(chatId) || { pack: "", faultId: "", history: [], messageId: null };
  const next = { ...cur, ...patch };
  if (!Array.isArray(next.history)) next.history = [];
  dtState.set(chatId, next);
  return next;
}

function getDt(chatId) {
  return dtState.get(chatId) || null;
}

function pushDtHistory(chatId, nodeId) {
  const cur = getDt(chatId);
  if (!cur) return;
  const hist = Array.isArray(cur.history) ? cur.history : [];
  const last = hist[hist.length - 1];
  if (String(last) !== String(nodeId)) hist.push(String(nodeId));
  setDt(chatId, { history: hist });
}

function popDtHistory(chatId) {
  const cur = getDt(chatId);
  if (!cur) return null;
  const hist = Array.isArray(cur.history) ? [...cur.history] : [];
  if (hist.length <= 1) return null;
  hist.pop();
  const prev = hist[hist.length - 1] || null;
  setDt(chatId, { history: hist });
  return prev;
}

/* =========================
   YAML DECISION TREE SUPPORT
   ========================= */

/**
 * ✅ Single source of truth for mapping pack -> loader.
 */
function loadPackByName(pack) {
  const p = String(pack || "").toLowerCase();
  if (p === "general_dc") return loadGeneralDc();
  if (p === "kempower") return loadKempower();
  if (p === "tritium") return loadTritium();
  return loadAutel();
}

function getFaultById(pack, id) {
  const data = loadPackByName(pack);
  return (data.faults || []).find((x) => String(x.id) === String(id));
}

/* =========================
   REPORT TEMPLATE HELPERS
   ========================= */
function normalizeStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x || "").trim()).filter(Boolean);
}

function getReportTemplateFromFault(fault) {
  const rt = fault?.report_template || {};
  const actions = normalizeStringArray(rt.actions);
  const parts_used = normalizeStringArray(rt.parts_used);
  const verification = normalizeStringArray(rt.verification);
  const summary = String(rt.summary || "").trim();

  return { summary, actions, parts_used, verification };
}

function defaultReportTemplate() {
  return { summary: "", actions: [], parts_used: [], verification: [] };
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

/**
 * ✅ standardize menu callbacks so we never collide with fault-card callbacks.
 */
function packMenuCallback(pack) {
  if (pack === "general_dc") return "general_dc:menu";
  if (pack === "kempower") return "kempower:menu";
  if (pack === "tritium") return "tritium:menu";
  return "autel:menu";
}

async function showFaultCard({ chatId, messageId, pack, fault }) {
  // Save which fault is currently "open" for DT (safe, no long callback_data)
  setDt(chatId, {
    pack,
    faultId: String(fault?.id || ""),
    history: [],
    messageId: messageId || null,
  });

  const rows = [];

  // Start DT (if present)
  if (fault?.decision_tree?.start_node && fault?.decision_tree?.nodes) {
    rows.push([{ text: "🧭 Start troubleshooting", callback_data: "dt:start" }]);
  }

  // Report from this fault (autofill)
  rows.push([{ text: "🧾 Create report for this fault", callback_data: reportFromFaultCallback(pack, fault.id) }]);

  // Back to menu
  rows.push([{ text: "⬅️ Back", callback_data: packMenuCallback(pack) }]);

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
  if (!imageKey) return "";

  const key = String(imageKey).trim().replace(/^\/+/, "");
  const relBase = key.replace(/^\/*/, "");

  const hasExt = /\.[a-z0-9]+$/i.test(relBase);
  const candidates = hasExt ? [relBase] : [`${relBase}.png`, `${relBase}.jpg`, `${relBase}.jpeg`, `${relBase}.webp`];

  for (const rel of candidates) {
    const localPath = path.join(IMAGES_DIR, rel);
    if (fs.existsSync(localPath)) {
      return PUBLIC_URL ? `${PUBLIC_URL}/images/${rel}` : "";
    }
  }

  return PUBLIC_URL ? `${PUBLIC_URL}/images/${candidates[0]}` : "";
}

/**
 * ✅ Renders current node based on dtState.
 * Buttons are SAFE:
 * - dt:o:<index>
 * - dt:bk
 * - dt:mn
 */
async function renderYamlDecisionNode({ chatId, messageId, pack, fault, nodeId }) {
  const tree = fault?.decision_tree;
  const node = tree?.nodes?.[nodeId];

  // menu-jump nodes if referenced in YAML
  if (nodeId === "__MENU_GENERAL_DC__") return showGeneralDcMenu(chatId, messageId);
  if (nodeId === "__MENU_KEMPOWER__") return showKempowerMenu(chatId, messageId);
  if (nodeId === "__MENU_AUTEL__") return showAutelMenu(chatId, messageId);
  if (nodeId === "__MENU_TRITIUM__") return showTritiumMenu(chatId, messageId);

  if (!node) {
    return upsertMessage(chatId, {
      messageId,
      text: `⚠️ Decision node not found: ${nodeId}`,
      parse_mode: "Markdown",
      reply_markup: kb([[{ text: "⬅️ Back", callback_data: packMenuCallback(pack) }]]),
    });
  }

  // Persist DT state (so option clicks can route safely)
  setDt(chatId, { pack, faultId: String(fault.id), messageId: messageId || null });
  pushDtHistory(chatId, nodeId);

  const text = node.prompt || "…";

  const rows = [];
  const opts = Array.isArray(node.options) ? node.options : [];
  opts.forEach((opt, idx) => {
    rows.push([{ text: opt.label || opt.text || "Next", callback_data: `dt:o:${idx}` }]);
  });

  rows.push([{ text: "🧾 Create report for this fault", callback_data: reportFromFaultCallback(pack, fault.id) }]);
  rows.push([{ text: "⬅️ Back", callback_data: "dt:bk" }]);

  const menuLabel = pack === "general_dc" ? "🏠 General DC menu" : `🏠 ${cap(pack)} menu`;
  rows.push([{ text: menuLabel, callback_data: "dt:mn" }]);

  const imageUrl = node.image ? imageKeyToUrl(node.image) : "";

  if (node.image && !imageUrl) {
    return upsertMessage(chatId, {
      messageId,
      text: `${text}\n\n⚠️ (Image available, but PUBLIC_URL is blank so Telegram can’t fetch it in this mode.)`,
      parse_mode: "Markdown",
      reply_markup: kb(rows),
    });
  }

  return upsertPhotoOrText(chatId, {
    messageId,
    text,
    parse_mode: "Markdown",
    reply_markup: kb(rows),
    imageUrl: imageUrl || "",
  });
}

/* =========================
   /report WIZARD
   ========================= */
function setReport(chatId, patch) {
  const cur =
    reportState.get(chatId) || {
      step: "site",
      data: {
        actionOptions: [],
        actions: [],

        manufacturer: "",
        faultId: "",
        faultTitle: "",
        faultSummary: "",
        prefilled: false,

        site: "",
        chargerIdPublic: "", // public / billing services number
        chargerSerialNumber: "", // OEM S/N
        assetId: "", // internal asset id (optional)
        technician: "",
        clientRef: "",

        photos: [],
        notes: "",
        resolution: "",
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
  const site = escapeHtml(stripEmojisForFinal(data.site || ""));
  const chargerIdPublic = escapeHtml(stripEmojisForFinal(data.chargerIdPublic || ""));
  const chargerSerialNumber = escapeHtml(stripEmojisForFinal(data.chargerSerialNumber || ""));
  const assetId = escapeHtml(stripEmojisForFinal(data.assetId || ""));
  const technician = escapeHtml(stripEmojisForFinal(data.technician || ""));
  const clientRef = escapeHtml(stripEmojisForFinal(data.clientRef || ""));

  const manufacturer = escapeHtml(stripEmojisForFinal((data.manufacturer || "").toUpperCase()));
  const faultTitle = escapeHtml(stripEmojisForFinal(data.faultTitle || ""));
  const faultSummary = escapeHtml(stripEmojisForFinal(data.faultSummary || ""));
  const resolution = escapeHtml(stripEmojisForFinal(data.resolution || ""));
  const notes = escapeHtml(stripEmojisForFinal(data.notes || ""));

  const actions = Array.isArray(data.actions) ? data.actions : [];
  const cleanActions = actions.map((a) => stripEmojisForFinal(a)).filter(Boolean);
  const actionsLines = cleanActions.length
    ? cleanActions.map((a) => `• ${escapeHtml(a)}`).join("\n")
    : "• (none recorded)";

  const photos = Array.isArray(data.photos) ? data.photos : [];
  const attachmentsLine = photos.length ? `• Photos uploaded (${photos.length})` : "• None";

  return (
    `🧾 <b>EVBot Service Report</b>\n\n` +
    `<b>Site:</b> ${site}\n` +
    `<b>Charger ID (public / billing):</b> ${chargerIdPublic}\n` +
    `<b>Charger Serial Number (S/N):</b> ${chargerSerialNumber}\n` +
    (assetId ? `<b>Asset ID (internal):</b> ${assetId}\n` : "") +
    `<b>Technician:</b> ${technician}\n` +
    `<b>Client reference / ticket #:</b> ${clientRef}\n` +
    (manufacturer ? `<b>Manufacturer:</b> ${manufacturer}\n` : "") +
    `<b>Fault:</b> ${faultTitle}\n` +
    (faultSummary ? `<b>Fault summary:</b> ${faultSummary}\n` : "") +
    `\n<b>Actions Taken:</b>\n${actionsLines}\n\n` +
    `<b>Status / Outcome:</b> ${resolution}\n` +
    `<b>Attachments:</b>\n${attachmentsLine}\n` +
    (notes ? `\n<b>Notes:</b>\n${notes}\n` : "")
  );
}

async function startReport(chatId) {
  setReport(chatId, {
    step: "site",
    data: {
      actionOptions: [],
      actions: [],
      manufacturer: "",
      faultId: "",
      faultTitle: "",
      faultSummary: "",
      prefilled: false,

      site: "",
      chargerIdPublic: "",
      chargerSerialNumber: "",
      assetId: "",
      technician: "",
      clientRef: "",

      photos: [],
      notes: "",
      resolution: "",
    },
  });

  return bot.sendMessage(chatId, "🧾 <b>Report Builder</b>\n\nWhat is the <b>site name</b>?\n\n(Reply with text)", {
    parse_mode: "HTML",
  });
}

// Start report with manufacturer+fault prefilled + manufacturer+fault checklist
async function startReportFromFault(chatId, pack, fault) {
  const t = getReportTemplateFromFault(fault) || defaultReportTemplate();

  const actionOptionsBuilt = buildReportActionOptions({
    manufacturer: pack,
    faultId: String(fault?.id || ""),
    yamlActions: normalizeStringArray(t.actions),
  });

  setReport(chatId, {
    step: "site",
    data: {
      actionOptions: actionOptionsBuilt,
      actions: [],
      manufacturer: pack,
      faultId: String(fault?.id || ""),
      faultTitle: fault?.title || "",
      faultSummary: String(t.summary || "").trim(),
      prefilled: true,

      site: "",
      chargerIdPublic: "",
      chargerSerialNumber: "",
      assetId: "",
      technician: "",
      clientRef: "",

      photos: [],
      notes: "",
      resolution: "",
    },
  });

  const packLabel = pack === "general_dc" ? "General DC" : cap(pack);

  return bot.sendMessage(
    chatId,
    `🧾 <b>Report Builder</b>\n\nPrefilled:\n<b>Manufacturer:</b> ${escapeHtml(
      packLabel
    )}\n<b>Fault:</b> ${escapeHtml(fault?.title || "")}\n\nWhat is the <b>site name</b>?\n\n(Reply with text)`,
    { parse_mode: "HTML" }
  );
}

async function askChargerIdPublic(chatId) {
  setReport(chatId, { step: "chargerIdPublic" });
  return bot.sendMessage(chatId, "What is the <b>Charger ID</b> (public / billing services number)?\n\n(Reply with text)", {
    parse_mode: "HTML",
  });
}

async function askChargerSerialNumber(chatId) {
  setReport(chatId, { step: "chargerSerialNumber" });
  return bot.sendMessage(chatId, "What is the <b>Charger Serial Number</b> (S/N)?\n\n(Reply with text)", {
    parse_mode: "HTML",
  });
}

async function askAssetId(chatId) {
  setReport(chatId, { step: "assetId" });
  return bot.sendMessage(chatId, "What is the <b>asset ID</b> (internal, optional)?\n\n(Reply with text or type N/A)", {
    parse_mode: "HTML",
  });
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
    [{ text: "🧰 General DC", callback_data: "r:mfr:general_dc" }],
    [{ text: "🔵 Autel", callback_data: "r:mfr:autel" }],
    [{ text: "🟢 Kempower", callback_data: "r:mfr:kempower" }],
    [{ text: "🔺 Tritium", callback_data: "r:mfr:tritium" }],
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
  const pack = String(st?.data?.manufacturer || "general_dc").toLowerCase();

  const data = loadPackByName(pack);
  const faults = data.faults || [];

  const rows = [];

  if (!faults.length) {
    rows.push([
      {
        text: `⚠️ No ${pack === "general_dc" ? "General DC" : cap(pack)} faults loaded (check /debug/${pack})`,
        callback_data: "noop",
      },
    ]);
  } else {
    const prefix = pack.toUpperCase(); // GENERAL_DC / AUTEL / KEMPOWER / TRITIUM
    faults.forEach((f) => {
      rows.push([{ text: f.title, callback_data: `r:fault:${prefix}:${f.id}` }]);
    });
  }

  rows.push([{ text: "⬅️ Back", callback_data: "r:back:mfr" }]);
  rows.push([{ text: "Cancel", callback_data: "r:cancel" }]);

  const packLabel = pack === "general_dc" ? "General DC fault" : `${escapeHtml(cap(pack))} fault`;
  return bot.sendMessage(chatId, `Select the <b>${packLabel}</b>:`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
}

// Fallback generic checklist options
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

function buildActionsKeyboard(actionOptions, selected = []) {
  const opts = Array.isArray(actionOptions) && actionOptions.length ? actionOptions : REPORT_ACTION_OPTIONS;

  const rows = opts.map((label, idx) => {
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
  const actionOptions = st?.data?.actionOptions || [];

  const title = st?.data?.faultTitle ? `\n\n<b>Fault:</b> ${escapeHtml(st.data.faultTitle)}` : "";
  const mfr =
    st?.data?.manufacturer
      ? `\n<b>Manufacturer:</b> ${escapeHtml(st.data.manufacturer === "general_dc" ? "General DC" : cap(st.data.manufacturer))}`
      : "";

  return bot.sendMessage(chatId, `Select <b>actions performed</b>:${mfr}${title}`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildActionsKeyboard(actionOptions, selected) },
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

/* =========================
   MENUS
   ========================= */

function showManufacturerMenu(chatId, messageId) {
  resetDt(chatId);

  // ✅ GENERAL DC MUST BE AT THE TOP
  const rows = [
    [{ text: "🧰 General DC (All Brands)", callback_data: "mfr:general_dc" }],
    [{ text: "🔵 Autel", callback_data: "mfr:autel" }],
    [{ text: "🟢 Kempower", callback_data: "mfr:kempower" }],
    [{ text: "🔺 Tritium", callback_data: "mfr:tritium" }],
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

function buildPackMenuKeyboard(pack) {
  const data = loadPackByName(pack);
  const faults = data.faults || [];

  const rows = [];

  if (!faults.length) {
    rows.push([
      {
        text: `⚠️ No ${pack === "general_dc" ? "General DC" : cap(pack)} faults loaded (check /debug/${pack})`,
        callback_data: "noop",
      },
    ]);
  } else {
    const prefix = pack.toUpperCase(); // GENERAL_DC / AUTEL / KEMPOWER / TRITIUM
    faults.forEach((f) => rows.push([{ text: f.title, callback_data: `${prefix}:${f.id}` }]));
  }

  rows.push([{ text: "🧾 Build a report (/report)", callback_data: "r:new" }]);
  rows.push([{ text: "⬅️ Back to Manufacturer", callback_data: "menu:mfr" }]);
  rows.push([{ text: "🔁 Reset", callback_data: "reset" }]);

  return rows;
}

/**
 * ✅ General DC quick-picks (fast menu)
 * These IDs match the YAML we created.
 */
function buildGeneralDcQuickKeyboard() {
  return [
    [{ text: "🟥 Will Not Power On", callback_data: "GENERAL_DC:general_dc_will_not_power_on" }],
    [{ text: "🟧 Won’t Start Charge", callback_data: "GENERAL_DC:general_dc_powers_on_wont_start_charge" }],
    [{ text: "🟨 Offline / Comms", callback_data: "GENERAL_DC:general_dc_offline_backend_comms" }],
    [{ text: "🟦 Handshake Failure", callback_data: "GENERAL_DC:general_dc_vehicle_handshake_failure" }],
    [{ text: "🟪 Insulation / Earth Fault", callback_data: "GENERAL_DC:general_dc_insulation_earth_fault" }],
    [{ text: "🟫 Overtemp / Cooling", callback_data: "GENERAL_DC:general_dc_overtemp_cooling_fault" }],
    [{ text: "⬛ E-Stop / Interlock", callback_data: "GENERAL_DC:general_dc_estop_interlock_active" }],
    [{ text: "🟠 Low Power / Derating", callback_data: "GENERAL_DC:general_dc_power_derating_low_power" }],
    [{ text: "🖥️ HMI Frozen", callback_data: "GENERAL_DC:general_dc_hmi_frozen_unresponsive" }],

    [{ text: "📋 View all General DC faults", callback_data: "general_dc:all" }],
    [{ text: "🧾 Build a report (/report)", callback_data: "r:new" }],
    [{ text: "⬅️ Back to Manufacturer", callback_data: "menu:mfr" }],
    [{ text: "🔁 Reset", callback_data: "reset" }],
  ];
}

async function showGeneralDcMenu(chatId, messageId) {
  resetDt(chatId);

  return upsertMessage(chatId, {
    messageId,
    text: "🧰 <b>General DC (All Brands)</b>\n\nSelect the issue category:",
    parse_mode: "HTML",
    reply_markup: kb(buildGeneralDcQuickKeyboard()),
  });
}

async function showGeneralDcAllMenu(chatId, messageId) {
  return upsertMessage(chatId, {
    messageId,
    text: "🧰 <b>General DC (All Brands)</b>\n\nChoose a General DC fault:",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildPackMenuKeyboard("general_dc") },
  });
}

async function showAutelMenu(chatId, messageId) {
  return upsertMessage(chatId, {
    messageId,
    text: "Autel Troubleshooting 📋\n\nChoose an Autel fault:",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildPackMenuKeyboard("autel") },
  });
}

async function showKempowerMenu(chatId, messageId) {
  return upsertMessage(chatId, {
    messageId,
    text: "Kempower Troubleshooting 🟢\n\nChoose a Kempower fault:",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildPackMenuKeyboard("kempower") },
  });
}

async function showTritiumMenu(chatId, messageId) {
  return upsertMessage(chatId, {
    messageId,
    text: "Tritium Troubleshooting 🔺\n\nChoose a Tritium fault:",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildPackMenuKeyboard("tritium") },
  });
}

/* =========================
   COMMANDS
   ========================= */
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

bot.onText(/^\/general_dc$/, async (msg) => {
  resetDt(msg.chat.id);
  await showGeneralDcMenu(msg.chat.id);
});

bot.onText(/^\/autel$/, async (msg) => {
  resetDt(msg.chat.id);
  await showAutelMenu(msg.chat.id);
});

bot.onText(/^\/kempower$/, async (msg) => {
  resetDt(msg.chat.id);
  await showKempowerMenu(msg.chat.id);
});

bot.onText(/^\/tritium$/, async (msg) => {
  resetDt(msg.chat.id);
  await showTritiumMenu(msg.chat.id);
});

bot.onText(/^\/report$/, async (msg) => {
  await startReport(msg.chat.id);
});

bot.onText(/^\/cancel$/, async (msg) => {
  clearReport(msg.chat.id);
  resetDt(msg.chat.id);
  await bot.sendMessage(msg.chat.id, "✅ Cancelled.");
});

/* =========================
   REPORT TEXT CAPTURE
   ========================= */
// Capture text replies during report wizard
bot.on("message", async (msg) => {
  const chatId = msg?.chat?.id;
  const text = (msg?.text || "").trim();
  if (!chatId) return;

  // photo handler handles photos
  if (!text) return;

  // ignore commands
  if (text.startsWith("/")) return;

  const st = reportState.get(chatId);
  if (!st) return;

  if (st.step === "site") {
    setReport(chatId, { data: { site: text } });
    return askChargerIdPublic(chatId);
  }

  if (st.step === "chargerIdPublic") {
    setReport(chatId, { data: { chargerIdPublic: text } });
    return askChargerSerialNumber(chatId);
  }

  if (st.step === "chargerSerialNumber") {
    setReport(chatId, { data: { chargerSerialNumber: text } });
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

    // If report started from a fault card, skip manufacturer/fault selection
    if (st.data?.prefilled) return askActions(chatId);

    return askReportManufacturer(chatId);
  }

  if (st.step === "notes") {
    setReport(chatId, { data: { notes: text } });
    return finishReport(chatId);
  }
});

/* =========================
   PHOTO CAPTURE (Report)
   ========================= */
// Capture photo uploads during the photo step (silent)
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

  return bot.sendMessage(chatId, "📸 Photo added. Upload more, or tap Done.");
});

/* =========================
   SINGLE CALLBACK HANDLER
   ========================= */
bot.on("callback_query", async (q) => {
  const chatId = q?.message?.chat?.id;
  const messageId = q?.message?.message_id;
  const data = q?.data || "";

  // Always answer callback to stop spinner (and keep Telegram happy)
  try {
    await bot.answerCallbackQuery(q.id, { text: "✅", show_alert: false });
  } catch (_) {}

  // Keep your small per-chat debounce (helps double-taps), but NO time-limit cut-off.
  global.__EVBOT_CB_RL = global.__EVBOT_CB_RL || new Map();
  const now = Date.now();
  const last = chatId ? global.__EVBOT_CB_RL.get(chatId) || 0 : 0;
  if (chatId && now - last < 250) return;
  if (chatId) global.__EVBOT_CB_RL.set(chatId, now);

  if (!chatId) return;
  if (data === "noop") return;

  /* --------- GLOBAL NAV --------- */
  if (data === "reset") {
    clearReport(chatId);
    resetDt(chatId);
    return showManufacturerMenu(chatId, messageId);
  }

  if (data === "menu:mfr") {
    clearReport(chatId);
    resetDt(chatId);
    return showManufacturerMenu(chatId, messageId);
  }

  if (data === "general_dc:all") {
    clearReport(chatId);
    resetDt(chatId);
    return showGeneralDcAllMenu(chatId, messageId);
  }

  if (data.startsWith("mfr:")) {
    const mfr = data.split(":")[1];
    if (mfr === "general_dc") return showGeneralDcMenu(chatId, messageId);
    if (mfr === "autel") return showAutelMenu(chatId, messageId);
    if (mfr === "kempower") return showKempowerMenu(chatId, messageId);
    if (mfr === "tritium") return showTritiumMenu(chatId, messageId);
    return showManufacturerMenu(chatId, messageId);
  }

  // "<pack>:menu"
  if (data.endsWith(":menu")) {
    const pack = data.split(":")[0].toLowerCase();
    resetDt(chatId);
    if (pack === "general_dc") return showGeneralDcMenu(chatId, messageId);
    if (pack === "kempower") return showKempowerMenu(chatId, messageId);
    if (pack === "tritium") return showTritiumMenu(chatId, messageId);
    return showAutelMenu(chatId, messageId);
  }

  /* --------- REPORT FROM FAULT CARD --------- */
  if (data.startsWith("RF|")) {
    const [, pack, faultId] = data.split("|");
    const fault = getFaultById(pack, faultId);
    if (!fault) return bot.sendMessage(chatId, "⚠️ Could not start report: fault not found.");
    clearReport(chatId);
    return startReportFromFault(chatId, pack, fault);
  }

  /* =========================
     ✅ DECISION TREE (SAFE)
     ========================= */

  // Start decision tree from fault card
  if (data === "dt:start") {
    const st = getDt(chatId);
    if (!st?.pack || !st?.faultId) {
      return bot.sendMessage(chatId, "⚠️ No active fault selected. Go back and open a fault first.");
    }
    const fault = getFaultById(st.pack, st.faultId);
    if (!fault?.decision_tree?.start_node) {
      return bot.sendMessage(chatId, "⚠️ This fault has no decision tree.");
    }
    // reset history and render start node
    setDt(chatId, { history: [] });
    return renderYamlDecisionNode({
      chatId,
      messageId,
      pack: st.pack,
      fault,
      nodeId: fault.decision_tree.start_node,
    });
  }

  // Decision tree option click: dt:o:<index>
  if (data.startsWith("dt:o:")) {
    const st = getDt(chatId);
    if (!st?.pack || !st?.faultId) {
      return bot.sendMessage(chatId, "⚠️ No active fault selected. Open a fault first.");
    }

    const idx = Number(data.split(":")[2]);
    if (Number.isNaN(idx)) return;

    const fault = getFaultById(st.pack, st.faultId);
    const tree = fault?.decision_tree;
    if (!tree?.nodes || !tree?.start_node) return;

    // current node is last in history, or start_node if history empty
    const currentNodeId =
      Array.isArray(st.history) && st.history.length ? st.history[st.history.length - 1] : tree.start_node;

    const node = tree.nodes[currentNodeId];
    const opts = Array.isArray(node?.options) ? node.options : [];
    const opt = opts[idx];
    const nextNodeId = opt?.next;

    if (!nextNodeId) {
      return bot.sendMessage(chatId, "⚠️ Option is missing a next node.");
    }

    return renderYamlDecisionNode({
      chatId,
      messageId,
      pack: st.pack,
      fault,
      nodeId: nextNodeId,
    });
  }

  // Back within decision tree
  if (data === "dt:bk") {
    const st = getDt(chatId);
    if (!st?.pack || !st?.faultId) return;

    const fault = getFaultById(st.pack, st.faultId);
    if (!fault) return showManufacturerMenu(chatId, messageId);

    const prevNode = popDtHistory(chatId);
    if (!prevNode) {
      // back to fault card
      return showFaultCard({ chatId, messageId, pack: st.pack, fault });
    }

    return renderYamlDecisionNode({
      chatId,
      messageId,
      pack: st.pack,
      fault,
      nodeId: prevNode,
    });
  }

  // Menu jump from DT
  if (data === "dt:mn") {
    const st = getDt(chatId);
    if (!st?.pack) return showManufacturerMenu(chatId, messageId);

    resetDt(chatId);

    if (st.pack === "general_dc") return showGeneralDcMenu(chatId, messageId);
    if (st.pack === "kempower") return showKempowerMenu(chatId, messageId);
    if (st.pack === "tritium") return showTritiumMenu(chatId, messageId);
    return showAutelMenu(chatId, messageId);
  }

  /* ------------------- REPORT CALLBACKS ------------------- */
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
    const mfr = data.split(":")[2];

    const actionOptionsBuilt = buildReportActionOptions({
      manufacturer: mfr,
      faultId: "",
      yamlActions: [],
    });

    setReport(chatId, {
      data: {
        manufacturer: mfr,
        faultId: "",
        faultTitle: "",
        faultSummary: "",
        actionOptions: actionOptionsBuilt,
        actions: [],
      },
    });

    return askFault(chatId);
  }

  if (data.startsWith("r:fault:")) {
    const parts = data.split(":");
    const type = parts[2];
    const id = parts[3];

    const pack =
      type === "GENERAL_DC" ? "general_dc" : type === "KEMPOWER" ? "kempower" : type === "TRITIUM" ? "tritium" : "autel";

    const f = getFaultById(pack, id);
    const t = getReportTemplateFromFault(f) || defaultReportTemplate();

    const actionOptionsBuilt = buildReportActionOptions({
      manufacturer: pack,
      faultId: String(id),
      yamlActions: normalizeStringArray(t.actions),
    });

    setReport(chatId, {
      data: {
        manufacturer: pack,
        faultId: String(id),
        faultTitle: f ? f.title : `${pack === "general_dc" ? "General DC" : cap(pack)} Fault (${id})`,
        faultSummary: String(t.summary || "").trim(),
        actionOptions: actionOptionsBuilt,
        actions: [],
      },
    });

    return askActions(chatId);
  }

  if (data.startsWith("r:act:")) {
    const st = reportState.get(chatId);
    if (!st) return;

    if (data === "r:act:done") return askResolution(chatId);

    const idx = Number(data.split(":")[2]);

    const actionOptions =
      Array.isArray(st.data.actionOptions) && st.data.actionOptions.length ? st.data.actionOptions : REPORT_ACTION_OPTIONS;

    if (Number.isNaN(idx) || idx < 0 || idx >= actionOptions.length) return;

    const label = actionOptions[idx];
    const selected = new Set(st.data.actions || []);
    if (selected.has(label)) selected.delete(label);
    else selected.add(label);

    setReport(chatId, { data: { actions: Array.from(selected) } });

    const title = st?.data?.faultTitle ? `\n\n<b>Fault:</b> ${escapeHtml(st.data.faultTitle)}` : "";
    const mfr =
      st?.data?.manufacturer
        ? `\n<b>Manufacturer:</b> ${escapeHtml(
            st.data.manufacturer === "general_dc" ? "General DC" : cap(st.data.manufacturer)
          )}`
        : "";

    return upsertMessage(chatId, {
      messageId,
      text: `Select <b>actions performed</b>:${mfr}${title}`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildActionsKeyboard(actionOptions, Array.from(selected)) },
    });
  }

  if (data.startsWith("r:res:")) {
    const res = data.split(":").slice(2).join(":");
    setReport(chatId, { data: { resolution: res } });
    return askUploadPhotos(chatId);
  }

  if (data === "PHOTOS_SKIP" || data === "PHOTOS_DONE") {
    return askNotes(chatId);
  }

  if (data === "r:notes:skip") {
    setReport(chatId, { data: { notes: "" } });
    return finishReport(chatId);
  }

  /* ------------------- FAULT SELECTION (STRICT PACK ROUTING) ------------------- */
  if (data.startsWith("GENERAL_DC:")) {
    const id = data.split(":")[1];
    const fault = getFaultById("general_dc", id);
    if (!fault) {
      resetDt(chatId);
      return upsertMessage(chatId, {
        messageId,
        text: "Fault not found.",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "general_dc:menu" }]] },
      });
    }
    return showFaultCard({ chatId, messageId, pack: "general_dc", fault });
  }

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

  if (data.startsWith("TRITIUM:")) {
    const id = data.split(":")[1];
    const fault = getFaultById("tritium", id);
    if (!fault) {
      resetDt(chatId);
      return upsertMessage(chatId, {
        messageId,
        text: "Fault not found.",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "tritium:menu" }]] },
      });
    }
    return showFaultCard({ chatId, messageId, pack: "tritium", fault });
  }

  // Unknown callback: do nothing (safe)
});

/* =========================
   WEBHOOK ROUTE (Railway)
   ========================= */
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

/* =========================
   START SERVER + WEBHOOK SETUP
   ========================= */
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
