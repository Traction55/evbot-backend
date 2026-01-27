/**
 * EVBot backend (Express + YAML fault library + Telegram bot)
 * - Works locally (polling) and on Railway (webhook)
 * - Manufacturer menu first (General DC + Autel + Kempower + Tritium)
 * - Fault packs loaded from ../faults/*.yml
 * - YAML decision_tree supported with SAFE callback_data (dt:start / dt:o:<idx> / dt:bk / dt:mn)
 * - /report builds a client-ready service report
 *
 * ✅ UX + ROUTING FIX (Jan 2026):
 * - Standardize callbacks for ALL packs:
 *    - Menus:         <pack>:menu
 *    - All faults:    <pack>:all
 *    - Fault select:  <pack>:fault:<id>
 * - Backwards compatible: still accepts legacy "AUTEL:<id>", "KEMPOWER:<id>", "TRITIUM:<id>", "GENERAL_DC:<id>"
 *
 * ✅ FIX: “No active fault selected” after tapping menus/reset
 * - Adds per-message DT state cache:
 *    dtState = per chat (normal flow)
 *    dtMsgState = per message (old buttons still work)
 *
 * ✅ FIX: YAML ROUTES working
 * - Supports __ROUTE_GENERAL_DC_OFFLINE__ and __ROUTE_GENERAL_DC_OVERTEMP__ targets in YAML
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

function logEvent(event, data = {}) {
  console.log(JSON.stringify({ event, ...data, ts: new Date().toISOString() }));
}

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

function normalizePublicUrl(raw) {
  const v = (raw || "").trim();
  if (!v) return "";
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  return `https://${v}`;
}

const PUBLIC_URL = normalizePublicUrl(
  process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? process.env.RAILWAY_PUBLIC_DOMAIN : "")
);

const USE_WEBHOOK = String(process.env.USE_WEBHOOK || "").toLowerCase() === "true";
const WEBHOOK_PATH = "/telegram";
const WEBHOOK_URL = PUBLIC_URL ? `${PUBLIC_URL}${WEBHOOK_PATH}` : "";
const useWebhook = USE_WEBHOOK && !!WEBHOOK_URL;

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
const GENERAL_DC_FILE = path.join(FAULTS_DIR, "general_dc.yml");

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
  const faults = Array.isArray(obj) ? obj : Array.isArray(obj?.faults) ? obj.faults : [];
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

// Boot logs
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

// Static images: /images/... -> ../assets/images/...
const IMAGES_DIR = path.join(__dirname, "..", "assets", "images");
app.use("/images", express.static(IMAGES_DIR));

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
    ids: data.faults.map((f) => f.id).slice(0, 50),
    titles: data.faults.map((f) => f.title).slice(0, 50),
  });
});
app.get("/debug/autel", (req, res) => {
  const data = loadAutel();
  res.json({
    file: AUTEL_FILE,
    exists: fs.existsSync(AUTEL_FILE),
    count: data.faults.length,
    ids: data.faults.map((f) => f.id).slice(0, 50),
    titles: data.faults.map((f) => f.title).slice(0, 50),
  });
});
app.get("/debug/kempower", (req, res) => {
  const data = loadKempower();
  res.json({
    file: KEMPOWER_FILE,
    exists: fs.existsSync(KEMPOWER_FILE),
    count: data.faults.length,
    ids: data.faults.map((f) => f.id).slice(0, 50),
    titles: data.faults.map((f) => f.title).slice(0, 50),
  });
});
app.get("/debug/tritium", (req, res) => {
  const data = loadTritium();
  res.json({
    file: TRITIUM_FILE,
    exists: fs.existsSync(TRITIUM_FILE),
    count: data.faults.length,
    ids: data.faults.map((f) => f.id).slice(0, 50),
    titles: data.faults.map((f) => f.title).slice(0, 50),
  });
});

// Optional: verify image file exists via API
app.get("/debug/images", (req, res) => {
  const rel = String(req.query.path || "");
  const full = path.join(IMAGES_DIR, rel);
  res.json({ query: rel, full, exists: rel ? fs.existsSync(full) : null });
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
async function upsertMessage(chatId, opts) {
  const { text, parse_mode, reply_markup, messageId } = opts;
  if (messageId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode, reply_markup });
    } catch (e) {
      if (!isIgnorableTelegramEditError(e)) console.error("❌ editMessageText failed:", e?.message || e);
    }
  }
  return bot.sendMessage(chatId, text, { parse_mode, reply_markup });
}

// NOTE: kept simple here—images can be sent via decision nodes if you extend to sendPhoto.
// For now: always text (consistent and reliable).
async function upsertPhotoOrText(chatId, opts) {
  const { messageId, text, parse_mode, reply_markup } = opts;
  return upsertMessage(chatId, { messageId, text, parse_mode, reply_markup });
}

/* =========================
   STATE
   ========================= */
const reportState = new Map();

/**
 * Decision Tree state (SAFE callback_data)
 * chatId -> { pack, faultId, history: [nodeId...], messageId }
 */
const dtState = new Map();

/**
 * ✅ DT state bound to the message that created the buttons
 * Fixes: old dt:o:* presses after user taps menus/reset
 * key = `${chatId}:${messageId}` -> { pack, faultId, history }
 */
const dtMsgState = new Map();
function dtMsgKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}
function setDtForMessage(chatId, messageId, patch) {
  if (!chatId || !messageId) return null;
  const key = dtMsgKey(chatId, messageId);
  const cur = dtMsgState.get(key) || { pack: "", faultId: "", history: [] };
  const next = { ...cur, ...patch };
  if (!Array.isArray(next.history)) next.history = [];
  dtMsgState.set(key, next);
  return next;
}
function getDtFromMessage(chatId, messageId) {
  if (!chatId || !messageId) return null;
  return dtMsgState.get(dtMsgKey(chatId, messageId)) || null;
}

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
   PACK HELPERS
   ========================= */
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

// Standardized callbacks
function cbPackMenu(pack) {
  return `${pack}:menu`;
}
function cbPackAll(pack) {
  return `${pack}:all`;
}
function cbFault(pack, id) {
  return `${pack}:fault:${id}`;
}
function cbReportFromFault(pack, faultId) {
  return `RF|${pack}|${faultId}`;
}

/* =========================
   LEGACY RENDER (fallback)
   ========================= */
function buildLegacyFaultHtml(f) {
  const lines = [];
  lines.push(`🧰 <b>${escapeHtml(f.title || "Fault")}</b>`);
  if (f.description) lines.push(`\n${escapeHtml(String(f.description))}`);
  lines.push("\n");
  return lines.join("\n");
}

/* =========================
   FAULT CARD
   ========================= */
async function showFaultCard({ chatId, messageId, pack, fault }) {
  setDt(chatId, { pack, faultId: String(fault?.id || ""), history: [], messageId: messageId || null });

  // ✅ also bind DT state to this messageId so old buttons remain valid
  if (messageId) {
    setDtForMessage(chatId, messageId, {
      pack,
      faultId: String(fault?.id || ""),
      history: [],
    });
  }

  const rows = [];

  if (fault?.decision_tree?.start_node && fault?.decision_tree?.nodes) {
    rows.push([{ text: "🧭 Start troubleshooting", callback_data: "dt:start" }]);
  }

  rows.push([{ text: "🧾 Create report for this fault", callback_data: cbReportFromFault(pack, fault.id) }]);
  rows.push([{ text: "⬅️ Back", callback_data: cbPackMenu(pack) }]);

  // YAML preferred: response.telegram_markdown
  if (fault?.response?.telegram_markdown) {
    return upsertMessage(chatId, {
      messageId,
      text: fault.response.telegram_markdown,
      parse_mode: "Markdown",
      reply_markup: kb(rows),
    });
  }

  // Fallback legacy HTML
  const html = buildLegacyFaultHtml(fault);
  return upsertMessage(chatId, {
    messageId,
    text: html,
    parse_mode: "HTML",
    reply_markup: kb(rows),
  });
}

/* =========================
   YAML DECISION TREE
   ========================= */
function imageKeyToUrl(imageKey) {
  if (!imageKey) return "";
  const key = String(imageKey).trim().replace(/^\/+/, "");
  const relBase = key.replace(/^\/*/, "");
  const hasExt = /\.[a-z0-9]+$/i.test(relBase);
  const candidates = hasExt ? [relBase] : [`${relBase}.png`, `${relBase}.jpg`, `${relBase}.jpeg`, `${relBase}.webp`];

  for (const rel of candidates) {
    const localPath = path.join(IMAGES_DIR, rel);
    if (fs.existsSync(localPath)) return PUBLIC_URL ? `${PUBLIC_URL}/images/${rel}` : "";
  }
  return PUBLIC_URL ? `${PUBLIC_URL}/images/${candidates[0]}` : "";
}

async function renderYamlDecisionNode({ chatId, messageId, pack, fault, nodeId }) {
  const tree = fault?.decision_tree;

  // ============================
  // ✅ ROUTE shortcuts (from YAML)
  // ============================
  if (nodeId === "__ROUTE_GENERAL_DC_OFFLINE__") {
    const rf = getFaultById("general_dc", "__ROUTE_GENERAL_DC_OFFLINE__");
    if (!rf?.decision_tree?.start_node) {
      return bot.sendMessage(chatId, "⚠️ Route fault missing: Offline/Comms route.");
    }
    setDt(chatId, { pack: "general_dc", faultId: rf.id, history: [], messageId: messageId || null });
    if (messageId) setDtForMessage(chatId, messageId, { pack: "general_dc", faultId: rf.id, history: [] });
    return renderYamlDecisionNode({
      chatId,
      messageId,
      pack: "general_dc",
      fault: rf,
      nodeId: rf.decision_tree.start_node,
    });
  }

  if (nodeId === "__ROUTE_GENERAL_DC_OVERTEMP__") {
    const rf = getFaultById("general_dc", "__ROUTE_GENERAL_DC_OVERTEMP__");
    if (!rf?.decision_tree?.start_node) {
      return bot.sendMessage(chatId, "⚠️ Route fault missing: Overtemp/Cooling route.");
    }
    setDt(chatId, { pack: "general_dc", faultId: rf.id, history: [], messageId: messageId || null });
    if (messageId) setDtForMessage(chatId, messageId, { pack: "general_dc", faultId: rf.id, history: [] });
    return renderYamlDecisionNode({
      chatId,
      messageId,
      pack: "general_dc",
      fault: rf,
      nodeId: rf.decision_tree.start_node,
    });
  }

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
      reply_markup: kb([[{ text: "⬅️ Back", callback_data: cbPackMenu(pack) }]]),
    });
  }

  setDt(chatId, { pack, faultId: String(fault.id), messageId: messageId || null });
  pushDtHistory(chatId, nodeId);

  // ✅ keep per-message DT state in sync as the user clicks through
  if (messageId) {
    const st = getDt(chatId);
    setDtForMessage(chatId, messageId, {
      pack: st?.pack || pack,
      faultId: st?.faultId || String(fault?.id || ""),
      history: Array.isArray(st?.history) ? st.history : [],
    });
  }

  const text = node.prompt || "…";

  const rows = [];
  const opts = Array.isArray(node.options) ? node.options : [];
  opts.forEach((opt, idx) => {
    rows.push([{ text: opt.label || opt.text || "Next", callback_data: `dt:o:${idx}` }]);
  });

  rows.push([{ text: "🧾 Create report for this fault", callback_data: cbReportFromFault(pack, fault.id) }]);
  rows.push([{ text: "⬅️ Back", callback_data: "dt:bk" }]);
  rows.push([{ text: `🏠 ${pack === "general_dc" ? "General DC" : cap(pack)} menu`, callback_data: "dt:mn" }]);

  // If you want photos, extend upsertPhotoOrText to actually sendPhoto.
  const imageUrl = node.image ? imageKeyToUrl(node.image) : "";
  if (node.image && !imageUrl) {
    return upsertMessage(chatId, {
      messageId,
      text: `${text}\n\n⚠️ (Image referenced, but PUBLIC_URL is blank so Telegram can’t fetch it.)`,
      parse_mode: "Markdown",
      reply_markup: kb(rows),
    });
  }

  return upsertPhotoOrText(chatId, { messageId, text, parse_mode: "Markdown", reply_markup: kb(rows) });
}

/* =========================
   REPORT (minimal stubs kept)
   ========================= */
function setReport(chatId, patch) {
  const cur =
    reportState.get(chatId) || {
      step: "site",
      data: {
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
        actions: [],
        actionOptions: [],
        photos: [],
        notes: "",
        resolution: "",
      },
    };
  const next = { ...cur, ...patch, data: { ...cur.data, ...(patch.data || {}) } };
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
      actions: [],
      actionOptions: [],
      photos: [],
      notes: "",
      resolution: "",
    },
  });

  return bot.sendMessage(chatId, "🧾 <b>Report Builder</b>\n\nWhat is the <b>site name</b>?\n\n(Reply with text)", {
    parse_mode: "HTML",
  });
}

async function startReportFromFault(chatId, pack, fault) {
  setReport(chatId, {
    step: "site",
    data: {
      manufacturer: pack,
      faultId: String(fault?.id || ""),
      faultTitle: fault?.title || "",
      faultSummary: "",
      prefilled: true,
      site: "",
      chargerIdPublic: "",
      chargerSerialNumber: "",
      assetId: "",
      technician: "",
      clientRef: "",
      actions: [],
      actionOptions: [],
      photos: [],
      notes: "",
      resolution: "",
    },
  });

  const packLabel = pack === "general_dc" ? "General DC" : cap(pack);
  return bot.sendMessage(
    chatId,
    `🧾 <b>Report Builder</b>\n\nPrefilled:\n<b>Manufacturer:</b> ${escapeHtml(packLabel)}\n<b>Fault:</b> ${escapeHtml(
      fault?.title || ""
    )}\n\nWhat is the <b>site name</b>?\n\n(Reply with text)`,
    { parse_mode: "HTML" }
  );
}

/* =========================
   MENUS
   ========================= */
function showManufacturerMenu(chatId, messageId) {
  resetDt(chatId);
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
    faults.forEach((f) => rows.push([{ text: f.title, callback_data: cbFault(pack, f.id) }]));
  }

  rows.push([{ text: "🧾 Build a report (/report)", callback_data: "r:new" }]);
  rows.push([{ text: "⬅️ Back to Manufacturer", callback_data: "menu:mfr" }]);
  rows.push([{ text: "🔁 Reset", callback_data: "reset" }]);

  return rows;
}

// General DC quick picks -> MUST match YAML IDs in general_dc.yml
function buildGeneralDcQuickKeyboard() {
  return [
    [{ text: "🟥 Will Not Power On", callback_data: cbFault("general_dc", "general_dc_will_not_power_on") }],
    [{ text: "🟧 Won’t Start Charge", callback_data: cbFault("general_dc", "general_dc_powers_on_wont_start_charge") }],
    [{ text: "🟨 Offline / Comms", callback_data: cbFault("general_dc", "general_dc_offline_backend_comms") }],
    [{ text: "🟦 Handshake Failure", callback_data: cbFault("general_dc", "general_dc_vehicle_handshake_failure") }],
    [{ text: "🟪 Insulation / Earth Fault", callback_data: cbFault("general_dc", "general_dc_insulation_earth_fault") }],
    [{ text: "🟫 Overtemp / Cooling", callback_data: cbFault("general_dc", "general_dc_overtemp_cooling_fault") }],
    [{ text: "⬛ E-Stop / Interlock", callback_data: cbFault("general_dc", "general_dc_estop_interlock_active") }],
    [{ text: "🟠 Low Power / Derating", callback_data: cbFault("general_dc", "general_dc_power_derating_low_power") }],
    [{ text: "🖥️ HMI Frozen", callback_data: cbFault("general_dc", "general_dc_hmi_frozen_unresponsive") }],
    [{ text: "📋 View all General DC faults", callback_data: cbPackAll("general_dc") }],
    [{ text: "🧾 Build a report (/report)", callback_data: "r:new" }],
    [{ text: "⬅️ Back to Manufacturer", callback_data: "menu:mfr" }],
    [{ text: "🔁 Reset", callback_data: "reset" }],
  ];
}

async function showGeneralDcMenu(chatId, messageId) {
  // NOTE: We still reset chat-level DT state, BUT message-level state keeps old buttons working.
  resetDt(chatId);
  return upsertMessage(chatId, {
    messageId,
    text: "🧰 <b>General DC (All Brands)</b>\n\nSelect the issue category:",
    parse_mode: "HTML",
    reply_markup: kb(buildGeneralDcQuickKeyboard()),
  });
}

async function showGeneralDcAllMenu(chatId, messageId) {
  resetDt(chatId);
  return upsertMessage(chatId, {
    messageId,
    text: "🧰 <b>General DC (All Brands)</b>\n\nChoose a General DC fault:",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildPackMenuKeyboard("general_dc") },
  });
}

async function showAutelMenu(chatId, messageId) {
  resetDt(chatId);
  return upsertMessage(chatId, {
    messageId,
    text: "🔵 <b>Autel</b>\n\nChoose an Autel fault:",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildPackMenuKeyboard("autel") },
  });
}

async function showKempowerMenu(chatId, messageId) {
  resetDt(chatId);
  return upsertMessage(chatId, {
    messageId,
    text: "🟢 <b>Kempower</b>\n\nChoose a Kempower fault:",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildPackMenuKeyboard("kempower") },
  });
}

async function showTritiumMenu(chatId, messageId) {
  resetDt(chatId);
  return upsertMessage(chatId, {
    messageId,
    text: "🔺 <b>Tritium</b>\n\nChoose a Tritium fault:",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildPackMenuKeyboard("tritium") },
  });
}

/* =========================
   COMMANDS
   ========================= */
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  logEvent("start", { lang: msg.from?.language_code || "unknown" });

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
   REPORT WIZARD (TEXT CAPTURE)
   ========================= */
function isYes(s) {
  return ["y", "yes", "yeah", "yep"].includes(String(s || "").trim().toLowerCase());
}
function isNo(s) {
  return ["n", "no", "nah", "nope"].includes(String(s || "").trim().toLowerCase());
}

async function promptReportStep(chatId) {
  const st = reportState.get(chatId);
  if (!st) return;

  const step = st.step;
  const d = st.data || {};

  if (step === "site") {
    return bot.sendMessage(chatId, "🧾 <b>Report Builder</b>\n\nWhat is the <b>site name</b>?\n\n(Reply with text)", {
      parse_mode: "HTML",
    });
  }

  if (step === "chargerIdPublic") {
    return bot.sendMessage(chatId, "What is the <b>Charger ID (public / billing)</b>?\n\n(Reply with text)", {
      parse_mode: "HTML",
    });
  }

  if (step === "chargerSerialNumber") {
    return bot.sendMessage(chatId, "What is the <b>Charger Serial Number (S/N)</b>?\n\n(Reply with text)", {
      parse_mode: "HTML",
    });
  }

  if (step === "assetId") {
    return bot.sendMessage(chatId, "Optional: <b>Asset ID (internal)</b>?\n\nReply with text, or type <b>skip</b>.", {
      parse_mode: "HTML",
    });
  }

  if (step === "technician") {
    return bot.sendMessage(chatId, "What is the <b>Technician name</b>?\n\n(Reply with text)", {
      parse_mode: "HTML",
    });
  }

  if (step === "clientRef") {
    return bot.sendMessage(chatId, "What is the <b>Client reference / ticket #</b>?\n\n(Reply with text)", {
      parse_mode: "HTML",
    });
  }

  if (step === "actions") {
    return bot.sendMessage(
      chatId,
      "Enter <b>Actions Taken</b>.\n\n• Send one action per message.\n• When finished, type <b>done</b>.\n• To clear actions, type <b>clear</b>.",
      { parse_mode: "HTML" }
    );
  }

  if (step === "faultSummary") {
    return bot.sendMessage(chatId, "Optional: <b>Fault summary</b>?\n\nReply with text, or type <b>skip</b>.", {
      parse_mode: "HTML",
    });
  }

  if (step === "resolution") {
    return bot.sendMessage(
      chatId,
      "What is the <b>Status / Outcome</b>?\n\nExamples: Resolved ✅ / Temporarily restored / Escalated to OEM / Parts required",
      { parse_mode: "HTML" }
    );
  }

  if (step === "notes") {
    return bot.sendMessage(chatId, "Optional: <b>Notes</b>?\n\nReply with text, or type <b>skip</b>.", {
      parse_mode: "HTML",
    });
  }

  if (step === "confirm") {
    const html = formatReportHtml(d);
    return bot.sendMessage(
      chatId,
      `${html}\n\nReply <b>send</b> to post the final report, or <b>cancel</b>.`,
      { parse_mode: "HTML" }
    );
  }
}

function nextReportStep(cur) {
  const order = [
    "site",
    "chargerIdPublic",
    "chargerSerialNumber",
    "assetId",
    "technician",
    "clientRef",
    "actions",
    "faultSummary",
    "resolution",
    "notes",
    "confirm",
  ];
  const i = order.indexOf(cur);
  return i >= 0 && i < order.length - 1 ? order[i + 1] : "confirm";
}

bot.on("message", async (msg) => {
  const chatId = msg?.chat?.id;
  const text = (msg?.text || "").trim();
  if (!chatId) return;
  if (!text) return;
  if (text.startsWith("/")) return;

  const st = reportState.get(chatId);
  if (!st) return;

  const step = st.step;
  const t = text;

  // Global commands during wizard
  if (t.toLowerCase() === "cancel") {
    clearReport(chatId);
    return bot.sendMessage(chatId, "✅ Cancelled.");
  }

  // Step handlers
  if (step === "site") {
    setReport(chatId, { step: "chargerIdPublic", data: { site: t } });
    return promptReportStep(chatId);
  }

  if (step === "chargerIdPublic") {
    setReport(chatId, { step: "chargerSerialNumber", data: { chargerIdPublic: t } });
    return promptReportStep(chatId);
  }

  if (step === "chargerSerialNumber") {
    setReport(chatId, { step: "assetId", data: { chargerSerialNumber: t } });
    return promptReportStep(chatId);
  }

  if (step === "assetId") {
    if (t.toLowerCase() !== "skip") setReport(chatId, { data: { assetId: t } });
    setReport(chatId, { step: "technician" });
    return promptReportStep(chatId);
  }

  if (step === "technician") {
    setReport(chatId, { step: "clientRef", data: { technician: t } });
    return promptReportStep(chatId);
  }

  if (step === "clientRef") {
    setReport(chatId, { step: "actions", data: { clientRef: t } });
    return promptReportStep(chatId);
  }

  if (step === "actions") {
    const lower = t.toLowerCase();
    if (lower === "clear") {
      setReport(chatId, { data: { actions: [] } });
      return bot.sendMessage(chatId, "🧹 Actions cleared. Add actions again, or type <b>done</b>.", {
        parse_mode: "HTML",
      });
    }
    if (lower === "done") {
      setReport(chatId, { step: "faultSummary" });
      return promptReportStep(chatId);
    }
    // add an action line
    const cur = reportState.get(chatId);
    const actions = Array.isArray(cur?.data?.actions) ? cur.data.actions : [];
    actions.push(t);
    setReport(chatId, { data: { actions } });
    return bot.sendMessage(chatId, `✅ Added action (${actions.length}). Add another, or type <b>done</b>.`, {
      parse_mode: "HTML",
    });
  }

  if (step === "faultSummary") {
    if (t.toLowerCase() !== "skip") setReport(chatId, { data: { faultSummary: t } });
    setReport(chatId, { step: "resolution" });
    return promptReportStep(chatId);
  }

  if (step === "resolution") {
    setReport(chatId, { step: "notes", data: { resolution: t } });
    return promptReportStep(chatId);
  }

  if (step === "notes") {
    if (t.toLowerCase() !== "skip") setReport(chatId, { data: { notes: t } });
    setReport(chatId, { step: "confirm" });
    return promptReportStep(chatId);
  }

  if (step === "confirm") {
    const lower = t.toLowerCase();
    if (lower === "send") {
      const cur = reportState.get(chatId);
      const html = formatReportHtml(cur?.data || {});
      clearReport(chatId);
      return bot.sendMessage(chatId, html, { parse_mode: "HTML" });
    }
    return bot.sendMessage(chatId, "Reply <b>send</b> to post the report, or <b>cancel</b>.", { parse_mode: "HTML" });
  }
});


/* =========================
   PHOTO CAPTURE (Report) - optional
   ========================= */
bot.on("photo", async (msg) => {
  const chatId = msg?.chat?.id;
  if (!chatId) return;
  const st = reportState.get(chatId);
  if (!st || st.step !== "UPLOAD_PHOTOS") return;

  const photos = msg.photo || [];
  if (!photos.length) return;
  const best = photos[photos.length - 1];
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

  try {
    await bot.answerCallbackQuery(q.id, { text: "✅", show_alert: false });
  } catch (_) {}

  global.__EVBOT_CB_RL = global.__EVBOT_CB_RL || new Map();
  const now = Date.now();
  const last = chatId ? global.__EVBOT_CB_RL.get(chatId) || 0 : 0;
  if (chatId && now - last < 250) return;
  if (chatId) global.__EVBOT_CB_RL.set(chatId, now);

  if (!chatId) return;
  if (data === "noop") return;

  /* --------- GLOBAL NAV --------- */
  if (data === "reset" || data === "menu:mfr") {
    clearReport(chatId);
    resetDt(chatId);
    return showManufacturerMenu(chatId, messageId);
  }

  if (data === "r:new") {
    clearReport(chatId);
    resetDt(chatId);
    return startReport(chatId);
  }

  if (data.startsWith("mfr:")) {
    const mfr = data.split(":")[1];
    clearReport(chatId);
    resetDt(chatId);
    if (mfr === "general_dc") return showGeneralDcMenu(chatId, messageId);
    if (mfr === "autel") return showAutelMenu(chatId, messageId);
    if (mfr === "kempower") return showKempowerMenu(chatId, messageId);
    if (mfr === "tritium") return showTritiumMenu(chatId, messageId);
    return showManufacturerMenu(chatId, messageId);
  }

  // Pack menu callbacks: "<pack>:menu"
  if (data.endsWith(":menu")) {
    const pack = data.split(":")[0].toLowerCase();
    clearReport(chatId);
    resetDt(chatId);
    if (pack === "general_dc") return showGeneralDcMenu(chatId, messageId);
    if (pack === "kempower") return showKempowerMenu(chatId, messageId);
    if (pack === "tritium") return showTritiumMenu(chatId, messageId);
    return showAutelMenu(chatId, messageId);
  }

  // Pack all callbacks: "<pack>:all"
  if (data.endsWith(":all")) {
    const pack = data.split(":")[0].toLowerCase();
    clearReport(chatId);
    resetDt(chatId);
    if (pack === "general_dc") return showGeneralDcAllMenu(chatId, messageId);
    // For others, "all" just shows the normal fault list
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
    resetDt(chatId);
    return startReportFromFault(chatId, pack, fault);
  }

  /* =========================
     DECISION TREE (SAFE)
     ========================= */

  // ✅ helper: recover dt state from message if chat state missing
  function getActiveDtState() {
    const st = getDt(chatId) || getDtFromMessage(chatId, messageId);
    if (st && !getDt(chatId)) setDt(chatId, st);
    return st;
  }

  if (data === "dt:start") {
    const st = getActiveDtState();
    if (!st?.pack || !st?.faultId) {
      return bot.sendMessage(chatId, "⚠️ No active fault selected. Tap a fault first (not just the menu).");
    }
    const fault = getFaultById(st.pack, st.faultId);
    if (!fault?.decision_tree?.start_node) {
      return bot.sendMessage(chatId, "⚠️ This fault has no decision tree.");
    }
    setDt(chatId, { history: [] });
    if (messageId) setDtForMessage(chatId, messageId, { history: [] });

    return renderYamlDecisionNode({
      chatId,
      messageId,
      pack: st.pack,
      fault,
      nodeId: fault.decision_tree.start_node,
    });
  }

  if (data.startsWith("dt:o:")) {
    const st = getActiveDtState();
    if (!st?.pack || !st?.faultId) {
      return bot.sendMessage(chatId, "⚠️ No active fault selected. Open a fault first.");
    }
    const idx = Number(data.split(":")[2]);
    if (Number.isNaN(idx)) return;

    const fault = getFaultById(st.pack, st.faultId);
    const tree = fault?.decision_tree;
    if (!tree?.nodes || !tree?.start_node) return;

    const currentNodeId =
      Array.isArray(st.history) && st.history.length ? st.history[st.history.length - 1] : tree.start_node;

    const node = tree.nodes[currentNodeId];
    const opts = Array.isArray(node?.options) ? node.options : [];
    const opt = opts[idx];
    const nextNodeId = opt?.next;

    if (!nextNodeId) return bot.sendMessage(chatId, "⚠️ Option is missing a next node.");

    return renderYamlDecisionNode({
      chatId,
      messageId,
      pack: st.pack,
      fault,
      nodeId: nextNodeId,
    });
  }

  if (data === "dt:bk") {
    const st = getActiveDtState();
    if (!st?.pack || !st?.faultId) return;

    const fault = getFaultById(st.pack, st.faultId);
    if (!fault) return showManufacturerMenu(chatId, messageId);

    const prevNode = popDtHistory(chatId);

    // keep message-level history aligned (best effort)
    if (messageId) {
      const ms = getDtFromMessage(chatId, messageId);
      if (ms?.history?.length > 1) {
        const h = [...ms.history];
        h.pop();
        setDtForMessage(chatId, messageId, { history: h });
      }
    }

    if (!prevNode) {
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

  if (data === "dt:mn") {
    const st = getActiveDtState();
    if (!st?.pack) return showManufacturerMenu(chatId, messageId);
    resetDt(chatId);

    if (st.pack === "general_dc") return showGeneralDcMenu(chatId, messageId);
    if (st.pack === "kempower") return showKempowerMenu(chatId, messageId);
    if (st.pack === "tritium") return showTritiumMenu(chatId, messageId);
    return showAutelMenu(chatId, messageId);
  }

  /* =========================
     FAULT SELECTION (STANDARD + LEGACY)
     ========================= */

  // ✅ Standard: "<pack>:fault:<id>"
  if (data.includes(":fault:")) {
    const [packRaw, , ...rest] = data.split(":"); // pack, "fault", id...
    const pack = String(packRaw || "").toLowerCase();
    const id = rest.join(":"); // allow ":" in ids (rare)
    const fault = getFaultById(pack, id);

    if (!fault) {
      resetDt(chatId);
      return upsertMessage(chatId, {
        messageId,
        text: "Fault not found.",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: cbPackMenu(pack) }]] },
      });
    }
    return showFaultCard({ chatId, messageId, pack, fault });
  }

  // ✅ Legacy: "GENERAL_DC:<id>", "AUTEL:<id>", "KEMPOWER:<id>", "TRITIUM:<id>"
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
