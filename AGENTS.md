# gifttracker-bot

- The app is a single static Telegram Mini App page: `index.html` (no build step).
- Hosted on GitHub Pages straight from the repo root (`.nojekyll` disables Jekyll processing).
- Local preview: `docker compose -f docker-compose.base44.yml up -d` → python http.server serves the repo root on port 3000 (bind-mounted, edits are live on refresh).
- Market data is fetched live in the browser from the public Portals marketplace API (no key, no backend):
  `https://portal-market.com/api/collections?limit=500` — collections with `floor_price`, `supply`, `listed_count`,
  plus `floor_changes` (24h floor change per collection id). CORS echoes any origin.
- There is NO backend of any kind: everything runs client-side, so GitHub Pages hosting is enough.
- Profile tab shows Telegram user basics client-side; bot-related stats (portfolio/alerts/VIP) live only in @Trackingonebot.
