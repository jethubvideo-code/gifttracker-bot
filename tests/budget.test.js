// §7/§4: бюджеты размера — HTML+CSS+JS+данные первого экрана ≤ 250 КБ gzip, JS ≤ 120 КБ gzip, логотип ≤ 20 КБ
"use strict";
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const D = path.join(__dirname, '..', 'docs');
const gz = f => zlib.gzipSync(fs.readFileSync(path.join(D, f))).length;
const kb = n => (n/1024).toFixed(1) + 'КБ';
let fails = [];
const html = fs.readFileSync(path.join(D, 'index.html'), 'utf8');
const jsInline = (html.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || []).join('');
const jsGz = zlib.gzipSync(Buffer.from(jsInline)).length;
const first = ['index.html','sw.js','live.json','gifts.json','status.json','images.json','manifest.webmanifest'];
const firstGz = first.reduce((s, f) => s + (fs.existsSync(path.join(D,f)) ? gz(f) : 0), 0);
console.log('первый экран (gzip):', kb(firstGz), '| инлайн-JS (gzip):', kb(jsGz), '| логотип:', kb(fs.statSync(path.join(D,'logo.webp') || path.join(D,'logo.png')).size));
if (firstGz > 250*1024) fails.push('первый экран ' + kb(firstGz) + ' > 250КБ');
if (jsGz > 120*1024) fails.push('JS ' + kb(jsGz) + ' > 120КБ');
const logoPath = fs.existsSync(path.join(D,'logo.webp')) ? 'logo.webp' : 'logo.png';
if (fs.statSync(path.join(D,logoPath)).size > 20*1024) fails.push('логотип ' + logoPath + ' ' + kb(fs.statSync(path.join(D,logoPath)).size) + ' > 20КБ');
if (fails.length) { console.error('BUDGET FAIL:', fails); process.exit(1); }
console.log('BUDGET OK');
