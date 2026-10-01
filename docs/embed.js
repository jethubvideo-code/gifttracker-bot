/* GiftTracker embed widget
   Использование: <script src=".../embed.js" data-gift="PlushPepe"></script>
   Атрибуты: data-gift (слаг коллекции), data-theme (auto|dark|light) */
(function () {
  var sc = document.currentScript;
  if (!sc || !sc.src) return;
  var slug = (sc.getAttribute("data-gift") || "PlushPepe").trim();
  var theme = (sc.getAttribute("data-theme") || "auto").toLowerCase();
  var base = sc.src.replace(/embed\.js.*$/i, "");
  function pick(p) {
    return fetch(base + p + (p.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  Promise.all([pick("floors.json"), pick("gifts.json")]).then(function (rs) {
    var fl = rs[0] || { floors: {} };
    var gdoc = rs[1] || { gifts: [] };
    var e = (fl.floors || {})[slug];
    var gi = null;
    var gl = gdoc.gifts || [];
    for (var i = 0; i < gl.length; i++) {
      if (String(gl[i].slug || gl[i].name).toLowerCase() === slug.toLowerCase()) { gi = gl[i]; break; }
    }
    var f = e ? Number(e.f) || 0 : 0;
    var rate = Number(fl.rate_usd) || 0;
    var usd = rate && f ? " ≈ $" + (Math.round(f * rate * 100) / 100) : "";
    var d = e && e.pf ? Math.round(((f - Number(e.pf)) / Number(e.pf)) * 1000) / 10 : null;
    var issued = gi ? Number(gi.issued) || 0 : 0;
    var total = gi ? Number(gi.total) || 0 : 0;
    var dark = theme === "dark" || (theme !== "light" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var card = document.createElement("a");
    card.href = "https://t.me/nft/" + slug.toLowerCase() + "-" + Math.max(1, issued || 1);
    card.target = "_blank";
    card.rel = "noopener";
    card.style.cssText =
      "display:inline-flex;align-items:center;gap:9px;padding:9px 13px;border-radius:12px;text-decoration:none;" +
      "font:700 12.5px/1.3 -apple-system,'Segoe UI',Roboto,sans-serif;border:1px solid " + (dark ? "#2a2a30" : "#e5e0d5") + ";" +
      "background:" + (dark ? "#1c1c22" : "#fffdf8") + ";color:" + (dark ? "#f5f2ea" : "#1c1a15") + ";box-shadow:0 4px 14px -6px rgba(0,0,0,.18)";
    var nm = document.createElement("span");
    nm.textContent = slug + (total ? " · " + issued.toLocaleString("ru-RU") + "/" + total.toLocaleString("ru-RU") : "");
    nm.style.fontWeight = "800";
    var pr = document.createElement("span");
    pr.textContent = f ? f.toLocaleString("ru-RU") + " TON" + usd : "нет лотов";
    pr.style.color = f ? (dark ? "#d4a847" : "#8a6a1a") : (dark ? "#8a8a90" : "#9a948a");
    var dl = document.createElement("span");
    if (d !== null && d !== 0) {
      dl.textContent = (d > 0 ? "▲" : "▼") + Math.abs(d) + "%";
      dl.style.color = d > 0 ? "#3fd68f" : "#f87171";
      dl.style.fontSize = "10.5px";
      dl.style.fontWeight = "800";
    }
    card.appendChild(nm);
    card.appendChild(pr);
    if (dl.textContent) card.appendChild(dl);
    sc.parentNode && sc.parentNode.insertBefore(card, sc.nextSibling);
  });
})();
