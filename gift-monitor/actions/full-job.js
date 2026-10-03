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

// ГЛОБАЛЬНЫЙ БАКЕТ AIMD «ПОТОЛОК -1» (как TCP): РЕАЛЬНЫЙ потолок Telegram НЕ 30/сек — живые логи
// показали 85+ сообщ/сек без единого 429. Контроллер сам нащупывает фактическую границу:
// +1 сообщ/сек каждые 30с чистого потока (до 80), на 429 → rate -3 мгновенно (пол 20) И запоминание
// границы hi=rate-4 (выше неё больше не лезем). Telegram — единственный судья, 429 слушается всегда.
const RL = { rate: 30, tokens: 30, ts: Date.now(), last429: 0, lastUp: 0, hi: 60 }; // v20: старт 30/60, органический разгон до 60 // v18: потолок 60→80 (пер-чатный гейт 1.0с теперь первичная защита от флуда)
const CHAT_CD = {};   // v17: пер-чат флуд-кулдаун (chat → ts, до которого чат не дёргаем)
const CHAT_LAST = {}; // v19: пер-чат пейсинг 1.5с (chat → ts последнего сообщения)
let GIT_LOCK = false; // сериализация git-операций свипа и фонового контура (index.lock не делится)
// МОНИТОРИНГ ПРОИЗВОДИТЕЛЬНОСТИ: каждый свип печатает CHECK COMPLETED (req.17)
const STATS = { api: 0, tg: 0, retries429: 0, lastCommit: false };
let STATE_CACHE = null; // state в памяти ПРОГОНА: свипы эстафеты не перечитывают диск (req.2 — меньше I/O),
let RL_RESTORED = false; // а волатильные штампы больше не грязнят коммит (req.3/4/15)
 // старт 40, проба до 150: реальный потолок ставит Telegram через 429 (пол 20, граница hi=rate-4)
async function rlWait() {
  for (;;) {
    const now = Date.now();
    if (now - RL.lastUp > 10_000 && now - RL.last429 > 10_000) { // чистый поток — наращиваем (10с: шторм не ждёт)
      RL.lastUp = now;
      if (RL.hi < 60 && now - RL.last429 > 600_000) RL.hi = Math.min(60, RL.hi + 2); // 10 мин без 429 — граница оттаивает
      RL.rate = Math.min(RL.hi, RL.rate + 1); // безусловно: если rate застрял выше hi (после 429) — вернётся под границу
    }
    RL.tokens = Math.min(RL.rate, RL.tokens + ((now - RL.ts) / 1000) * RL.rate);
    RL.ts = now;
    if (RL.tokens >= 1) { RL.tokens -= 1; return; }
    await sleep(Math.max(4, Math.ceil(((1 - RL.tokens) * 1000) / RL.rate)));
  }
}

async function tg(method, body) {
  if (method === "sendMessage") { STATS.tg++; await rlWait(); } // ВСЕ уведомления через один бакет — глобальный лимит бота один
  STATS.api++;
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

// ВЕТВЬ-НЕЗАВИСИМЫЙ КОММИТ (урок прогона 36984393037: schedule-прогон GitHub чекаутит
// по sha → DETACHED; checkout -B main молча провалился → pull --rebase в детаче →
// «You are not currently on a branch» → state НЕ пушится часами при живой доставке).
// Паттерн без ветвяной магии: истина = память прогонa. fetch tip → reset на него →
// вернуть НАШИ правки (стэш) → commit → push HEAD:main (фаст-форвард от tip).
function gitHardCommit(files, msg) {
  const run = (c) => execSync(c, { cwd: REPO_ROOT, stdio: "pipe", timeout: 90_000 });
  try {
    // СНАПШОТ-ПАТТЕРН v16.2 (урок 08:43: git stash pop дал КОНФЛИКТ, unmerged-индекс
    // остался и ВСЕ последующие коммиты падали «could not write index» при живой доставке).
    // Никакого stash/pop: файлы читаются (только что записаны из памяти — истина),
    // worktree сбрасывается к свежему tip, файлы восстанавливаются поверх. Конфликт невозможен.
    const list = String(files).split(/\s+/).filter(Boolean);
    const snap = {};
    for (const f of list) {
      try { snap[f] = fs.readFileSync(path.join(REPO_ROOT, f)); } catch {}
    }
    run("git fetch origin main --quiet");
    run("git reset --hard origin/main -q"); // детач-безопасно: база коммита = удалённый tip
    run("git checkout -B main -q");
    run('git config user.name "gift-monitor"');
    run('git config user.email "actions@github.com"');
    for (const f of list) {
      if (snap[f] != null) fs.writeFileSync(path.join(REPO_ROOT, f), snap[f]); // память побеждает git
    }
    run(`git add ${files}`);
    const staged = execSync("git status --porcelain", { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 });
    if (!String(staged).trim()) return true; // изменений нет — штатный no-op, коммит не нужен
    run(`git commit -m "${msg}"`);
    for (let a = 0; a < 3; a++) {
      try { run("git push origin HEAD:main"); return true; }
      catch { run("git fetch origin main --quiet"); run("git rebase origin/main"); } // гонка пушей → ретрай
    }
    return false;
  } catch (e) {
    console.log("gitHardCommit:", String(e.message).slice(0, 140));
    return false;
  }
}

// ФОНОВЫЙ КОНТУР ЖИВОГО СЧЁТЧИКА (v15): сайт обязан показывать цифру t.me «точь-в-точь».
// Свип узнаёт счётчик в НАЧАЛЕ, а коммитит в КОНЦЕ (60-80с доставки = отставание 400-500 при шторме 300/мин).
// Здесь: каждые ~15с ТОЛЬКО горячие коллекции (очередь не пуста) → docs/live.json → микро-коммит.
// НЕ трогает state/доставку (детект по lastSentNum — мутации стейта запрещены), git через GIT_LOCK.
const LIVE_LAST = {};
const BUMP_TS = {}; // слаг → ts последнего бампа этого прогона (для LIVE-контура)
async function hotCounterLoop() {
  const LIVE_FILE = path.join(REPO_ROOT, "docs", "live.json");
  console.log("LIVE: фоновый контур живых счётчиков запущен (тик 15с)");
  for (;;) {
    await sleep(15_000);
    let st = {};
    try { st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { continue; }
    try {
      const hot = Object.keys(st)
        .filter((k) => {
          if (!st[k] || typeof st[k] !== "object" || k.startsWith("__")) return false;
          const q = (st[k].issued || 0) - (st[k].lastSentNum || 0);
          // реальная очередь доставки (lastSentNum>0 отсекает бейзлайн-нулевые спокойные коллекции)
          if ((st[k].lastSentNum || 0) > 0 && q > 0) return true;
          // свежий бамп этого прогона (даже первая доставка) — счётчик растёт прямо сейчас
          if ((BUMP_TS[k] || 0) > NOW() - 900) return true;
          return false;
        })
        .sort((a, b) => (((st[b].issued || 0) - (st[b].lastSentNum || 0)) - ((st[a].issued || 0) - (st[a].lastSentNum || 0)))) // сначала самая штормовая
        .slice(0, 6);
      if (!hot.length) continue;
      const doc = { updated: new Date().toISOString(), items: {} };
      for (const slug of hot) {
        const c = await tgCounter(slug, (st[slug].issued || 0) + 1);
        if (c) doc.items[slug] = { i: c.issued, t: c.total, ts: NOW() };
      }
      if (!Object.keys(doc.items).length) continue;
      // req.6: коммит ТОЛЬКО если ЗНАЧЕНИЕ (i/t) реально изменилось — ts не считается
      const key = JSON.stringify(doc.items);
      if (LIVE_LAST.key === key) continue;
      LIVE_LAST.key = key;
      const dump = JSON.stringify(doc);
      fs.writeFileSync(LIVE_FILE, dump);
      if (GIT_LOCK) continue; // свип коммитит — файл ляжет следующим тиком
      GIT_LOCK = true;
      try {
        gitHardCommit("docs/live.json", "live counters [skip ci]");
      } catch (e) { console.log("LIVE commit:", String(e.message).slice(0, 90)); }
      finally { GIT_LOCK = false; }
    } catch (e) { console.log("LIVE tick:", String(e.message).slice(0, 90)); }
  }
}

// официальный счётчик «улучшено X из Y» со страницы t.me/nft/<slug>-<n>
async function tgCounter(slug, sample) {
  STATS.api++;
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
  if (!b.col.address || count <= 0) return out; // count=0 → [] (slice(-0)=slice(0)=всё окно — ловушка)
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
  // НОВЕЙШИЕ count трансферы окна → новейшие номера свипа (выравнивание под возрастающую доставку
  // РОВНО ПО НОМЕРАМ; при обычном прыжке 1-8 это все трансферы окна, как и раньше)
  const chosen = inWin.slice(-count);
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
  const num = ev.number;
  const link = `https://t.me/nft/${ev.slug.toLowerCase()}${num ? `-${num}` : ""}`;
  const gift = String(ev.giftDisplay || ev.slug);

  // КОРОТКИЙ ФОРМАТ (по образцу владельца, 02.10): без времени/владельца/лишних ссылок — максимум скорости чтения
  return (
    `🎁 Подарок: ${esc(gift)}\n` +
    (ev.counter ? `📊 Улучшено всего (Telegram): ${ev.counter.issued.toLocaleString("ru-RU")} из ${ev.counter.total.toLocaleString("ru-RU")}\n` : "") +
    `\n🔗 <a href="${link}">Подарок</a>\n\n` +
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



let STORM_DRAIN = false;
let RECENT_429 = []; // v20: [{chat,ts}] — окно 60с, считаем УНИКАЛЬНЫЕ чаты (2 застрявших чата ≠ глобальный лимит) // true = в очереди ещё номера: свипы подряд, без пауз

async function main() {
  STORM_DRAIN = false;

  SWEEP_CHANGED = false;
  const sweepT0 = Date.now();
  STATS.api = 0; STATS.tg = 0; STATS.retries429 = 0; STATS.lastCommit = false; // метрики ТЕКУЩЕГО свипа
  // state живёт в памяти прогонa: загрузка с диска ОДИН раз за прогон (req.2), запись — только при изменениях (req.3)
  let state = STATE_CACHE;
  if (!state) {
    try {
      state = STATE_CACHE = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
      state = STATE_CACHE = {};
    }
  }
  const cols = require(COLS_FILE);
  // RL-ПЕРСИСТЕНТНОСТЬ: эстафета перезапускается каждые 30 мин — без этого AIMD вечно сбрасывался
  // на стартовые 25-40/сек и НИКОГДА не держал разведанный максимум. Скорость живёт в state-full.json.
  if (!RL_RESTORED)
  try {
    RL_RESTORED = true;
    const saved = state.__rl;
    if (saved && Number(saved.rate) >= 20) {
      RL.rate = Math.min(150, Math.max(15, Number(saved.rate)));
      RL.hi = Math.min(150, Math.max(15, Number(saved.hi) || RL.rate));
      RL.last429 = Number(saved.last429) || 0; // v19.1: восстанавливаем last429
      RL.tokens = RL.rate; RL.ts = Date.now();
      // v19.1: ТЁПЛЫЙ СТАРТ — если 429 был давно (>30 мин) или не было, стартуем с 35
      const since429 = Date.now() - RL.last429;
      if (RL.last429 === 0 || since429 > 1_800_000) {
        RL.rate = Math.max(30, RL.rate); // v20: тёплый старт — не ниже 30 при чистом потоке
        RL.hi = Math.max(60, RL.hi); // v20: потолок 60 при тёплом старте
        console.log(`RL: ТЁПЛЫЙ СТАРТ ${RL.rate}/сек (граница ${RL.hi}), 429 был ${RL.last429 ? Math.round(since429/60000)+'мин назад' : 'никогда'})`);
      } else {
        console.log(`RL: поднят с прошлого прогона: ${RL.rate}/сек (граница ${RL.hi}), 429 ${Math.round(since429/1000)}с назад`);
      }
    }
  } catch {}
  let subs = decryptSubs();
  console.log(`full-job v11 (бот на борту): коллекций: ${cols.length}, подписчиков: ${subs.length}`);
  // 🤖 БОТ БЕЗ ВНЕШНИХ СЕРВИСОВ: getUpdates-поллинг прямо здесь, на GitHub Actions
  try {
    const bot = require("./bot.js");
    const off0 = state.__bot ? state.__bot.offset : 0;
    const botOut = await bot.poll({ tg, subs, state });
    const off1 = state.__bot ? state.__bot.offset : 0;
    if (off1 !== off0) SWEEP_CHANGED = true; // offset = дедуп-база бота, обязана пережить рестарт
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
  await pool(cols, 16, async (c) => {
    const st =
      state[c.name] ||
      (state[c.name] = { issued: 0, sample: 1, lastSentTime: 0, lastSentNum: 0 });
    // ШТОРМ-ДРЕЙН: спокойную коллекцию (очередь пуста, проверена <30с назад) не дёргаем — счётчики не жгут время свипа
    if (st.issued > 0 && st.total > 0 && st.lastSweepTs && NOW() - st.lastSweepTs < 30 && (st.lastSentNum || 0) >= st.issued) {
      gifts.push({ slug: c.name, name: c.display_name || c.name, issued: st.issued, total: st.total, added: Number(c.added) || 0 });
      return;
    }
    const cnt = await tgCounter(c.name, st.sample || 1);
    if (!cnt) {
      errors++;
      return;
    }
    checked++;
    st.total = cnt.total; // кэш тотала для шторм-пропусков
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
      BUMP_TS[c.name] = NOW(); // LIVE-контур: коллекция растёт прямо сейчас (любой бамп, не только кэтч-ап)
      bumps.push({ col: c, issued: cnt.issued, prev: st.issued, total: cnt.total });
    SWEEP_CHANGED = true;
      st.issued = cnt.issued;
      st.sample = cnt.sample;
    } else if ((st.lastSentNum || 0) > 0 && (st.lastSentNum || 0) < st.issued) {
      // КЭТЧ-АП БЕЗ НОВОГО БАМПА (урок 08:30: шторм кончился, очередь 10982 замерла):
      // счётчик не двигается, но хвост не доставлен — дренируем его сами, не ждём прыжка.
      // Мета не цепляется (окно пустое), формат 162-симв мета не показывает — безопасно.
      bumps.push({ col: c, issued: st.issued, prev: st.issued, total: cnt.total });
      SWEEP_CHANGED = true;
    } else if (cnt.issued < st.issued) {
      // официальные счётчики только растут: снижение = протухший кэш t.me — игнорируем,
      // иначе следующий свип увидит ложный «бамп» и повторно скинет старьё
    }
  });

  console.log(`счётчиков проверено: ${checked}, ошибок: ${errors}, baseline: ${baselined}, апгрейдов: ${bumps.length}`);

  // 2) обогащение + доставка 1:1: КАЖДЫЙ апгрейд = СВОЁ сообщение, БЕЗ пропусков и сжатия.
  // Лента сайта при этом получает ВСЕ номера СРАЗУ при обнаружении (мгновенно, даже хвосты очереди).
  for (const b of bumps) {
    const st = state[b.col.name];
    // ДВОЙНАЯ ПРОВЕРКА НОМЕРА: t.me мог отдать протухший кэш — перепроверяем счётчик в момент доставки
    try {
      const re = await tgCounter(b.col.name, st.sample || 1);
      if (re && re.issued > b.issued) {
        console.log(`уточнение счётчика ${b.col.name}: ${b.issued} → ${re.issued}`);
        b.issued = re.issued;
        st.issued = re.issued;
      }
    } catch {}
    // ОКНО МЕТЫ ПОКРЫВАЕТ ВЕСЬ БЭКЛОГ (от последней доставки): у номеров из очереди
    // тоже появляется НАСТОЯЩИЙ владелец и время, не только у свежих
    const winStart = Math.min((st.prevSweepTs || NOW() - 180) - 120, (st.lastSentTime || NOW() - 180) - 120);
    const winEnd = NOW() + 120;
    let from = (st.lastSentNum || b.prev || 0) + 1; // от последнего ДОСТАВЛЕННОГО+1: бэклог не теряется
    if (from > b.issued) { skipped++; continue; } // дубль — уже всё доставлено
    // FIFO-бэклог: кап 30/свип, СТАРЕЙШИЕ первыми. Хвост дошьётся след. свипами — ни один номер не теряется.
    const total = b.issued - from + 1;
    const count = Math.min(total, 60); // кап 60: меньше свипов на ту же сотню = меньше фикс-цены (счётчики, коммит)
    if (total > count) STORM_DRAIN = true; // очередь не пуста → следующий свип сразу
    BUMP_TS[b.col.name] = NOW(); // LIVE-контур: эта коллекция растёт прямо сейчас
    if (total > count) console.log(`кэтч-ап ${b.col.name}: очередь ${total}, свип ${count} (в ленте все ${total} уже сейчас)`);
    const enrichN = total > count ? 0 : Math.min(count, total > 50 ? 8 : count); // глубокий бэклог: мета БЕЗ выравнивания = враньё → честно без неё + 0 тонапи-вызовов (быстрее); свежий прыжок: мета ровно к своим номерам
    const metas = await enrichRange(b, enrichN, winStart, winEnd);
    const colImg = await giftImage(b.col.name, b.issued); // 1 картинка на коллекцию за свип (не 30 запросов)
    const stormLogs = []; // лента этого свипа (пушим по возрастанию после цикла)
    const batchTs = new Date().toISOString(); // ОДИН штамп на весь батч — иначе мс-дрожь внутри цикла (новые→старые) переворачивает видимый порядок в ленте
    for (let n = from; n < from + count; n++) { // РОВНО ПО НОМЕРАМ (приказ владельца): строго по возрастанию 1,2,3... — никакого перемешивания
      const mIdx = (n - from) - (count - metas.length);
      const m = mIdx >= 0 && mIdx < metas.length ? metas[mIdx] : {};
      const mOk = !!(m.mintTime && m.mintTime >= winStart && m.mintTime <= winEnd);
      const ev = {
        slug: b.col.name,
        giftDisplay: (mOk ? m.giftDisplay || "" : "") || b.col.display_name || b.col.name,
        number: n, // ← ЕДИНСТВЕННАЯ ПРАВДА: официальный номер счётчика (как на t.me)
        ownerAddr: mOk ? m.ownerAddr || "" : "",
        ownerName: mOk ? m.ownerName || "" : "",
        mintTime: mOk ? m.mintTime : 0,
        counter: { issued: n, total: b.total },
      };
      // ЛЕНТА ЗАПИСЫВАЕТСЯ ВСЕГДА и ДО доставки — сайт не отстаёт от счётчика никогда
      stormLogs.push({
        slug: b.col.name, gift: ev.giftDisplay, number: n,
        owner: ev.ownerName || "", owner_addr: ev.ownerAddr || "",
        mint: ev.mintTime, counter_issued: n, counter_total: b.total,
        img: colImg || "", sent: 0, time: batchTs,
      });
      // мета не подтвердилась (тонапи протух/окно старое) → честное «минуту назад», НЕ пропускаем
      if (!ev.mintTime || ev.mintTime < NOW() - 1200) ev.mintTime = NOW() - 60;
      const text = buildMessage(ev);
      let sentThis = 0;
      // 1:1: каждому подписчику СВОЁ сообщение на ЭТОТ апгрейд (пул 6 параллельно)
      const targets = [];
      for (const s of subs) {
        if (s.radar_mode) continue;
        const muted = (s.muted_gifts || []).some((m2) => String(m2 || "").toLowerCase() === b.col.name.toLowerCase());
        if (muted) continue;
        const fm = String(s.filter_model || "").trim().toLowerCase();
        const fb = String(s.filter_backdrop || "").trim().toLowerCase();
        if (fm || fb) continue;
        targets.push(s);
      }
      // 🟢 ЖИВЫЕ ПЕРВЫМИ: активные юзеры (свежее касание бота) получают апгрейд раньше дормантных
      // 🔒 §10: seen-ключи = HMAC-SHA256(telegram_id, CRYPT_KEY), плейнтекст-ID не читаем (обратная совместимость стёрта)
      const seenKey = (tid) => require("crypto").createHmac("sha256", process.env.CRYPT_KEY || "gm").update(String(tid)).digest("hex").slice(0, 32);
      const seenOf = (x) => ((state.seen || {})[seenKey(x.telegram_id)]) || 0;
      targets.sort((a, b) => seenOf(b) - seenOf(a));
      let tIdx = 0;
      const sendPool = async () => {
        while (tIdx < targets.length) {
          const s = targets[tIdx++];
          // дормант = касание бота 30+ дней назад (нет данных — НЕ дормант, безопасный старт фичи)
          const sv = seenOf(s);
          const dormant = sv > 0 && NOW() - sv >= 30 * 86400;
          const silent = !!(night && s.night_mode) || b.issued - n >= 150 || dormant; // хвост очереди и дормантные — без звука, свежие активным звенят
          const chat = String(s.chat_id || s.telegram_id);
          if ((CHAT_CD[chat] || 0) > Date.now()) continue; // v17: чат во флуд-кулдауне — не дёргаем, догонит след. свипами
          let ok = false;
          for (let attempt = 0; attempt < 2 && !ok; attempt++) {
            const w = 1500 - (Date.now() - (CHAT_LAST[chat] || 0)); // v19: пейсинг ≥1.5с/чат (1.0с спровоцировал мгновенный 429 — чаты ещё не отошли от утреннего шторма; 1.5с — безопасный компромисс)
            if (w > 0) await sleep(w);
            CHAT_LAST[chat] = Date.now();
            const r = await tg("sendMessage", {
              chat_id: chat,
              text,
              parse_mode: "HTML",
              disable_notification: silent,
              link_preview_options: { is_disabled: false },
            });
            if (r && r.ok) { ok = true; sentThis++; }
            else if (r && r.error_code === 429) { // v19.2: пер-чат 429 — НЕ сбивает глобальную скорость
              const ra = Math.min(120, Number(r.parameters?.retry_after) || 30);
              CHAT_CD[chat] = Date.now() + ra * 3000; /* v20.1: 3x кулдаун */
              STATS.retries429++;
              // v20: глобальный отступ только если 6+ УНИКАЛЬНЫХ чатов за 60с (не сырые события)
              const now = Date.now();
              RECENT_429 = RECENT_429.filter(x => now - x.ts < 60_000);
              RECENT_429.push({ chat, ts: now });
              const uniq = new Set(RECENT_429.map(x => String(x.chat))).size;
              if (uniq >= 12) {
                RL.hi = Math.max(25, RL.rate - 4); RL.rate = Math.max(15, RL.rate - 3); RL.last429 = now; RL.tokens = 0;
                console.log(`RL: ГЛОБАЛЬНЫЙ 429 (${uniq} уникальных чатов за 60с) → отступ ${RL.rate}/сек`);
                RECENT_429 = [];
              } else {
                console.log(`RL: пер-чат 429 (${chat}, уникальных за 60с: ${uniq}) → кулдаун ${ra}с, скорость ${RL.rate}/сек сохранена`);
              }
              break;
            }
            else break;
          }
          // 🎯 личное «твой подарок улучшили» (этот номер — свой номер юзера)
          const mgList = Array.isArray(s.my_gifts) ? s.my_gifts : [];
          for (const mgx of mgList) {
            const pp = String(mgx || "").split(":");
            const mn = parseInt(pp[1], 10);
            if (!mn || String(pp[0] || "").trim().toLowerCase() !== b.col.name.toLowerCase()) continue;
            if (mn !== n) continue;
            const g2 = String(b.col.display_name || b.col.name);
            const lnk = `https://t.me/nft/${b.col.name.toLowerCase()}-${mn}`;
            const mineTxt =
              `🎯 <b>ТВОЙ ПОДАРОК УЛУЧШЕН!</b>\n\n` +
              `🎁 Подарок: ${esc(g2)}\n` +
              `\n🔗 <a href="${lnk}">Подарок</a>\n\n` +
              `#TelegramGifts #NFT #${b.col.name}`;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const r2 = await tg("sendMessage", {
                  chat_id: chat,
                  text: mineTxt,
                  parse_mode: "HTML",
                  disable_notification: silent,
                  link_preview_options: { is_disabled: false },
                });
                if (r2 && r2.ok) break;
                if (r2 && r2.error_code === 429) { const ra2 = Math.min(120, Number(r2.parameters?.retry_after) || 30); CHAT_CD[String(s.chat_id || s.telegram_id)] = Date.now() + ra2 * 3000; STATS.retries429++; const now2 = Date.now(); RECENT_429 = RECENT_429.filter(x => now2 - x.ts < 60_000); const pChat = String(s.chat_id || s.telegram_id); RECENT_429.push({ chat: pChat, ts: now2 }); const uniq2 = new Set(RECENT_429.map(x => String(x.chat))).size; if (uniq2 >= 12) { RL.hi = Math.max(25, RL.rate - 4); RL.rate = Math.max(15, RL.rate - 3); RL.last429 = now2; RL.tokens = 0; console.log(`RL: ГЛОБАЛЬНЫЙ 429 (${uniq2} уникальных за 60с) → отступ ${RL.rate}/сек`); RECENT_429 = []; } else { console.log(`RL: пер-чат 429 (личный ${pChat}, уникальных: ${uniq2}) → кулдаун ${ra2}с, скорость сохранена`); } break; }
                break;
              } catch { break; }
            }
          }
        }
      };
      await Promise.all(Array.from({ length: 16 }, () => sendPool())); // v19: пул 16 (было 20) — умеренный параллелизм под 1.5с
      sent += sentThis;
      detected++;
      // 🏆 лидерборд улучшителей
      const lk = String(ev.ownerName || ev.ownerAddr || "").trim();
      if (lk) { st.leaders = st.leaders || {}; st.leaders[lk] = (st.leaders[lk] || 0) + 1; }
      st.lastSentTime = NOW();
      st.lastSentNum = n; // маркер после КАЖДОГО номера: краш в середине свипа = ноль дублей и ноль потерь
      console.log(`апгрейд 1:1: ${b.col.name} #${n}, отправлено: ${sentThis}`);
    }
    for (const l of stormLogs) bumpLogs.push(l); // лента: цикл уже по возрастанию, reverse не нужен
    // хвост очереди (>30) — тоже в ленту немедленно, доставится след. свипами (каждый своим сообщением)
    for (let n = from + count; n <= b.issued; n++) {
      bumpLogs.push({ slug: b.col.name, gift: b.col.display_name || b.col.name, number: n, owner: "", owner_addr: "", mint: 0, counter_issued: n, counter_total: b.total, img: colImg || "", sent: 0, time: new Date().toISOString() });
    }
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
  try { prev = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")); } catch {}
  try {
    fs.mkdirSync(path.join(REPO_ROOT, "docs"), { recursive: true });
    // NO-OP: штампы/счётчик прогонов двигаются ТОЛЬКО на содержательном свипе (req.4/15) —
    // иначе каждый свип = обязательный коммит «пустышка»
    const DIRTY = SWEEP_CHANGED;
    // v21.2: сборка ленты (дедуп: один номер = одна запись) + уникальные per-NFT фото.
    // og:image страница t.me/nft/<num> рождается ПОЗЖЕ счётчика → провал не перманентный:
    // записи живут в ленте до 30 слотов и ретраятся до 3 свипов, страница успевает родиться
    const seen = new Set();
    const merged = [...(prev.last_upgrades || []), ...bumpLogs];
    const feedOut = [];
    for (let i = merged.length - 1; i >= 0; i--) {
      const e2 = merged[i];
      const k = String(e2.slug) + "#" + String(e2.number);
      if (seen.has(k)) continue;
      seen.add(k);
      feedOut.unshift(e2);
      if (feedOut.length >= 30) break;
    }
    const need = feedOut.filter((e) => e.u !== 1 && (e.t || 0) < 3).slice(-24);
    if (need.length) {
      let done = 0;
      await pool(need, 4, async (e) => {
        const u2 = await giftImage(String(e.slug || "").toLowerCase(), e.number || e.counter_issued);
        if (u2) { e.img = u2; e.u = 1; done++; } else { e.t = (e.t || 0) + 1; }
      });
      if (done) console.log(`лента: уникальных фото ${done}/${need.length}`);
    }
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      updated: DIRTY ? new Date().toISOString() : (prev.updated || new Date().toISOString()),
      updated_unix: DIRTY ? NOW() : (prev.updated_unix || NOW()),
      runs: (prev.runs || 0) + (DIRTY ? 1 : 0),
      collections: cols.length,
      checked: checked,
      errors: errors,
      detected_total: (prev.detected_total || 0) + detected,
      sent_total: (prev.sent_total || 0) + sent,
      last_upgrades: feedOut,
    }, null, 1));
  } catch (e) { console.log("status.json:", String(e).slice(0, 80)); }

  // таблица всех подарков для сайта (штампы — только на содержательном свипе, req.4)
  try {
    let prevG = {};
    try { prevG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "docs", "gifts.json"), "utf8")); } catch {}
    const DIRTY = SWEEP_CHANGED;
    fs.writeFileSync(path.join(REPO_ROOT, "docs", "gifts.json"), JSON.stringify({
      updated: DIRTY ? new Date().toISOString() : (prevG.updated || new Date().toISOString()),
      updated_unix: DIRTY ? NOW() : (prevG.updated_unix || NOW()),
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
    // NO-OP: лидерборд меняется только при доставках — штамп не должен грязнить коммит (req.15)
    let prevL = {};
    try { prevL = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "docs", "leaders.json"), "utf8")); } catch {}
    if (JSON.stringify(prevL.leaders || {}) !== JSON.stringify(leaders)) {
      fs.writeFileSync(path.join(REPO_ROOT, "docs", "leaders.json"), JSON.stringify({ updated: new Date().toISOString(), leaders }, null, 1));
    }
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

  // 4) state + коммит — NO-OP-ПРИНЦИП (req.3/4/15): пишем и коммитим ТОЛЬКО при реальных изменениях.
  // Раньше FRESH_COMMIT=1 коммитил КАЖДЫЙ свип: ~3000 пустых коммитов/сутки + столько же Pages-билдов.
  const RL_MOVED = Math.abs((state.__rl?.rate || 0) - RL.rate) >= 5 || (state.__rl?.hi || 0) !== RL.hi || (Number(state.__rl?.last429) || 0) !== RL.last429; // v19.1: last429 тоже коммитится
  const STATE_DIRTY = SWEEP_CHANGED || RL_MOVED;
  if (STATE_DIRTY) {
    state.__rl = { rate: RL.rate, hi: RL.hi, last429: RL.last429 }; // v19.1: last429 персистится — оттайка hi честно ждёт 10 мин после реального 429
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  }
  // CHECK COMPLETED — метрика свипа (req.17)
  console.log(
    `CHECK COMPLETED | Duration: ${((Date.now() - sweepT0) / 1000).toFixed(1)}s | Counters: ${checked} | ` +
      `API: ${STATS.api} (TG: ${STATS.tg}) | 429-retries: ${STATS.retries429} | Upgrades: ${detected} (${sent} msgs) | ` +
      `Commit: ${STATE_DIRTY ? "YES" : "NO (no-op)"} | Deploy: NO (данные = raw-CDN, не Pages)`
  );
  STATS.lastCommit = STATE_DIRTY;
  if (!STATE_DIRTY) return; // изменений нет → ни записи, ни коммита, ни пуша (req.15)
  while (GIT_LOCK) await sleep(300); // ждём фоновый LIVE-коммит — git index один
  GIT_LOCK = true;
  try {
    execSync('git config user.name "gift-monitor"', { cwd: REPO_ROOT, timeout: 60_000 });
    execSync('git config user.email "actions@github.com"', { cwd: REPO_ROOT, timeout: 60_000 });
    // ремень+стропы (req.15): реальный рабочий диф пуст → выходим БЕЗ коммита
    try {
      const dirtyFiles = execSync("git status --porcelain", { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 }).trim();
      if (!dirtyFiles) {
        console.log("state: диф пуст — коммит не нужен (no-op)");
        return;
      }
    } catch {}
    const ok = gitHardCommit(
      "data/state-full.json data/subscribers.enc docs/status.json docs/gifts.json docs/history.json docs/images.json docs/leaders.json docs/live.json",
      "monitor: state update [skip ci]"
    );
    if (ok) console.log("state: закоммичен (ветвь-независимо)");
  } catch (e) {
    console.log("state: ⚠️ PUSH/COMMIT ПРОВАЛ (маркер НЕ закоммичен — риск дублей при рестарте):", String(e.message).slice(0, 160));
  } finally { GIT_LOCK = false; }
}

(async () => {
  try {
    // SCHEDULE-прогоны GitHub чекаутят по sha → DETACHED HEAD → git push/rebase фатально падают
    // («You are not currently on a branch»), а коммиты глотались как «не потребовался» — state молча
    // не пушится, доставка идёт вхолостую. Прикрепляем ветку main ДО всей работы (кроме sendtest).
    if (MODE !== "sendtest") {
      try { execSync("git checkout -B main", { cwd: REPO_ROOT, stdio: "pipe", timeout: 60_000 }); } catch {}
    }
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
          `curl -s -m 15 -H "Authorization: Bearer ${process.env.GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" ` +
          `https://api.github.com/repos/jethubvideo-code/gifttracker-bot/actions/workflows/full-monitor.yml/runs?per_page=15`,
          { encoding: "utf8", timeout: 20_000 }
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
      const BUDGET_MS = 1_800_000; // 30 минут непрерывных проверок — рестарт эстафеты в 2.3 раза реже, GUARD-ватчдог порогов не имеет (проверяет только живость цепи), безопасно
      const t0 = Date.now();
      hotCounterLoop().catch((e) => console.log("LIVE loop:", String(e).slice(0, 90))); // свежесть счётчиков сайта ~15с
      let n = 0;
      while (true) {
        const sweepStart = Date.now();
        n++;
        const fitsNext = (Date.now() - t0) + 20_000 <= BUDGET_MS;
        // коммит больше не принудительный: NO-OP при отсутствии изменений (req.4/15)
        await main();
        if (!fitsNext) break; // следующий цикл не влезает — эстафета
        const wait = STORM_DRAIN ? 200 : Math.max(200, 20_000 - (Date.now() - sweepStart));
        await sleep(wait);
      }
      console.log("LOOP: свипов за прогон: " + n);
      // эстафета: сами запускаем следующий прогон (крон GitHub капризничает)
      try {
        let hasQueue = false;
        try {
          const q = execSync(
            `curl -s -m 15 -H "Authorization: Bearer ${process.env.GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" ` +
            `https://api.github.com/repos/jethubvideo-code/gifttracker-bot/actions/workflows/full-monitor.yml/runs?per_page=10`,
            { encoding: "utf8", timeout: 20_000 }
          );
          const myId = String(process.env.GITHUB_RUN_ID || "");
          hasQueue = (JSON.parse(q).workflow_runs || [])
            .some((x) => (x.status === "queued" || x.status === "in_progress") && String(x.id) !== myId);
        } catch {}
        if (!hasQueue) {
        const r = execSync(
          `curl -s -m 15 -w "\nHTTP:%{http_code}" -X POST ` +
          `-H "Authorization: Bearer ${process.env.GITHUB_TOKEN}" ` +
          `-H "Accept: application/vnd.github+json" ` +
          `https://api.github.com/repos/jethubvideo-code/gifttracker-bot/actions/workflows/full-monitor.yml/dispatches ` +
          `-d '{"ref":"main","inputs":{"force":"chain"}}'`,
          { encoding: "utf8", timeout: 20_000 }
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
