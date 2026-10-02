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
  `📊 Индекс рынка: <code>/index</code>\n\n` +
  `🌐 Мини-апп: меню бота → «Мини Апп»\n\n` +
  `Все команды: <code>/help</code>`;

const NEED_SUB = `📢 Чтобы бот работал, подпишись на канал «Банк звёзд» @unknowesecret — там бесплатные фишки и розыгрыши.\n\nПосле подписки нажми кнопку ниже 👇`;

/* ═══ обработка одного апдейта ═══ */
/* ═══════════ ПАРТНЁРСКАЯ ВИТРИНА (100% GitHub, без внешних сервисов) ═══════════
   Анкета в 5 шагов прямо в чате. Заявка пишется в data/partners.json,
   движок публикует её в docs/partners.json → сайт показывает карточку.
   Шаги живут в sub.pt (шифрованный subscribers.enc, персистентны между свипами). */
const PT_FILE = path.join(REPO_ROOT, "data", "partners.json");

function ptList() {
  try { const a = JSON.parse(fs.readFileSync(PT_FILE, "utf8")); if (Array.isArray(a)) return a; } catch {}
  return [];
}

async function ptStep(tg, sub, chatId, text) {
  const p = sub.pt;
  const t = String(text || "").trim();
  if (t.toLowerCase() === "/cancel" || t.toLowerCase() === "/stop") {
    sub.pt = null;
    await tg("sendMessage", { chat_id: chatId, text: "❌ Анкета отменена. Начать заново: /partner" });
    return true;
  }
  if (p.step === "name") {
    if (t.length < 2 || t.length > 60) {
      await tg("sendMessage", { chat_id: chatId, text: "⚠️ Название: от 2 до 60 символов. Попробуй ещё раз" });
      return true;
    }
    p.name = t; p.step = "desc";
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `✍️ Отлично: <b>${esc(t)}</b>\n\n<b>2/5.</b> Короткое описание — чем занимаетесь? (до 200 символов)` });
    return true;
  }
  if (p.step === "desc") {
    p.desc = t.slice(0, 200); p.step = "site";
    await tg("sendMessage", { chat_id: chatId, text: "🔗 3/5. Ссылка на сайт?\n(если нет сайта — отправь «-»)" });
    return true;
  }
  if (p.step === "site") {
    p.site = t === "-" ? "" : t.slice(0, 300); p.step = "tg";
    await tg("sendMessage", { chat_id: chatId, text: "✈️ 4/5. Telegram-канал или @юзернейм?\n(или «-»)" });
    return true;
  }
  if (p.step === "tg") {
    p.tg = t === "-" ? "" : t.slice(0, 100); p.step = "ig";
    await tg("sendMessage", { chat_id: chatId, text: "📷 5/5. Instagram?\n(или «-»)" });
    return true;
  }
  if (p.step === "ig") {
    p.ig = t === "-" ? "" : t.slice(0, 100); p.step = "logo";
    await tg("sendMessage", { chat_id: chatId, text: "🏷 Осталось чуть-чуть!\n\nОтправь ЛОГОТИП фото — или /skip без логотипа" });
    return true;
  }
  if (p.step === "logo") {
    if (t.toLowerCase() === "/skip") { p.logo_file_id = ""; return await ptFinish(tg, sub, chatId); }
    await tg("sendMessage", { chat_id: chatId, text: "📷 Жду фото-логотип (или /skip)" });
    return true;
  }
  return true;
}

async function ptFinish(tg, sub, chatId) {
  const p = sub.pt || {};
  const links = [p.site, p.tg, p.ig].filter(Boolean);
  if (!p.name || !links.length) {
    sub.pt = { step: "site", name: p.name || "", desc: p.desc || "", site: "", tg: "", ig: "" };
    await tg("sendMessage", { chat_id: chatId, text: "⚠️ Нужна хотя бы одна ссылка (сайт, Telegram или Instagram).\n\n🔗 Ссылка на сайт? (или «-»)" });
    return true;
  }
  const list = ptList();
  const me = String(sub.telegram_id || "");
  const dayAgo = Date.now() - 86400_000;
  // апдейт-режим: своя свежая карточка обновляется, а не плодится
  const idx = list.findIndex((e) => String(e.added_by) === me && new Date(e.ts).getTime() > dayAgo);
  const entry = {
    id: idx >= 0 ? list[idx].id : String(Date.now()),
    name: String(p.name).slice(0, 60),
    desc: String(p.desc || "").slice(0, 200),
    site: String(p.site || "").slice(0, 300),
    tg: String(p.tg || "").slice(0, 100),
    ig: String(p.ig || "").slice(0, 100),
    logo_file_id: String(p.logo_file_id || ""),
    added_by: me,
    ts: new Date().toISOString(),
  };
  // старый логотип сохраняем, если новый не прислали
  if (idx >= 0 && list[idx].logo_file && !entry.logo_file_id) entry.logo_file = list[idx].logo_file;
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  try { fs.mkdirSync(path.dirname(PT_FILE), { recursive: true }); fs.writeFileSync(PT_FILE, JSON.stringify(list.slice(-400), null, 1)); } catch (e) {
    await tg("sendMessage", { chat_id: chatId, text: "⚠️ Не получилось сохранить, попробуй позже (/partner)" });
    return true;
  }
  sub.pt = null;
  await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text:
    "✅ <b>Карточка принята!</b>\n\nОна появится на сайте в течение минуты:\nраздел «Партнёры» + баннер в ленте апгрейдов.\n\n" +
    "Хочешь изменить карточку — просто заполни анкету заново: /partner" });
  console.log(`партнёрская карточка: ${entry.name} (от ${me})`);
  return true;
}

async function handleMessage(tg, subs, msg) {
  const fromId = String(msg.from && msg.from.id);
  const chatId = String(msg.chat && msg.chat.id) || fromId;
  if (!fromId) return false;
  const text = String(msg.text || "").trim();
  let changed = false;
  let sub = findSub(subs, fromId);

  // 📷 фото-логотип для партнёрской карточки (пришло фото на шаге logo)
  if (!text && Array.isArray(msg.photo) && msg.photo.length && sub && sub.pt && sub.pt.step === "logo") {
    sub.pt.logo_file_id = msg.photo[msg.photo.length - 1].file_id;
    changed = true;
    await ptFinish(tg, sub, chatId);
    return changed;
  }
  if (!text) return false;
  let c = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  const args = text.split(/\s+/).slice(1).join(" ").trim();

  /* 🏷 партнёрская анкета: шаги перехватывают обычный текст (кроме /start) */
  if (sub && sub.pt && sub.pt.step && c !== "/start" && c !== "/help") {
    changed = (await ptStep(tg, sub, chatId, text)) || changed;
    return changed;
  }

  if (c === "/start" || c === "/help" || c === "/track" || c === "/partner") {
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
    if (c === "/partner" || args.toLowerCase() === "partner") {
      sub.pt = { step: "name" };
      changed = true;
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text:
        "🏷 <b>Партнёрская витрина — бесплатно!</b>\n\n" +
        "Карточка твоей компании появится на сайте Gift Monitor:\nраздел «Партнёры» + баннер в ленте апгрейдов.\n\n" +
        "Анкета — 5 коротких шагов. Отмена в любой момент: /cancel\n\n" +
        "<b>1/5.</b> Название компании или проекта?" });
      return changed;
    }
    if (c === "/help") {
      await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text:
        `📖 <b>Все команды:</b>\n\n` +
        `/start — включить уведомления\n/stop — выключить\n\n` +
        `🎯 <b>/mine Имя №</b> — следить за СВОИМ подарком (например <code>/mine PoolFloat 12345</code>)\n` +
        `🎯 /mine — список, <code>/mine del 1</code> — удалить\n\n` +
        `📊 /index — GM INDEX: Σ флоров, медиана, TON→USD\n\n` +
        `🌙 /night — тихий режим 23:00–08:00\n` +
        `🙈 /mute Имя — скрыть подарок, /unmute Имя — вернуть\n\n` +
        `🏷 /partner — карточку компании на сайте (бесплатно)\n\n` +
        `🌐 Мини-апп: меню бота → «Мини Апп»`, reply_markup: menuKb() });
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
      if (!g) { await tg("sendMessage", { chat_id: chatId, text: `Подарок «${esc(add[1])}» не найден — проверь имя как в мини-аппе` }); return changed; }
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
    if (!g) { await tg("sendMessage", { chat_id: chatId, text: `Подарок «${esc(args)}» не найден — проверь имя как в мини-аппе` }); return changed; }
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
  /* 🛠 API */

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
    [{ text: "🎯 Мои подарки", callback_data: "menu:mine" }, { text: "📊 GM INDEX", callback_data: "menu:idx" }],
    [{ text: "🌙 Режим", callback_data: "menu:night" }, { text: "📖 Все команды", callback_data: "menu:help" }],
  ] };
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
  } else if (String(q.data).indexOf("menu:") === 0) {
    const cmd = ({ "menu:mine": "/mine", "menu:idx": "/index", "menu:night": "/night", "menu:help": "/help" })[String(q.data)];
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
