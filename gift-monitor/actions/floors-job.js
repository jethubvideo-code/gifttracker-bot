/**
 * floors-job v2 — флоры 121 коллекции: МЕДИАНА + фильтр мусорных лотов + TON→USD + Δ-снапшоты 15 мин.
 * Фишки: (1) медиана 10% дешёвых лотов вместо минимума; (2) мусор < 40% медианы отсекается;
 * (3) умная глубина: глубокий скан для новых/сдвинувшихся, обычный для стабильных;
 * (14) снапшоты каждые 15 мин (точнее Δ24ч и спарклайны); (16) курс TON→USD (CoinGecko).
 * docs/floors.json      — текущие флоеры + Δ с прошлого скана (+ данные для шита)
 * docs/floors-hist.json — снапшоты флоеров за 48ч (для Δ24ч и спарклайнов на сайте)
 * Запуск: .github/workflows/floors-scan.yml (каждые 15 мин) + workflow_dispatch.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const COLS_FILE = path.join(__dirname, "..", "collections.json");
const FLOORS_FILE = path.join(REPO_ROOT, "docs", "floors.json");
const HIST_FILE = path.join(REPO_ROOT, "docs", "floors-hist.json");

const NOW = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ——— тонапи с лимитом параллелизма 1 и ретраями на 429 ———
let chain = Promise.resolve();
function tonapi(url) {
  const p = chain.then(async () => {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`https://tonapi.io${url}`, {
          headers: {
            Authorization: `Bearer ${process.env.TONAPI_KEY || ""}`,
            "User-Agent": "Mozilla/5.0",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 429) { await sleep(4000); continue; } // rate-limit — подождать и ретрай
        if (!res.ok) return null;
        return await res.json().catch(() => null);
      } catch {}
      await sleep(2500);
    }
    return null;
  });
  chain = p.catch(() => {});
  return p;
}

function normAddr(a) {
  a = String(a || "").trim();
  if (!a) return "";
  if (/^0x/i.test(a)) return "0:" + a.slice(2); // hex → raw
  return a;
}

// медиана массива
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// скан одной коллекции: страницы по 100 NFT, собираем ВСЕ цены лотов.
// ФЛОР = медиана 10% самых дешёвых ЧИСТЫХ лотов (фишки 1+2):
//   мусорные лоты (< 40% медианы всех цен) отсекаются — скам-листинги не врут флору
async function scanCollection(addr, deep) {
  const prices = [];
  let pages = 0;
  const MAXP = deep ? 10 : 4; // глубокий скан для горячих/новых, обычный 4 стр (фишка 3)
  for (let p = 0; p < MAXP; p++) {
    const d = await tonapi(`/v2/nfts/collections/${encodeURIComponent(addr)}/items?limit=100&offset=${p * 100}`);
    const items = d && d.nft_items;
    if (!Array.isArray(items) || items.length === 0) break;
    pages++;
    for (const it of items) {
      const s = it.sale;
      if (!s || !s.price || s.price.currency_type !== "native") continue;
      const v = Number(s.price.value);
      if (!Number.isFinite(v) || v <= 0) continue;
      prices.push(v);
    }
    if (items.length < 100) break;        // коллекция закончилась раньше
    if (prices.length >= 40) break;       // плотные листинги: выборки достаточно
  }
  if (!prices.length) return null;
  const allMed = median(prices);
  const clean = prices.filter((v) => v >= 0.4 * allMed);   // фильтр мусора (фишка 2)
  const pool = clean.length >= 2 ? clean : prices;        // фильтр съел всё — берём как есть
  const sorted = [...pool].sort((a, b) => a - b);
  const take = Math.max(3, Math.ceil(sorted.length * 0.1));
  const floor = median(sorted.slice(0, take));            // медиана 10% дешёвых (фишка 1)
  return {
    floor_ton: +(floor / 1e9).toFixed(4),
    min_ton: +(sorted[0] / 1e9).toFixed(4),
    sales: prices.length,
    junk: prices.length - pool.length,
    pages,
  };
}

// курс TON→USD (CoinGecko, бесплатный, один запрос за прогон — фишка 16)
async function tonRate() {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd", {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) continue;
      const j = await res.json().catch(() => null);
      const usd = j && j["the-open-network"] && j["the-open-network"].usd;
      if (Number.isFinite(usd) && usd > 0) return +usd.toFixed(4);
    } catch {}
    await sleep(1500);
  }
  return null;
}

(async () => {
  try {
    const cols = JSON.parse(fs.readFileSync(COLS_FILE, "utf8"));
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(FLOORS_FILE, "utf8")).floors || {}; } catch {}

    const out = {};
    let ok = 0, noaddr = 0, nosale = 0, junked = 0, deepCnt = 0;
    const t0 = Date.now();

    for (const c of cols) {
      const slug = String(c.name || "").trim();
      if (!slug) continue;
      const addr = normAddr(c.address);
      if (!addr) { noaddr++; continue; }
      const pv = prev[slug];
      const pf = pv && Number(pv.f) ? pv.f : null;
      const fresh = pv && pv.t && NOW() - pv.t < 3 * 3600;     // прошлый скан < 3ч назад
      // умная глубина (фишки 3+4): глубокий если флоера нет / цена сдвинулась >5% / данные протухли
      const moved = pf !== null && pv && pv.pf && Number(pv.pf) > 0 && Math.abs(pf - pv.pf) / pv.pf > 0.05;
      const deep = !pf || !fresh || moved; // глубокий скан: нет флоера / протухло >3ч / цена сдвинулась >5%
      if (deep) deepCnt++;
      const res = await scanCollection(addr, deep);
      if (res) {
        out[slug] = {
          f: res.floor_ton,          // текущий флоер, TON (медиана)
          pf: pf,                    // флоер прошлого скана
          s: res.sales,              // лотов в выборке (для честности «≈»)
          k: res.junk,               // мусорных лотов отсечено
          p: res.pages,              // просканировано страниц
          t: NOW(),
        };
        junked += res.junk;
        ok++;
      } else {
        nosale++;
        // лотов не видно (продано всё/нет адреса страницы) — держим прошлые данные, не теряем
        if (prev[slug]) out[slug] = Object.assign({}, prev[slug], { pf: prev[slug].f });
      }
      if (ok % 25 === 0 && ok > 0) console.log(`  … ${ok} флоеров собрано (${Math.round((Date.now()-t0)/1000)}с)`);
    }

    console.log(`ФЛОЕРЫ v2 (медиана): собрано ${ok}, без адреса ${noaddr}, без лотов ${nosale}, мусора отсечено ${junked}, глубоких сканов ${deepCnt}, время ${Math.round((Date.now()-t0)/1000)}с`);

    // курс TON→USD (фишка 16)
    const rate = await tonRate();
    if (rate) console.log(`курс TON→USD: ${rate}`);

    // 1) текущие флоеры — NO-OP если ни один флор/курс не изменился (req.8/15):
    // раньше updated-штамп двигался КАЖДЫЙ прогон = 96 пустых коммитов/сутки
    fs.mkdirSync(path.dirname(FLOORS_FILE), { recursive: true });
    let prevF = {};
    try { prevF = JSON.parse(fs.readFileSync(FLOORS_FILE, "utf8")); } catch {}
    const FLOORS_CHANGED =
      JSON.stringify(prevF.floors || {}) !== JSON.stringify(out) || (prevF.rate_usd || 0) !== (rate || 0);
    if (FLOORS_CHANGED) {
      fs.writeFileSync(FLOORS_FILE, JSON.stringify({
        updated: new Date().toISOString(),
        updated_unix: NOW(),
        rate_usd: rate,
        floors: out,
      }, null, 1));
    }

    // 2) снапшоты каждые 15 МИН (фишка 14) для Δ24ч и спарклайнов (48ч)
    let hist = {};
    try { hist = JSON.parse(fs.readFileSync(HIST_FILE, "utf8")); } catch {}
    if (!Array.isArray(hist.hours)) hist.hours = [];
    const bucketTs = Math.floor(NOW() / 900) * 900;   // 15-минутное ведро
    let bucket = hist.hours.find((h) => h.ts === bucketTs);
    if (!bucket) { bucket = { ts: bucketTs, floors: {} }; hist.hours.push(bucket); }
    for (const [slug, v] of Object.entries(out)) {
      if (v && Number(v.f)) bucket.floors[slug] = v.f;
    }
    hist.hours = hist.hours.filter((h) => h.ts >= NOW() - 48 * 3600).sort((a, b) => a.ts - b.ts);
    fs.writeFileSync(HIST_FILE, JSON.stringify(hist, null, 1));

    // 3) коммит + пуш — ТОЛЬКО при реальном дифе (req.15: git status --porcelain перед коммитом)
    let dirtyF = "";
    try { dirtyF = execSync("git status --porcelain", { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 }).trim(); } catch {}
    const tDur = ((Date.now() - t0) / 1000).toFixed(1);
    if (!dirtyF) {
      console.log(`CHECK COMPLETED | Duration: ${tDur}s | Collections scanned: ${ok} | Changed floors: 0 | Commit: NO (no-op) | Deploy: NO (raw-CDN)`);
      return; // пустой свип: ни коммита, ни пуша, ни Pages-билда
    }
    execSync('git config user.name "gift-monitor"', { cwd: REPO_ROOT });
    execSync('git config user.email "actions@github.com"', { cwd: REPO_ROOT });
    try {
      execSync(`git add ${path.relative(REPO_ROOT, FLOORS_FILE)} ${path.relative(REPO_ROOT, HIST_FILE)}`, { cwd: REPO_ROOT, stdio: "pipe" });
      execSync('git commit -m "floors v2: медиана+фильтр мусора+USD+15м снапшоты [skip ci]"', { cwd: REPO_ROOT, stdio: "pipe" });
    } catch (e) { console.log("нет изменений для коммита"); }
    try { execSync("git push", { cwd: REPO_ROOT, stdio: "pipe" }); }
    catch {
      execSync("git pull --rebase --autostash", { cwd: REPO_ROOT, stdio: "pipe" });
      execSync("git push", { cwd: REPO_ROOT, stdio: "pipe" });
    }
    console.log(`CHECK COMPLETED | Duration: ${tDur}s | Collections scanned: ${ok} | Changed floors: ${FLOORS_CHANGED ? ok : "snapshot-only"} | Commit: YES | Deploy: NO (raw-CDN)`);
  } catch (e) {
    console.error("FATAL:", String(e).slice(0, 300));
    process.exit(1);
  }
})();
