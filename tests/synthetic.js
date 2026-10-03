// §11: синтетический монитор прод-сайта (лёгкий): живость + свежесть + алерт владельцу через бота
"use strict";
const fetch = require('util').promisify ? null : null;
const https = require('https');
const get = (url) => new Promise((res, rej) => {
  https.get(url, { timeout: 15000 }, r => { let b=''; r.on('data', d => b+=d); r.on('end', () => res({ status: r.statusCode, body: b })); })
    .on('error', rej).on('timeout', function(){ this.destroy(); rej(new Error('timeout')); });
});
(async () => {
  const BASE = 'https://jethubvideo-code.github.io/gifttracker-bot/';
  const problems = [];
  try {
    const main = await get(BASE);
    if (main.status !== 200) problems.push('index=' + main.status);
    const live = JSON.parse((await get(BASE + 'live.json')).body);
    const age = (Date.now() - new Date(live.updated).getTime()) / 1000;
    console.log('live.json свежесть:', Math.round(age) + 'с');
    if (age > 600) problems.push('live.json старше 10 мин: ' + Math.round(age/60) + ' мин');
    const status = JSON.parse((await get(BASE + 'status.json')).body);
    const sage = (Date.now() - new Date(status.updated || status.ts || Date.now()).getTime()) / 1000;
    if (sage > 3600) problems.push('status.json старше часа');
  } catch (e) { problems.push('недоступен: ' + e.message); }
  if (problems.length) {
    console.error('SYNTHETIC FAIL:', problems);
    const tok = process.env.TELEGRAM_BOT_TOKEN, owner = process.env.OWNER_CHAT_ID;
    if (tok && owner) {
      const text = '⚠️ GM Синтетический монитор: ' + problems.join('; ');
      https.request({ hostname: 'api.telegram.org', path: '/bot' + tok + '/sendMessage', method: 'POST',
        headers: { 'Content-Type': 'application/json' } }, () => process.exit(1))
        .end(JSON.stringify({ chat_id: owner, text }));
    } else process.exit(1);
  } else console.log('SYNTHETIC OK: прод живой и свежий');
})();
