"use strict";

/**
 * MAÇ TEPKİLERİ UCU — kapalı listeli, metinsiz maç odası.
 *
 * NEDEN BU ŞEKİLDE: kullanıcılar maçı zaten başka yerde tartışıyor. Oraya
 * rakip olmak yerine onlarda OLMAYAN şeyi veriyoruz — maç oynanırken herkesin
 * tepkisinin aynı ekranda, canlı sayılarla birikmesi. Serbest metin YOK:
 * moderasyon yükü sıfır kalıyor ve talep gerçekten varsa ölçmüş oluyoruz.
 * Gerekçe `lib/reactions-store.cjs` başında.
 *
 * ⚠️ KİMLİK GÖVDEDEN ALINMAZ. Yazma ucu `verifyToken` kullanıyor ve tepkiyi
 * `req.uid`e yazıyor; gövdedeki `userId` YOK SAYILIR. Aksi hâlde herkes
 * herkesin adına tepki basardı — bu depoda aynı sınıf birden çok kez bulundu
 * (bkz. lib/kimlik-kontrol.cjs).
 */

const express = require("express");
const router = express.Router();

const { verifyToken, optionalToken } = require("../middleware/verifyToken.cjs");
const Reactions = require("../lib/reactions-store.cjs");
const UsersStore = require("../lib/users-store.cjs");

/** Kimlik → görünen ad. match-race ile AYNI kural: ad yoksa kısaltılmış kimlik. */
async function adlariCoz(userIds, db) {
  const benzersiz = [...new Set(userIds.map((x) => String(x || "")).filter(Boolean))];
  if (!benzersiz.length) return () => "";

  let items = [];
  try {
    items = Object.values(await UsersStore.getUsersByIdsLower(benzersiz, db));
  } catch (e) {
    console.error("[reactions] adlar cozulemedi:", e?.message || e);
  }

  const harita = new Map();
  for (const u of items) {
    const uid = String(u.userId || "");
    if (uid) harita.set(uid.toLowerCase(), u.nickname || u.displayName || uid);
  }
  return (uid) => {
    const ad = harita.get(String(uid || "").toLowerCase());
    if (ad && ad !== uid) return ad;
    const s = String(uid || "");
    return s.length > 12 ? s.slice(0, 8) + "…" : s;
  };
}

/**
 * GET /api/rt/reactions?fixtureId=...&limit=20
 *
 * `keys` DE DÖNÜYOR: izin verilen liste tek kaynak olarak sunucuda duruyor
 * (bkz. store). İstemci kendi kopyasını tutarsa iki liste sessizce ayrışır ve
 * kullanıcı bastığı tepkinin reddedildiğini ancak deneyince öğrenir.
 */
router.get("/reactions", optionalToken, async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "").trim();
    if (!fixtureId) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });

    const db = req.app?.locals?.db || null;
    const { counts, total, feed } = await Reactions.readReactions(
      { fixtureId, limit: req.query.limit },
      db
    );

    const getName = await adlariCoz(feed.map((f) => f.userId), db);

    return res.json({
      ok: true,
      fixtureId,
      keys: Reactions.TEPKILER,
      counts,
      total,
      feed: feed.map((f) => ({
        key: f.key,
        userId: f.userId,
        displayName: getName(f.userId),
        at: f.at,
      })),
      cooldownMs: Reactions.BEKLEME_MS,
    });
  } catch (e) {
    console.error("[reactions] okuma hatasi:", e?.message || e);
    return res.status(500).json({ ok: false, error: "REACTIONS_FAILED" });
  }
});

/**
 * POST /api/rt/reactions   { fixtureId, key }
 *
 * Yanıt GÜNCEL SAYIMLARI da içeriyor: istemci basar basmaz doğru sayıyı
 * gösterebilsin, bir sonraki yoklamayı beklemesin.
 */
router.post("/reactions", express.json(), verifyToken, async (req, res) => {
  try {
    const fixtureId = String(req.body?.fixtureId || "").trim();
    const key = String(req.body?.key || "").trim();
    if (!fixtureId) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });

    const db = req.app?.locals?.db || null;
    const r = await Reactions.addReaction({ fixtureId, userId: req.uid, key }, db);

    if (!r.ok) {
      /* Bilinmeyen anahtar 400, hız/kota 429 — istemci ikisini AYIRMALI:
       * biri hata (kod yanlış), diğeri normal (biraz bekle). */
      const durum = r.error === "UNKNOWN_REACTION" ? 400 : r.error === "WRITE_FAILED" ? 500 : 429;
      return res.status(durum).json({ ...r, keys: Reactions.TEPKILER });
    }

    const { counts, total } = await Reactions.readReactions({ fixtureId, limit: 1 }, db);
    return res.json({ ok: true, fixtureId, key, at: r.at, counts, total });
  } catch (e) {
    console.error("[reactions] yazma hatasi:", e?.message || e);
    return res.status(500).json({ ok: false, error: "REACTIONS_FAILED" });
  }
});

module.exports = router;
