#!/usr/bin/env node
/**
 * Gift Monitor — детектор ВЫХОДА НОВЫХ лимиток (GitHub Actions).
 * Источник: официальный каталог Fragment (fragment.com/gifts).
 * Новая лимитка → добавляется в collections.json (основной монитор подхватывает сам)
 * + уведомление подписчикам «Новые лимитки» и владельцу.
 * Backfill TON-адреса: tonapi search по имени (после первых апгрейдов).
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const COLS_FILE = path.join(__dirname, "..", "collections.json");
const SUBS_FILE = path.join(REPO_ROOT, "data", "subscribers.enc");

const TONAPI_KEY = process.env.TONAPI_KEY || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CRYPT_KEY = process.env.CRYPT_KEY || "";
const OWNER_ID = "8396883978";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function esc(t) { return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// tonapi: строгая очередь 1rps
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
  } catch { return null; }
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
  } catch { return []; }
}

// Каталог Fragment → слаги
async function fetchCatalogSlugs() {
  try {
    const res = await fetch("https://fragment.com/gifts", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const out = new Set();
    for (const m of html.matchAll(/gifts\/([a-z0-9-]+)/g)) out.add(m[1]);
    return out.size > 50 ? out : null;
  } catch { return null; }
}

// Имя коллекции с Fragment
async function fetchGiftMeta(slug) {
  try {
    const res = await fetch(`https://nft.fragment.com/collection/${slug}.json`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    if (j && typeof j.name === "string") return { name: j.name };
    return null;
  } catch { return null; }
}

// Счётчик новой лимитки (X может быть 0)
async function fetchNewGiftCounter(slug) {
  for (const c of [1, 2, 3]) {
    try {
      const res = await fetch(`https://t.me/nft/${slug.toLowerCase()}-${c}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) continue;
      const m = (await res.text()).match(/Quantity<\/th><td>([\d\u00a0\s]+)\/([\d\u00a0\s]+)\s*issued/);
      if (!m) continue;
      const issued = parseInt(m[1].replace(/[\u00a0\s]/g, ""), 10);
      const total = parseInt(m[2].replace(/[\u00a0\s]/g, ""), 10);
      if (!Number.isFinite(issued) || !Number.isFinite(total) || issued < 0 || total <= 0) continue;
      return { issued, total };
    } catch { continue; }
  }
  return null;
}

async function main() {
  const t0 = Date.now();
  const catalog = await fetchCatalogSlugs();
  if (!catalog) { console.log("каталог Fragment недоступен, выходим"); return; }
  const cols = require(COLS_FILE);
  const known = new Set(cols.map((c) => String(c.name || "").toLowerCase()));
  const fresh = [...catalog].filter((s) => !known.has(s.toLowerCase())).slice(0, 5);
  console.log(`каталог: ${catalog.size}, известно: ${cols.length}, новых: ${fresh.length}`);

  let notified = 0;
  const subs = fresh.length > 0 ? decryptSubs() : [];

  for (const slug of fresh) {
    const meta = await fetchGiftMeta(slug);
    const counter = await fetchNewGiftCounter(slug);
    const dispName = meta?.name || slug;
    // регистрируем в основном мониторе (added = когда лимитка вышла, для бейджа НОВИНКА на сайте)
    cols.push({ name: slug, address: "", display_name: dispName, added: Math.floor(Date.now() / 1000) });
    console.log(`новая лимитка: ${slug} (${dispName})`);
    // мгновенное фото новой лимитки на сайт (обложка Fragment; позже gift-images заменит на og:image)
    try {
      const imgPath = path.join(REPO_ROOT, "docs", "images.json");
      const doc = JSON.parse(fs.readFileSync(imgPath, "utf8"));
      doc.images = doc.images || {};
      doc.images[slug] = `https://nft.fragment.com/collection/${encodeURIComponent(slug.toLowerCase())}.webp`;
      fs.writeFileSync(imgPath, JSON.stringify(doc, null, 1));
      console.log(`фото в images.json: ${slug}`);
    } catch (e) { console.log("images.json не обновлён:", String(e.message).slice(0, 80)); }
    // уведомление подписчикам «Новые лимитки» + владелец
    const text =
      `🚨 <b>ВЫШЛА НОВАЯ ЛИМИТКА: ${esc(dispName)}!</b>\n\n` +
      `Всего выпущено: <b>${counter ? counter.total.toLocaleString("ru-RU") : "?"}</b> копий\n` +
      (counter ? `Улучшено уже: <b>${counter.issued.toLocaleString("ru-RU")}</b>\n` : "") +
      `\n🏷️ Купить: любой чат → 📎 → «Подарки» → поиск «${esc(dispName)}»\n` +
      `Успей — лимитки разбирают быстро!\n\n` +
      `🔗 <a href="https://t.me/nft/${slug.toLowerCase()}-1">Открыть в Telegram</a> · <a href="https://fragment.com/gifts/${slug}">Fragment</a>\n\n` +
      `#TelegramGifts #НоваяЛимитка`;
    const photo = `https://nft.fragment.com/collection/${encodeURIComponent(slug.toLowerCase())}.webp`;
    const seen = new Set();
    for (const s of subs) {
      if (s.notify_new_gifts !== true && String(s.telegram_id) !== OWNER_ID) continue;
      const chatId = String(s.chat_id || s.telegram_id);
      if (seen.has(chatId)) continue;
      seen.add(chatId);
      let r = await tg("sendPhoto", { chat_id: chatId, photo, caption: text, parse_mode: "HTML" });
      if (!r || !r.ok) r = await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
      if (r && r.ok) notified++;
      await sleep(80);
    }
  }

  // Backfill TON-адреса: у коллекций без адреса, где уже есть имя
  let backfilled = 0;
  const noAddr = cols.filter((c) => !c.address && c.display_name).slice(0, 2);
  for (const c of noAddr) {
    const q = encodeURIComponent(String(c.display_name));
    const search = await tonapi(`/v2/accounts/search?name=${q}`);
    const cands = (search?.addresses || []).filter((a) => a.trust === "whitelist" && /\.ton$/i.test(a.name || ""));
    if (cands.length) { c.address = cands[0].address; backfilled++; console.log(`адрес найден: ${c.name}`); }
  }

  if (fresh.length || backfilled) {
    fs.writeFileSync(COLS_FILE, JSON.stringify(cols, null, 1));
    try {
      execSync('git config user.name "gift-monitor"', { cwd: REPO_ROOT });
      execSync('git config user.email "actions@github.com"', { cwd: REPO_ROOT });
      execSync(`git add ${path.relative(REPO_ROOT, COLS_FILE)} docs/images.json`, { cwd: REPO_ROOT });
      execSync('git commit -m "new gifts: catalog update [skip ci]"', { cwd: REPO_ROOT, stdio: "pipe" });
      try { execSync("git push", { cwd: REPO_ROOT, stdio: "pipe" }); }
      catch { execSync("git pull --rebase --autostash", { cwd: REPO_ROOT, stdio: "pipe" }); execSync("git push", { cwd: REPO_ROOT, stdio: "pipe" }); }
      console.log("collections.json закоммичен");
    } catch (e) { console.log("коммит не удался:", String(e.message).slice(0, 100)); }
  }
  console.log(`ИТОГ: новых=${fresh.length}, уведомлений=${notified}, адресов найдено=${backfilled}, ${Math.round((Date.now()-t0)/1000)}с`);
}

(async () => {
  try { await main(); } catch (e) { console.error("FATAL:", String(e).slice(0, 300)); process.exit(1); }
})();
