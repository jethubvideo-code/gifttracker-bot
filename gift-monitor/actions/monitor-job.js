#!/usr/bin/env node
/**
 * Gift Monitor — GitHub Actions edition v2 (poller).
 * Тяжёлая работа (120 коллекций каждые 5 мин) крутится БЕСПЛАТНО на серверах GitHub.
 * При обнаружении апгрейда вызывает реле-функцию Base44, которая проверяет и рассылает.
 * Никаких секретов не нужно — реле сама всё проверяет по официальным данным.
 *
 * Режимы: (без аргументов) — обычный прогон по data/enabled.json; force — прогнать всегда.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DATA = path.join(REPO_ROOT, "data");
const COLS_FILE = path.join(__dirname, "..", "collections.json");
const STATE_FILE = path.join(DATA, "state.json");
const ENABLED_FILE = path.join(DATA, "enabled.json");

const RELAY_URL = "https://base44.app/api/apps/6a98178ea237b1c35cce824e/functions/giftRelay";
const MODE = (process.env.MODE || process.argv[2] || "").toLowerCase();
const FORCE = MODE === "force" || (process.env.FORCE || "") === "true";

// ---------- утилиты ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function callRelay(payload) {
  for (let i = 1; i <= 2; i++) {
    try {
      const res = await fetch(RELAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25000),
      });
      return await res.json().catch(() => null);
    } catch {}
    if (i < 2) await sleep(3000);
  }
  return null;
}

// ---------- main ----------
async function main() {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    state = {};
  }
  const cols = require(COLS_FILE);

  let checked = 0,
    errors = 0,
    baselined = 0,
    bumped = 0,
    relayOk = 0;

  await pool(cols, 10, async (c) => {
    const st = state[c.name] || null;
    const cnt = await tgCounter(c.name, st ? st.sample : 1);
    if (!cnt) {
      errors++;
      return;
    }
    checked++;
    if (!st) {
      // первый прогон: baseline, старьё не шлём
      state[c.name] = { issued: cnt.issued, sample: cnt.sample };
      baselined++;
      return;
    }
    if (cnt.issued > st.issued) {
      // НОВЫЙ АПГРЕЙД → реле проверит и разошлёт
      bumped++;
      const r = await callRelay({ slug: c.name, issued: cnt.issued, total: cnt.total, sample: cnt.sample });
      if (r && r.ok) relayOk++;
      console.log(`bump: ${c.name} ${st.issued} → ${cnt.issued}, relay:`, r ? JSON.stringify(r).slice(0, 120) : "FAIL");
      st.issued = cnt.issued;
      st.sample = cnt.sample;
    } else if (cnt.issued < st.issued) {
      // счётчик почему-то уменьшился (перевыпуск) — синхронизируемся молча
      st.issued = cnt.issued;
    }
  });

  console.log(`ИТОГ: checked=${checked}, baseline=${baselined}, bumped=${bumped}, relayOk=${relayOk}, errors=${errors}`);

  // сохраняем state и коммитим в репо
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  try {
    execSync('git config user.name "gift-monitor"', { cwd: REPO_ROOT });
    execSync('git config user.email "actions@github.com"', { cwd: REPO_ROOT });
    execSync("git add data/state.json", { cwd: REPO_ROOT });
    execSync('git commit -m "monitor: state update [skip ci]"', { cwd: REPO_ROOT, stdio: "pipe" });
    execSync("git push", { cwd: REPO_ROOT, stdio: "pipe" });
    console.log("state: закоммичен");
  } catch (e) {
    console.log("state: коммит не потребовался:", String(e.message).slice(0, 100));
  }
}

(async () => {
  try {
    if (!FORCE) {
      let enabled = true;
      try {
        enabled = JSON.parse(fs.readFileSync(ENABLED_FILE, "utf8")).enabled === true;
      } catch {}
      if (!enabled) {
        console.log("MONITOR: выключен (data/enabled.json → enabled=false). Выход.");
        process.exit(0);
      }
    }
    await main();
  } catch (e) {
    console.error("FATAL:", String(e).slice(0, 300));
    process.exit(1);
  }
})();
