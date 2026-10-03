var FAILURES = [];
var fs = require('fs');
var html = fs.readFileSync(__dirname + '/../docs/index.html', 'utf8');
var scripts = [];
var re = /<script[^>]*>([\s\S]*?)<\/script>/g, m;
while (m = re.exec(html)) scripts.push(m[1]);
var mainJs = scripts[2].replace(/"use strict";/g, '');

// ---- минимальный DOM-шим ----
var createCount = 0; var TICKS = []; // сколько раз реально создан НОВЫЙ div-элемент (document.createElement)
function stubEl(){
  var listeners = [];
  var self = {
    _tag: 'div', className: '', style: {},
    _html: '',
    get innerHTML(){ return this._html; },
    set innerHTML(v){ this._html = v; },
    querySelector: function(sel){ return stubEl(); },
    querySelectorAll: function(sel){ return []; },
    appendChild: function(node){ return node; },
    addEventListener: function(fn){ listeners.push(fn); },
  };
  return self;
}
var registry = {};
global.document = {
  createElement: function(tag){ createCount++; return stubEl(); },
  createDocumentFragment: function(){
    var children = [];
    return { childNodes: children, appendChild: function(n){ children.push(n); return n; } };
  },
  addEventListener: function(){}, hidden: false,
};
global.$ = function(id){ if (!registry[id]) registry[id] = stubEl(); return registry[id]; };

global.esc = function(s){ return String(s==null?'':s); };
global.fmtNum = function(x){ return String(x); };
global.T = function(k){ return k; };
global.LANG = 'ru';
global.haptic = function(){}; global.openLink = function(){}; global.openColSheet = function(){};
global.shareCard = function(){}; global.toggleFav = function(){}; global.isFav = function(){ return false; };
global.etaOf = function(){ return {}; }; global.etaTxt = function(){ return ''; };
global.initialsOf = function(){ return 'XX'; }; global.evAgo = function(){ return 'now'; };
global.evTs = function(e){ return e.mint||0; }; global.fmtDate = function(){ return ''; };
global.addrShort = function(s){ return s; }; global.floorD24 = function(){ return null; };
global.usdOf = function(){ return ''; };
global.feedMine = false; global.gridMine = false; global.sortMode = 'default';

// выполняем код скрипта в текущем глобальном контексте (vm не нужен — просто eval)
eval(mainJs);

// данные для теста
giftsData = [
  { slug: 'PoolFloat', name: 'PoolFloat', issued: 100, total: 1000, added: 0 },
  { slug: 'MirageLamp', name: 'Mirage Lamp', issued: 44069, total: 226713, added: 0 },
];
imagesData = { PoolFloat: 'img/poolfloat.webp', MirageLamp: 'img/miragelamp.webp' };
hotMap = {};
var sampleEvents = [
  { slug: 'MirageLamp', gift: 'Mirage Lamp', number: 44069, counter_issued: 44069, counter_total: 226713, mint: 1000, img: 'img/miragelamp.webp' },
  { slug: 'PoolFloat', gift: 'PoolFloat', number: 100, counter_issued: 100, counter_total: 1000, mint: 900, img: 'img/poolfloat.webp' },
];

console.log('=== ТИК 1 (первая отрисовка) ===');
createCount = 0;
renderFeed(sampleEvents);
renderGrid('');
console.log('создано новых карточек (innerHTML-построений):', createCount, '(ожидаем 4: 2 ленты + 2 грида)');
if (createCount !== 4) FAILURES.push('тик1: ' + createCount + ' != 4');

console.log('=== ТИК 2 (те же данные, 5с спустя — имитация setInterval) ===');
createCount = 0;
renderFeed(sampleEvents);
renderGrid('');
console.log('создано новых карточек на повторном тике:', createCount, '(ожидаем 0 — все карточки переиспользованы, <img> не трогали)');
if (createCount !== 0) FAILURES.push('ТИК2 АНТИ-H1 ПРОВАЛ: ' + createCount + ' != 0 (полная перерисовка вернулась!)');

console.log('=== ТИК 3 (счётчик обновился, картинка та же) ===');
giftsData[1].issued = 44070;
createCount = 0;
renderGrid('');
console.log('создано новых карточек при изменении счётчика (картинка та же):', createCount, '(ожидаем 0 — обновили текст на месте)');
if (createCount !== 0) FAILURES.push('тик3: ' + createCount + ' != 0');

console.log('=== ТИК 4 (появилась НОВАЯ картинка для коллекции) ===');
imagesData.PoolFloat = 'img/poolfloat_NEW.webp';
createCount = 0;
renderGrid('');
console.log('создано новых карточек при смене картинки:', createCount, '(ожидаем 1 — только эта карточка пересобрана)');
if (createCount !== 1) FAILURES.push('тик4: ' + createCount + ' != 1');
if (FAILURES.length) { console.error('RECONCILE TEST FAILED:', FAILURES); process.exit(1); }
console.log('RECONCILE TEST OK: анти-H1 жив, <img> переиспользуются');
