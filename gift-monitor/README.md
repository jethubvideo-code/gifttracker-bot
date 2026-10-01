# 🎁 Telegram Gift Monitor — автономный монитор апгрейдов подарков

Следит за улучшениями **всех 120 коллекций Telegram Gifts до NFT** и отдаёт живые данные через API + красивую HTML-карточку в стиле Telegram.

**Без внешних платформ** — чистый Node.js, ноль зависимостей. Твой сервер, твои правила.

## Что умеет

- 🛰️ Мониторит минты (апгрейды) 120 коллекций через [tonapi.io](https://tonapi.io)
- 🔢 Официальные счётчики «улучшено X из Y» прямо со страниц `t.me/nft/<slug>-<N>`
- 🧠 Анти-дубли: помнит уже обработанные NFT (seen-лист на коллекцию)
- ⏱️ Первый запуск — baseline без шторма старых событий
- 📄 API `/api/latest` — свежие апгрейды + счётчики всех коллекций (CORS открыт)
- 💅 `GET /` — живая карточка апгрейда в стиле Telegram (автообновление каждые 60 сек)
- ⚛️ `GiftUpgradeCard.jsx` — тот же вид как React-компонент для своих проектов

## Установка

```bash
git clone https://github.com/ТВОЙ_ЛОГИН/telegram-gift-monitor.git
cd telegram-gift-monitor
TONAPI_KEY=твой_ключ node server.js
```

Открой: **http://localhost:8787**

Ключ tonapi бесплатный: [tonapi.io](https://tonapi.io) → Sign up → API key.
Без ключа тоже работает, но с лимитами запросов.

## Настройки (переменные окружения)

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `PORT` | `8787` | порт HTTP-сервера |
| `TICK_MS` | `60000` | цикл проверки, мс (минимум разумный — 60 сек: Telegram сам обновляет счётчики раз в 1-2 мин) |
| `BATCH` | `30` | коллекций за один цикл. `BATCH=120` = все за один проход (нужен ключ tonapi) |
| `TONAPI_KEY` | — | ключ tonapi (рекомендуется) |

## API

```
GET /api/latest
{
  "ok": true,
  "updated_at": 1790827248,
  "upgrades": [
    {
      "gift_slug": "VictoryMedal",
      "gift_display": "Victory Medal #106717",
      "nft_number": 106717,
      "nft_address": "0:...",
      "model": "Aurora Veil",
      "backdrop": "Black",
      "owner": "0:...",
      "mint_time": 1790827100,
      "counter_issued": 106717,
      "counter_total": 124608
    }
  ],
  "collections": [ { "name": "PlushPepe", "issued": 95000, "total": 100000 }, ... ]
}
```

## Запуск 24/7 на VPS (pm2)

```bash
npm install -g pm2
TONAPI_KEY=ключ pm2 start server.js --name gift-monitor
pm2 save && pm2 startup   # автозапуск после ребута сервера
```

## Docker

```bash
docker build -t gift-monitor .
docker run -d -p 8787:8787 -e TONAPI_KEY=ключ --name gift-monitor gift-monitor
```

## Структура

```
telegram-gift-monitor/
├── server.js               # монитор + HTTP API + хостинг карточки
├── collections.json        # 120 коллекций Telegram Gifts (адреса TON)
├── telegram_gift_card.html # живая карточка (автообновление)
├── GiftUpgradeCard.jsx     # React-версия карточки
├── Dockerfile
├── .env.example
└── README.md
```

## Как добавить новую коллекцию

Telegram выпустил новый подарок? Открой его NFT-страницу `t.me/nft/Имя-1`, возьми адрес коллекции (TonViewer → collection) и добавь в `collections.json`:

```json
{ "name": "NewGift", "address": "0:..." }
```

Рестартни сервер — он подхватит сам.

## Лицензия

MIT — делай что хочешь.
