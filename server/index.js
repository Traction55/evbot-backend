/**
 * EVBot backend (Express + YAML fault library + Telegram bot)
 * - Works locally (polling) and on Railway (webhook)
 * - /autel shows Autel faults (YAML) + supports YAML decision_tree
 * - /report generates a client-ready service report
 * - Includes legacy hard-coded AC decision tree (ac:*) still available
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

// ------------------- YAML LOADING (ROBUST) -------------------
const FAULTS_DIR = path.join(__dirname, "..", "faults");
const AUTEL_FILE = path.join(FAULTS_DIR, "autel.yml");

function loadYamlSafe(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return yaml.load(raw) || {};
  } catch (e) {
    console.error(`❌ YAML load failed: ${file}`, e?.message || e);
    return {};
  }
}

function normalizeAutelData(obj) {
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
  return normalizeAutelData(loadYamlSafe(AUTEL_FILE));
}

// Boot log (shows in Railway Deploy Logs)
try {
  const bootAutel = loadAutel();
  console.log(`✅ Autel file path: ${AUTEL_FILE}`);
  console.log(`✅ Autel faults loaded: ${bootAutel.faults.length}`);
} catch (_) {}

// ------------------- EXPRESS -------------------
const app = express();
app.use(cors());
app.use(express.json());

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
  })
);

// Debug endpoint (use this to confirm Railway can see your YAML)
app.get("/debug/autel", (req, res) => {
  const data = loadAutel();
  res.json({
    file: AUTEL_FILE,
    exists: fs.existsSync(AUTEL_FILE),
    count: data.faults.length,
    titles: data.faults.slice(0, 30).map((f) => f.title),
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

// ------------------- STATE -------------------
const reportState = new Map();

// ✅ Decision-tree state with HISTORY
// chatId -> { faultId: string, history: string[] }
const dtState = new Map();

// ------------------- YAML DECISION TREE SUPPORT -------------------
function dtCallback(faultId, nodeId) {
  return `DT|${faultId}|${nodeId}`;
}
function dtBackCallback(faultId) {
  return `DTB|${faultId}`;
}

function getAutelFaultById(id) {
  const autel = loadAutel();
  return (autel.faults || []).find((x) => String(x.id) === String(id));
}

function resetDt(chatId) {
  dtState.delete(chatId);
}

// Push node into history (avoid duplicates)
function pushDtHistory(chatId, faultId, nodeId) {
  const cur = dtState.get(chatId);

  if (!cur || String(cur.faultId) !== String(faultId)) {
    dtState.set(chatId, { faultId: String(faultId), history: [String(nodeId)] });
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
function popDtHistory(chatId, faultId) {
  const cur = dtState.get(chatId);
  if (!cur || String(cur.faultId) !== String(faultId)) return null;

  const hist = Array.isArray(cur.history) ? [...cur.history] : [];
  if (hist.length <= 1) return null; // nothing to go back to

  // remove current
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

async function showAutelFaultCard({ chatId, messageId, fault }) {
  // leaving the fault card should reset the decision-tree history for clean UX
  resetDt(chatId);

  // Preferred: YAML field response.telegram_markdown
  if (fault?.response?.telegram_markdown) {
    const rows = [];

    if (fault?.decision_tree?.start_node && fault?.decision_tree?.nodes) {
      rows.push([
        {
          text: "🧭 Start troubleshooting",
          callback_data: dtCallback(fault.id, fault.decision_tree.start_node),
        },
      ]);
    }

    rows.push([{ text: "⬅️ Back", callback_data: "autel:menu" }]);

    return upsertMessage(chatId, {
      messageId,
      text: fault.response.telegram_markdown,
      parse_mode: "Markdown",
      reply_markup: kb(rows),
    });
  }

  // Fallback: old schema rendered to HTML
  const html = buildLegacyFaultHtml(fault);

  const rows = [];
  if (fault?.decision_tree?.start_node && fault?.decision_tree?.nodes) {
    rows.push([
      {
        text: "🧭 Start troubleshooting",
        callback_data: dtCallback(fault.id, fault.decision_tree.start_node),
      },
    ]);
  }
  rows.push([{ text: "⬅️ Back", callback_data: "autel:menu" }]);

  return upsertMessage(chatId, {
    messageId,
    text: html,
    parse_mode: "HTML",
    reply_markup: kb(rows),
  });
}

async function renderYamlDecisionNode({ chatId, messageId, fault, nodeId }) {
  const tree = fault?.decision_tree;
  const node = tree?.nodes?.[nodeId];

  if (!node) {
    return upsertMessage(chatId, {
      messageId,
      text: `⚠️ Decision node not found: ${nodeId}`,
      parse_mode: "Markdown",
      reply_markup: kb([[{ text: "⬅️ Back", callback_data: `AUTEL:${fault.id}` }]]),
    });
  }

  // Track history for "Back one step"
  pushDtHistory(chatId, fault.id, nodeId);

  const text = node.prompt || "…";

  // 1 button per row for clean UX
  const rows = (node.options || []).map((opt) => [
    { text: opt.label, callback_data: dtCallback(fault.id, opt.next) },
  ]);

  // ✅ Back now goes back ONE NODE, not to fault card
  rows.push([{ text: "⬅️ Back", callback_data: dtBackCallback(fault.id) }]);

  // menu option
  rows.push([{ text: "🏠 Autel menu", callback_data: "autel:menu" }]);

  return upsertMessage(chatId, {
    messageId,
    text,
    parse_mode: "Markdown",
    reply_markup: kb(rows),
  });
}

// ------------------- /report WIZARD -------------------
function setReport(chatId, patch) {
  const cur = reportState.get(chatId) || { step: "site", data: { actions: [] } };
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

function formatReport(data) {
  const site = escapeHtml(data.site || "");
  const chargerId = escapeHtml(data.chargerId || "");
  const faultTitle = escapeHtml(data.faultTitle || "");
  const resolution = escapeHtml(data.resolution || "");
  const notes = escapeHtml(data.notes || "");

  const actions = Array.isArray(data.actions) ? data.actions : [];
  const actionsLines = actions.length ? actions.map((a) => `• ${escapeHtml(a)}`).join("\n") : "• (none recorded)";

  return (
    `🧾 <b>EVBot Service Report</b>\n\n` +
    `<b>Site:</b> ${site}\n` +
    `<b>Charger:</b> ${chargerId}\n` +
    `<b>Fault:</b> ${faultTitle}\n\n` +
    `<b>Actions completed:</b>\n${actionsLines}\n\n` +
    `<b>Status / Outcome:</b> ${resolution}\n` +
    (notes ? `\n<b>Notes:</b>\n${notes}\n` : "")
  );
}

async function startReport(chatId) {
  setReport(chatId, { step: "site", data: { actions: [] } });

  return bot.sendMessage(
    chatId,
    "🧾 <b>Report Builder</b>\n\nStep 1/5 — What is the <b>site name</b>?\n\n(Reply with text)",
    { parse_mode: "HTML" }
  );
}

async function askCharger(chatId) {
  setReport(chatId, { step: "charger" });

  return bot.sendMessage(chatId, "Step 2/5 — What is the <b>charger ID / asset ID</b>?\n\n(Reply with text)", {
    parse_mode: "HTML",
  });
}

async function askFault(chatId) {
  setReport(chatId, { step: "fault" });

  const autel = loadAutel();
  const faults = autel.faults || [];

  const rows = [[{ text: "🧰 AC Contactor Fault (Decision Tree)", callback_data: "r:fault:ac" }]];

  if (!faults.length) {
    rows.push([{ text: "⚠️ No Autel faults loaded (check /debug/autel)", callback_data: "noop" }]);
  } else {
    faults.forEach((f) => {
      rows.push([{ text: f.title, callback_data: `r:fault:AUTEL:${f.id}` }]);
    });
  }

  rows.push([{ text: "Cancel", callback_data: "r:cancel" }]);

  return bot.sendMessage(chatId, "Step 3/5 — Select the <b>fault</b>:", {
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

  return bot.sendMessage(chatId, "Step 4/5 — Select <b>actions performed</b>:", {
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

  return bot.sendMessage(chatId, "Step 5/5 — Select <b>status/outcome</b>:", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
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

  const reportText = formatReport(data);

  setReport(chatId, { step: "done" });

  await bot.sendMessage(chatId, reportText, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Start a new report", callback_data: "r:new" }],
        [{ text: "⬅️ Back to Autel menu", callback_data: "autel:menu" }],
      ],
    },
  });
}

// ------------------- LEGACY AC CONTACTOR DECISION TREE (kept) -------------------
const AC = {
  start: {
    text:
      "🧰 <b>AC Contactor Fault</b>\n\n" +
      "<b>Step 1 — Safety</b>\n" +
      "• LOTO / isolate supply\n" +
      "• Prove dead before touching\n" +
      "• Verify no voltage present\n\n" +
      "Tap <b>Next</b> when safe.",
    buttons: kb([
      [{ text: "Next ➡️", callback_data: "ac:observe" }],
      [{ text: "⬅️ Back", callback_data: "autel:menu" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  observe: {
    text: "🔎 <b>What do you observe?</b>\n\nChoose the closest match:",
    buttons: kb([
      [{ text: "No clunk (no pull-in)", callback_data: "ac:noclunk" }],
      [{ text: "Clunks but fault remains", callback_data: "ac:clunkfault" }],
      [{ text: "Intermittent / works after reboot", callback_data: "ac:intermittent" }],
      [{ text: "Not sure", callback_data: "ac:not_sure" }],
      [{ text: "⬅️ Back", callback_data: "ac:start" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  noclunk: {
    text:
      "🔌 <b>No pull-in</b>\n\n" +
      "<b>Check A1:</b> Is there coil command voltage present when the unit is trying to start?\n\n" +
      "Measure at the coil terminals (A1/A2) during command.\n\n" +
      "<b>Also check:</b>\n" +
      "• Wiring tight / correctly terminated (no loose connections)\n" +
      "• No burn marks / heat damage on contactor",
    buttons: kb([
      [{ text: "Yes (coil voltage present)", callback_data: "ac:coilcmd_yes" }],
      [{ text: "No (no coil voltage)", callback_data: "ac:coilcmd_no" }],
      [{ text: "Not sure", callback_data: "ac:coilcmd_unsure" }],
      [{ text: "⬅️ Back", callback_data: "ac:observe" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  coilcmd_yes: {
    text:
      "✅ <b>Coil command present</b>\n\n" +
      "<b>Likely causes:</b>\n" +
      "• Coil open circuit / failed coil\n" +
      "• Contactor mechanically stuck\n" +
      "• Incorrect coil rating (wrong part)\n\n" +
      "<b>Checks:</b>\n" +
      "• Verify coil rating matches control voltage\n" +
      "• Verify all wires are correctly terminated (no loose connections)\n" +
      "• No burn marks on the contactor / terminals\n\n" +
      "<b>Action:</b> If coil voltage is present and it won’t pull in → replace contactor.",
    buttons: kb([
      [{ text: "Replacement checklist", callback_data: "ac:replace" }],
      [{ text: "Escalate to Autel", callback_data: "ac:escalate" }],
      [{ text: "⬅️ Back", callback_data: "ac:noclunk" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  coilcmd_no: {
    text:
      "❌ <b>No coil command</b>\n\n" +
      "<b>Likely causes:</b>\n" +
      "• Control PCB/IO not driving output\n" +
      "• Interlock chain open (E-stop/door/etc)\n" +
      "• Wiring fault between IO and coil\n\n" +
      "<b>Checks:</b>\n" +
      "• Verify interlocks / E-stop / door switch status\n" +
      "• Trace output from IO to coil terminals\n" +
      "• Verify terminations (no loose connections)\n\n" +
      "<b>Action:</b> Trace back to control PCB/IO and confirm interlocks.",
    buttons: kb([
      [{ text: "Escalate to Autel", callback_data: "ac:escalate" }],
      [{ text: "⬅️ Back", callback_data: "ac:noclunk" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  coilcmd_unsure: {
    text:
      "🤔 <b>Not sure if coil voltage is present</b>\n\n" +
      "<b>Do this:</b>\n" +
      "• Put meter on A1/A2 (coil terminals)\n" +
      "• Trigger a start attempt\n" +
      "• Note voltage during the attempt\n\n" +
      "<b>Then choose:</b>\n" +
      "• If voltage appears during start → pick <b>Yes</b>\n" +
      "• If 0V the whole time → pick <b>No</b>",
    buttons: kb([
      [{ text: "Yes (coil voltage present)", callback_data: "ac:coilcmd_yes" }],
      [{ text: "No (no coil voltage)", callback_data: "ac:coilcmd_no" }],
      [{ text: "⬅️ Back", callback_data: "ac:noclunk" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  clunkfault: {
    text:
      "🔁 <b>Clunks but fault remains</b>\n\n" +
      "<b>Check B1:</b> Does the auxiliary feedback change state when it pulls in?\n\n" +
      "<b>Do this:</b>\n" +
      "• Verify correct voltages at the aux/signal terminals\n" +
      "• Verify correct NO/NC used\n" +
      "• Verify wiring is tight / correctly terminated\n" +
      "• No burn marks / heat damage on contactor/aux terminals",
    buttons: kb([
      [{ text: "Aux changes correctly", callback_data: "ac:aux_yes" }],
      [{ text: "Aux not changing", callback_data: "ac:aux_no" }],
      [{ text: "Not sure", callback_data: "ac:aux_unsure" }],
      [{ text: "⬅️ Back", callback_data: "ac:observe" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  aux_yes: {
    text:
      "✅ <b>Aux changes correctly</b>\n\n" +
      "<b>If fault still remains:</b>\n" +
      "• Confirm the aux is wired to the correct input on the control IO\n" +
      "• Verify voltage at the IO input when aux changes\n" +
      "• Check for wiring breaks / intermittent at terminals\n\n" +
      "<b>Next:</b> If IO input voltage/state is correct but fault persists, escalate with readings/logs.",
    buttons: kb([
      [{ text: "Escalate to Autel", callback_data: "ac:escalate" }],
      [{ text: "⬅️ Back", callback_data: "ac:clunkfault" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  aux_no: {
    text:
      "⚠️ <b>Aux not changing</b>\n\n" +
      "<b>Likely causes:</b>\n" +
      "• Loose/incorrect termination\n" +
      "• Wrong NO/NC used\n" +
      "• Failed aux block\n\n" +
      "<b>Checks:</b>\n" +
      "• Verify correct voltages at signal/aux terminals\n" +
      "• Re-terminate all conductors (no loose connections)\n" +
      "• Confirm correct NO/NC terminal selection\n" +
      "• Inspect for any burn marks / heat damage\n\n" +
      "<b>Action:</b> Re-terminate, verify terminals, replace contactor/aux block if needed.",
    buttons: kb([
      [{ text: "Wiring checklist", callback_data: "ac:wiring" }],
      [{ text: "Replace contactor", callback_data: "ac:replace" }],
      [{ text: "⬅️ Back", callback_data: "ac:clunkfault" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  aux_unsure: {
    text:
      "🤔 <b>Not sure if aux changes</b>\n\n" +
      "<b>Do this:</b>\n" +
      "• Identify the aux terminals used (NO/NC + COM)\n" +
      "• Measure continuity or voltage change while contactor pulls in\n" +
      "• Confirm you are on the correct NO/NC pair\n\n" +
      "Then choose the closest branch.",
    buttons: kb([
      [{ text: "Aux changes correctly", callback_data: "ac:aux_yes" }],
      [{ text: "Aux not changing", callback_data: "ac:aux_no" }],
      [{ text: "⬅️ Back", callback_data: "ac:clunkfault" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  intermittent: {
    text:
      "🌡️ <b>Intermittent fault</b>\n\n" +
      "<b>Common causes:</b>\n" +
      "• Loose terminations (coil/aux)\n" +
      "• Heat-related coil failure\n" +
      "• Supply dips / phase imbalance\n" +
      "• Aux feedback flickering\n\n" +
      "<b>Checks:</b>\n" +
      "• Torque check all terminations\n" +
      "• Verify aux/signal voltages stable\n" +
      "• Inspect for discoloration/burn marks\n\n" +
      "<b>Action:</b> Capture logs + readings and re-test.",
    buttons: kb([
      [{ text: "Escalate with log checklist", callback_data: "ac:escalate" }],
      [{ text: "⬅️ Back", callback_data: "ac:observe" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  replace: {
    text:
      "🧾 <b>Replacement checklist</b>\n\n" +
      "• LOTO + prove dead\n" +
      "• Photo: wiring before removal\n" +
      "• Verify coil/aux terminal mapping\n" +
      "• Verify correct aux/signal voltages after install\n" +
      "• Torque terminations to spec (no loose connections)\n" +
      "• Inspect for burn marks / heat damage\n" +
      "• Re-test start sequence\n\n" +
      "If fault persists, escalate with logs + readings.",
    buttons: kb([
      [{ text: "Escalate", callback_data: "ac:escalate" }],
      [{ text: "⬅️ Back", callback_data: "ac:observe" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  escalate: {
    text:
      "📈 <b>Escalation pack</b>\n\n" +
      "Send Autel:\n" +
      "• Fault ID + time\n" +
      "• Coil voltage (ON/OFF)\n" +
      "• Aux state (ON/OFF)\n" +
      "• Aux/signal terminal voltages\n" +
      "• Incoming AC L-L voltages + phase balance\n" +
      "• Photos: contactor, aux terminals, any heat/burn marks\n" +
      "• Logs/export if available",
    buttons: kb([
      [{ text: "⬅️ Back", callback_data: "ac:observe" }],
      [{ text: "Autel menu", callback_data: "autel:menu" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  wiring: {
    text:
      "🔧 <b>Wiring checklist</b>\n\n" +
      "• Verify all wires fully seated\n" +
      "• No loose strands / ferrules OK\n" +
      "• Correct NO/NC aux terminals used\n" +
      "• Verify correct voltages at signal terminals\n" +
      "• No burn marks on contactor/terminals\n" +
      "• Confirm continuity where relevant",
    buttons: kb([
      [{ text: "⬅️ Back", callback_data: "ac:clunkfault" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
  not_sure: {
    text:
      "🤔 <b>Not sure</b>\n\n" +
      "Start with:\n" +
      "1) Listen for pull-in (clunk)\n" +
      "2) Measure coil voltage during start\n" +
      "3) Check aux feedback change + terminal voltages\n\n" +
      "Then choose the closest branch.",
    buttons: kb([
      [{ text: "Back to observations", callback_data: "ac:observe" }],
      [{ text: "Autel menu", callback_data: "autel:menu" }],
      [{ text: "🔁 Reset", callback_data: "reset" }],
    ]),
  },
};

// ------------------- MENU HELPERS -------------------
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

bot.onText(/^\/autel$/, async (msg) => {
  resetDt(msg.chat.id);
  await showAutelMenu(msg.chat.id);
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

  if (text.startsWith("/")) return;

  const st = reportState.get(chatId);
  if (!st) return;

  if (st.step === "site") {
    setReport(chatId, { data: { site: text } });
    return askCharger(chatId);
  }

  if (st.step === "charger") {
    setReport(chatId, { data: { chargerId: text } });
    return askFault(chatId);
  }

  if (st.step === "notes") {
    setReport(chatId, { data: { notes: text } });
    return finishReport(chatId);
  }
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

    if (mfr === "autel") {
      return showAutelMenu(chatId, messageId);
    }

    if (mfr === "kempower") {
      return upsertMessage(chatId, {
        messageId,
        text:
          "🟢 <b>Kempower troubleshooting</b>\n\n" +
          "Coming next.\n\n" +
          "For now, select <b>Autel</b> to continue.",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔵 Autel", callback_data: "mfr:autel" }],
            [{ text: "⬅️ Back", callback_data: "menu:mfr" }],
          ],
        },
      });
    }

    return showManufacturerMenu(chatId, messageId);
  }

  // ✅ DT BACK ONE STEP
  if (data.startsWith("DTB|")) {
    const [, faultId] = data.split("|");
    const fault = getAutelFaultById(faultId);
    if (!fault) {
      resetDt(chatId);
      return showAutelMenu(chatId, messageId);
    }

    const prevNode = popDtHistory(chatId, faultId);

    // If nothing to pop, fall back to showing the fault card
    if (!prevNode) {
      return showAutelFaultCard({ chatId, messageId, fault });
    }

    return renderYamlDecisionNode({ chatId, messageId, fault, nodeId: prevNode });
  }

  // YAML decision tree next node
  if (data.startsWith("DT|")) {
    const [, faultId, nodeId] = data.split("|");
    const fault = getAutelFaultById(faultId);

    if (!fault) {
      resetDt(chatId);
      return upsertMessage(chatId, {
        messageId,
        text: "⚠️ Fault not found.",
        parse_mode: "HTML",
        reply_markup: kb([[{ text: "⬅️ Back", callback_data: "autel:menu" }]]),
      });
    }

    return renderYamlDecisionNode({ chatId, messageId, fault, nodeId });
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

  if (data.startsWith("r:fault:")) {
    if (data === "r:fault:ac") {
      setReport(chatId, { data: { faultTitle: "AC Contactor Fault" } });
    } else if (data.startsWith("r:fault:AUTEL:")) {
      const id = data.split(":")[3];
      const f = getAutelFaultById(id);
      setReport(chatId, { data: { faultTitle: f ? f.title : `Autel Fault (${id})` } });
    }
    return askActions(chatId);
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
      text: "Step 4/5 — Select <b>actions performed</b>:",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildActionsKeyboard(Array.from(selected)) },
    });
  }

  if (data.startsWith("r:res:")) {
    const res = data.split(":").slice(2).join(":");
    setReport(chatId, { data: { resolution: res } });
    return askNotes(chatId);
  }

  if (data === "r:notes:skip") {
    setReport(chatId, { data: { notes: "" } });
    return finishReport(chatId);
  }

  // ------------------- AUTEL / AC -------------------
  if (data === "autel:menu") {
    resetDt(chatId);
    return showAutelMenu(chatId, messageId);
  }

  // Legacy AC decision tree routing (edit message)
  if (data.startsWith("ac:")) {
    const key = data.split(":")[1];
    const node = AC[key];
    if (!node) return;

    return upsertMessage(chatId, {
      messageId,
      text: node.text,
      parse_mode: "HTML",
      reply_markup: node.buttons,
    });
  }

  // Autel YAML fault selection (edit message)
  if (data.startsWith("AUTEL:")) {
    const id = data.split(":")[1];
    const fault = getAutelFaultById(id);

    if (!fault) {
      resetDt(chatId);
      return upsertMessage(chatId, {
        messageId,
        text: "Fault not found.",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "autel:menu" }]] },
      });
    }

    return showAutelFaultCard({ chatId, messageId, fault });
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
