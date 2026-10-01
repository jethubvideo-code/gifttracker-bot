#!/usr/bin/env node
/**
 * Gift Monitor — GitHub Actions edition (одноразовый прогон).
 * Тот же движок, что у бота, но запускается на серверах GitHub (бесплатно).
 *
 * Режимы:
 *   (без аргументов)  — обычный прогон: смотрит data/enabled.json;
 *                        если enabled=false — сразу выходит (standby mode)
 *   force             — прогнать даже если standby выключен (тест)
 *   sendtest          — тестовое сообщение владельцу (проверка токена)
 *
 * State: data/state.json (коммитится обратно в репо после прогона)
 * Подписчики: data/subscribers.enc (AES-256, ключ в секретах репо)
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
  for (let i = 1; i <= 2; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const r = await res.json().catch(() => null);
      if (r && r.error_code === 429) {
        await sleep(Math.min(3, Number(r.parameters?.retry_after) || 1) * 1000);
        continue;
      }
      return r;
    } catch {}
    if (i < 2) await sleep(1000);
  }
  return null;
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

async function ownerName(addr) {
  if (!addr) return "";
  const acc = await tonapi(`/v2/accounts/${addr}`);
  const name = acc?.name || "";
  return name && name !== addr ? String(name) : "";
}

// официальный счётчик t.me/nft/<slug>-<n>
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
      if (issued > 0 && total > 0) return { issued, total };
    } catch {}
  }
  return null;
}

function decryptSubs() {
  if (!fs.existsSync(SUBS_FILE)) return [];
  try {
    const out = execSync(
      `openssl enc -d -aes-256-cbc -pbkdf2 -pass 'pass:${CRYPT_KEY}' -in "${SUBS_FILE}"`,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
    );
    const d = JSON.parse(out);
    return Array.isArray(d) ? d : (d.subscribers || []);
  } catch (e) {
    console.log("subscribers decrypt failed:", String(e).slice(0, 120));
    return [];
  }
}

function fmtOwner(addr, name) {
  if (!addr) return "";
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

  let text =
    `🚀 НОВОЕ УЛУЧШЕНИЕ: ${esc(title)}!\n\n` +
    `🎁 Подарок: ${esc(gift)}\n` +
    (num ? `🏷️ NFT: #${num.toLocaleString("ru-RU")}\n` : "") +
    (ev.owner ? `👤 Владелец: ${fmtOwner(ev.ownerAddr, ev.ownerName)}\n` : "") +
    `🕐 Улучшено: ${ago}\n` +
    (ev.counter ? `📊 Улучшено всего (Telegram): ${ev.counter.issued.toLocaleString("ru-RU")} из ${ev.counter.total.toLocaleString("ru-RU")}\n` : "") +
    (ev.batch > 1 ? `⚡️ Улучшений в эту минуту: ${ev.batch}\n` : "") +
    `\n🔗 <a href="${link}">Подарок</a> · <a href="https://t.me/mrkt">MRKT</a> · <a href="https://t.me/portals">Portals</a>\n\n` +
    `#TelegramGifts #NFT #${ev.slug}`;
  return text;
}

// ---------- sendtest: проверка доставки ----------
async function sendTest() {
  const subs = decryptSubs();
  const owner = subs.find((s) => String(s.telegram_id) === OWNER_ID) || { chat_id: OWNER_ID };
  const r = await tg("sendMessage", {
    chat_id: String(owner.chat_id),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    text:
      "✅ <b>Gift Monitor — standby engine</b>\n\n" +
      "Это тестовое сообщение с серверов GitHub Actions.\n" +
      "Движок работает: токен живой, доставка идёт.\n\n" +
      "Сейчас движок в режиме ожидания (enabled=false). Основной бот на Base44 продолжает слать уведомления. Если он встанет — один флаг в data/enabled.json переключает доставку на GitHub.",
  });
  console.log("sendtest:", r?.ok ? "✅ доставлено владельцу" : "❌ " + JSON.stringify(r).slice(0, 200));
  process.exit(r?.ok ? 0 : 1);
}

// ---------- main ----------
async function main() {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    state = {};
  }

  const cols = require(COLS_FILE).filter((c) => c.address);
  const subs = decryptSubs();
  console.log(`коллекций: ${cols.length}, подписчиков: ${subs.length}`);

  const hour = hourSamarkand();
  const night = hour >= 23 || hour < 8;

  const queue = [];
  let checked = 0,
    err = 0,
    baselined = 0,
    detected = 0,
    sent = 0,
    skipped = 0;

  // 1) события минта по всем коллекциям
  await pool(cols, 10, async (c) => {
    const st = state[c.name] || (state[c.name] = { lastTs: 0, seen: [], lastSentTime: 0, lastSentNum: 0 });
    const data = await tonapi(`/v2/accounts/${c.address}/events?limit=50`);
    checked++;
    if (!data || !Array.isArray(data.events)) {
      err++;
      return;
    }
    let maxTs = st.lastTs;
    const fresh = [];
    for (const ev of data.events) {
      const ts = ev.timestamp || 0;
      if (ts > maxTs) maxTs = ts;
      if (st.lastTs && ts <= st.lastTs - 120) continue;
      for (const act of ev.actions || []) {
        if (act.type !== "NftItemTransfer") continue;
        const t = act.NftItemTransfer || {};
        if ((t.sender?.address || t.sender) !== c.address) continue;
        const nft = t.nft;
        if (!nft || st.seen.includes(nft) || fresh.includes(nft)) continue;
        fresh.push(nft);
        queue.push({ col: c, addr: nft, ts: ts || NOW() });
      }
    }
    if (!st.lastTs) {
      // первый прогон по коллекции: baseline, старьё не шлём
      st.lastTs = Math.max(maxTs, NOW() - 60);
      st.seen = fresh.slice(0, 40);
      baselined++;
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].col.name === c.name) queue.splice(i, 1);
      return;
    }
    st.lastTs = Math.max(st.lastTs, maxTs);
    st.seen = [...new Set([...fresh, ...st.seen])].slice(0, 40);
  });

  console.log(`событий проверено: ${checked}, ошибок: ${err}, baseline: ${baselined}, новых NFT: ${queue.length}`);

  // 2) группируем по коллекции, шлём по одному сообщению на подарок
  const byCol = new Map();
  for (const e of queue) {
    if (!byCol.has(e.col.name)) byCol.set(e.col.name, []);
    byCol.get(e.col.name).push(e);
  }

  for (const [name, evs] of byCol) {
    const st = state[name];
    if (!st) continue;
    // подавление как в боте: 60 сек окно + тот же номер счётчика
    if (st.lastSentTime && NOW() - st.lastSentTime < 60) {
      skipped++;
      continue;
    }
    let best = evs[0];
    for (const e of evs) if ((e.ts || 0) > (best.ts || 0)) best = e;
    detected += evs.length;

    const item = await tonapi(`/v2/nfts/${best.addr}`);
    if (!item) {
      err++;
      continue;
    }
    const meta = parseMetaName(item.metadata?.name, item.index);
    const attrs = {};
    const raw = item.metadata?.attributes;
    if (Array.isArray(raw)) for (const a of raw) attrs[String(a.trait_type || "").toLowerCase()] = a.value;
    else if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) attrs[k.toLowerCase()] = String(v);

    const slug = meta.slug || name;
    const counter = await tgCounter(slug, meta.index || 1);
    if (counter && st.lastSentNum && counter.issued === st.lastSentNum) {
      skipped++;
      continue;
    }

    const ownerAddr = item.owner?.address || "";
    const ownerNm = ownerAddr ? await ownerName(ownerAddr) : "";

    const ev = {
      slug,
      giftDisplay: meta.hasNumber ? (item.metadata?.name || "").trim() : name,
      number: meta.index || (counter ? counter.issued : null),
      owner: ownerAddr,
      ownerAddr,
      ownerName: ownerNm,
      mintTime: best.ts,
      counter,
      batch: evs.length,
    };

    const text = buildMessage(ev);
    let sentThis = 0;
    for (const sub of subs) {
      if (night && sub.night_mode) continue;
      if (sub.radar_mode) continue;
      const muted = (sub.muted_gifts || []).some((m) => String(m || "").toLowerCase() === slug.toLowerCase());
      if (muted) continue;
      const fm = String(sub.filter_model || "").trim().toLowerCase();
      const fb = String(sub.filter_backdrop || "").trim().toLowerCase();
      if (fm && !String(attrs.model || "").toLowerCase().includes(fm)) continue;
      if (fb && !String(attrs.backdrop || "").toLowerCase().includes(fb)) continue;
      const r = await tg("sendMessage", {
        chat_id: String(sub.chat_id || sub.telegram_id),
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: false },
      });
      if (r?.ok) sentThis++;
    }
    sent += sentThis;
    st.lastSentTime = NOW();
    if (counter) st.lastSentNum = counter.issued;
  }

  console.log(`ИТОГ: detected=${detected}, sent=${sent}, skipped=${skipped}, errors=${err}`);

  // 3) сохраняем state и коммитим
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 0));
  try {
    execSync('git config user.name "gift-monitor"', { cwd: REPO_ROOT });
    execSync('git config user.email "actions@github.com"', { cwd: REPO_ROOT });
    execSync("git add data/state-full.json", { cwd: REPO_ROOT });
    execSync('git commit -m "monitor: state update [skip ci]"', { cwd: REPO_ROOT, stdio: "pipe" });
    execSync("git push", { cwd: REPO_ROOT, stdio: "pipe" });
    console.log("state: закоммичен");
  } catch (e) {
    console.log("state: коммит не потребовался или push конфликт:", String(e.message).slice(0, 120));
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
        console.log("STANDBY: выключен (data/enabled.json → enabled=true для активации). Выход.");
        process.exit(0);
      }
    }
    await main();
  } catch (e) {
    console.error("FATAL:", String(e).slice(0, 300));
    process.exit(1);
  }
})();
