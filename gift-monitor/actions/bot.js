/* ═══════════════════════════════════════════════════════════════
   BOT-POLL — бот живёт прямо в движке на GitHub Actions.
   Никаких внешних сервисов: getUpdates-поллинг + ответы командами.
   Подписчики хранятся локально (шифрованный файл, пишет encryptSubs).
   Вызывается из full-job.js каждый свип: await bot.poll({ tg, subs, state, helpers }).
   ═══════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const DOCS = path.join(REPO_ROOT, "docs");
const OWNER_IDS = ["8396883978", "7503491071"];
const CHANNEL = "@unknowesecret";
const PRO_TPL = ["PlushPepe", "PoolFloat", "LolPop"];

const flip = require("./flip.js");

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (x) => String(Math.round(Number(x || 0) * 100) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const fmtInt = (x) => String(Math.round(Number(x) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function readDoc(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DOCS, name), "utf8")); } catch { return null; }
}

function findGift(q) {
  const t = String(q || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return null;
  const doc = readDoc("gifts.json");
  const list = (doc && doc.gifts) || [];
  for (const g of list) if (String(g.slug || g.name).toLowerCase().replace(/\s+/g, "") === t) return g;
  for (const g of list) if (String(g.slug || g.name).toLowerCase().replace(/\s+/g, "").indexOf(t) >= 0) return g;
  return null;
}

function findSub(subs, id) {
  const k = String(id);
  return subs.find((s) => String(s.telegram_id) === k) || null;
}

function newSub(id, chatId) {
  return {
    telegram_id: String(id),
    chat_id: String(chatId || id),
    is_active: true,
    muted_gifts: [],
    night_mode: false,
    radar_mode: false,
    filter_model: "",
    filter_backdrop: "",
    my_gifts: [],
    notify_new_gifts: true,
    free_gift: "",
    language: "ru",
    game_points: 0,
  };
}

async function gateOk(tg, id) {
  if (OWNER_IDS.indexOf(String(id)) >= 0) return true;
  try {
    const r = await tg("getChatMember", { chat_id: CHANNEL, user_id: Number(id) });
    if (r && r.ok && r.result && ["member", "administrator", "creator"].indexOf(r.result.status) >= 0) return true;
    if (r && r.ok) return false;
    return true; // сбой API — не блокируем (fail-open)
  } catch { return true; }
}

function marketButtons(slug) {
  return {
    inline_keyboard: [
      [{ text: "🛒 MRKT", url: `https://t.me/mrkt?startapp=${slug}` }],
      [{ text: "🌊 Portals", url: `https://t.me/portals/market?startapp=${slug}` }, { text: "💎 GetGems", url: `https://getgems.io/collection/${slug.toLowerCase()}` }],
    ],
  };
}

/* ═══ сообщения ═══ */
const WELCOME =
  `🚀 <b>Gift NFT Monitor</b> — слежу за улучшениями Telegram Gifts до NFT.\n\n` +
  `⚡ Все апгрейды всех 120+ подарков — <b>бесплатно</b>, уведомления приходят сами.\n\n` +
  `🎯 Свои подарки: <code>/mine Имя №</code>\n` +
  `💳 Цена коллекции: <code>/card PlushPepe</code>\n` +
  `📅 Календарь лимиток: <code>/calendar</code>\n` +
  `📊 Индекс рынка: <code>/index</code>\n` +
  `🏆 Топ улучшителей: <code>/top</code>\n` +
  `🎮 Игра «Угадай флор»: <code>/game PlushPepe 5000</code>\n` +
  `🌙 Тихий режим: <code>/night</code> · Скрыть подарок: <code>/mute Имя</code>\n\n` +
  `Все команды: <code>/help</code>`;

const NEED_SUB = `📢 Чтобы бот работал, подпишись на канал «Банк звёзд» @unknowesecret — там бесплатные фишки и розыгрыши.\n\nПосле подписки нажми кнопку ниже 👇`;

/* ═══ обработка одного апдейта ═══ */
async function handleMessage(tg, subs, msg) {
  const fromId = String(msg.from && msg.from.id);
  const chatId = String(msg.chat && msg.chat.id) || fromId;
  if (!fromId) return false;
  const text = String(msg.text || "").trim();
  let changed = false;
  let sub = findSub(subs, fromId);

  if (!text) return false;
  let c = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  const args = text.split(/\s+/).slice(1).join(" ").trim();

  if (c === "/start" || c === "/help" || c === "/track") {
    const ok = await gateOk(tg, fromId);
    if (!ok) {
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: NEED_SUB, reply_markup: { inline_keyboard: [
        [{ text: "📢 Вступить в канал", url: "https://t.me/unknowesecret" }],
        [{ text: "✅ Я подписался", callback_data: "checksub" }],
      ] } });
      return changed;
    }
    if (!sub) { sub = newSub(fromId, chatId); subs.push(sub); changed = true; }
    if (!sub.is_active) { sub.is_active = true; changed = true; }
    if (c === "/help") {
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text:
        `📖 <b>Все команды:</b>\n\n` +
        `/start — включить уведомления\n/stop — выключить\n\n` +
        `🎯 <b>/mine Имя №</b> — следить за СВОИМ подарком (например <code>/mine PoolFloat 12345</code>)\n` +
        `🎯 /mine — список, <code>/mine del 1</code> — удалить\n\n` +
        `💳 /card Имя — флор, лоты, счётчик + кнопки MRKT/Portals/GetGems\n` +
        `📅 /calendar — календарь лимиток со скоростью распродажи\n` +
        `📊 /index — GM INDEX: Σ флоров, медиана, TON→USD\n` +
        `🏆 /top — лидерборд улучшителей\n` +
        `🎮 /game Имя ЦЕНА — прогноз флора на завтра, очки за точность\n` +
        `🛠 /api — открытые данные для разработчиков\n\n` +
        `🌙 /night — тихий режим 23:00–08:00\n` +
        `🙈 /mute Имя — скрыть подарок, /unmute Имя — вернуть\n\n` +
        `🌐 Мини-апп: меню бота → «Мини Апп»\n\n🎓 <b>Flip-школа:</b> /flip гайд · /academy 5 шагов · /sim тренажёр · /calc профит · /trends · /limits`, reply_markup: menuKb() });
      return changed;
    }
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text: WELCOME, reply_markup: menuKb() });
    return changed;
  }

  if (c === "/stop" || c === "/hide") {
    if (sub && sub.is_active) { sub.is_active = false; changed = true; }
    await tg("sendMessage", { chat_id: chatId, text: "⏸ Уведомления выключены. Вернуть: /start" });
    return changed;
  }

  if (!sub || !sub.is_active) {
    await tg("sendMessage", { chat_id: chatId, text: "Сначала включи бота: /start 👋" });
    return changed;
  }

  /* 🎯 мои подарки */
  if (c === "/mine") {
    let mine = Array.isArray(sub.my_gifts) ? sub.my_gifts.map(String) : [];
    const m = args.match(/^del\s+(\d+)$/i);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < mine.length) {
        const removed = mine.splice(idx, 1);
        sub.my_gifts = mine; changed = true;
        await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `🗑 Убрал: <b>${esc(removed[0])}</b>\nОсталось: ${mine.length} шт.` });
      } else {
        await tg("sendMessage", { chat_id: chatId, text: "Номер не найден. Смотри список: /mine" });
      }
      return changed;
    }
    const add = args.match(/^([A-Za-zА-Яа-я0-9_ ]+?)\s*[#№]?\s*(\d{1,7})$/);
    if (add) {
      const g = findGift(add[1]);
      if (!g) { await tg("sendMessage", { chat_id: chatId, text: `Подарок «${esc(add[1])}» не найден. /calendar — все подарки` }); return changed; }
      const slug = String(g.slug || g.name);
      const entry = `${slug}:${parseInt(add[2], 10)}`;
      if (mine.some((x) => x.toLowerCase() === entry.toLowerCase())) {
        await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `Уже есть в списке: <b>${esc(entry)}</b>` });
      } else if (mine.length >= 20) {
        await tg("sendMessage", { chat_id: chatId, text: "Лимит: 20 подарков. Удали старый: /mine del N" });
      } else {
        mine.push(entry);
        sub.my_gifts = mine; changed = true;
        await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `✅ <b>Твой подарок на радаре!</b>\n\n🎯 ${esc(slug)} #${add[2]}\n\nКак только его улучшат до NFT — узнаешь первым, отдельным уведомлением.\nСписок: /mine` });
      }
      return changed;
    }
    if (!mine.length) {
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: "🎯 <b>Мои подарки</b>\n\nПока пусто. Добавь свой:\n<code>/mine PoolFloat 12345</code>\n\nКогда именно ТВОЙ номер улучшат до NFT — придёт личное уведомление 🚀" });
    } else {
      const doc = readDoc("gifts.json");
      const list = (doc && doc.gifts) || [];
      const lines = mine.map((x, i) => {
        const [slug, num] = x.split(":");
        const g = list.find((y) => String(y.slug || y.name).toLowerCase() === String(slug).toLowerCase());
        const issued = g ? Number(g.issued) || 0 : 0;
        const done = issued >= parseInt(num, 10);
        return `${i + 1}. ${done ? "✅" : "⏳"} ${esc(slug)} #${num}${done ? " — улучшен!" : ` (улучшено ${fmtInt(issued)})`}`;
      });
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `🎯 <b>Мои подарки (${mine.length}/20):</b>\n\n${lines.join("\n")}\n\nДобавить: <code>/mine Имя №</code>\nУдалить: <code>/mine del N</code>` });
    }
    return changed;
  }

  /* 💳 карточка */
  if (c === "/card") {
    if (!args) { await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: "💳 Карточка коллекции:\n<code>/card PlushPepe</code>" }); return changed; }
    const g = findGift(args);
    if (!g) { await tg("sendMessage", { chat_id: chatId, text: `Подарок «${esc(args)}» не найден. /calendar — все подарки` }); return changed; }
    const slug = String(g.slug || g.name);
    const doc = readDoc("floors.json") || { floors: {} };
    const fEnt = (doc.floors || {})[slug] || null;
    const fl = fEnt ? Number(fEnt.f) || 0 : 0;
    const pf = fEnt ? Number(fEnt.pf) || 0 : 0;
    const rate = Number(doc.rate_usd) || 0;
    const listed = fEnt ? Number(fEnt.s) || 0 : 0;
    let delta = "";
    if (fl && pf) {
      const d = ((fl - pf) / pf) * 100;
      delta = d > 0.05 ? ` (+${fmt(d)}%) 📈` : d < -0.05 ? ` (${fmt(d)}%) 📉` : " (0%)";
    }
    const pct = g.total ? Math.round((g.issued / g.total) * 100) : 0;
    const text = `💳 <b>${esc(g.name || slug)}</b>\n\n` +
      (fl ? `💰 Флор: <b>${fmt(fl)} TON</b>${rate ? ` (≈ $${fmt(fl * rate)})` : ""}${delta}\n🛒 Лотов: ${fmtInt(listed)}` : "💰 Лотов сейчас нет") +
      `\n📈 Улучшено: ${fmtInt(g.issued)} из ${fmtInt(g.total)} (${pct}%)` +
      `\n\n🔗 <a href="https://t.me/nft/${slug.toLowerCase()}-${g.issued}">Открыть подарок</a>`;
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text, link_preview_options: { is_disabled: false, url: `https://t.me/nft/${slug.toLowerCase()}-${g.issued}`, show_above_text: true }, reply_markup: marketButtons(slug) });
    return changed;
  }

  /* 📅 календарь */
  if (c === "/calendar") {
    const gdoc = readDoc("gifts.json");
    const hdoc = readDoc("history.json");
    if (!gdoc) { await tg("sendMessage", { chat_id: chatId, text: "⏳ Данные не готовы, попробуй через минуту" }); return changed; }
    const hours = (hdoc && hdoc.hours) || [];
    const rateOf = {};
    if (hours.length >= 2) {
      const last = hours[hours.length - 1];
      const first = hours[Math.max(0, hours.length - 24)];
      for (const g of gdoc.gifts) {
        const s = String(g.slug || g.name);
        const a = first.issued ? first.issued[s] : undefined;
        const b2 = last.issued ? last.issued[s] : undefined;
        if (a !== undefined && b2 !== undefined && b2 > a) rateOf[s] = b2 - a;
      }
    }
    const sorted = gdoc.gifts.slice().sort((a, b) => (Number(b.added) || 0) - (Number(a.added) || 0)).slice(0, 10);
    const now = Date.now() / 1000;
    const lines = sorted.map((g) => {
      const s = String(g.slug || g.name);
      const rest = g.total ? g.total - g.issued : 0;
      const rate = rateOf[s] || 0;
      const eta = rate > 0 && rest > 0 ? ` · распродажа ~${fmt(rest / rate / 24)}д` : "";
      const isNew = g.added && now - g.added < 7 * 86400 ? " 🆕" : "";
      return `• <b>${esc(g.name || s)}</b>${isNew}\n  улучшено ${fmtInt(g.issued)} из ${fmtInt(g.total)} · осталось ${fmtInt(rest)}${eta}`;
    });
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `📅 <b>Календарь лимиток</b>\n\nПоследние коллекции (верхние = новее):\n\n${lines.join("\n\n")}\n\n⏳ Оценка по скорости улучшений за 24ч.` });
    return changed;
  }

  /* 📊 индекс */
  if (c === "/index") {
    const doc = readDoc("floors.json");
    if (!doc) { await tg("sendMessage", { chat_id: chatId, text: "⏳ Данные не готовы, попробуй через минуту" }); return changed; }
    const vals = [];
    for (const k of Object.keys(doc.floors || {})) { const v = Number((doc.floors[k] || {}).f) || 0; if (v > 0) vals.push(v); }
    const sum = vals.reduce((a, b) => a + b, 0);
    const sorted = vals.slice().sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const rate = Number(doc.rate_usd) || 0;
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `📊 <b>GM INDEX — индекс рынка</b>\n\nΣ флоров всех коллекций:\n<b>${fmt(sum)} TON</b>${rate ? ` ≈ <b>$${fmt(sum * rate)}</b>` : ""}\n\nКоллекций с флором: ${vals.length}\nМедианный флор: ${fmt(median)} TON${rate ? ` (≈ $${fmt(median * rate)})` : ""}\n\nТоп-дешёвые и топ-дорогие — на сайте, раздел ПРО 🌐` });
    return changed;
  }

  /* 🏆 топ улучшителей */
  if (c === "/top") {
    let leaders = [];
    let src = null;
    try { src = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data", "state-full.json"), "utf8")); } catch { src = null; }
    const agg = {};
    if (src) {
      for (const key of Object.keys(src)) {
        const l = src[key] && src[key].leaders ? src[key].leaders : {};
        for (const name of Object.keys(l)) agg[name] = (agg[name] || 0) + l[name];
      }
    }
    leaders = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const medals = ["🥇", "🥈", "🥉"];
    const lines = leaders.map(([name, cnt], i) => `${medals[i] || (i + 1) + "."} <b>${esc(name)}</b> — ${cnt} ⚡`);
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `🏆 <b>Топ улучшителей</b>\n\n${lines.join("\n") || "Счётчик копится — заходи позже"}\n\nУлучшишь свой подарок — попадёшь в топ 😉` });
    return changed;
  }

  /* 🛠 API */
  if (c === "/api") {
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text:
      `🛠 <b>Открытые данные</b>\n\nJSON обновляются автоматически, без ключей:\n` +
      `• status.json — лента апгрейдов\n• gifts.json — все коллекции\n• floors.json — флоры + курс TON/USD\n` +
      `• floors-hist.json — история флоров\n• history.json — почасовая история\n• images.json — картинки\n• leaders.json — лидерборд\n\n` +
      `Виджет для любого сайта:\n<code>&lt;script src=".../embed.js" data-gift="PlushPepe"&gt;&lt;/script&gt;</code>\n\n` +
      `Браузер данных — в мини-аппе, раздел ПРО 🌐` });
    return changed;
  }

  /* 🎮 игра */
  if (c === "/game") {
    const guess = args.match(/^([A-Za-zА-Яа-я0-9_ ]+?)\s+(\d+(?:[.,]\d+)?)$/);
    if (guess) {
      const g = findGift(guess[1]);
      if (!g) { await tg("sendMessage", { chat_id: chatId, text: `Подарок «${esc(guess[1])}» не найден. /calendar — все подарки` }); return changed; }
      const val = parseFloat(guess[2].replace(",", "."));
      if (!(val > 0) || val > 1e6) { await tg("sendMessage", { chat_id: chatId, text: "Цена в TON, например: /game PlushPepe 5000" }); return changed; }
      sub.game_slug = String(g.slug || g.name);
      sub.game_guess_ton = val;
      sub.game_target_ts = Date.now() + 24 * 3600 * 1000;
      changed = true;
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `🎮 <b>Прогноз принят!</b>\n\n🎯 ${esc(sub.game_slug)} — ты назвал <b>${fmt(val)} TON</b>\n\n⏳ Через 24 часа отправь <code>/game</code> — сверим с реальным флором.\nОчки: промах до 5% = 10 · до 15% = 6 · до 30% = 3 · иначе 1` });
      return changed;
    }
    if (sub.game_slug && sub.game_target_ts) {
      if (Date.now() < sub.game_target_ts) {
        const left = Math.ceil((sub.game_target_ts - Date.now()) / 3600000);
        await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `🎮 <b>Твой прогноз:</b> ${esc(sub.game_slug)} — ${fmt(sub.game_guess_ton)} TON\n\n⏳ До проверки: ~${left} ч. Возвращайся: /game` });
      } else {
        const doc = readDoc("floors.json") || { floors: {} };
        const ent = (doc.floors || {})[sub.game_slug];
        const actual = ent ? Number(ent.f) || 0 : 0;
        if (!actual) {
          await tg("sendMessage", { chat_id: chatId, text: `⏳ По ${esc(sub.game_slug)} нет лотов — флор не определить. Попробуй позже: /game` });
        } else {
          const d = Math.abs(actual - sub.game_guess_ton) / actual;
          const score = d <= 0.05 ? 10 : d <= 0.15 ? 6 : d <= 0.3 ? 3 : 1;
          sub.game_points = (Number(sub.game_points) || 0) + score;
          const myGuess = sub.game_guess_ton;
          const mySlug = sub.game_slug;
          sub.game_slug = ""; sub.game_guess_ton = 0; sub.game_target_ts = 0;
          changed = true;
          const verdict = score >= 10 ? "🎯 Снайпер!" : score >= 6 ? "👏 Близко!" : score >= 3 ? "🙂 Нормально" : "😅 Мимо, но очко есть";
          await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `🎮 <b>Проверка прогноза — ${esc(mySlug)}</b>\n\nТвой прогноз: ${fmt(myGuess)} TON\nРеальный флор: <b>${fmt(actual)} TON</b>\nПромах: ${fmt(d * 100)}%\n\n${verdict} <b>+${score} очк.</b>\nВсего очков: <b>${fmtInt(sub.game_points)}</b>\n\nНовый прогноз: <code>/game Имя ЦЕНА</code>` });
        }
      }
    } else {
      const doc = readDoc("floors.json") || { floors: {} };
      const arr = Object.entries(doc.floors || {}).filter(([, v]) => (Number((v || {}).f) || 0) > 5);
      const suggest = arr.length ? arr[Math.floor(Math.random() * arr.length)][0] : PRO_TPL[0];
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `🎮 <b>Угадай флор!</b>\n\nНазови флор коллекции на завтра:\n<code>/game ${esc(suggest)} 5000</code>\n\nЧерез 24 часа сверим с реальной ценой 🏆\nТвои очки: <b>${fmtInt(sub.game_points || 0)}</b>` });
    }
    return changed;
  }

  /* ═══ Flip-школа ═══ */
  if (c === "/flip") {
    const nm = args.match(/(\d+)/);
    if (!nm) {
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text:
        `🎓 <b>Flip-школа</b>\n\nНаучись флипать подарки с нуля:\n\n📚 <b>Гайд</b> — 7 уроков флипа\n🎓 <b>Академия</b> — 5 шагов для новичка\n🏋️ <b>Тренажёр</b> — виртуальные 1000 TON на реальных ценах\n🧮 <b>Калькулятор</b> — профит после комиссий\n🔥 <b>Тренды</b> — растут/падают\n🆕 <b>Лимитки</b> — радар новых серий\n\nВыбирай кнопкой ⬇️ или командой: /flip 3 — сразу к уроку`, reply_markup: flip.flipKb() });
      return changed;
    }
    let n = parseInt(nm[1], 10);
    if (!(n >= 1 && n <= flip.LESSONS.length)) n = 1;
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text: flip.LESSONS[n - 1].b, reply_markup: lessonKb(n) });
    return changed;
  }

  if (c === "/academy") {
    let st = Number(sub.flip_step) || 0;
    if (st < 0 || st >= flip.ACADEMY.length) st = 0;
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text: flip.ACADEMY[st] + "\n\nПрогресс: " + (st + 1) + "/" + flip.ACADEMY.length, reply_markup: academyKb(st) });
    return changed;
  }

  if (c === "/sim") {
    const parts = text.split(/\s+/);
    const subCmd = (parts[1] || "").toLowerCase();
    if (subCmd === "reset") {
      sub.sim = null; changed = true;
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: "🔄 Тренажёр сброшен. Новый банк: 1000 TON. Покупай: /sim buy PlushPepe 1" });
      return changed;
    }
    if (subCmd === "buy" || subCmd === "sell") {
      const slugRaw = parts[2] || "";
      const qty = Math.max(1, parseInt(parts[3] || "1", 10) || 1);
      const g = findGift(slugRaw);
      if (!g) { await tg("sendMessage", { chat_id: chatId, text: `Подарок «${esc(slugRaw)}» не найден. /calendar — все подарки` }); return changed; }
      const slug = String(g.slug || g.name);
      const floors = readDoc("floors.json") || {};
      const r = subCmd === "buy" ? flip.simBuy(sub, slug, qty, floors) : flip.simSell(sub, slug, qty, floors);
      if (r.changed) changed = true;
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text: r.msg });
      return changed;
    }
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text: flip.simStatus(sub, readDoc("floors.json") || {}) });
    return changed;
  }

  if (c === "/calc") {
    const m = args.match(/(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)/);
    const t = m ? flip.calcText(parseFloat(m[1].replace(",", ".")), parseFloat(m[2].replace(",", "."))) : null;
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true },
      text: t || "🧮 <b>Калькулятор флипа</b>\n\nПришли цены: <code>/calc ПОКУПКА ПРОДАЖА</code>\nПример: <code>/calc 100 120</code> — купил за 100, продаёшь за 120.\n\nУчтёт комиссию маркета 5% и газ." });
    return changed;
  }

  if (c === "/trends") {
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text: flip.trendsText(readDoc("floors-hist.json")) });
    return changed;
  }

  if (c === "/limits") {
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text: flip.limitsText(readDoc("gifts.json"), readDoc("history.json"), readDoc("floors.json")) });
    return changed;
  }

  /* 🌙 ночь */
  if (c === "/night") {
    sub.night_mode = !sub.night_mode;
    changed = true;
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: sub.night_mode ? "🌙 <b>Тихий режим ВКЛ</b> (23:00–08:00 уведомления без звука)" : "🌙 Тихий режим ВЫКЛ — уведомления со звуком" });
    return changed;
  }

  /* 🙈 мьюты */
  if (c === "/mute" || c === "/unmute") {
    let mutes = Array.isArray(sub.muted_gifts) ? sub.muted_gifts.map(String) : [];
    if (!args) {
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `🙈 Скрытые: ${mutes.length ? mutes.map(esc).join(", ") : "нет"}\n\nСкрыть: <code>/mute Имя</code> · Вернуть: <code>/unmute Имя</code> (макс. 5)` });
      return changed;
    }
    const g = findGift(args);
    const slug = g ? String(g.slug || g.name) : args;
    if (c === "/mute") {
      if (!mutes.some((x) => x.toLowerCase() === slug.toLowerCase())) {
        if (mutes.length >= 5) { await tg("sendMessage", { chat_id: chatId, text: "Максимум 5 скрытых. /unmute чтобы освободить место" }); return changed; }
        mutes.push(slug);
        sub.muted_gifts = mutes; changed = true;
      }
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `🙈 ${esc(slug)} скрыт — уведомления по нему не придут` });
    } else {
      const before = mutes.length;
      mutes = mutes.filter((x) => x.toLowerCase() !== slug.toLowerCase());
      if (mutes.length !== before) { sub.muted_gifts = mutes; changed = true; }
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `👁 ${esc(slug)} снова в эфире` });
    }
    return changed;
  }

  await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `Не знаю такую команду 🙂\nВсе команды: /help` });
  return changed;
}

function menuKb() {
  return { inline_keyboard: [
    [{ text: "🎯 Мои подарки", callback_data: "menu:mine" }, { text: "📅 Календарь", callback_data: "menu:cal" }],
    [{ text: "📊 GM INDEX", callback_data: "menu:idx" }, { text: "🏆 Топ", callback_data: "menu:top" }],
    [{ text: "🎮 Игра", callback_data: "menu:game" }, { text: "🌙 Режим", callback_data: "menu:night" }],
    [{ text: "🎓 Flip-школа", callback_data: "menu:flip" }],
    [{ text: "📖 Все команды", callback_data: "menu:help" }],
  ] };
}

function lessonKb(n) {
  const total = flip.LESSONS.length;
  const row = [];
  if (n > 1) row.push({ text: "⬅️", callback_data: "flip:lesson:" + (n - 1) });
  row.push({ text: "📚 " + n + "/" + total, callback_data: "menu:flip" });
  if (n < total) row.push({ text: "➡️", callback_data: "flip:lesson:" + (n + 1) });
  return { inline_keyboard: [row, [{ text: "🎓 Flip-школа", callback_data: "menu:flip" }]] };
}

function academyKb(st) {
  if (st < flip.ACADEMY.length - 1) return { inline_keyboard: [[{ text: "➡️ Дальше", callback_data: "flip:acad:next" }], [{ text: "🎓 Flip-школа", callback_data: "menu:flip" }]] };
  return { inline_keyboard: [[{ text: "🏋️ В тренажёр", callback_data: "flip:sim" }, { text: "🎓 Flip-школа", callback_data: "menu:flip" }]] };
}

async function handleCallback(tg, subs, q) {
  const fromId = String(q.from && q.from.id);
  const chatId = String(q.message && q.message.chat && q.message.chat.id) || fromId;
  let changed = false;
  if (String(q.data) === "checksub") {
    const ok = await gateOk(tg, fromId);
    if (ok) {
      let sub = findSub(subs, fromId);
      if (!sub) { sub = newSub(fromId, chatId); subs.push(sub); changed = true; }
      sub.is_active = true; changed = true;
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Подписка подтверждена!" });
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text: WELCOME, reply_markup: menuKb() });
    } else {
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Подписки на канал ещё нет", show_alert: true });
    }
  } else if (/^flip:lesson:\d+$/.test(String(q.data))) {
    const n = parseInt(String(q.data).split(":")[2], 10);
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    if (n >= 1 && n <= flip.LESSONS.length) {
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text: flip.LESSONS[n - 1].b, reply_markup: lessonKb(n) });
    }
  } else if (String(q.data) === "flip:acad:next") {
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    let sub2 = findSub(subs, fromId);
    if (!sub2) { sub2 = newSub(fromId, chatId); subs.push(sub2); changed = true; }
    let st = (Number(sub2.flip_step) || 0) + 1;
    if (st >= flip.ACADEMY.length) st = flip.ACADEMY.length - 1;
    sub2.flip_step = st; changed = true;
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text: flip.ACADEMY[st] + "\n\nПрогресс: " + (st + 1) + "/" + flip.ACADEMY.length, reply_markup: academyKb(st) });
  } else if (String(q.data).indexOf("menu:") === 0) {
    const cmd = ({ "menu:mine": "/mine", "menu:cal": "/calendar", "menu:idx": "/index", "menu:top": "/top", "menu:game": "/game", "menu:night": "/night", "menu:help": "/help", "menu:flip": "/flip", "menu:academy": "/academy", "menu:trends": "/trends", "menu:limits": "/limits", "menu:calc": "/calc", "flip:sim": "/sim" })[String(q.data)];
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    if (cmd) {
      const t = await handleMessage(tg, subs, { from: { id: Number(fromId) }, chat: { id: Number(chatId) }, text: cmd });
      changed = t || changed;
    }
  } else {
    await tg("answerCallbackQuery", { callback_query_id: q.id });
  }
  return changed;
}

/* ═══ точка входа: поллинг апдейтов ═══ */
async function poll({ tg, subs, state }) {
  let changed = false;
  const off = (state.__bot && state.__bot.offset) || 0;
  let r = await tg("getUpdates", { offset: off, timeout: 4, allowed_updates: ["message", "callback_query"] });
  if (r && r.ok === false && r.error_code === 409) {
    console.log("бот: вебхук ещё стоит — снимаю (бот теперь живёт на GitHub)");
    await tg("deleteWebhook", { drop_pending_updates: false });
    r = await tg("getUpdates", { offset: off, timeout: 4, allowed_updates: ["message", "callback_query"] });
  }
  if (!r || !r.ok || !Array.isArray(r.result) || !r.result.length) {
    if (r && r.ok === false) console.log("бот: getUpdates ошибка:", JSON.stringify(r).slice(0, 120));
    return { subsChanged: changed, processed: 0 };
  }
  let newOff = off;
  for (const u of r.result) {
    newOff = Math.max(newOff, u.update_id + 1);
    try {
      if (u.message) changed = (await handleMessage(tg, subs, u.message)) || changed;
      else if (u.callback_query) changed = (await handleCallback(tg, subs, u.callback_query)) || changed;
    } catch (e) {
      console.log("бот: ошибка обработки:", String(e).slice(0, 120));
    }
  }
  state.__bot = { offset: newOff };
  console.log(`бот: обработано ${r.result.length}, offset ${newOff}${changed ? " (+изменения подписчиков)" : ""}`);
  return { subsChanged: changed, processed: r.result.length };
}

module.exports = { poll };
