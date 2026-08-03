"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

// ⚠️ SKORLIG_DATA_DIR: sabit yol testleri GERÇEK data/ dizinine yazdırır.
const DATA_DIR         = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");

const SeasonTotals = require("../lib/season-totals.cjs");
const Season = require("../lib/season.cjs");
const { BOT_ID_SET } = require("../lib/botIds.cjs");

async function readJson(file, fallback = null) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

/**
 * ⚠️ BURADA BİR `GET /totals` İŞLEYİCİSİ VARDI — KALDIRILDI, ÖLÜ KODDU.
 *
 * Aynı yol `routes/totals-read.cjs` tarafından da tanımlanıyor ve o
 * server.cjs'te DAHA ÖNCE bağlanıyor (341 vs 378), yani express isteği hep
 * ona veriyordu; buradaki işleyiciye hiç sıra gelmiyordu.
 *
 * ÖLÇÜLDÜ (iki dosya server.cjs'teki gerçek sırayla bağlanıp istek atıldı):
 *     GET /api/rt/totals?userId=demo1
 *       → yanıt alanları: ok, items, updatedAt, limited, season, …
 *       → buradaki işleyicinin söz verdiği last10 / avgPerMatch: YOK
 *
 * Tehlike okuyandaydı: bu dosya "userId'nin son 10 maçı ve maç başı
 * ortalaması" döndüğünü belgeliyordu. Sunucu bunu ASLA döndürmüyor. Bu
 * belgeye güvenip istemci yazan biri sessizce yanlış alanları bekler.
 *
 * Kayıp yok: `totals-read.cjs` `?userId=` ile aynı kullanıcının satırını
 * zaten döndürüyor ve o yol Mongo öncelikli.
 */

/**
 * GET /api/rt/totals/board
 * Genel leaderboard: kullanıcı bazlı total / played / penalties
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03): bu uç YALNIZCA leaderboard.json'a bakıyordu.
 * O dosya git'te izlenmiyor (.gitignore `data/*`) ve Render'ın diski geçici —
 * her deploy'dan sonra dosya YOK, yani tablo boş dönüyordu. Aynı gün aynı
 * sınıftan iki kusur daha düzeltildi (leaderboard `/countries`, ve daha önce
 * groups/friends/users); okuma tek yerden yapılmalı: lib/season-totals.cjs.
 *
 * Ayrıca leaderboard.json MAÇ KAYITLARIDIR, sezon toplamı değil: `played`
 * satır sayısıyla hesaplanıyordu ve dosya yalnızca son partiyi tuttuğu için
 * (ölçüldü: 40 satır) sayı gerçek maç sayısı da değildi.
 *
 * Bot işareti `?humans=1`: kardeş uçların (leaderboard.cjs, totals-read.cjs)
 * verdiği kararın aynısı — botu SİLME, İŞARETLE, isteğe bağlı süz.
 */
router.get("/totals/board", async (req, res) => {
  const db = req.app?.locals?.db || null;
  const { items, updatedAt } = await SeasonTotals.loadTotals(db);

  let rows = (Array.isArray(items) ? items : []).map((x) => ({
    userId: String(x.userId || "anon"),
    total: Number(x.totalPoints || 0),
    played: Number(x.matches || 0),
    penalties: Number(x.totalPenalty || 0),
    isBot: BOT_ID_SET.has(String(x.userId || "").trim().toLowerCase()),
  }));

  if (!rows.length) {
    // Eski davranış: ne Mongo ne totals.json varsa maç kayıtlarından türet.
    const lb = await readJson(LEADERBOARD_FILE, { items: [], totals: {} });
    const byUser = new Map();
    for (const r of (Array.isArray(lb.items) ? lb.items : [])) {
      const uid = r.userId || "anon";
      if (!byUser.has(uid)) {
        byUser.set(uid, {
          userId: uid, total: 0, played: 0, penalties: 0,
          isBot: BOT_ID_SET.has(String(uid).trim().toLowerCase()),
        });
      }
      const acc = byUser.get(uid);
      acc.total     += Number(r.points  || 0);
      acc.played    += 1;
      acc.penalties += Number(r.penalty || 0);
    }
    rows = Array.from(byUser.values());
  }

  const humansOnly = String(req.query.humans || "") === "1";
  if (humansOnly) rows = rows.filter((r) => !r.isBot);

  rows.sort((a, b) => b.total - a.total);

  const sezon = Season.seasonKey();
  return res.json({
    ok: true,
    leaderboard: rows,
    updatedAt: updatedAt || null,
    // Hangi sezona bakıldığı görünür olmalı: tablo ayın 1'inde sıfırlanıyor.
    season: sezon,
    seasonLabel: Season.label(sezon),
    isCurrentSeason: true,
    humansOnly,
  });
});

module.exports = router;
