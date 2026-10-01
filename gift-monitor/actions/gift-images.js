#!/usr/bin/env node
/**
 * Gift Images Sync — картинки всех 120 коллекций для сайта (GitHub Actions).
 * Для каждой коллекции берёт og:image последнего улучшенного NFT
 * со страницы t.me/nft/<slug>-<issued> и складывает в docs/images.json.
 * Сайт использует этот манифест, чтобы выглядеть как настоящий маркетплейс.
 *
 * Запуск: воркфлоу gift-images.yml (каждые 6 часов + вручную).
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GIFTS_FILE = path.join(REPO_ROOT, "docs", "gifts.json");
const IMG_FILE = path.join(REPO_ROOT, "docs", "images.json");

function loadJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; }
}

async function fetchOgImage(slug, num) {
  if (!slug || !num) return "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://t.me/nft/${slug.toLowerCase()}-${num}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) continue;
      const m = (await res.text()).match(/property="og:image"\s+content="([^"]+)"|content="([^"]+)"\s+property="og:image"/);
      return m ? m[1] || m[2] || "" : "";
    } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
  return "";
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx], idx); } catch (e) { console.log("worker err:", String(e).slice(0, 80)); }
    }
  });
  await Promise.all(workers);
}

async function main() {
  const gifts = loadJson(GIFTS_FILE, {});
  const list = Array.isArray(gifts.gifts) ? gifts.gifts : [];
  if (!list.length) { console.log("gifts.json пуст — выходим"); return; }
  const prev = loadJson(IMG_FILE, {});
  let images = { ...(prev.images || {}) };
  if (typeof images !== "object" || Array.isArray(images) || !images) images = {};

  let ok = 0, kept = 0, failed = 0;
  await pool(list, 6, async (g) => {
    const slug = String(g.slug || g.name || "").trim();
    const issued = Number(g.issued) || 0;
    if (!slug || !issued) return;
    const existing = images[slug];
    // картинка уже есть и счётчик не двигался — не перезабираем
    if (existing && existing.__n === issued) { kept++; return; }
    // старый формат: голая строка-URL
    const url = await fetchOgImage(slug, issued);
    if (url) {
      images[slug] = { url, __n: issued };
      ok++;
    } else if (existing) {
      existing.__n = issued; // не теряем картинку, но помечаем позицию
      kept++;
    } else {
      failed++;
    }
  });

  const out = { updated: new Date().toISOString(), images: {} };
  for (const [k, v] of Object.entries(images)) {
    if (k === "__updated") continue;
    out.images[k] = v.url || v;
  }
  fs.writeFileSync(IMG_FILE, JSON.stringify(out, null, 1));
  console.log(`картинки: обновлено ${ok}, сохранено ${kept}, не удалось ${failed}, всего ${Object.keys(out.images).length}`);

  try {
    execSync("git config user.name \"gift-images-bot\"", { cwd: REPO_ROOT, stdio: "pipe" });
    execSync("git config user.email \"actions@github.com\"", { cwd: REPO_ROOT, stdio: "pipe" });
    execSync("git add docs/images.json", { cwd: REPO_ROOT, stdio: "pipe" });
    const st = execSync("git status --porcelain", { cwd: REPO_ROOT, encoding: "utf8" });
    if (st.includes("images.json")) {
      execSync('git commit -m "images: sync gift covers [skip ci]"', { cwd: REPO_ROOT, stdio: "pipe" });
      execSync("git push", { cwd: REPO_ROOT, stdio: "pipe" });
      console.log("коммит запушен");
    } else {
      console.log("без изменений");
    }
  } catch (e) {
    console.log("git:", String(e).slice(0, 120));
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
