/* ═══ Flip-школа: гайд, академия, тренажёр, калькулятор, тренды, радар лимиток ═══ */
/* Данные передаёт bot.js: floors {floors:{slug:{f}}}, floorsHist {hours:[{ts,floors:{slug:price}}]},
   gifts {gifts:[{slug,name,issued,total,added}]}, history {hours:[{ts,issued:{slug:n}}]} */

const SIM_START = 1000;           // стартовый кэш тренажёра, TON
const FEE_SELL = 0.05;            // комиссия маркета с продажи (MRKT/GetGems ~5%)
const FEE_GAS = 0.01;             // газ TON за сделку (упрощённо)

function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function fmt(n) { return (Math.round(Number(n) * 100) / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 }); }

/* ─── 51. ГАЙД: 7 уроков ─── */
const LESSONS = [
  { t: "Что такое флип", b:
    `🔄 <b>Урок 1. Флип — что это</b>\n\nФлип = купить дешевле, продать дороже за короткий срок.\n\nЦикл сделки:\n1️⃣ Покупаешь <b>спот</b> (нераспечатанный подарок в Telegram)\n2️⃣ Распаковываешь → подарок превращается в <b>NFT</b> на блокчейне TON\n3️⃣ Выставляешь NFT на маркет (MRKT / GetGems / Portals)\n4️⃣ Продал дороже покупки → профит\n\n<b>Спот</b> — цена в магазине Telegram.\n<b>Флор</b> — самый дешёвый NFT-лот на маркете.\nЕсли флор выше спота — окно для флипа есть.\n\nДальше: /flip 2` },
  { t: "Флор и спред", b:
    `📊 <b>Урок 2. Флор и спред</b>\n\n<b>Флор</b> (floor) — минимальная цена лота коллекции. Его видно на MRKT, GetGems, Portals.\n\n<b>Спред</b> = флор − спот. Спред должен покрыть комиссии и дать прибыль.\n\nПример: спот 100 TON, флор 115 TON. Спред 15 TON. Минус комиссии ~6-8 TON → чистыми ~7-9 TON с одной штуки.\n\n⚠️ Смотри ВЕСЬ список лотов: если после первого лота следующие по 90 — флор «одинокий», реальная цена ниже.\n\nФлоры всех 120 коллекций: команда <code>/card Имя</code> или на сайте.\n\nДальше: /flip 3` },
  { t: "Комиссии", b:
    `💸 <b>Урок 3. Комиссии — главный убийца новичка</b>\n\nВ каждой сделке:\n• Маркет берёт ~5% с продажи (MRKT, GetGems, Portals)\n• Сеть TON — копейки (~0.005-0.01 TON)\n\nТочка безубыточности:\n<code>продажа ≥ покупка / 0.95</code>\n\nКупил за 100 → продать надо минимум за ~105.3, иначе ты в минусе.\n\nСчитай ДО покупки: команда <code>/calc 100 120</code> покажет чистыми.\n\nПравило: если после комиссий остаётся меньше 5% профита — сделка не стоит риска.\n\nДальше: /flip 4` },
  { t: "Лимитки", b:
    `🎯 <b>Урок 4. Лимитки — главные деньги флипа</b>\n\nОграниченная серия (лимитка) дорожает в первые часы: спрос высокий, тираж маленький.\n\nКак читать:\n• <b>Скорость распродажи</b> — если тираж улетает за часы, хайп высокий\n• <b>Счётчик улучшений</b> — чем быстрее растут NFT-апгрейды, тем горячее\n• Типичная динамика: пик цены в первые 1-6 часов → откат → рост, если коллекция сильная\n\nСтратегия: купить на старте → продать на пике первых часов → переждать откат → вторая точка входа.\n\nРадар новых лимиток: команда <code>/limits</code>\n\nДальше: /flip 5` },
  { t: "Снайпы", b:
    `🚨 <b>Урок 5. Снайпы — бесплатные деньги</b>\n\nСнайп — лот, выставленный заметно ниже флора (≤0.75×). Причины: продавец спешит, не знает цену, ошибся.\n\nКак проверять снайп:\n• Лот реальный? Ссылка должна вести на настоящий NFT\n• Флор именно этой коллекции, не похожей?\n• Номер/фон/модель не «мусорные»? Дешёвый фон может стоить 0.3× от среднего\n• Продавец не в бане маркета?\n\nПроверил → купил → выставил по флору → профит 20-30% почти без риска.\n\nДальше: /flip 6` },
  { t: "Редкость", b:
    `🎨 <b>Урок 6. Редкость решает исход</b>\n\nУ каждого NFT есть атрибуты: <b>фон</b> (backdrop) и <b>модель</b> (model).\n\nРазница в разы:\n• Обычный фон ≈ 1× от флора\n• Редкий фон ≈ 2-5× и выше\n• «Мусорный» фон может стоить 0.3× — его никто не хочет\n\nПеред покупкой ОДИНОЧНОГО лота смотри его атрибуты, а не только флор коллекции. Дешёвый лот часто дешёвый из-за фона.\n\nПокупаешь спотом для минта — там атрибутов не видно: это лотерея, закладывай риск в цену.\n\nДальше: /flip 7` },
  { t: "Психология", b:
    `🧠 <b>Урок 7. Психология и риски</b>\n\nГлавные ошибки новичков:\n• <b>FOMO</b> — покупка на пике, потому что «все берут». Заходи ДО хайпа или на откате\n• <b>Жадность</b> — не продал на пике, ждал ещё → откат → в минус\n• <b>Всё в одну корзину</b> — держи позиции маленькими (5-10% банка на сделку)\n• <b>Нет плана</b> — до покупки знай, где продаёшь\n\nДисциплина флиппера:\n1. Размер позиции\n2. Цель профита\n3. Стоп (макс минус)\n4. Журнал сделок\n\n🏆 Финал: тренируйся в <code>/sim</code> на виртуальных 1000 TON — без риска деньгами.\n\nУроки кончились. Практика: /sim, /calc, /limits, /trends` },
];

/* ─── 52. АКАДЕМИЯ: 5 шагов ─── */
const ACADEMY = [
  `🎓 <b>Шаг 1/5. Что такое подарок и NFT</b>\n\nTelegram-подарок — картинка, которую можно купить в приложении (или получить). Подарок можно распаковать — тогда он становится <b>NFT</b>: уникальным токеном в блокчейне TON.\nNFT = можно продать на маркете любому человеку. Подарок в упаковке = только спот.\n\nКаждый NFT имеет: номер (#12345), фон, модель. От них зависит цена.\n\n➡️ Кнопка «Дальше» ниже`,
  `🎓 <b>Шаг 2/5. Где торгуют</b>\n\n• <b>Fragment</b> — официальный магазин подарков (спот) и часть продаж NFT\n• <b>MRKT</b> — маркет NFT внутри Telegram: t.me/mrkt\n• <b>GetGems</b> — крупный маркет TON: getgems.io\n• <b>Portals</b> — маркет с редкостями: t.me/portals\n\nНа всех маркетаx есть список лотов: самый дешёвый = <b>флор</b>.\n\nКоманда <code>/card Имя</code> — флор, лоты и кнопки всех трёх маркетов сразу.`,
  `🎓 <b>Шаг 3/5. Первая сделка по шагам</b>\n\n1. Выбери коллекцию: <code>/card Имя</code> → сравни спот и флор\n2. Считаем: <code>/calc спот флор</code> → чистая прибыль после комиссий\n3. Профит есть? Покупай спот\n4. Распакуй (минт) — станет NFT\n5. Выстави лот на маркет чуть ниже флора — продастся быстрее\n6. Продалось → вывод/реинвест\n\nНикогда не пропускай шаг 2. Это правило.`,
  `🎓 <b>Шаг 4/5. Лимитки 24 часа</b>\n\nНовая лимитка = окно возможностей:\n• Первые минуты-часы: цена взлетает на хайпе\n• <b>Когда продавать</b>: следи за скоростью распродажи (<code>/limits</code>) — пока тираж улетает, спрос держит цену; замедлилось в разы → продавай\n• Откат после пика — нормально; вторая волна приходит, если коллекция сильная\n\n⚠️ Не покупай лимитку на пике без счёта комиссий. <code>/calc</code> и тут главный.`,
  `🎓 <b>Шаг 5/5. Финал — твой набор</b>\n\nУ тебя теперь есть всё:\n🏋️ <code>/sim</code> — тренажёр на виртуальных 1000 TON\n🧮 <code>/calc</code> — калькулятор прибыли\n🔥 <code>/trends</code> — тренды коллекций\n🆕 <code>/limits</code> — радар новых лимиток\n📚 <code>/flip</code> — 7 уроков флипа\n\nСовет: 5-10 сделок в тренажёре ДО реальных денег. Удачи! 🍀`,
];

/* ─── меню Flip-школы (клавиатура) ─── */
function flipKb() {
  return { inline_keyboard: [
    [{ text: "📚 Гайд", callback_data: "flip:lesson:0" }, { text: "🎓 Академия", callback_data: "menu:academy" }],
    [{ text: "🏋️ Тренажёр", callback_data: "flip:sim" }, { text: "🧮 Калькулятор", callback_data: "menu:calc" }],
    [{ text: "🔥 Тренды", callback_data: "menu:trends" }, { text: "🆕 Лимитки", callback_data: "menu:limits" }],
    [{ text: "⬅️ Меню", callback_data: "menu:help" }],
  ] };
}

/* ─── 53. ТРЕНАЖЁР ─── */
function simState(sub) {
  if (!sub.sim) sub.sim = { cash: SIM_START, holdings: {}, realized: 0, trades: 0 };
  const s = sub.sim;
  if (typeof s.cash !== "number") s.cash = SIM_START;
  if (!s.holdings) s.holdings = {};
  return s;
}

function simStatus(sub, floors) {
  const s = simState(sub);
  const fl = (floors && floors.floors) || {};
  let holdVal = 0, rows = "";
  for (const [slug, h] of Object.entries(s.holdings)) {
    const price = (fl[slug] && Number(fl[slug].f)) || 0;
    const val = price * h.qty;
    holdVal += val;
    const pnl = price ? (price - h.avg) * h.qty : 0;
    const sign = pnl >= 0 ? "+" : "";
    rows += `  <b>${esc(slug)}</b>: ${h.qty} шт × ${fmt(price)} TON — PnL ${sign}${fmt(pnl)}\n`;
  }
  const equity = s.cash + holdVal;
  const roi = ((equity - SIM_START) / SIM_START) * 100;
  const roiStr = (roi >= 0 ? "📈 +" : "📉 ") + fmt(roi) + "%";
  let txt = `🏋️ <b>Тренажёр флипа</b>\n\n💵 Кэш: <b>${fmt(s.cash)} TON</b>\n📦 Позиции:\n${rows || "  (пусто — купи: /sim buy Имя кол-во)\n"}\n`;
  txt += `💼 Капитал: <b>${fmt(equity)} TON</b> (старт ${SIM_START}) — ${roiStr}\n`;
  txt += `✅ Реализованный PnL: <b>${fmt(s.realized)} TON</b> · сделок: ${s.trades}\n\n`;
  txt += `Команды:\n<code>/sim buy PlushPepe 2</code> — купить 2 шт по флору\n<code>/sim sell PlushPepe 2</code> — продать (−5% маркет −газ)\n<code>/sim reset</code> — начать заново\n\n⚠️ Цены виртуальные = реальные флоры рынка. Комиссия продажи 5%, газ 0.01 TON.`;
  return txt;
}

function simBuy(sub, slug, qty, floors) {
  const s = simState(sub);
  const ent = floors && floors.floors && floors.floors[slug];
  const price = ent && Number(ent.f);
  if (!price || price <= 0) return { ok: false, msg: `По «${esc(slug)}» нет лотов — флор неизвестен. /trends — где есть цены` };
  const cost = price * qty + FEE_GAS;
  if (cost > s.cash) return { ok: false, msg: `Не хватает кэша: нужно ${fmt(cost)} TON, есть ${fmt(s.cash)}. /sim sell или /sim reset` };
  s.cash -= cost;
  const h = s.holdings[slug] || { qty: 0, avg: 0 };
  h.avg = (h.avg * h.qty + price * qty) / (h.qty + qty);
  h.qty += qty;
  s.holdings[slug] = h;
  s.trades++;
  return { ok: true, msg: `🛒 <b>Куплено:</b> ${qty} × ${esc(slug)} по ${fmt(price)} TON\n💸 Кэш: ${fmt(s.cash)} TON\n\nПродавай, когда флор вырастет: /sim sell ${esc(slug)} ${qty}`, changed: true };
}

function simSell(sub, slug, qty, floors) {
  const s = simState(sub);
  const h = s.holdings[slug];
  if (!h || h.qty <= 0) return { ok: false, msg: `У тебя нет «${esc(slug)}». /sim buy ${esc(slug)} 1` };
  qty = Math.min(qty, h.qty);
  const ent = floors && floors.floors && floors.floors[slug];
  const price = ent && Number(ent.f);
  if (!price || price <= 0) return { ok: false, msg: `По «${esc(slug)}» сейчас нет лотов — продать не можем, попробуй позже` };
  const gross = price * qty;
  const net = gross * (1 - FEE_SELL) - FEE_GAS;
  s.cash += net;
  const pnl = net - h.avg * qty;
  s.realized += pnl;
  h.qty -= qty;
  if (h.qty <= 0) delete s.holdings[slug];
  s.trades++;
  const sign = pnl >= 0 ? "+" : "";
  return { ok: true, msg: `🏷 <b>Продано:</b> ${qty} × ${esc(slug)} по ${fmt(price)} TON\n${pnl >= 0 ? "🟢" : "🔴"} PnL: <b>${sign}${fmt(pnl)} TON</b> (после комиссии 5% и газа)\n💸 Кэш: ${fmt(s.cash)} TON · всего реализовано: ${fmt(s.realized)}`, changed: true };
}

/* ─── 54. КАЛЬКУЛЯТОР ─── */
function calcText(buy, sell) {
  const b = Number(buy), sPrice = Number(sell);
  if (!(b > 0) || !(sPrice > 0) || b > 1e9 || sPrice > 1e9) return null;
  const net = sPrice * (1 - FEE_SELL) - FEE_GAS;
  const pnl = net - b;
  const roi = (pnl / b) * 100;
  const be = Math.ceil((b / (1 - FEE_SELL)) * 100) / 100;
  const verdict = pnl <= 0 ? "🔴 <b>Убыток</b> — сделка не стоит риска" :
    roi < 5 ? "🟡 <b>Профит есть, но тонкий</b> (<5%) — подумай дважды" :
    roi < 20 ? "🟢 <b>Хорошая сделка</b>" : "🚀 <b>Отличная сделка</b>";
  return `🧮 <b>Калькулятор флипа</b>\n\n🛒 Покупка: <b>${fmt(b)} TON</b>\n🏷 Продажа (лот): <b>${fmt(sPrice)} TON</b>\n\n💸 Комиссия маркета (5%): −${fmt(sPrice * FEE_SELL)} TON\n⛽ Газ: −${fmt(FEE_GAS)} TON\n\n💰 Чистыми: <b>${pnl >= 0 ? "+" : ""}${fmt(pnl)} TON</b> (${(roi >= 0 ? "+" : "") + fmt(roi)}%)\n⚖️ Точка безубыточности: продать за <b>${fmt(be)} TON</b>+\n\n${verdict}\n\nПример: <code>/calc 100 120</code>`;
}

/* ─── 56. ТРЕНДЫ (по доступной истории флоров) ─── */
function trendsText(floorsHist) {
  const hours = (floorsHist && floorsHist.hours) || [];
  if (hours.length < 2) return `🔥 <b>Тренды</b>\n\nИстории флоров пока мало (${hours.length} ч) — тренды появятся через несколько часов. Загляни позже: /trends`;
  const first = hours[0], last = hours[hours.length - 1];
  const spanH = Math.max(1, Math.round((last.ts - first.ts) / 3600));
  const list = [];
  for (const [slug, price] of Object.entries(last.floors || {})) {
    const p0 = first.floors && first.floors[slug];
    if (!p0 || !(price > 0)) continue;
    const pct = ((price - p0) / p0) * 100;
    if (Math.abs(pct) >= 3) list.push({ slug, pct, price });
  }
  list.sort((a, b) => b.pct - a.pct);
  const up = list.filter(x => x.pct > 0).slice(0, 5);
  const down = list.filter(x => x.pct < 0).slice(-5).reverse();
  let txt = `🔥 <b>Тренды коллекций за ${spanH} ч</b>\n\n`;
  if (up.length) { txt += `📈 <b>Растут:</b>\n`; for (const x of up) txt += `  <b>${esc(x.slug)}</b> — ${fmt(x.price)} TON (<b>+${fmt(x.pct)}%</b>)\n`; }
  if (down.length) { txt += `\n📉 <b>Падают:</b>\n`; for (const x of down) txt += `  <b>${esc(x.slug)}</b> — ${fmt(x.price)} TON (<b>${fmt(x.pct)}%</b>)\n`; }
  if (!up.length && !down.length) txt += `Пока всё спокойно — нет движений ≥3%. Загляни позже.`;
  txt += `\n💡 Растущие = хайп-кандидаты, падающие = возможные окна покупки.\nЖивые флоры: /card Имя`;
  return txt;
}

/* ─── 59. РАДАР ЛИМИТОК 24ч ─── */
function limitsText(giftsDoc, historyDoc, floorsDoc) {
  const now = Date.now() / 1000;
  const gifts = ((giftsDoc && giftsDoc.gifts) || []);
  const hours = (historyDoc && historyDoc.hours) || [];
  const fl = (floorsDoc && floorsDoc.floors) || {};
  // кандидаты: недавно добавленные ИЛИ тираж распродаётся активно (issued < total, малый total)
  const fresh = gifts.filter(g => g.added && Number(g.added) > 1e9 && now - g.added < 14 * 86400);
  const sellingOut = gifts.filter(g => Number(g.total) > 0 && Number(g.total) < 100000 && Number(g.issued) > 0 && Number(g.issued) < Number(g.total))
    .sort((a, b) => (b.issued / b.total) - (a.issued / a.total)).slice(0, 5);
  const speedOf = (slug) => {
    if (hours.length < 2) return null;
    const last = hours[hours.length - 1], first = hours[Math.max(0, hours.length - 24)];
    const iL = (last.issued || {})[slug], iF = (first.issued || {})[slug];
    if (iL == null || iF == null) return null;
    const h = Math.max(1, (last.ts - first.ts) / 3600);
    return (iL - iF) / h;
  };
  const rowOf = (g, tag) => {
    const sp = speedOf(g.slug);
    const left = Number(g.total) - Number(g.issued);
    const pct = Math.round((Number(g.issued) / Number(g.total)) * 100);
    const f = (fl[g.slug] && Number(fl[g.slug].f)) || 0;
    return `  ${tag} <b>${esc(g.name)}</b>: продано ${fmtInt(g.issued)}/${fmtInt(g.total)} (${pct}%)\n     🚀 скорость: ${sp ? fmt(sp) + " шт/ч" : "н/д"} · остаток: ${fmtInt(left)}${f ? " · флор: " + fmt(f) + " TON" : ""}`;
  };
  let txt = `🆕 <b>Радар лимиток</b>\n\n`;
  if (fresh.length) {
    txt += `<b>Свежие (до 14 дней):</b>\n`;
    for (const g of fresh.slice(0, 3)) txt += rowOf(g, "🆕") + "\n";
  } else {
    txt += `<b>Новых лимиток пока нет</b> — следим, алерт придёт автоматически.\n`;
  }
  txt += `\n<b>Распродаются быстрее всех:</b>\n`;
  for (const g of sellingOut) txt += rowOf(g, "⏳") + "\n";
  txt += `\n💡 <b>Как флипать:</b>\n• Тираж улетает быстро (шт/ч высокий) → спрос держит цену — продавай на пике первых часов\n• Скорость упала в разы → хайп кончается, продавай или жди отката\n• Считай профит ДО покупки: <code>/calc цена флор</code>`;
  return txt;
}

function fmtInt(n) { return Math.round(Number(n) || 0).toLocaleString("ru-RU"); }

module.exports = { LESSONS, ACADEMY, flipKb, simState, simStatus, simBuy, simSell, calcText, trendsText, limitsText, SIM_START };
