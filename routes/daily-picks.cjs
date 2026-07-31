"use strict";

const express = require("express");
const Season = require("../lib/season.cjs");
const router = express.Router();
const fetch = globalThis.fetch || require("node-fetch");
const { calcOdds } = require("../services/odds-engine.cjs");
const MW = require("../services/match-weights.cjs");
const { macOdulu, SONUC_TABAN_PUAN } = require("../lib/ekonomi.cjs");

/**
 * Sonucu doğru bilmenin GERÇEKTEN kazandıracağı LC.
 *
 * settle2 ile aynı zincir: `3 × oddsMultiplier(...)` → `base` → merdiven.
 * `oddsMultiplier` ham oranı [0.34, 4.0] aralığına sıkıştırıyor; gösterimin
 * sıkıştırmaması, ekranın ödeyemeyeceği sayılar vaat etmesi demekti.
 */
function sonucOdulu(home, away, oc) {
  return macOdulu(SONUC_TABAN_PUAN * MW.oddsMultiplier(home, away, oc));
}
const { getStreak } = require("../services/streak.cjs");
const { verifyToken, optionalToken } = require("../middleware/verifyToken.cjs");

const AF_BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const AF_KEY = process.env.AF_KEY || "";
const AF_HDR = process.env.AF_HEADER_KEY || "x-apisports-key";

/* ⚠️ İKİSİ DE KALDIRILDI — ekranın kendi ödül formülü buradan geliyordu.
 * `BASE_LC × ham_oran` settle2'nin ödediğiyle ilgisizdi; `QUAD_BONUS_MULTIPLIER`
 * ise hiç var olmayan bir dörtlü bonusunu vaat ediyordu (ödeme her maç için
 * tek tek yapılıyor). Ödül artık `sonucOdulu` ile ödemeyle aynı zincirden. */

const TEAM_RATINGS = require("../services/odds-engine.cjs").TEAM_RATINGS;

const COUNTRY_LEAGUES = {
  "Türkiye": [203, 204], "İngiltere": [39, 40], "İspanya": [140, 141],
  "Almanya": [78, 79], "Fransa": [61, 62], "İtalya": [135, 136],
  "Portekiz": [94], "Hollanda": [88], "Belçika": [144],
  "Yunanistan": [197], "Arjantin": [128], "Brezilya": [71],
  "Japonya": [98], "Suudi Arabistan": [307], "ABD": [253],
};
const GLOBAL_FALLBACK = [39, 140, 135, 78, 61, 88, 94, 203];

function matchAttraction(home, away) {
  const hr = TEAM_RATINGS[home] || 65;
  const ar = TEAM_RATINGS[away] || 65;
  return Math.max(hr, ar) + Math.min(hr, ar) * 0.4;
}

async function fetchLeagueFixtures(leagueId, dateStr) {
  if (!AF_KEY) return [];
  try {
    const qs = new URLSearchParams({ league: String(leagueId), date: dateStr, timezone: "Europe/Istanbul" });
    const r = await fetch(`${AF_BASE}/fixtures?${qs}`, {
      headers: { [AF_HDR]: AF_KEY, Accept: "application/json" },
    });
    const json = await r.json();
    return (json.response || [])
      .filter(f => ["NS", "1H", "2H", "HT", "LIVE"].includes(f.fixture?.status?.short))
      .map(f => {
        const home = f.teams?.home?.name || "?";
        const away = f.teams?.away?.name || "?";
        const odds = calcOdds(home, away);
        return {
          fixtureId: String(f.fixture?.id),
          home,
          away,
          homeLogo: f.teams?.home?.logo || null,
          awayLogo: f.teams?.away?.logo || null,
          kickoffISO: f.fixture?.date || null,
          status: f.fixture?.status?.short || "NS",
          league: f.league?.name || null,
          country: f.league?.country || null,
          leagueId,
          odds,
          /* ⚠️ ÖDÜL ARTIK ÖDEMEYLE AYNI ZİNCİRDEN. Eskiden burada
           * `Math.round(10 * ham_oran)` hesaplanıyordu; settle2 ise puanı
           * [0.34, 4.0] aralığına sıkıştırıp sabit bir merdivenden ödüyor.
           * Ekranda yazan sayı cüzdana geçenin 2-200 katıydı (ölçüldü:
           * GS–FB deplasman 38 vs ≤15; Real Madrid–Erokspor 3009 vs ≤15). */
          rewards: {
            home: sonucOdulu(home, away, "H"),
            draw: sonucOdulu(home, away, "D"),
            away: sonucOdulu(home, away, "A"),
          },
          _attraction: matchAttraction(home, away),
        };
      });
  } catch { return []; }
}

// GET /api/daily-picks/singles?country=Türkiye
router.get("/singles", async (req, res) => {
  const country = String(req.query.country || "").trim();
  const limit = Math.min(8, Math.max(1, Number(req.query.limit) || 5));
  // ⚠️ TARIH ISTANBUL'A GORE. Ayni istek API'ye `timezone: "Europe/Istanbul"`
  // gonderiyor (bkz. fetchLeagueFixtures) ama tarih UTC hesaplaniyordu: yerel
  // 00:00–03:00 arasinda DUNUN maclari isteniyordu.
  const dateStr = Season.dayKey();

  try {
    const localLeagues = (country && COUNTRY_LEAGUES[country]) || [];
    const seen = new Set();
    let all = [];

    for (const lid of localLeagues) {
      const fixtures = await fetchLeagueFixtures(lid, dateStr);
      for (const f of fixtures) {
        if (!seen.has(f.fixtureId)) { seen.add(f.fixtureId); all.push(f); }
      }
    }

    if (all.length < limit) {
      for (const lid of GLOBAL_FALLBACK) {
        if (localLeagues.includes(lid)) continue;
        const fixtures = await fetchLeagueFixtures(lid, dateStr);
        for (const f of fixtures) {
          if (!seen.has(f.fixtureId)) { seen.add(f.fixtureId); all.push(f); }
        }
        if (all.length >= limit * 2) break;
      }
    }

    all.sort((a, b) => b._attraction - a._attraction);
    const picks = all.slice(0, limit).map(f => {
      const { _attraction, ...rest } = f;
      return rest;
    });

    res.json({ ok: true, date: dateStr, country: country || null, count: picks.length, picks });
  } catch (e) {
    res.status(500).json({ ok: false, error: "SINGLES_ERR", detail: String(e.message || e) });
  }
});

// GET /api/daily-picks/quad?country=Türkiye
router.get("/quad", async (req, res) => {
  const country = String(req.query.country || "").trim();
  // ⚠️ TARIH ISTANBUL'A GORE. Ayni istek API'ye `timezone: "Europe/Istanbul"`
  // gonderiyor (bkz. fetchLeagueFixtures) ama tarih UTC hesaplaniyordu: yerel
  // 00:00–03:00 arasinda DUNUN maclari isteniyordu.
  const dateStr = Season.dayKey();

  try {
    const localLeagues = (country && COUNTRY_LEAGUES[country]) || [];
    const seen = new Set();
    let all = [];

    for (const lid of [...localLeagues, ...GLOBAL_FALLBACK]) {
      if (seen.size >= 20) break;
      const fixtures = await fetchLeagueFixtures(lid, dateStr);
      for (const f of fixtures) {
        if (!seen.has(f.fixtureId)) { seen.add(f.fixtureId); all.push(f); }
      }
    }

    all.sort((a, b) => b._attraction - a._attraction);
    const quad = all.slice(0, 4).map(f => {
      const { _attraction, ...rest } = f;
      /* ⚠️ DÖRTLÜ EKRANI DA AYNI ZİNCİRDEN. Burada ayrıca `QUAD_BONUS_MULTIPLIER`
       * ile çarpılıyordu — ama settle2 dörtlü diye FAZLA ÖDEMİYOR: ödeme her maç
       * için tek tek, aynı merdivenden yapılıyor. Yani çarpan da ekranın
       * ödeyemeyeceği bir söz veriyordu. Çarpan kaldırıldı; "dörtlü" bir bonus
       * değil, dikkat çeken dört maçın seçkisi. */
      rest.rewards = {
        home: sonucOdulu(rest.home, rest.away, "H"),
        draw: sonucOdulu(rest.home, rest.away, "D"),
        away: sonucOdulu(rest.home, rest.away, "A"),
      };
      return rest;
    });

    const combinedOdds = quad.reduce((acc, f) => {
      const minOdd = Math.min(f.odds.home, f.odds.draw, f.odds.away);
      return +(acc * minOdd).toFixed(2);
    }, 1);

    res.json({
      ok: true, date: dateStr, country: country || null,
      count: quad.length, matches: quad,
      /* ⚠️ HAYALET BONUS — 0'a çekildi.
       *
       * Burası `BASE_LC * combinedOdds * 2` hesaplayıp istemciye gönderiyordu;
       * `mobile/components/QuickPlaySection.tsx` de ekranda "4/4 → +N LC" rozeti
       * olarak gösteriyor. Ama sunucuda dörtlüyü ödeyen HİÇBİR yol yok:
       * settle2'nin tek bonusu `streak_bonus` (üst üste doğru tahmin) ve o da
       * dörtlü seçkisinden habersiz. Yani rozet hiç ödenmeyecek bir söz veriyordu.
       *
       * İstemci `quadBonus > 0` ile koruduğu için 0 dönmek rozeti tamamen gizler;
       * alan, gerçek bir dörtlü bonusu yazılırsa sözleşme bozulmasın diye duruyor. */
      allCorrectBonus: 0,
      combinedOdds,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "QUAD_ERR", detail: String(e.message || e) });
  }
});

// GET /api/daily-picks/streak?userId=xxx
router.get("/streak", optionalToken, async (req, res) => {
  const userId = req.uid || req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

  try {
    const streak = await getStreak(userId);
    res.json({ ok: true, ...streak });
  } catch (e) {
    res.status(500).json({ ok: false, error: "STREAK_ERR", detail: String(e.message || e) });
  }
});

module.exports = router;
/* Sınama için: gösterilen ödülün gerçek hesabı. Testin kendi kopyasını
 * yazması, bu turda bir kez yeşil-ama-ölü sonuç üretti (bkz. tests/
 * vaat-edilen-odul.test.cjs notu). */
module.exports._sonucOdulu = sonucOdulu;
