#!/usr/bin/env node
/**
 * Gift Monitor — Full standalone engine (GitHub Actions).
 * Полностью независимая доставка уведомлений с серверов GitHub.
 * Детекция: официальные счётчики t.me/nft (надёжно, без ключей и лимитов).
 * Обогащение: tonapi (номер/владелец/время) — только для найденных апгрейдов.
 *
 * Режимы:
 *   (без аргументов) — обычный прогон: смотрит data/enabled-full.json
 *   force            — прогнать всегда (тест)
 *   sendtest         — тестовое сообщение владельцу
 *
 * ВАЖНО: включать (enabled-full=true) ТОЛЬКО когда монитор Base44 выключен,
 * иначе подписчики получат дубли — движки не видят дедуп друг друга.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DATA = path.join(REPO_ROOT, "data");
const COLS_FILE = path.join(__dirname, "..", "collections.json");
const STATE_FILE = path.join(DATA, "state-full.json");
const ENABLED_FILE = path.join(DATA, "enabled-full.json");
const SUBS_FILE = path.join(DATA, "subscribers.enc");
const STATUS_FILE = path.join(REPO_ROOT, "docs", "status.json");

const TONAPI_KEY = process.env.TONAPI_KEY || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CRYPT_KEY = process.env.CRYPT_KEY || "";
const OWNER_ID = "8396883978";
const NOW = () => Math.floor(Date.now() / 1000);

const MODE = (process.env.MODE || process.argv[2] || "").toLowerCase();
const FORCE = MODE === "force" || (process.env.FORCE || "") === "true" || process.argv[2] === "force";

// ---------- утилиты ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function pool(items, n, fn) {
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// tonapi: строгая очередь, максимум ~1 запрос в 1.1с (лимит бесплатного ключа)
let tonChain = Promise.resolve();
function tonapi(url) {
  const p = tonChain.then(async () => {
    await sleep(1100);
    for (let i = 1; i <= 2; i++) {
      try {
        const res = await fetch(`https://tonapi.io${url}`, {
          headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {},
          signal: AbortSignal.timeout(12000),
        });
        if (res.ok) return await res.json().catch(() => null);
      } catch {}
      if (i < 2) await sleep(2000);
    }
    return null;
  });
  tonChain = p.catch(() => {});
  return p;
}

async function tg(method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

// официальный счётчик «улучшено X из Y» со страницы t.me/nft/<slug>-<n>
async function tgCounter(slug, sample) {
  for (const n of [...new Set([sample, 1, 2, 3])].filter((x) => x > 0)) {
    try {
      const res = await fetch(`https://t.me/nft/${slug.toLowerCase()}-${n}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) continue;
      const m = (await res.text()).match(/Quantity<\/th><td>([\d\u00a0\s]+)\/([\d\u00a0\s]+)\s*issued/);
      if (!m) continue;
      const issued = parseInt(m[1].replace(/[\u00a0\s]/g, ""), 10);
      const total = parseInt(m[2].replace(/[\u00a0\s]/g, ""), 10);
      if (issued > 0 && total > 0) return { issued, total, sample: n };
    } catch {}
  }
  return null;
}

// картинка NFT со страницы t.me/nft/<slug>-<n> (og:image, CDN Telegram)
async function giftImage(slug, num) {
  if (!slug || !num) return "";
  try {
    const res = await fetch(`https://t.me/nft/${slug.toLowerCase()}-${num}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return "";
    const m = (await res.text()).match(/property="og:image"\s+content="([^"]+)"|content="([^"]+)"\s+property="og:image"/);
    return m ? m[1] || m[2] || "" : "";
  } catch { return ""; }
}

function hourSamarkand() {
  try {
    return parseInt(
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Samarkand", hour: "numeric", hour12: false }).format(new Date()),
      10
    );
  } catch {
    return 12;
  }
}

function parseMetaName(name, index) {
  const parts = String(name || "").trim().split(" #");
  const slug = (parts[0] || "").replace(/[\s'\u2019]/g, "");
  let numStr = String(parts[1] ?? "").replace(/,/g, "");
  if (!numStr) {
    const n = Number(index);
    if (Number.isFinite(n) && n > 0 && n < 1e7) numStr = String(n);
  }
  const num = parseInt(numStr, 10);
  return { slug, index: Number.isFinite(num) && num > 0 && num < 1e7 ? num : 0, hasNumber: numStr !== "" };
}

function decryptSubs() {
  if (!fs.existsSync(SUBS_FILE)) return [];
  try {
    const out = execSync(
      `openssl enc -d -aes-256-cbc -pbkdf2 -pass 'pass:${CRYPT_KEY}' -in "${SUBS_FILE}"`,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
    );
    const d = JSON.parse(out);
    return Array.isArray(d) ? d : d.subscribers || [];
  } catch (e) {
    console.log("subscribers decrypt failed:", String(e).slice(0, 120));
    return [];
  }
}

function fmtOwner(addr, name) {
  const short = addr.length > 12 ? addr.slice(0, 6) + "..." + addr.slice(-4) : addr;
  return name ? `${esc(name)} (<code>${short}</code>)` : `<code>${short}</code>`;
}

function buildMessage(ev) {
  const now = NOW();
  const mins = ev.mintTime ? Math.max(0, Math.round((now - ev.mintTime) / 60)) : 0;
  const ago = mins < 60 ? `${mins} мин. назад` : `${Math.floor(mins / 60)} ч. ${mins % 60} мин. назад`;
  const num = ev.number;
  const link = `https://t.me/nft/${ev.slug.toLowerCase()}${num ? `-${num}` : ""}`;
  const gift = String(ev.giftDisplay || ev.slug);
  const title = ev.counter ? `${gift} #${ev.counter.issued.toLocaleString("ru-RU")}` : gift;

  return (
    `🚀 НОВОЕ УЛУЧШЕНИЕ: ${esc(title)}!\n\n` +
    `🎁 Подарок: ${esc(gift)}\n` +
    (num ? `🏷️ NFT: #${num.toLocaleString("ru-RU")}\n` : "") +
    (ev.ownerAddr ? `👤 Владелец: ${fmtOwner(ev.ownerAddr, ev.ownerName)}\n` : "") +
    `🕐 Улучшено: ${ago}\n` +
    (ev.counter ? `📊 Улучшено всего (Telegram): ${ev.counter.issued.toLocaleString("ru-RU")} из ${ev.counter.total.toLocaleString("ru-RU")}\n` : "") +
    `\n🔗 <a href="${link}">Подарок</a> · <a href="https://t.me/mrkt">MRKT</a> · <a href="https://t.me/portals">Portals</a>\n\n` +
    `#TelegramGifts #NFT #${ev.slug}`
  );
}

// ---------- sendtest ----------
async function sendTest() {
  const subs = decryptSubs();
  const owner = subs.find((s) => String(s.telegram_id) === OWNER_ID) || { chat_id: OWNER_ID };
  const r = await tg("sendMessage", {
    chat_id: String(owner.chat_id),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    text:
      "✅ <b>Gift Monitor — полная независимая версия</b>\n\n" +
      "Тестовое сообщение с серверов GitHub Actions.\n" +
      "Движок умеет сам: счётчики → детект → обогащение → доставка. Никаких зависимостей от Base44.\n\n" +
      "Сейчас режим ожидания (enabled-full=false). Для активации: выключить Monitor A на Base44 и поставить enabled-full=true.",
  });
  console.log("sendtest:", r?.ok ? "✅ доставлено владельцу" : "❌ " + JSON.stringify(r).slice(0, 200));
  process.exit(r?.ok ? 0 : 1);
}

// ---------- обогащение найденного апгрейда через tonapi ----------
async function enrich(b) {
  let ev = {
    slug: b.col.name,
    giftDisplay: b.col.display_name || b.col.name,
    number: b.issued,
    ownerAddr: "",
    ownerName: "",
    mintTime: 0,
    counter: { issued: b.issued, total: b.total },
  };
  if (!b.col.address) return ev;
  const events = await tonapi(`/v2/accounts/${b.col.address}/events?limit=50`);
  if (!events || !Array.isArray(events.events)) return ev;
  let bestAddr = null,
    bestTs = 0;
  for (const e of events.events) {
    const ts = e.timestamp || 0;
    if (ts <= bestTs) continue;
    for (const act of e.actions || []) {
      if (act.type !== "NftItemTransfer") continue;
      const tr = act.NftItemTransfer || {};
      if ((tr.sender?.address || tr.sender) !== b.col.address) continue;
      bestAddr = tr.nft;
      bestTs = ts;
    }
  }
  if (!bestAddr) return ev;
  const item = await tonapi(`/v2/nfts/${bestAddr}`);
  if (!item) return ev;
  const meta = parseMetaName(item.metadata?.name, item.index);
  if (meta.hasNumber) {
    ev.number = meta.index;
    ev.giftDisplay = ((item.metadata?.name || "").split(" #")[0].trim()) || ev.giftDisplay;
  }
  ev.ownerAddr = item.owner?.address || "";
  if (ev.ownerAddr) {
    const acc = await tonapi(`/v2/accounts/${ev.ownerAddr}`);
    const nm = acc?.name || "";
    ev.ownerName = nm && nm !== ev.ownerAddr ? nm : "";
  }
  ev.mintTime = bestTs || NOW();
  return ev;
}

// ---------- main ----------
let SWEEP_CHANGED = false;

async function main() {
  SWEEP_CHANGED = false;
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    state = {};
  }
  const cols = require(COLS_FILE);
  const subs = decryptSubs();
  console.log(`коллекций: ${cols.length}, подписчиков: ${subs.length}`);

  const hour = hourSamarkand();
  const night = hour >= 23 || hour < 8;

  let checked = 0,
    errors = 0,
    baselined = 0,
    detected = 0,
    sent = 0,
    skipped = 0;

  // 1) официальные счётчики (надёжно, без ключей)
  const bumps = [];
  const bumpLogs = [];
  const gifts = [];
  await pool(cols, 10, async (c) => {
    const st =
      state[c.name] ||
      (state[c.name] = { issued: 0, sample: 1, lastSentTime: 0, lastSentNum: 0 });
    const cnt = await tgCounter(c.name, st.sample || 1);
    if (!cnt) {
      errors++;
      return;
    }
    checked++;
    gifts.push({ slug: c.name, name: c.display_name || c.name, issued: cnt.issued, total: cnt.total });
    if (!st.issued) {
      st.issued = cnt.issued;
      st.sample = cnt.sample;
      baselined++; SWEEP_CHANGED = true;
      return;
    }
    if (cnt.issued > st.issued) {
      bumps.push({ col: c, issued: cnt.issued, total: cnt.total });
    SWEEP_CHANGED = true;
      st.issued = cnt.issued;
      st.sample = cnt.sample;
    } else if (cnt.issued < st.issued) {
      st.issued = cnt.issued;
      st.sample = cnt.sample;
    }
  });

  console.log(`счётчиков проверено: ${checked}, ошибок: ${errors}, baseline: ${baselined}, апгрейдов: ${bumps.length}`);

  // 2) обогащение + доставка
  for (const b of bumps) {
    const st = state[b.col.name];
    if (st.lastSentNum === b.issued) {
      skipped++;
      continue;
    }
    if (st.lastSentTime && NOW() - st.lastSentTime < 60) {
      skipped++;
      continue;
    }
    detected++;
    const ev = await enrich(b);
    const img = await giftImage(b.col.name, ev.number || b.issued);
    const text = buildMessage(ev);
    let sentThis = 0;
    for (const s of subs) {
      if (night && s.night_mode) continue;
      if (s.radar_mode) continue;
      const muted = (s.muted_gifts || []).some((m) => String(m || "").toLowerCase() === b.col.name.toLowerCase());
      if (muted) continue;
      const fm = String(s.filter_model || "").trim().toLowerCase();
      const fb = String(s.filter_backdrop || "").trim().toLowerCase();
      if (fm || fb) continue; // фильтр-пользователи обслуживаются только основным ботом (нет данных модели здесь)
      const r = await tg("sendMessage", {
        chat_id: String(s.chat_id || s.telegram_id),
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: false },
      });
      if (r && r.ok) sentThis++;
      if (r && r.error_code === 429) await sleep(Math.min(3, Number(r.parameters?.retry_after) || 1) * 1000);
    }
    sent += sentThis;
    bumpLogs.push({
      slug: b.col.name,
      gift: ev.giftDisplay || b.col.display_name || b.col.name,
      number: ev.number || b.issued,
      owner: ev.ownerName || "",
      owner_addr: ev.ownerAddr || "",
      mint: ev.mintTime || 0,
      counter_issued: ev.counter ? ev.counter.issued : b.issued,
      counter_total: ev.counter ? ev.counter.total : b.total,
      img: img || "",
      sent: sentThis,
      time: new Date().toISOString(),
    });
    st.lastSentTime = NOW();
    st.lastSentNum = b.issued;
    console.log(`апгрейд: ${b.col.name} #${b.issued}, отправлено: ${sentThis}`);
  }

  console.log(`ИТОГ: detected=${detected}, sent=${sent}, skipped=${skipped}, errors=${errors}`);

  // 3) статусная страница (GitHub Pages)
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")); } catch {}
  try {
    fs.mkdirSync(path.join(REPO_ROOT, "docs"), { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      updated: new Date().toISOString(),
      updated_unix: NOW(),
      runs: (prev.runs || 0) + 1,
      collections: cols.length,
      checked: checked,
      errors: errors,
      detected_total: (prev.detected_total || 0) + detected,
      sent_total: (prev.sent_total || 0) + sent,
      last_upgrades: [...(prev.last_upgrades || []), ...bumpLogs].slice(-30),
    }, null, 1));
  } catch (e) { console.log("status.json:", String(e).slice(0, 80)); }

  // таблица всех подарков для сайта
  try {
    fs.writeFileSync(path.join(REPO_ROOT, "docs", "gifts.json"), JSON.stringify({
      updated: new Date().toISOString(),
      updated_unix: NOW(),
      count: gifts.length,
      gifts: gifts.sort((a, b) => a.name.localeCompare(b.name)),
    }, null, 1));
  } catch (e) { console.log("gifts.json:", String(e).slice(0, 80)); }

  // 4) state + коммит (с ретраем на гонку пушей)
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  try {
    execSync('git config user.name "gift-monitor"', { cwd: REPO_ROOT });
    execSync('git config user.email "actions@github.com"', { cwd: REPO_ROOT });
    if (!SWEEP_CHANGED && process.env.FRESH_COMMIT !== "1") {
      console.log("state: без изменений, коммит пропущен");
      return;
    }
    execSync("git add data/state-full.json docs/status.json docs/gifts.json", { cwd: REPO_ROOT });
    execSync('git commit -m "monitor: state update [skip ci]"', { cwd: REPO_ROOT, stdio: "pipe" });
    try {
      execSync("git push", { cwd: REPO_ROOT, stdio: "pipe" });
    } catch {
      execSync("git pull --rebase --autostash", { cwd: REPO_ROOT, stdio: "pipe" });
      execSync("git push", { cwd: REPO_ROOT, stdio: "pipe" });
    }
    console.log("state: закоммичен");
  } catch (e) {
    console.log("state: коммит не потребовался:", String(e.message).slice(0, 100));
  }
}

(async () => {
  try {
    if (MODE === "sendtest") {
      await sendTest();
      return;
    }
    if (!FORCE) {
      let enabled = false;
      try {
        enabled = JSON.parse(fs.readFileSync(ENABLED_FILE, "utf8")).enabled === true;
      } catch {}
      if (!enabled) {
        console.log("STANDBY: выключен (data/enabled-full.json → enabled=true для активации). Выход.");
        process.exit(0);
      }
    }
    if (process.env.EVENT_NAME === "schedule") {
      // 24/7 реалтайм-режим: цикл свипов внутри одного прогона (~75с между проверками)
      const BUDGET_MS = 300_000; // 5 минут, дальше эстафета следующему тику
      const t0 = Date.now();
      let n = 0;
      while (Date.now() - t0 < BUDGET_MS) {
        const sweepStart = Date.now();
        n++;
        process.env.FRESH_COMMIT = (n % 8 === 0) ? "1" : "0"; // свежесть бейджа раз в ~10 мин
        await main();
        const wait = 75_000 - (Date.now() - sweepStart);
        if (wait > 200 && Date.now() - t0 + wait < BUDGET_MS) await sleep(wait);
      }
      console.log("LOOP: свипов за прогон: " + n);
      // эстафета: сами запускаем следующий прогон (крон GitHub капризничает)
      try {
        const r = execSync(
          `curl -s -o /dev/null -w "%{http_code}" -X POST ` +
          `-H "Authorization: Bearer ${process.env.GITHUB_TOKEN}" ` +
          `-H "Accept: application/vnd.github+json" ` +
          `https://api.github.com/repos/jethubvideo-code/gifttracker-bot/actions/workflows/full-monitor.yml/dispatches ` +
          `-d '{"ref":"main"}'`,
          { encoding: "utf8" }
        );
        console.log("эстафета: следующий прогон запущен (" + r.trim() + ")");
      } catch (e) {
        console.log("эстафета не удалась, крон-страховка подхватит:", String(e.message).slice(0, 80));
      }
    } else {
      await main();
    }
  } catch (e) {
    console.error("FATAL:", String(e).slice(0, 300));
    process.exit(1);
  }
})();
