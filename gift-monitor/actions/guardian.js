// GUARDIAN — автопилот-охранник системы. 100% GitHub Actions, без внешних платформ и кредитов.
// Запуск: guardian.yml каждые 6 часов + workflow_dispatch (mode=report — только отчёт, без вмешательства).
// Сам, без человека и без агента:
//   1. Проверяет живость эстафеты full-monitor; мертва → перезапускает (dispatch chain).
//   2. Следит за срабатываниями всех воркфлоу: сбои за 12ч, последние выводы каждого.
//   3. Считает бэклог очереди доставки из data/state-full.json.
//   4. Пишет снапшот здоровья в docs/health.json (коммит при изменении).
//   5. При проблемах шлёт краткий отчёт владельцу через бота (TELEGRAM_BOT_TOKEN — var репозитория).

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO = process.env.GITHUB_REPOSITORY || "jethubvideo-code/gifttracker-bot";
const API = "https://api.github.com/repos/" + REPO;
const HDR = { Authorization: "Bearer " + (process.env.GITHUB_TOKEN || ""), Accept: "application/vnd.github+json" };
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const OWNER = process.env.OWNER_CHAT_ID || "8396883978"; // §10: вынести в var OWNER_CHAT_ID, фолбэк удалить после
const MODE = process.env.MODE || "";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WF_ALL = ["full-monitor.yml", "gift-monitor.yml", "new-gift-watch.yml", "floors-scan.yml", "gift-images.yml"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(API + p, { headers: HDR, signal: AbortSignal.timeout(15000), ...opts });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      await sleep(3000);
    }
  }
  return { status: 0, body: null };
}

async function tg(text) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: OWNER, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

(async () => {
  // 1) живость эстафеты
  const full = await api("/actions/workflows/full-monitor.yml/runs?per_page=10");
  const runs = (full.body && full.body.workflow_runs) || [];
  const chainAlive = runs.some((r) => r.status === "queued" || r.status === "in_progress");
  let restarted = false;
  if (!chainAlive && MODE !== "report") {
    const d = await api("/actions/workflows/full-monitor.yml/dispatches", {
      method: "POST",
      headers: { ...HDR, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { force: "chain" } }),
    });
    restarted = d.status === 201 || d.status === 204;
    console.log("GUARDIAN: цепь мертва — эстафета перезапущена:", restarted, "(HTTP", d.status + ")");
  }

  // 2) сбои за 12ч + последние выводы воркфлоу
  const all = await api("/actions/runs?per_page=100");
  const aruns = (all.body && all.body.workflow_runs) || [];
  const t12 = Date.now() - 12 * 3600_000;
  const fails12 = aruns.filter((r) => r.conclusion === "failure" && Date.parse(r.created_at) > t12).length;
  const wfState = {};
  for (const wf of WF_ALL) {
    const last = aruns.find((r) => r.name && r.name.toLowerCase().includes(wf.replace(".yml", "").split("-")[0]) && r.status === "completed");
    wfState[wf] = last ? { conclusion: last.conclusion, at: last.created_at } : null;
  }
  const auxBroken = ["new-gift-watch.yml", "floors-scan.yml", "gift-images.yml"].filter(
    (wf) => wfState[wf] && wfState[wf].conclusion === "failure"
  );

  // 3) бэклог очереди доставки
  let backlog = 0;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data", "state-full.json"), "utf8"));
    for (const k of Object.keys(st)) {
      const v = st[k];
      // только реально доставляемые (lastSentNum>0): без подписчиков lastSentNum=0, это не бэклог
      if (v && typeof v === "object" && Number(v.issued) > 0 && Number(v.lastSentNum) > 0) {
        backlog += Math.max(0, Number(v.issued) - Number(v.lastSentNum));
      }
    }
  } catch (e) {
    console.log("state не читается:", String(e).slice(0, 80));
  }

  // 4) снапшот здоровья → docs/health.json (коммит только при изменении)
  const health = {
    ts: new Date().toISOString(),
    chain_alive: chainAlive,
    chain_restarted: restarted,
    failures_12h: fails12,
    backlog_total: backlog,
    workflows: wfState,
  };
  let changed = true;
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "docs", "health.json"), "utf8"));
    if (prev.chain_alive === health.chain_alive && prev.failures_12h === fails12 && Math.abs((prev.backlog_total || 0) - backlog) < 10) changed = false;
  } catch {}
  if (changed) {
    try {
      fs.writeFileSync(path.join(REPO_ROOT, "docs", "health.json"), JSON.stringify(health, null, 1));
      execSync(
        `git config user.name "guardian-bot" && git config user.email "guardian@users.noreply.github.com" && ` +
          `git add docs/health.json && git commit -m "guardian: health snapshot ts=${Date.now()}" >/dev/null 2>&1 && ` +
          `(git pull --rebase -q >/dev/null 2>&1 || true) && git push`,
        { cwd: REPO_ROOT, timeout: 90_000, stdio: "pipe" }
      );
      console.log("health.json закоммичен");
    } catch (e) {
      console.log("git push health:", String(e).slice(0, 120));
    }
  }

  // 5) отчёт владельцу — только при проблемах (или mode=report)
  const problems = [];
  if (restarted) problems.push("эстафета была мертва — перезапущена");
  if (!chainAlive && !restarted) problems.push("эстафета мертва и перезапуск НЕ удался");
  if (fails12 >= 3) problems.push(`сбоев прогонов за 12ч: ${fails12}`);
  if (auxBroken.length) problems.push("сломаны воркфлоу: " + auxBroken.join(", "));
  console.log(`GUARDIAN: цепь ${chainAlive ? "жива" : "мертва"} | сбоев 12ч ${fails12} | очередь ${backlog} | проблем ${problems.length}`);
  if (problems.length || MODE === "report") {
    await tg(
      `🛡 <b>GUARDIAN</b>\n` +
        `Цепь: ${chainAlive ? "✅ жива" : "❌ мертва"}${restarted ? " → перезапущена" : ""}\n` +
        `Сбои за 12ч: ${fails12}\n` +
        `Очередь доставки: ${backlog} шт\n` +
        (problems.length ? `⚠️ ${problems.join("; ")}` : "Проблем нет, система сама себя содержит.")
    );
  }
})().catch((e) => {
  console.log("GUARDIAN FATAL:", String(e).slice(0, 200));
  process.exit(1);
});
