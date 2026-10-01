// Сканер флоеров (минимальных цен лотов) всех коллекций Telegram Gifts.
// Источник: тонапи (листинги GetGems в метаданных NFT). Работает НА GitHub Actions,
// внешних платформ не касается. Пишет:
//   docs/floors.json      — текущие флоеры + Δ с прошлого скана (+ данные для шита)
//   docs/floors-hist.json — почасовые снапшоты флоеров за 48ч (для Δ24ч и спарклайнов на сайте)
// Запуск: .github/workflows/floors-scan.yml (каждые 15 мин) + workflow_dispatch.
// Честность: флоер = мин. цена среди просканированной выборки лотов (до 600 экз./коллекция,
// лимит бесплатного тонапи ~1 запрос/сек); для гигантских коллекций это приближение «≈».

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const COLS_FILE = path.join(REPO_ROOT, "gift-monitor", "collections.json");
const FLOORS_FILE = path.join(REPO_ROOT, "docs", "floors.json");
const HIST_FILE = path.join(REPO_ROOT, "docs", "floors-hist.json");

const TONAPI_KEY = (process.env.TONAPI_KEY || "").trim();
const NOW = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// адреса в collections.json бывают трёх форматов; тонапи хочет raw (0:) или base64 (EQ/UQ)
function normAddr(a) {
  a = String(a || "").trim();
  if (!a) return "";
  if (/^0x/i.test(a)) return "0:" + a.slice(2); // hex → raw
  return a;
}

// строгая очередь: ~1 запрос в 1.05с — анонимный лимит тонапи ≈1 rps; при ключе быстрее не рискуем
let chain = Promise.resolve();
function tonapi(url) {
  const p = chain.then(async () => {
    await sleep(1050);
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`https://tonapi.io${url}`, {
          headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : { "User-Agent": "Mozilla/5.0" },
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

// скан одной коллекции: страницы по 100 NFT, ищем sale.price (нативные TON), берём минимум
async function scanCollection(addr) {
  let floor = Infinity, sales = 0, pages = 0;
  const MAXP = 6; // до 600 экземпляров за скан (бюджет бесплатного тонапи)
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
      if (v < floor) floor = v;
      sales++;
    }
    if (items.length < 100) break;   // коллекция закончилась раньше 600
    if (sales >= 20) break;          // плотные листинги: флоер уже виден
  }
  return floor === Infinity ? null : { floor_ton: +(floor / 1e9).toFixed(4), sales, pages };
}

(async () => {
  try {
    const cols = JSON.parse(fs.readFileSync(COLS_FILE, "utf8"));
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(FLOORS_FILE, "utf8")).floors || {}; } catch {}

    const out = {};
    let ok = 0, noaddr = 0, nosale = 0;
    const t0 = Date.now();

    for (const c of cols) {
      const slug = String(c.name || "").trim();
      if (!slug) continue;
      const addr = normAddr(c.address);
      if (!addr) { noaddr++; continue; }
      const res = await scanCollection(addr);
      if (res) {
        out[slug] = {
          f: res.floor_ton,                                  // текущий флоер, TON
          pf: prev[slug] && Number(prev[slug].f) ? prev[slug].f : null, // флоер прошлого скана
          s: res.sales,                                      // лотов в выборке (для честности «≈»)
          p: res.pages,                                      // просканировано страниц
          t: NOW(),
        };
        ok++;
      } else {
        nosale++;
        // лотов не видно (продано всё/нет адреса страницы) — держим прошлые данные, не теряем
        if (prev[slug]) out[slug] = Object.assign({}, prev[slug], { pf: prev[slug].f });
      }
      if (ok % 25 === 0 && ok > 0) console.log(`  … ${ok} флоеров собрано (${Math.round((Date.now()-t0)/1000)}с)`);
    }

    console.log(`ФЛОЕРЫ: собрано ${ok}, без адреса ${noaddr}, без лотов ${nosale}, время ${Math.round((Date.now()-t0)/1000)}с`);

    // 1) текущие флоеры
    fs.mkdirSync(path.dirname(FLOORS_FILE), { recursive: true });
    fs.writeFileSync(FLOORS_FILE, JSON.stringify({
      updated: new Date().toISOString(),
      updated_unix: NOW(),
      floors: out,
    }, null, 1));

    // 2) почасовые снапшоты для Δ24ч и спарклайнов (48ч)
    let hist = {};
    try { hist = JSON.parse(fs.readFileSync(HIST_FILE, "utf8")); } catch {}
    if (!Array.isArray(hist.hours)) hist.hours = [];
    const hourTs = Math.floor(NOW() / 3600) * 3600;
    let bucket = hist.hours.find((h) => h.ts === hourTs);
    if (!bucket) { bucket = { ts: hourTs, floors: {} }; hist.hours.push(bucket); }
    for (const [slug, v] of Object.entries(out)) {
      if (v && Number(v.f)) bucket.floors[slug] = v.f;
    }
    hist.hours = hist.hours.filter((h) => h.ts >= NOW() - 48 * 3600).sort((a, b) => a.ts - b.ts);
    fs.writeFileSync(HIST_FILE, JSON.stringify(hist, null, 1));

    // 3) коммит + пуш (с ретраем на гонку с движком)
    execSync('git config user.name "gift-monitor"', { cwd: REPO_ROOT });
    execSync('git config user.email "actions@github.com"', { cwd: REPO_ROOT });
    execSync("git add docs/floors.json docs/floors-hist.json", { cwd: REPO_ROOT });
    execSync('git commit -m "floors: scan update [skip ci]"', { cwd: REPO_ROOT, stdio: "pipe" });
    try {
      execSync("git push", { cwd: REPO_ROOT, stdio: "pipe" });
    } catch {
      execSync("git pull --rebase --autostash", { cwd: REPO_ROOT, stdio: "pipe" });
      execSync("git push", { cwd: REPO_ROOT, stdio: "pipe" });
    }
    console.log("floors.json + floors-hist.json: закоммичены и запушены");
  } catch (e) {
    console.error("FATAL:", String(e).slice(0, 300));
    process.exit(1);
  }
})();
