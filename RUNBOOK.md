# RUNBOOK — что делать при сбое

## Быстрая диагностика
1. Открыть вкладку Actions репозитория: живой ли `Gift Monitor Full` (in_progress/queued = норм).
2. `curl -s https://jethubvideo-code.github.io/gifttracker-bot/live.json | head -c 200` — поле `updated` свежее (≤10 мин)?
3. Если движок молчит: Actions → Gift Monitor Full → Run workflow. Guardian поднимает его сам раз в 6ч.

## Типовые сбои
- **Бот не отвечает**: движок живой, но юзер не получает ответов → проверить в логах последнего прогона `бот: обработано N` (бот работает только пока жив прогон; пауза ≤35 мин между прогонами — норма).
- **Сайт белый/старый**: у юзера кэш WebView → открыть ссылку в браузере; проверить версию `docs/sw.js` (gm-vXX) через curl.
- **429 в логах**: норма при штормах, AIMD сам сбрасывает скорость. Не лечить, если доставка идёт.
- **CI QA красный**: смотри какой джоб — budget (превышен размер) / reconcile (вернулась полная перерисовка) / e2e (упал прод или картинки). E2E красный + synthetic красный = реальный сбой.

## Ротация токена бота
1. Telegram → @BotFather → /revoke → новый токен.
2. GitHub → Settings → Secrets and variables → Actions → Variables → `TELEGRAM_BOT_TOKEN` → заменить значение.
3. Ничего в коде менять не нужно. Движок подхватит на следующем прогоне.

## Переменные окружения (все в Actions Variables)
- `TELEGRAM_BOT_TOKEN` — токен @Trackingonebot
- `CRYPT_KEY` — ключ AES для subscribers.enc (не терять: без него подписчики не расшифруются)
- `TONAPI_KEY` — ключ TON API
- `OWNER_CHAT_ID` — ID владельца для алертов (создать вручную, см. ниже)

## Создать OWNER_CHAT_ID (один раз, с телефона)
GitHub → репозиторий → Settings → Secrets and variables → Actions → Variables tab → New repository variable → Name: `OWNER_CHAT_ID`, Value: 8396883978 → Add.

## Перенос движка на VPS (§8.6, ~10 минут)
Движок — обычный Node-скрипт без сборки: `git clone <repo> && node gift-monitor/actions/full-job.js` с переменными окружения выше (или `node gift-monitor/actions/full-monitor-loop.js` при наличии циклического скрипта). Состояние и подписки приезжают в `data/`. Выключить GitHub-воркфлоу эстафеты (Actions → full-monitor → Disable), иначе двойная доставка.

## Откат сайта
Последние деплои: Actions → Deploy Pages → правый верх → Re-run на старом прогоне, или git: `git revert <commit> && git push`. SW-кэш у юзеров обновится по бампу версии в `docs/sw.js` (gm-vXX → gm-vXX+1).
