import React, { useEffect, useRef } from "react";

/**
 * GiftUpgradeCard — автономный React-компонент, 1:1 копия вида
 * уведомления Telegram-бота об улучшении подарка до NFT.
 *
 * Без каких-либо внешних интеграций (платформы, бот, бэкенд) —
 * чистая вёрстка + CSS-анимация. Данные приходят через props.
 *
 * Опционально: npm install lottie-web — если хочешь проигрывать
 * РЕАЛЬНУЮ анимацию подарка (lottieUrl), а не статичную картинку.
 */

function minutesAgoText(min) {
  if (min < 60) return `${min} мин. назад`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} ч. ${m} мин. назад`;
}

export default function GiftUpgradeCard({
  giftName = "Victory Medals",
  nftNumber = 106717,
  issuedTotal = 106717,
  issuedCap = 124608,
  minutesAgo = 2,
  ownerShort = "",          // напр. "EQAbc...xyz1", пусто = строку не показывать
  slug = "victorymedal",    // для ссылки t.me/nft/<slug>-<nftNumber>
  imageUrl = "",            // статичная картинка подарка
  lottieUrl = "",           // прямой .json — проиграется как реальная анимация
  time = "08:52",
}) {
  const lottieRef = useRef(null);

  useEffect(() => {
    if (!lottieUrl || !lottieRef.current) return;
    let anim;
    import("lottie-web").then((lottie) => {
      anim = lottie.default.loadAnimation({
        container: lottieRef.current,
        renderer: "svg",
        loop: true,
        autoplay: true,
        path: lottieUrl,
      });
    });
    return () => anim && anim.destroy();
  }, [lottieUrl]);

  const link = `https://t.me/nft/${slug}-${nftNumber}`;
  const previewTitle = `${giftName.replace(/s$/, "")} #${nftNumber}`;

  return (
    <div style={styles.wrap}>
      {/* ===== сообщение бота ===== */}
      <div style={styles.msg}>
        <p style={{ ...styles.msgLine, fontWeight: 600, marginBottom: 6 }}>
          🚀 НОВОЕ УЛУЧШЕНИЕ: {giftName} #{issuedTotal.toLocaleString("ru-RU")}!
        </p>
        <p style={styles.msgLine}>🎁 Подарок: {giftName}</p>
        <p style={styles.msgLine}>🏷️ NFT: #{nftNumber.toLocaleString("ru-RU")}</p>
        {ownerShort && (
          <p style={styles.msgLine}>
            👤 Владелец: <code>{ownerShort}</code>
          </p>
        )}
        <p style={styles.msgLine}>🕐 Улучшено: {minutesAgoText(minutesAgo)}</p>
        <p style={styles.msgLine}>
          📊 Улучшено всего (Telegram): {issuedTotal.toLocaleString("ru-RU")} из{" "}
          {issuedCap.toLocaleString("ru-RU")}
        </p>
        <div style={{ height: 8 }} />
        <p style={styles.msgLine}>
          🔗{" "}
          <a href={link} target="_blank" rel="noreferrer" style={styles.link}>
            Подарок
          </a>{" "}
          ·{" "}
          <a href="https://t.me/mrkt" target="_blank" rel="noreferrer" style={styles.link}>
            MRKT
          </a>{" "}
          ·{" "}
          <a href="https://t.me/portals" target="_blank" rel="noreferrer" style={styles.link}>
            Portals
          </a>
        </p>
        <p style={{ ...styles.link, marginTop: 4 }}>
          #TelegramGifts #NFT #{giftName.replace(/\s+/g, "")}
        </p>
        <div style={styles.msgTime}>{time}</div>
      </div>

      {/* ===== нативный линк-превью ===== */}
      <div style={styles.preview}>
        <div style={styles.previewSite}>Telegram</div>
        <div style={styles.previewTitle}>{previewTitle}</div>

        <div style={styles.giftStage} className="gift-stage-anim">
          <div style={styles.giftGlow} className="gift-glow-anim" />
          {lottieUrl ? (
            <div ref={lottieRef} style={{ width: "72%", height: "72%" }} />
          ) : (
            <img
              src={imageUrl}
              alt={giftName}
              style={styles.giftImg}
              className="gift-img-anim"
            />
          )}
        </div>

        <button style={styles.giftBtn} onClick={() => window.open(link, "_blank")}>
          Показать подарок
        </button>
      </div>

      {/* keyframes — вынесены сюда, т.к. inline-style не поддерживает @keyframes */}
      <style>{`
        .gift-img-anim { animation: giftFloat 3.2s ease-in-out infinite; }
        @keyframes giftFloat {
          0%,100% { transform: translateY(0) rotate(-1.2deg); }
          50%      { transform: translateY(-6px) rotate(1.2deg); }
        }
        .gift-stage-anim::after {
          content:"";
          position:absolute; top:0; left:-150%;
          width:60%; height:100%;
          background:linear-gradient(75deg,
            rgba(255,255,255,0) 0%, rgba(255,255,255,0.18) 45%,
            rgba(255,255,255,0.35) 50%, rgba(255,255,255,0.18) 55%,
            rgba(255,255,255,0) 100%);
          transform:skewX(-20deg);
          animation: shineSweep 3.2s ease-in-out infinite;
        }
        @keyframes shineSweep {
          0% { left:-150%; } 45% { left:150%; } 100% { left:150%; }
        }
        .gift-glow-anim { animation: glowPulse 2.6s ease-in-out infinite; }
        @keyframes glowPulse {
          0%,100% { box-shadow: inset 0 0 30px rgba(142,94,255,0.08); }
          50%      { box-shadow: inset 0 0 55px rgba(142,94,255,0.22); }
        }
      `}</style>
    </div>
  );
}

const styles = {
  wrap: { width: "100%", maxWidth: 420, fontFamily: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" },
  msg: {
    background: "#182533",
    border: "1px solid #223040",
    borderRadius: 14,
    padding: "10px 12px 8px 12px",
    color: "#e6ecf2",
    fontSize: 14.5,
    lineHeight: 1.45,
  },
  msgLine: { margin: "0 0 2px 0", whiteSpace: "pre-wrap" },
  link: { color: "#6ab3f3", textDecoration: "none" },
  msgTime: { textAlign: "right", fontSize: 11, color: "#6c7a86", marginTop: 4 },
  preview: {
    marginTop: 10,
    background: "#182533",
    border: "1px solid #223040",
    borderLeft: "3px solid #2ea6ff",
    borderRadius: 12,
    padding: "10px 12px 12px 10px",
    position: "relative",
    overflow: "hidden",
  },
  previewSite: { fontSize: 12.5, color: "#2ea6ff", fontWeight: 600, marginBottom: 2 },
  previewTitle: { fontSize: 14.5, fontWeight: 700, color: "#e6ecf2", marginBottom: 8 },
  giftStage: {
    position: "relative",
    width: "100%",
    aspectRatio: "1 / 1",
    borderRadius: 10,
    overflow: "hidden",
    background: "radial-gradient(circle at 50% 40%, #3a2560 0%, #1c1033 60%, #120a22 100%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  giftImg: {
    width: "72%",
    height: "72%",
    objectFit: "contain",
    filter: "drop-shadow(0 6px 18px rgba(0,0,0,0.45))",
  },
  giftGlow: { position: "absolute", inset: 0, borderRadius: 10, pointerEvents: "none" },
  giftBtn: {
    display: "block",
    width: "100%",
    marginTop: 10,
    padding: "9px 0",
    textAlign: "center",
    background: "transparent",
    border: "none",
    borderTop: "1px solid #223040",
    color: "#2ea6ff",
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: 0.2,
    cursor: "pointer",
    textTransform: "uppercase",
  },
};

/* ===================== Пример использования =====================
import GiftUpgradeCard from "./GiftUpgradeCard";

<GiftUpgradeCard
  giftName="Victory Medals"
  nftNumber={106717}
  issuedTotal={106717}
  issuedCap={124608}
  minutesAgo={2}
  slug="victorymedal"
  imageUrl="https://example.com/victory-medal.png"
  // lottieUrl="https://example.com/victory-medal.json"  // опционально
/>
=================================================================== */
