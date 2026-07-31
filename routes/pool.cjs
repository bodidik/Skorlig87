"use strict";

/**
 * MAÇ HAVUZU UÇLARI (bkz. docs/ekonomi-tasarim.md §4, lib/pool-store.cjs).
 *
 * ⚠️ ARAYÜZ AYRIMI ZORUNLU. Ekranda iki ayrı şey var ve karıştırılırsa
 * kullanıcı hata sanır:
 *
 *   "Tahmin dağılımı: 20 / 38 / 98"   ← bot + insan, BİLGİ sinyali
 *   "Havuz: 60 LC (4 oyuncu)"          ← yalnızca gerçek para
 *
 * 158 kişi tahmin verip havuzda 60 LC olması normaldir: botlar dağılımı
 * oluşturur, parayı oluşturmaz. Bu yüzden yanıt ikisini AYRI alanlarda verir
 * (`distribution` ve `pool`) — tek sayıya indirgemek yanıltıcı olurdu.
 */

const express = require("express");
const router = express.Router();

const Pool = require("../lib/pool-store.cjs");
const { verifyToken } = require("../middleware/verifyToken.cjs");
const { kimlikVeyaHata } = require("../lib/kimlik-kontrol.cjs");
const { BOT_PROFILE_MAP } = require("../lib/botIds.cjs");

const getDb = (req) => req.app?.locals?.db || null;
const isBot = (uid) => BOT_PROFILE_MAP.has(String(uid || "").toLowerCase());

/**
 * Tahmin dağılımı: bot + insan birlikte. Havuz parasından BAĞIMSIZ.
 * `predictions` koleksiyonundan 1X2 sonuçlarını sayar.
 */
async function tahminDagilimi(fixtureId, db) {
  const bos = { H: 0, D: 0, A: 0, total: 0, humans: 0, bots: 0 };
  if (!db) return bos;
  try {
    const docs = await db
      .collection("predictions")
      .find({ fixtureId: String(fixtureId) }, { projection: { outcome: 1, userIdLower: 1, _id: 0 } })
      .toArray();
    const out = { ...bos };
    for (const d of docs) {
      const oc = String(d.outcome || "").toUpperCase();
      if (!["H", "D", "A"].includes(oc)) continue;
      out[oc] += 1;
      out.total += 1;
      if (isBot(d.userIdLower)) out.bots += 1;
      else out.humans += 1;
    }
    return out;
  } catch (e) {
    console.error("[pool] tahmin dagilimi okunamadi:", e?.message || e);
    return bos;
  }
}

/**
 * GET /api/pool/:fixtureId?userId=...
 * Havuz durumu + tahmin dağılımı + (userId verilmişse) kendi bahsi.
 */
router.get("/:fixtureId", async (req, res) => {
  try {
    const db = getDb(req);
    const fid = String(req.params.fixtureId || "").trim();
    if (!fid) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });

    const uid = String(req.query.userId || "").trim();
    const [pool, distribution, mine] = await Promise.all([
      Pool.summary(fid, db),
      tahminDagilimi(fid, db),
      uid ? Pool.myBet(fid, uid, db) : Promise.resolve(null),
    ]);

    return res.json({
      ok: true,
      fixtureId: fid,
      // Para: yalnızca gerçek oyuncular
      pool,
      // Bilgi sinyali: bot + insan. Havuz parasıyla eşleşmemesi NORMAL.
      distribution,
      myBet: mine,
      note:
        "Dagilim bot+insan tahminlerini gosterir; havuz yalnizca gercek " +
        "oyuncularin parasini tutar. Iki sayinin farkli olmasi beklenir.",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "POOL_READ_FAILED", detail: String(e?.message || e) });
  }
});

/**
 * POST /api/pool/:fixtureId/bet   { side: "H"|"D"|"A", amount }
 *
 * Kimlik zorunlu (verifyToken): bahis para harcatıyor, `userId`'yi gövdeden
 * almak başkasının cüzdanından oynamaya izin verirdi.
 */
router.post("/:fixtureId/bet", verifyToken, express.json(), async (req, res) => {
  try {
    const db = getDb(req);
    const fid = String(req.params.fixtureId || "").trim();
    const uid = String(req.uid || "").trim();
    const side = String(req.body?.side || "").toUpperCase();
    const amount = Number(req.body?.amount || 0);

    if (!uid) return res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });

    const r = await Pool.placeBet({ fixtureId: fid, userId: uid, side, amount, isBot: isBot(uid) }, db);
    if (!r.ok) {
      // Kullanıcı hatası (yetersiz bakiye, tavan) 400; altyapı hatası 503.
      const altyapi = ["NO_DB", "LC_SPEND_FAILED", "BET_WRITE_FAILED"].includes(r.reason);
      return res.status(altyapi ? 503 : 400).json({ ok: false, error: r.reason, ...r });
    }
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "POOL_BET_FAILED", detail: String(e?.message || e) });
  }
});

/**
 * GET /api/pool/:fixtureId/my?userId=...
 * Yalnızca kendi bahsi (hafif sorgu; ekran yenilemesi için).
 */
router.get("/:fixtureId/my", verifyToken, async (req, res) => {
  try {
    // ⚠️ SAHIPLİK: kimlik sorgudan geliyordu; denetim yoktu.
    // bkz. lib/kimlik-kontrol.cjs
    const _k = kimlikVeyaHata(req, res, req.query.userId);
    if (!_k) return;
    const uid = _k.uid;
    const bet = await Pool.myBet(String(req.params.fixtureId || ""), uid, getDb(req));
    return res.json({ ok: true, bet });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "POOL_MY_FAILED", detail: String(e?.message || e) });
  }
});

module.exports = router;
