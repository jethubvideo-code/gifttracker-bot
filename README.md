# Gift NFT Monitor — бот + сайт, 100% на GitHub

Живой трекер апгрейдов NFT-подарков Telegram (120+ коллекций): движок на GitHub Actions (эстафета прогонов 24/7), бот Telegram (поллинг с GitHub), сайт/Mini App на GitHub Pages. Ноль внешних сервисов и БД.

## Устройство
- `gift-monitor/actions/full-job.js` — движок: свипы счётчиков t.me → апгрейды → 1:1 доставка всем подписчикам (AIMD ≤30/сек), бот (`bot.js`) на борту, состояние в `data/state-full.json`, подписчики в `data/subscribers.enc` (AES, ключ в Actions var `CRYPT_KEY`).
- Эстафета: `full-monitor.yml` (chain-relay, перекрытие) + `pages-data-sync.yml` (деплой данных каждые 5 мин) + `deploy-pages.yml` (статика).
- Сайт: `docs/index.html` (SPA без сборки), данные `docs/*.json`, SW `docs/sw.js` (gm-v46).
- Контроль: `guardian.yml` (раз в 6ч самопроверка + отчёт владельцу), `synthetic-monitor.yml` (раз в 30 мин живость прода), `ci-qa.yml` (бюджеты + анти-H1 тест + Playwright E2E).

## При сбое
Смотри **RUNBOOK.md**. Ключи и токены — только в Actions Secrets/Variables репозитория.
