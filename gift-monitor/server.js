/**
 * Gift Monitor Server — автономная копия мониторинга бота Gift NFT Monitor.
 * Следит за улучшениями Telegram Gifts до NFT по 120 коллекциям:
 *   - tonapi.io: события минта (NftItemTransfer от адреса коллекции)
 *   - t.me/nft/<slug>-<n>: официальные счётчики «улучшено X из Y»
 * Отдаёт JSON для HTML-карточки и сам её хостит.
 *
 * ЗАПУСК:  TONAPI_KEY=твой_ключ node server.js
 * Без ключа тоже работает, но с лимитами tonapi (лучше взять бесплатный ключ на tonapi.io).
 *
 * ЭНВИРОНЫ:
 *   PORT=8787          — порт
 *   TICK_MS=60000      — цикл проверки (60 сек, как в боте)
 *   BATCH=30           — сколько коллекций проверяется за цикл
 *                         (30 → все 120 за ~4 мин; поставь BATCH=120 для проверки всех каждую минуту)
 *   TONAPI_KEY=...     — ключ tonapi (рекомендуется)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const COLLECTIONS = require("./collections.json");
const PORT = +process.env.PORT || 8787;
const TICK_MS = +process.env.TICK_MS || 60_000;
const BATCH = Math.min(+process.env.BATCH || 30, COLLECTIONS.length);
const TONAPI_KEY = process.env.TONAPI_KEY || "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const MAX_UPGRADES = 50;
const COUNTER_TTL = 1800; // сек — счётчик t.me обновляем раз в 30 мин на коллекцию

// ---------- состояние ----------
const cols = COLLECTIONS
  .filter((c) => c.address)
  .map((c) => ({
    name: c.name,
    addr: c.address,
    seen: [],          // последние NFT-адреса (анти-дубли)
    lastTs: 0,         // последний обработанный timestamp
    baseline: false,   // первый прогон только baseline
    issued: 0,
    total: 0,
    sample: 1,
    counterTime: 0,
  }));

const upgrades = []; // последние апгрейды, новые первыми
let updatedAt = Math.floor(Date.now() / 1000);
let cursor = 0;      // ротация по коллекциям

// ---------- утилиты ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tonapi(url) {
  const headers = TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {};
  const res = await fetch(`https://tonapi.io${url}`, {
    headers,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// официальный счётчик «улучшено X из Y» со страницы t.me/nft/<slug>-<n>
async function tgCounter(slug, sample) {
  const tries = [...new Set([sample, 1, 2, 3])];
  for (const n of tries) {
    try {
      const res = await fetch(`https://t.me/nft/${slug.toLowerCase()}-${n}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(9_000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const m = html.match(/Quantity<\/th><td>([\d\u00a0\s]+)\/([\d\u00a0\s]+)\s*issued/);
      if (!m) continue;
      const issued = parseInt(m[1].replace(/[\u00a0\s]/g, ""), 10);
      const total = parseInt(m[2].replace(/[\u00a0\s]/g, ""), 10);
      if (issued > 0 && total > 0) return { issued, total, sample: n };
    } catch {
      continue;
    }
  }
  return null;
}

// «Plush Pepe #12345» → { slug: "PlushPepe", index: 12345, hasNumber: true }
function parseMetaName(name, index) {
  const parts = String(name || "").trim().split(" #");
  const slug = (parts[0] || "").replace(/[\s'\u2019]/g, "");
  let numStr = String(parts[1] ?? "").replace(/,/g, "");
  if (!numStr) {
    const n = Number(index);
    if (Number.isFinite(n) && n > 0 && n < 1e7) numStr = String(n);
  }
  const num = parseInt(numStr, 10);
  return {
    slug,
    index: Number.isFinite(num) && num > 0 && num < 1e7 ? num : 0,
    hasNumber: numStr !== "",
  };
}

// ---------- проверка одной коллекции ----------
async function checkCol(col) {
  const data = await tonapi(`/v2/accounts/${col.addr}/events?limit=50`);
  if (!data || !Array.isArray(data.events)) return;

  let maxTs = col.lastTs;
  const fresh = [];

  for (const ev of data.events) {
    const ts = ev.timestamp || 0;
    if (ts > maxTs) maxTs = ts;
    if (col.lastTs && ts <= col.lastTs - 120) continue;

    for (const act of ev.actions || []) {
      if (act.type !== "NftItemTransfer") continue;
      const t = act.NftItemTransfer || {};
      if ((t.sender?.address || t.sender) !== col.addr) continue; // минт из коллекции
      const nft = t.nft;
      if (!nft || col.seen.includes(nft) || fresh.includes(nft)) continue;
      fresh.push(nft);
    }
  }

  // первый прогон — только baseline, без шторма старых событий
  if (!col.baseline) {
    col.baseline = true;
    col.lastTs = Math.max(maxTs, Math.floor(Date.now() / 1000) - 60);
    col.seen = fresh.slice(0, 40);
    return;
  }

  col.lastTs = Math.max(col.lastTs, maxTs);
  col.seen = [...new Set([...fresh, ...col.seen])].slice(0, 40);

  for (const nftAddr of fresh) {
    const item = await tonapi(`/v2/nfts/${nftAddr}`);
    if (!item) continue;

    const meta = parseMetaName(item.metadata?.name, item.index);
    const attrs = {};
    const raw = item.metadata?.attributes;
    if (Array.isArray(raw))
      for (const a of raw) attrs[String(a.trait_type || "").toLowerCase()] = a.value;
    else if (raw && typeof raw === "object")
      for (const [k, v] of Object.entries(raw)) attrs[k.toLowerCase()] = String(v);

    // свежий счётчик, если протух
    const now = Math.floor(Date.now() / 1000);
    if (!col.counterTime || now - col.counterTime > COUNTER_TTL) {
      const c = await tgCounter(col.name, col.sample || 1);
      if (c) {
        col.issued = c.issued;
        col.total = c.total;
        col.sample = c.sample;
        col.counterTime = now;
      }
    }

    upgrades.unshift({
      gift_slug: meta.slug || col.name,
      gift_display: (item.metadata?.name || col.name).trim(),
      nft_number: meta.hasNumber ? meta.index : null,
      nft_address: nftAddr,
      model: attrs.model || "",
      backdrop: attrs.backdrop || "",
      owner: item.owner?.address || "",
      mint_time: Math.floor(Date.now() / 1000),
      counter_issued: col.issued,
      counter_total: col.total,
    });
  }
  if (upgrades.length > MAX_UPGRADES) upgrades.length = MAX_UPGRADES;
}

// ---------- главный цикл (как в боте: ротация по BATCH коллекций) ----------
let busy = false;
async function tick() {
  if (busy) return; // защита от наложения циклов
  busy = true;
  try {
    const batch = [];
    for (let i = 0; i < BATCH && batch.length < cols.length; i++) {
      batch.push(cols[cursor % cols.length]);
      cursor++;
    }
    await Promise.all(batch.map((c) => checkCol(c).catch(() => {})));
    updatedAt = Math.floor(Date.now() / 1000);
    console.log(
      `[${new Date().toISOString()}] проверено ${batch.length}, апгрейдов в памяти: ${upgrades.length}`
    );
  } finally {
    busy = false;
  }
}
tick();
setInterval(tick, TICK_MS);

// ---------- HTTP ----------
const HTML_FILE = path.join(__dirname, "telegram_gift_card.html");

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/latest") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*", // HTML можно открыть где угодно
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        ok: true,
        updated_at: updatedAt,
        upgrades,
        collections: cols.map((c) => ({
          name: c.name,
          issued: c.issued,
          total: c.total,
        })),
      })
    );
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end("telegram_gift_card.html не найден рядом с server.js");
    }
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`Gift Monitor: http://localhost:${PORT}`);
  console.log(`  цикл: ${TICK_MS / 1000} сек, за цикл ${BATCH} коллекций (все ${cols.length} за ~${Math.ceil(cols.length / BATCH)} цикла)`);
});
