"use strict";

/**
 * GET /api/pred/weights?fixtureId=...
 * (alternatif: ?home=X&away=Y&country=Z — takvimde olmayan maç için)
 *
 * Tahmin ekranının "kazanabileceğin puan" önizlemesi için, settle'ın
 * KULLANACAĞI çarpanları döndürür.
 *
 * NEDEN: Ön yüz eskiden maç sonucu çarpanını topluluk dağılımından
 * hesaplıyordu, sunucu ise maç oddsından. İkisi farklı girdi olduğu için
 * ekranda "3 puan" yazarken sunucu 12 puan veriyordu (%823 sapma). Artık
 * çarpanlar tek kaynaktan (services/match-weights.cjs) geliyor.
 *
 * Ayrıca soğuk başlangıcı çözer: odds ilk andan itibaren bellidir, ekran
 * "2 kişi tahmin yapsın" diye beklemek zorunda kalmaz.
 *
 * Skor çarpanı bilinçli olarak DÖNDÜRÜLMEZ — o topluluk nadirliğine bağlıdır
 * ve ön yüz zaten canlı topluluk verisiyle aynı formülü uyguluyor.
 */

const express = require("express");
const router  = express.Router();
const path    = require("path");
const fsp     = require("fs").promises;

const MW = require("../services/match-weights.cjs");
const { calcOdds } = require("../services/odds-engine.cjs");

const DATA_DIR = path.join(__dirname, "..", "data");
const LIVE_DIR = path.join(DATA_DIR, "live");
const FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");

async function readJson(file, fb) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch { return fb; }
}

function safeName(fid) {
  return String(fid).replace(/[<>:"/\\|?*]/g, "_");
}

/** Maç bilgisini takvimden, yoksa canlı durum dosyasından bul. */
async function findMatch(fixtureId) {
  const fid = String(fixtureId || "").trim();
  if (!fid) return null;

  const raw = await readJson(FIXTURES_FILE, null);
  const list = Array.isArray(raw) ? raw : (raw?.fixtures || raw?.items || []);
  const fx = list.find((f) => String(f.fixtureId || "") === fid);
  if (fx && (fx.home || fx.away)) {
    return { home: fx.home, away: fx.away, country: fx.country, league: fx.league };
  }

  const st = await readJson(path.join(LIVE_DIR, `${safeName(fid)}.json`), null);
  if (st && (st.home || st.away)) {
    return { home: st.home, away: st.away, country: st.country, league: st.league };
  }
  return null;
}

router.get("/pred/weights", async (req, res) => {
  try {
    const fid = String(req.query.fixtureId || "").trim();

    // Takım adları doğrudan verilebilir; takvimde henüz olmayan maçta gerekli.
    let home = String(req.query.home || "").trim();
    let away = String(req.query.away || "").trim();
    let country = String(req.query.country || "").trim();
    let league = "";

    if ((!home || !away) && fid) {
      const m = await findMatch(fid);
      if (m) {
        home = home || String(m.home || "");
        away = away || String(m.away || "");
        country = country || String(m.country || "");
        league = String(m.league || "");
      }
    }

    if (!home || !away) {
      return res.status(400).json({
        ok: false,
        error: "MATCH_NOT_FOUND",
        detail: "fixtureId takvimde/canlı veride bulunamadı; home & away parametresi gönderin.",
      });
    }

    const odds = calcOdds(home, away);

    return res.json({
      ok: true,
      fixtureId: fid || null,
      home, away, country: country || null, league: league || null,
      odds: {
        home: Math.round(odds.home * 100) / 100,
        draw: Math.round(odds.draw * 100) / 100,
        away: Math.round(odds.away * 100) / 100,
      },
      // 1X2 çarpanı — baz puanla çarpılır (topluluktan BAĞIMSIZ)
      outcomeMult: {
        H: MW.oddsMultiplier(home, away, "H"),
        D: MW.oddsMultiplier(home, away, "D"),
        A: MW.oddsMultiplier(home, away, "A"),
      },
      // yan kalemlere (ilk gol / ilk yarı / kırmızı / penaltı) uygulanır
      matchDifficulty: MW.matchDifficulty(home, away),
      // toplam puana uygulanan ülke/lig ağırlığı
      countryWeight: MW.getScoreWeight(country),
      basePoints: MW.BASE_POINTS,
      penaltyPoints: MW.PENALTY_POINTS,
    });
  } catch (e) {
    console.error("PRED_WEIGHTS_FAILED", e);
    return res.status(500).json({ ok: false, error: "PRED_WEIGHTS_FAILED", detail: String(e?.message || e) });
  }
});

module.exports = router;
