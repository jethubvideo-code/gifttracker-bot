# gifttracker-bot

- The app is a single static Telegram Mini App page: `index.html` (no build step).
- Hosted on GitHub Pages straight from the repo root (`.nojekyll` disables Jekyll processing).
- Local preview: `docker compose -f docker-compose.base44.yml up -d` → python http.server serves the repo root on port 3000 (bind-mounted, edits are live on refresh).
- Market data is fetched live in the browser from the public Portals marketplace API (no key, no backend):
  `https://portal-market.com/api/collections?limit=500` — collections with `floor_price`, `supply`, `listed_count`,
  plus `floor_changes` (24h floor change per collection id). CORS echoes any origin.
- There is NO backend of any kind: everything runs client-side, so GitHub Pages hosting is enough.
- Profile tab shows Telegram user basics client-side; bot-related stats (portfolio/alerts/VIP) live only in @Trackingonebot.

## VIP Payments (real, Telegram Stars)

- Payment backend: `createVipInvoice` — a Base44 backend function of the owner's Superagent app (app id `6a98178ea237b1c35cce824e`).
  `GET https://app.base44.com/api/apps/6a98178ea237b1c35cce824e/functions/createVipInvoice` → `{ok:true, link:"https://t.me/$..."}`.
  Creates a Stars invoice: 500 XTR for 30 days of VIP. CORS is open; no key required.
- The invoice MUST be created with @Trackingonebot's bot token (env `TELEGRAM_BOT_TOKEN_3` in the Base44 function).
  Creating it with any other bot breaks the flow: `openInvoice` in the Mini App requires the link to be issued by the same bot, and `successful_payment` is only handled by @Trackingonebot's webhook.
- SERVED SITE: GitHub Pages source = `/docs` → `docs/index.html` at https://jethubvideo-code.github.io/gifttracker-bot/ — status page (live upgrade feed + full gifts table, data from `docs/status.json` and `docs/gifts.json` written by the monitor job). Also the bot's «🌐 Мини Апп» target.
- 2026-10-01 owner-approved COMFORT redesign (v2 of docs page): premium dark UI, auto-refresh every 30 s with visible countdown, live badge ticker, count-up stats, gold highlight on newly arrived upgrades. The upgrade-card FORMAT must stay 1:1 with the bot message (🚀 НОВОЕ УЛУЧШЕНИЕ + Подарок/NFT/Владелец/Улучшено exact timestamp/Улучшено всего X из Y/Подарок·MRKT·Portals/хэштеги/📨 N уведомлений) — do not change card content lines without the owner's request.
- `index.html` (repo root) = parked market mini app (ULTRA design + in-app Stars VIP payment via `createVipInvoice`). Not served while Pages source is `/docs`. Keep the file, do not delete.
- Bot side (@Trackingonebot, webhook → `giftsMonitorBot`): `pre_checkout_query` → answerPreCheckoutQuery ok; `successful_payment` → set `GiftSubscriber.is_vip=true`, `vip_expires=+30d`, send confirmation. `/vip` command offers a trial button and a real `sendInvoice` (XTR 500) pay button.
- Stars revenue needs no wallet in code: it accrues on the bot and can be withdrawn via Fragment to a TON wallet.
- Do not change price (500 Stars/30 days), payload (`vip30`), or currency (XTR) without the owner's request.




