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
const SUBS_PULL_URL = "https://vesper-5cce824e.base44.app/functions/getSubs";

// живая синхронизация: тянем актуальных подписчиков прямо из бота (фолбэк — локальный файл)
async function freshSubs() {
  try {
    const res = await fetch(`${SUBS_PULL_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.log("подписчики: sync-сервер не ответил (" + res.status + ")"); return null; }
    const d = await res.json().catch(() => null);
    if (!d || !d.ok || typeof d.enc !== "string" || !d.enc) { console.log("подписчики: пустой sync-ответ"); return null; }
    fs.writeFileSync(SUBS_FILE, Buffer.from(d.enc, "base64"));
    const list = decryptSubs();
    if (!Array.isArray(list) || list.length === 0) {
      console.log("подписчики: удалённо 0/не расшифровалось — подозрительно, беру локальный файл");
      return null;
    }
    console.log(`подписчики: синхронизировано с ботом (${d.count})`);
    return list;
  } catch (e) {
    console.log("подписчики: sync не удался, работаю с локальным файлом:", String(e).slice(0, 80));
    return null;
  }
}

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
  let subs = await freshSubs();
  if (!subs) subs = decryptSubs();
  console.log(`full-job v7: коллекций: ${cols.length}, подписчиков: ${subs.length}`);

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
    let overflow = 0;
    if (b.issued - from + 1 > 8) { overflow = b.issued - from + 1 - 8; from = b.issued - 7; }
    if (overflow) console.log(`кэтч-ап ${b.col.name}: доставляю последние 8 (пропущено ${overflow})`);
    const count = b.issued - from + 1;
    const metas = await enrichRange(b, count, winStart, winEnd);
    for (let i = 0; i < count; i++) {
      const n = from + i;
      // картинка — ТОЧНО для ЭТОГО номера n (не для b.issued батча!), иначе у кэтч-апа из
      // нескольких номеров все карточки показывали бы фото ПОСЛЕДНЕГО экземпляра — чужой цвет/облик.
      const img = await giftImage(b.col.name, n);
      const mIdx = i - (count - metas.length); // тонапи может дать меньше трансферов — выравниваю по свежести
      const m = mIdx >= 0 && mIdx < metas.length ? metas[mIdx] : {};
      // мета валидна только если её минт внутри окна бампа — иначе это старый трансфер тонапи
      const mOk = !!(m.mintTime && m.mintTime >= winStart && m.mintTime <= winEnd);
      const ev = {
        slug: b.col.name,
        giftDisplay: (mOk ? m.giftDisplay || "" : "") || b.col.display_name || b.col.name,
        number: n, // ← ЕДИНСТВЕННАЯ ПРАВДА: официальный номер счётчика (как на t.me).
                   // Номер копии из метаданных НЕ показывается нигде — иначе юзер видит «старый» номер
        ownerAddr: mOk ? m.ownerAddr || "" : "",
        ownerName: mOk ? m.ownerName || "" : "",
        mintTime: mOk ? m.mintTime : 0,
        counter: { issued: n, total: b.total },
      };
      // СВЕЖЕСТЬ: доставляем ТОЛЬКО новые апгрейды (жалоба: «старых вообще не было, только свежие»).
      // свежий = тонапи подтверждает минт <20 мин, ИЛИ коллекция сканировалась <20 мин назад
      // (значит бамп случился между свипами). Всё старше — простои реле, лаги, кэтч-ап —
      // молча пропускаем и двигаем маркер, уведомление НЕ уходит.
      const FRESH_SEC = 1200;
      const metaFresh = ev.mintTime && NOW() - ev.mintTime <= FRESH_SEC;
      const windowFresh = st.prevSweepTs && NOW() - st.prevSweepTs <= FRESH_SEC; // окно бампа свежее?
      if (!metaFresh && !windowFresh) {
        st.lastSentNum = n;
        st.lastSentTime = NOW();
        skipped++;
        console.log(`пропуск старого: ${b.col.name} #${n} (доставка отменена)`);
        continue;
      }
      // свежий бамп, но время не подтвердилось/протухло → честное «минуту назад», не старьё
      if (!ev.mintTime || ev.mintTime < NOW() - FRESH_SEC) {
        ev.mintTime = NOW() - 60;
      }
      const text = buildMessage(ev);
      let sentThis = 0;
      for (const s of subs) {
        if (s.radar_mode) continue;
        const muted = (s.muted_gifts || []).some((m2) => String(m2 || "").toLowerCase() === b.col.name.toLowerCase());
        if (muted) continue;
        const fm = String(s.filter_model || "").trim().toLowerCase();
        const fb = String(s.filter_backdrop || "").trim().toLowerCase();
        if (fm || fb) continue; // фильтр-пользователи обслуживаются только основным ботом
        const silent = !!(night && s.night_mode); // ночь = беззвучно, но НЕ теряем апгрейд
        const r = await tg("sendMessage", {
          chat_id: String(s.chat_id || s.telegram_id),
          text,
          parse_mode: "HTML",
          disable_notification: silent,
          link_preview_options: { is_disabled: false },
        });
        if (r && r.ok) sentThis++;
        if (r && r.error_code === 429) await sleep(Math.min(3, Number(r.parameters?.retry_after) || 1) * 1000);
      }
      sent += sentThis;
      detected++;
      bumpLogs.push({
        slug: b.col.name,
        gift: ev.giftDisplay,
        number: ev.number,
        owner: ev.ownerName || "",
        owner_addr: ev.ownerAddr || "",
        mint: ev.mintTime,
        counter_issued: n,
        counter_total: b.total,
        img: img || "",
        sent: sentThis,
        time: new Date().toISOString(),
      });
      st.lastSentTime = NOW();
      st.lastSentNum = n;
      console.log(`апгрейд: ${b.col.name} #${n}, отправлено: ${sentThis}`);
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
    execSync("git add data/state-full.json docs/status.json docs/gifts.json docs/history.json docs/images.json", { cwd: REPO_ROOT });
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
        const fitsNext = (Date.now() - t0) + 40_000 <= BUDGET_MS;
        process.env.FRESH_COMMIT = "1"; // коммит КАЖДЫЙ свип: данные сайта свежие каждые ~40с
        await main();
        if (!fitsNext) break; // следующий цикл не влезает — эстафета
        const wait = Math.max(200, 40_000 - (Date.now() - sweepStart));
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
