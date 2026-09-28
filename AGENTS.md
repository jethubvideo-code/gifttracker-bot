# gifttracker-bot

- The app is a single static Telegram Mini App page: `index.html` (no build step).
- Hosted on GitHub Pages straight from the repo root (`.nojekyll` disables Jekyll processing).
- Local preview: `docker compose -f docker-compose.base44.yml up -d` → python http.server serves the repo root on port 3000 (bind-mounted, edits are live on refresh).
- Data comes from an external Base44 function: `API` constant in `index.html`
  (`https://base44.app/api/apps/6a98178ea237b1c35cce824e/functions/giftWebApp`, `?data=1` for market data, `?uid=<tg id>` for profile). CORS is `*`.
  If it returns HTTP 402 the owning Base44 app has hit its monthly integration limit — not a bug in this repo.
- Profile section only works when opened inside Telegram (via @Trackingonebot menu button).
