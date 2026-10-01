# gifttracker-bot

Автономный монитор апгрейдов Telegram Gifts → NFT. Работает 24/7 на GitHub Actions, без внешних платформ.

## Структура
- `gift-monitor/actions/full-job.js` — движок: счётчики t.me → детект апгрейдов → доставка уведомлений → коммит данных. Режим эстафеты (chain-relay) внутри одного прогона, коммит каждые ~20с.
- `gift-monitor/actions/new-gift-job.js` — новые лимитки из каталога Fragment (каждые 20 мин).
- `gift-monitor/actions/floors-job.js` — скан флор-цен (каждые 15 мин) → `docs/floors.json` + `docs/floors-hist.json`.
- `gift-monitor/actions/gift-images.js` — обложки всех коллекций → `docs/images.json` (каждые 6ч).
- `.github/workflows/` — расписания (full-monitor — эстафета 24/7, остальные по крону).
- `data/` — состояние движка (state-full.json, subscribers.enc — шифрованный снапшот подписчиков, enabled-full.json — флаг режима).
- `docs/` — сайт-дашборд (GitHub Pages): лента, каталог, аналитика, рынок с флор-ценами.

## Сайт
- `docs/index.html` — единая страница, автообновление каждые 20с, PWA (manifest + sw.js).
- Данные сайт читает из `docs/*.json` (fresh) через источник в base64.

## Правила
- Прогон, стартовавший до пуша, работает на старой версии кода.
- При каждом изменении `docs/index.html` бампать версию кэша в `docs/sw.js`.
- Репо публичный: никаких токенов и ключей в коде. Секреты — только в vars репозитория.
- Терминология владельца: «Флор цена» (не «флоер»).
