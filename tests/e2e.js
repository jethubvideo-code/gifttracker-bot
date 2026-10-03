// §11: E2E — эмуляция среднего Android: Chromium 390×844, лента непуста, картинки грузятся, консоль без ошибок
"use strict";
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(String(m.text()).slice(0,200)); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0,200)));
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:8000/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.ev', { timeout: 30000 });
  const firstCardMs = Date.now() - t0;
  await page.waitForTimeout(12000); // даём картинкам и поллингу шанс
  const s = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];
    const ok = imgs.filter(i => i.complete && i.naturalWidth > 0).length;
    return { total: imgs.length, ok, ev: document.querySelectorAll('.ev').length, gc: document.querySelectorAll('.gc').length,
             upd: (document.getElementById('upd') || {}).textContent || '' };
  });
  console.log('первая карточка:', firstCardMs + 'мс | ev:', s.ev, '| gc:', s.gc, '| img ok:', s.ok + '/' + s.total, '| данные:', s.upd);
  const fails = [];
  if (s.ev < 1) fails.push('лента пуста');
  if (s.gc < 40) fails.push('грид мал: ' + s.gc);
  if (s.total >= 10 && s.ok / s.total < 0.9) fails.push('картинки <90%: ' + s.ok + '/' + s.total);
  if (errors.length) fails.push('консоль: ' + errors.slice(0,5).join(' | '));
  await b.close();
  if (fails.length) { console.error('E2E FAIL:', fails); process.exit(1); }
  console.log('E2E OK');
})().catch(e => { console.error('E2E CRASH:', e.message); process.exit(1); });
