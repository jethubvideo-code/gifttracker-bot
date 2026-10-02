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
 * ВАЖНО: включать (enabled-full=true) ТОЛЬКО когда дублирующий монитор выключен,
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
const HIST_FILE = path.join(REPO_ROOT, "docs", "history.json");

const TONAPI_KEY = process.env.TONAPI_KEY || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CRYPT_KEY = process.env.CRYPT_KEY || "";
const OWNER_ID = "8396883978";
const NOW = () => Math.floor(Date.now() / 1000);

const MODE = (process.env.MODE || process.argv[2] || "").toLowerCase();
const FORCE = MODE === "force" || ["true", "chain"].includes(process.env.FORCE || "") || process.argv[2] === "force";

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
    const url = m ? m[1] || m[2] || "" : "";
    // ЩИТ: og:image = дефолтный логотип Telegram → страница-заглушка, НЕ картинка подарка
    return url && !url.includes("telegram.org/img") ? url : "";
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

function encryptSubs(list) {
  try {
    const plain = SUBS_FILE + ".plain";
    fs.writeFileSync(plain, JSON.stringify({ subscribers: list }));
    execSync(`openssl enc -aes-256-cbc -pbkdf2 -salt -pass 'pass:${CRYPT_KEY}' -in "${plain}" -out "${SUBS_FILE}"`, { stdio: "pipe" });
    try { fs.unlinkSync(plain); } catch {}
    return true;
  } catch (e) {
    console.log("encryptSubs failed:", String(e).slice(0, 120));
    return false;
  }
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

// диапазонное обогащение: последние `count` трансферов коллекции (по возрастанию времени)
async function enrichRange(b, count, winStart, winEnd) {
  const out = [];
  if (!b.col.address) return out;
  const events = await tonapi(`/v2/accounts/${b.col.address}/events?limit=50`);
  if (!events || !Array.isArray(events.events)) return out;
  const transfers = [];
  for (const e of events.events) {
    for (const act of e.actions || []) {
      if (act.type !== "NftItemTransfer") continue;
      const tr = act.NftItemTransfer || {};
      if ((tr.sender?.address || tr.sender) !== b.col.address) continue;
      transfers.push({ nft: tr.nft, ts: e.timestamp || 0 });
    }
  }
  transfers.sort((x, y) => x.ts - y.ts);
  // ОКНО БАМПА: берём только трансферы, случившиеся между свипами — именно этот апгрейд.
  // Протухший тонапи (трансферы на 10-20 мин старьё) — шум, его номера/время/владелец НЕ прикрепляются к свежему номеру.
  const inWin = transfers.filter((t) => t.ts && t.ts >= winStart && t.ts <= winEnd);
  // FIFO: берём СТАРЕЙШИЕ count трансферы окна (выравнивание под oldest-first доставку),
  // при обычном прыжке 1-8 это то же самое, что и последние
  const chosen = inWin.length > count ? inWin.slice(0, count) : inWin.slice(-count);
  for (let i = 0; i < chosen.length; i++) {
    const t = chosen[i];
    const ev = { number: 0, ownerAddr: "", ownerName: "", mintTime: t.ts, giftDisplay: "" };
    try {
      const item = await tonapi(`/v2/nfts/${t.nft}`);
      if (item) {
        const meta = parseMetaName(item.metadata?.name, item.index);
        if (meta.hasNumber) {
          ev.number = meta.index;
          ev.giftDisplay = ((item.metadata?.name || "").split(" #")[0].trim()) || "";
        }
        ev.ownerAddr = item.owner?.address || "";
        if (ev.ownerAddr && i === chosen.length - 1) { // имя владельца только для самого свежего — экономия тонапи
          const acc = await tonapi(`/v2/accounts/${ev.ownerAddr}`);
          const nm = acc?.name || "";
          ev.ownerName = nm && nm !== ev.ownerAddr ? nm : "";
        }
      }
    } catch {}
    out.push(ev);
  }
  return out;
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
      "Движок умеет сам: счётчики → детект → обогащение → доставка. Полностью автономен.\n\n" +
      "Сейчас режим ожидания (enabled-full=false). Для активации: выключить дублирующий монитор и поставить enabled-full=true.",
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


/* ═══════════ ПАРТНЁРСКАЯ ВИТРИНА: публикация заявок бота → docs/partners.json ═══════════
   100% GitHub: бот пишет заявки в data/partners.json, движок скачивает логотипы
   (getFile → docs/p/<id>.jpg), нормализует ссылки и публикует статический JSON для сайта. */
function normSite(v) {
  v = String(v || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v.replace(/^http:/i, "https:");
  return "https://" + v.replace(/\s+/g, "");
}
function normTg(v) {
  v = String(v || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v.replace(/^http:/i, "https:");
  v = v.replace(/^@/, "").replace(/\/$/, "");
  if (!v) return "";
  return "https://t.me/" + encodeURIComponent(v.replace(/[^A-Za-z0-9_]/g, ""));
}
function normIg(v) {
  v = String(v || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v.replace(/^http:/i, "https:");
  v = v.replace(/^@/, "").replace(/\/$/, "");
  if (!v) return "";
  return "https://instagram.com/" + v.replace(/[^A-Za-z0-9._/]/g, "");
}

async function publishPartners() {
  try {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data", "partners.json"), "utf8")); } catch { return; }
    if (!Array.isArray(list)) return;
    let dirty = false;
    // логотипы: качаем один раз, путь запоминаем в заявке
    for (const e of list) {
      if (e.logo_file_id && !e.logo_file) {
        try {
          const g = await tg("getFile", { file_id: e.logo_file_id });
          if (g && g.ok && g.result && g.result.file_path) {
            const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${g.result.file_path}`;
            const res = await fetch(url);
            if (res && res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              fs.mkdirSync(path.join(REPO_ROOT, "docs", "p"), { recursive: true });
              const fname = "p/" + String(e.id).replace(/[^A-Za-z0-9_-]/g, "") + ".jpg";
              fs.writeFileSync(path.join(REPO_ROOT, "docs", fname), buf);
              e.logo_file = fname;
              console.log(`партнёрский логотип скачан: ${fname} (${Math.round(buf.length / 1024)}КБ)`);
            } else { e.logo_file_id = ""; }
          } else { e.logo_file_id = ""; }
          dirty = true;
        } catch { e.logo_file_id = ""; dirty = true; }
      }
    }
    if (dirty) {
      try { fs.writeFileSync(path.join(REPO_ROOT, "data", "partners.json"), JSON.stringify(list, null, 1)); } catch {}
    }
    // публикация: дедуп по названию+ссылкам, витрина максимум 300
    const seen = new Set();
    const items = [];
    // идём от НОВЕЙШИХ к старым: первый (новейший) экземпляр ключа остаётся, витрина = новые сверху
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.name) continue;
      const siteN = normSite(e.site), tgN = normTg(e.tg), igN = normIg(e.ig);
      // дедуп по НОРМАЛИЗОВАННЫМ ссылкам: @starcoffee == t.me/starcoffee
      const k = (String(e.name) + "|" + siteN + "|" + tgN + "|" + igN).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({
        id: String(e.id),
        name: String(e.name).slice(0, 60),
        description: String(e.desc || "").slice(0, 200),
        site_url: siteN,
        telegram: tgN,
        instagram: igN,
        logo: e.logo_file || "",
      });
      if (items.length >= 300) break;
    }
    const out = JSON.stringify({ updated: new Date().toISOString(), updated_unix: NOW(), count: items.length, items }, null, 1);
    let prev = null;
    try { prev = fs.readFileSync(path.join(REPO_ROOT, "docs", "partners.json"), "utf8"); } catch {}
    if (prev !== out) {
      fs.writeFileSync(path.join(REPO_ROOT, "docs", "partners.json"), out);
      console.log(`партнёры: опубликовано ${items.length}`);
    }
  } catch (e) { console.log("партнёры:", String(e).slice(0, 100)); }
}

async function main() {

  SWEEP_CHANGED = false;
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    state = {};
  }
  const cols = require(COLS_FILE);
  let subs = decryptSubs();
  console.log(`full-job v11 (бот на борту): коллекций: ${cols.length}, подписчиков: ${subs.length}`);
  // 🤖 БОТ БЕЗ ВНЕШНИХ СЕРВИСОВ: getUpdates-поллинг прямо здесь, на GitHub Actions
  try {
    const bot = require("./bot.js");
    const botOut = await bot.poll({ tg, subs, state });
    if (botOut.subsChanged && encryptSubs(subs)) {
      SWEEP_CHANGED = true;
      console.log("бот: подписчики сохранены локально");
    }
  } catch (e) {
    console.log("бот: сбой поллинга:", String(e).slice(0, 120));
  }

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
    st.prevSweepTs = st.lastSweepTs || 0; // окно бампа = [prevSweep..now] — бамп случился внутри него
    st.lastSweepTs = NOW();
    gifts.push({ slug: c.name, name: c.display_name || c.name, issued: cnt.issued, total: cnt.total, added: Number(c.added) || 0 });
    if (!st.issued) {
      st.issued = cnt.issued;
      st.sample = cnt.sample;
      baselined++; SWEEP_CHANGED = true;
      return;
    }
    if (cnt.issued > st.issued) {
      bumps.push({ col: c, issued: cnt.issued, prev: st.issued, total: cnt.total });
    SWEEP_CHANGED = true;
      st.issued = cnt.issued;
      st.sample = cnt.sample;
    } else if (cnt.issued < st.issued) {
      // официальные счётчики только растут: снижение = протухший кэш t.me — игнорируем,
      // иначе следующий свип увидит ложный «бамп» и повторно скинет старьё
    }
  });

  console.log(`счётчиков проверено: ${checked}, ошибок: ${errors}, baseline: ${baselined}, апгрейдов: ${bumps.length}`);

  // 2) обогащение + доставка: ВСЕ номера диапазона (не только последний счётчик)
  const sweepEvents = []; // батчи этого свипа для рассылки (все коллекции → юзеру 1-2 сообщения)
  for (const b of bumps) {
    const st = state[b.col.name];
    // ДВОЙНАЯ ПРОВЕРКА НОМЕРА: t.me мог отдать протухший кэш — перепроверяем счётчик в момент доставки,
    // юзер видит именно тот номер, который улучшен СЕЙЧАС
    try {
      const re = await tgCounter(b.col.name, st.sample || 1);
      if (re && re.issued > b.issued) {
        console.log(`уточнение счётчика ${b.col.name}: ${b.issued} → ${re.issued}`);
        b.issued = re.issued;
        st.issued = re.issued;
      }
    } catch {}
    const winStart = (st.prevSweepTs || NOW() - 180) - 120; // окно бампа с запасом
    const winEnd = NOW() + 120;
    let from = (st.lastSentNum || b.prev || 0) + 1; // от последнего ДОСТАВЛЕННОГО+1: бэклог не теряется
    if (from > b.issued) { skipped++; continue; } // дубль — уже всё доставлено
    // FIFO-бэклог: кап 30/свип, СТАРЕЙШИЕ первыми; ЛЕНТА получает ВСЕ номера СРАЗУ (сайт не отстаёт никогда).
    // Сообщения — БАТЧАМИ: вся пачка свипа = 1-2 сообщения юзеру (штормы не душат лимиты Telegram).
    const total = b.issued - from + 1;
    const count = Math.min(total, 30);
    if (total > count) console.log(`кэтч-ап ${b.col.name}: очередь ${total}, свип ${count} (в ленте все ${total} уже сейчас)`);
    const metas = await enrichRange(b, Math.min(count, 12), winStart, winEnd);
    const colImg = await giftImage(b.col.name, b.issued); // 1 картинка на коллекцию за свип (не 30 запросов к t.me)
    const evs = [];
    for (let i = 0; i < count; i++) {
      const n = from + i;
      const mIdx = i - (count - metas.length);
      const m = mIdx >= 0 && mIdx < metas.length ? metas[mIdx] : {};
      const mOk = !!(m.mintTime && m.mintTime >= winStart && m.mintTime <= winEnd);
      const ev = {
        slug: b.col.name,
        giftDisplay: (mOk ? m.giftDisplay || "" : "") || b.col.display_name || b.col.name,
        number: n,
        ownerAddr: mOk ? m.ownerAddr || "" : "",
        ownerName: mOk ? m.ownerName || "" : "",
        mintTime: mOk ? m.mintTime : 0,
        counter: { issued: n, total: b.total },
      };
      // ЛЕНТА ЗАПИСЫВАЕТСЯ ВСЕГДА и ДО любых проверок доставки — лента сайта мгновенна
      bumpLogs.push({
        slug: b.col.name, gift: ev.giftDisplay, number: n,
        owner: ev.ownerName || "", owner_addr: ev.ownerAddr || "",
        mint: ev.mintTime, counter_issued: n, counter_total: b.total,
        img: colImg || "", sent: 0, time: new Date().toISOString(),
      });
      // СВЕЖЕСТЬ — только для ЛИЧНЫХ СООБЩЕНИЙ: старьё не рассылаем (но в ленте оно уже есть)
      const FRESH_SEC = 1200;
      const metaFresh = ev.mintTime && NOW() - ev.mintTime <= FRESH_SEC;
      const windowFresh = st.prevSweepTs && NOW() - st.prevSweepTs <= FRESH_SEC;
      if (!metaFresh && !windowFresh) {
        st.lastSentNum = n;
        skipped++;
        console.log(`пропуск старого в рассылке: ${b.col.name} #${n} (в ленте он есть)`);
        continue;
      }
      if (!ev.mintTime || ev.mintTime < NOW() - FRESH_SEC) ev.mintTime = NOW() - 60;
      evs.push(ev);
    }
    // хвост очереди (>30) — тоже в ленту немедленно, доставится след. свипами
    for (let n = from + count; n <= b.issued; n++) {
      bumpLogs.push({ slug: b.col.name, gift: b.col.display_name || b.col.name, number: n, owner: "", owner_addr: "", mint: 0, counter_issued: n, counter_total: b.total, img: colImg || "", sent: 0, time: new Date().toISOString() });
    }
    st.lastSentNum = from + count - 1; // маркер на конец обработанного диапазона (старьё+лента учтены)
    if (evs.length) {
      detected += evs.length;
      const lastEv = evs[evs.length - 1];
      const lk = String(lastEv.ownerName || lastEv.ownerAddr || "").trim();
      if (lk) { st.leaders = st.leaders || {}; st.leaders[lk] = (st.leaders[lk] || 0) + 1; }
      st.lastSentTime = NOW();
      sweepEvents.push({ col: b.col, evs, from, to: from + evs.length - 1 });
      console.log(`апгрейды: ${b.col.name} #${from}-${from + evs.length - 1} (${evs.length} шт) → батч-рассылка`);
    }
  }

  // 2.1) БАТЧ-ДОСТАВКА: каждому юзеру ОДНО сообщение со всеми апгрейдами свипа (шторм = 2-3 максимум)
  if (sweepEvents.length) {
    const targets = subs.filter((s) => !s.radar_mode);
    let msgTotal = 0;
    let evTotal = 0;
    for (const g of sweepEvents) evTotal += g.evs.length;
    const stormBlock = (g) => { // шторм-группа: диапазон + полная карточка самого свежего
      const first = g.evs[0], last = g.evs[g.evs.length - 1];
      const gift = String(g.col.display_name || g.col.name);
      const l1 = `https://t.me/nft/${g.col.name.toLowerCase()}-${first.number}`;
      const l2 = `https://t.me/nft/${g.col.name.toLowerCase()}-${last.number}`;
      return (
        `🚀 <b>${esc(gift)}: ${g.evs.length} новых апгрейдов</b>\n` +
        `🏷️ #${first.number.toLocaleString("ru-RU")} → #${last.number.toLocaleString("ru-RU")} · <a href="${l1}">первый</a> · <a href="${l2}">последний</a>\n\n` +
        buildMessage(last)
      );
    };
    const subText = (s) => { // текст свипа под конкретного юзера (мьюты/фильтры уважаем)
      const parts = [];
      for (const g of sweepEvents) {
        const muted = (s.muted_gifts || []).some((m2) => String(m2 || "").toLowerCase() === g.col.name.toLowerCase());
        if (muted) continue;
        const fm = String(s.filter_model || "").trim().toLowerCase();
        const fb = String(s.filter_backdrop || "").trim().toLowerCase();
        if (fm || fb) continue;
        if (g.evs.length <= 3) for (const ev of g.evs) parts.push(buildMessage(ev));
        else parts.push(stormBlock(g));
      }
      if (!parts.length) return null;
      if (parts.length > 1) return `⚡️ <b>СВОДКА СВИПА: ${evTotal} апгрейд${evTotal === 1 ? "" : "ов"}</b>\n\n` + parts.join("\n\n➖➖➖\n\n");
      return parts.join("\n\n");
    };
    const splitMsg = (text) => { // лимит 4096: режем по границам блоков
      const blocks = text.split("\n\n➖➖➖\n\n");
      const chunks = [];
      let cur = "";
      for (const bl of blocks) {
        if (cur && (cur + "\n\n➖➖➖\n\n" + bl).length > 3800) { chunks.push(cur); cur = bl; }
        else cur = cur ? cur + "\n\n➖➖➖\n\n" + bl : bl;
      }
      if (cur) chunks.push(cur);
      return chunks.length ? chunks : [text.slice(0, 3800)];
    };
    const sendTG = async (chat, text, silent) => { // sendMessage с 429-ретраем — сообщение НЕ теряется
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_notification: silent, link_preview_options: { is_disabled: false } });
        if (r && r.ok) { msgTotal++; return true; }
        if (r && r.error_code === 429) { await sleep(Math.min(10, Number(r.parameters?.retry_after) || 1) * 1000); continue; }
        return false;
      }
      return false;
    };
    const sendBatch = async (s) => {
      const txt = subText(s);
      if (!txt) return;
      const silent = !!(night && s.night_mode);
      const chat = String(s.chat_id || s.telegram_id);
      for (const chunk of splitMsg(txt)) await sendTG(chat, chunk, silent);
      // 🎯 «ТВОЙ ПОДАРОК УЛУЧШЕН» — все свои номера юзера за свип одним сообщением
      const mineLines = [];
      for (const g of sweepEvents) {
        const mgList = Array.isArray(s.my_gifts) ? s.my_gifts : [];
        for (const mgx of mgList) {
          const pp = String(mgx || "").split(":");
          const mn = parseInt(pp[1], 10);
          if (!mn || String(pp[0] || "").trim().toLowerCase() !== g.col.name.toLowerCase()) continue;
          const hit = g.evs.find((ev) => ev.number === mn);
          if (!hit) continue;
          const lnk = `https://t.me/nft/${g.col.name.toLowerCase()}-${mn}`;
          mineLines.push(
            `🎯 <b>ТВОЙ ПОДАРОК УЛУЧШЕН!</b>\n\n` +
            `🎁 ${esc(g.col.display_name || g.col.name)} #${mn.toLocaleString("ru-RU")} → NFT\n` +
            (hit.ownerAddr || hit.ownerName ? `👤 Владелец: ${fmtOwner(hit.ownerAddr, hit.ownerName)}\n` : "") +
            `\n🔗 <a href="${lnk}">Твой подарок</a> · <a href="https://t.me/mrkt">MRKT</a> · <a href="https://t.me/portals">Portals</a>\n\n` +
            `#TelegramGifts #NFT #${g.col.name}`
          );
        }
      }
      if (mineLines.length) {
        const mineTxt = mineLines.length === 1 ? mineLines[0] : `🎯 <b>ТВОИ ПОДАРКИ УЛУЧШЕНЫ (${mineLines.length})</b>\n\n` + mineLines.join("\n\n➖➖➖\n\n");
        for (const chunk of splitMsg(mineTxt)) await sendTG(chat, chunk, silent);
      }
    };
    const tArr = targets.slice();
    let tIdx2 = 0;
    const workers = Array.from({ length: 6 }, async () => { while (tIdx2 < tArr.length) { const sj = tArr[tIdx2++]; await sendBatch(sj); } });
    await Promise.all(workers);
    sent += msgTotal;
    console.log(`батч-рассылка: ${evTotal} апгрейдов → ${targets.length} юзеров = ${msgTotal} сообщений (индивидуально было бы ${evTotal * targets.length})`);
  }

  console.log(`ИТОГ: detected=${detected}, sent=${sent}, skipped=${skipped}, errors=${errors}`);

  // 2.5) история: почасовые вёдра для графиков сайта (активность 24ч + ETA-прогнозы + тикер «сегодня»)
  try {
    let hist = {};
    try { hist = JSON.parse(fs.readFileSync(HIST_FILE, "utf8")); } catch {}
    if (!Array.isArray(hist.hours)) hist.hours = [];
    const hourTs = Math.floor(NOW() / 3600) * 3600;
    let bucket = hist.hours.find((h) => h.ts === hourTs);
    if (!bucket) { bucket = { ts: hourTs, detected: 0, issued: {} }; hist.hours.push(bucket); }
    bucket.detected += detected + skipped; // всё случившееся: доставленное + молча пропущенное
    for (const c2 of cols) {
      const st = state[c2.name];
      if (st && st.issued) bucket.issued[c2.name] = st.issued;
    }
    hist.hours = hist.hours.filter((h) => h.ts >= NOW() - 48 * 3600).sort((a, b) => a.ts - b.ts);
    fs.writeFileSync(HIST_FILE, JSON.stringify(hist, null, 1));
  } catch (e) { console.log("history.json:", String(e).slice(0, 80)); }

  // 3) статусная страница (GitHub Pages)
  let prev = {};
  await publishPartners();

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
      last_upgrades: (() => {
        // дедуп: один номер = одна запись в ленте (раньше дубли при гонке свипов)
        const seen = new Set();
        const merged = [...(prev.last_upgrades || []), ...bumpLogs];
        const out = [];
        for (let i = merged.length - 1; i >= 0; i--) {
          const e2 = merged[i];
          const k = String(e2.slug) + "#" + String(e2.number);
          if (seen.has(k)) continue;
          seen.add(k);
          out.unshift(e2);
          if (out.length >= 30) break;
        }
        return out;
      })(),
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

  // 🏆 лидерборд улучшителей → docs/leaders.json (агрегация по всем коллекциям)
  try {
    const leadersAll = {};
    for (const c2 of cols) {
      const st2 = state[c2.name];
      const lmap = st2 && st2.leaders ? st2.leaders : {};
      for (const [k, v] of Object.entries(lmap)) leadersAll[k] = (leadersAll[k] || 0) + v;
    }
    const leaders = Object.entries(leadersAll)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 100);
    fs.writeFileSync(path.join(REPO_ROOT, "docs", "leaders.json"), JSON.stringify({ updated: new Date().toISOString(), leaders }, null, 1));
  } catch (e) { console.log("leaders.json:", String(e).slice(0, 80)); }

  // 3.5) обложки коллекций (ПОДАРКИ-таб): раньше обновлялись отдельным джобом раз в 6ч и
  // показывали СТАРЫЙ экземпляр (другой цвет/облик, чем текущий счётчик) — обманывало юзера.
  // Теперь при каждом реальном апгрейде свежее фото ЭТОГО конкретного номера (уже скачано
  // выше, доп. запросов НЕ делаем) сразу идёт в обложку коллекции — она всегда актуальна.
  try {
    const IMG_FILE = path.join(REPO_ROOT, "docs", "images.json");
    let imgDoc = {};
    try { imgDoc = JSON.parse(fs.readFileSync(IMG_FILE, "utf8")); } catch {}
    if (typeof imgDoc.images !== "object" || !imgDoc.images) imgDoc.images = {};
    let coverUpdated = 0;
    for (const log of bumpLogs) {
      if (log.img) { imgDoc.images[log.slug] = log.img; coverUpdated++; }
    }
    if (coverUpdated) {
      imgDoc.updated = new Date().toISOString();
      fs.writeFileSync(IMG_FILE, JSON.stringify(imgDoc, null, 1));
      console.log(`обложки коллекций обновлены живьём: ${coverUpdated}`);
    }
  } catch (e) { console.log("images.json (live-cover):", String(e).slice(0, 80)); }

  // 4) state + коммит (с ретраем на гонку пушей)
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  try {
    execSync('git config user.name "gift-monitor"', { cwd: REPO_ROOT });
    execSync('git config user.email "actions@github.com"', { cwd: REPO_ROOT });
    if (!SWEEP_CHANGED && process.env.FRESH_COMMIT !== "1") {
      console.log("state: без изменений, коммит пропущен");
      return;
    }
    execSync("git add data/state-full.json data/subscribers.enc data/partners.json docs/status.json docs/gifts.json docs/history.json docs/images.json docs/leaders.json docs/partners.json docs/p", { cwd: REPO_ROOT });
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
    // GUARD v2: крон-тик = страховка. Цепь жива ⟺ есть ДРУГОЙ прогон in_progress/queued.
    // Никаких порогов по времени: если очередь/прогон есть — тихо выходим, иначе подхватываем эстафету.
    if (process.env.EVENT_NAME === "schedule") {
      try {
        const q = execSync(
          `curl -s -H "Authorization: Bearer ${process.env.GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" ` +
          `https://api.github.com/repos/jethubvideo-code/gifttracker-bot/actions/workflows/full-monitor.yml/runs?per_page=15`,
          { encoding: "utf8" }
        );
        const myId = String(process.env.GITHUB_RUN_ID || "");
        const alive = (JSON.parse(q).workflow_runs || [])
          .some((x) => (x.status === "queued" || x.status === "in_progress") && String(x.id) !== myId);
        if (alive) {
          console.log("GUARD: цепочка жива (есть in_progress/queued), тихий выход");
          process.exit(0);
        }
        console.log("GUARD: цепочка мертва — беру эстафету на себя");
      } catch {}
    }
    if (process.env.EVENT_NAME === "schedule" || (process.env.FORCE || "") === "chain") {
      // 24/7 реалтайм-режим: цикл свипов внутри одного прогона (~75с между проверками)
      const BUDGET_MS = 780_000; // 13 минут непрерывных проверок, дальше эстафета
      const t0 = Date.now();
      let n = 0;
      while (true) {
        const sweepStart = Date.now();
        n++;
        const fitsNext = (Date.now() - t0) + 20_000 <= BUDGET_MS;
        process.env.FRESH_COMMIT = "1"; // коммит КАЖДЫЙ свип: данные сайта свежие каждые ~20с
        await main();
        if (!fitsNext) break; // следующий цикл не влезает — эстафета
        const wait = Math.max(200, 20_000 - (Date.now() - sweepStart));
        await sleep(wait);
      }
      console.log("LOOP: свипов за прогон: " + n);
      // эстафета: сами запускаем следующий прогон (крон GitHub капризничает)
      try {
        let hasQueue = false;
        try {
          const q = execSync(
            `curl -s -H "Authorization: Bearer ${process.env.GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" ` +
            `https://api.github.com/repos/jethubvideo-code/gifttracker-bot/actions/workflows/full-monitor.yml/runs?per_page=10`,
            { encoding: "utf8" }
          );
          const myId = String(process.env.GITHUB_RUN_ID || "");
          hasQueue = (JSON.parse(q).workflow_runs || [])
            .some((x) => (x.status === "queued" || x.status === "in_progress") && String(x.id) !== myId);
        } catch {}
        if (!hasQueue) {
        const r = execSync(
          `curl -s -w "\nHTTP:%{http_code}" -X POST ` +
          `-H "Authorization: Bearer ${process.env.GITHUB_TOKEN}" ` +
          `-H "Accept: application/vnd.github+json" ` +
          `https://api.github.com/repos/jethubvideo-code/gifttracker-bot/actions/workflows/full-monitor.yml/dispatches ` +
          `-d '{"ref":"main","inputs":{"force":"chain"}}'`,
          { encoding: "utf8" }
        ).trim();
        if (r.endsWith("HTTP:201") || r.endsWith("HTTP:204")) {
          console.log("эстафета: следующий прогон запущен (" + r.split("\n").pop() + ")");
        } else {
          console.log("эстафета curl:", r.slice(0, 120), "→ пробую gh");
          execSync(`GH_TOKEN="$GITHUB_TOKEN" gh workflow run full-monitor.yml --ref main -f force=chain`, { stdio: "pipe" });
          console.log("эстафета: gh запустил следующий прогон");
        }
        } else {
          console.log("эстафета: уже есть очередь/прогон — не дублируем");
        }
      } catch (e) {
        console.log("эстафета не удалась, крон-страховка подхватит:", String(e.message).slice(0, 120));
      }
    } else {
      await main();
    }
  } catch (e) {
    console.error("FATAL:", String(e).slice(0, 300));
    process.exit(1);
  }
})();
