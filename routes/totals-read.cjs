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

async function readJson(file, fb = null) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fb;
  }
}

/**
 * TOTALS loader:
 *  - totals.json beklenen format: { items:[{ userId,totalPoints,totalPenalty,matches,lastAt }], updatedAt }
 *  - Eski formatlara karşı toleranslı
 *  - Puanlara göre azalan sırada döner
 */
// Sezon toplamları Mongo öncelikli: totals.json Render'da her deploy'da
// siliniyor ve settle2 artık season_totals'a yazıyor. bkz. lib/season-totals.cjs
// Eski tip (düz array) toleransı korundu — dosya yedeği hâlâ devrede.
async function loadTotals(db) {
  const raw = await SeasonTotals.loadTotals(db || null);

  let items = [];
  if (Array.isArray(raw?.items)) {
    items = raw.items;
  } else if (Array.isArray(raw)) {
    items = raw;
  }

  const norm = items.map((x) => ({
    userId: String(x.userId || x.user || "anon"),
    totalPoints: Number(x.totalPoints ?? x.points ?? 0),
    totalPenalty: Number(x.totalPenalty ?? 0),
    matches: Number(x.matches ?? 0),
    lastAt: x.lastAt || null,
  }));

  norm.sort((a, b) => b.totalPoints - a.totalPoints);

  return {
    items: norm,
    updatedAt: raw.updatedAt || null,
  };
}

/** GET /api/rt/board2 → ham leaderboard.json içeriği (debug / eski kullanım) */
router.get("/board2", async (req, res) => {
  const lb = await readJson(LEADERBOARD_FILE, { items: [], updatedAt: null });
  res.json({
    ok: true,
    leaderboard: Array.isArray(lb.items) ? lb.items : [],
    updatedAt: lb.updatedAt || null,
  });
});

/** GET /api/rt/totals[?userId=demo1] → totals.json’dan normalize liste */
/**
 * GET /api/rt/totals?userId=...&limit=...
 *
 * ⚠️ SINIRSIZDI. Filtre verilmeyince TÜM sıralama dönüyordu: ölçüldü, 1707
 * satır / 182 KB. İki istemci de bunu gereksiz yere indiriyordu —
 * `me.tsx` yalnızca KENDİ satırını arıyordu (182 KB → 167 bayt, `?userId=`
 * ile), `kings.tsx` ise sıralayıp yalnızca ilk 100'ü gösteriyordu.
 *
 * `limit` sunucuda SIRALADIKTAN sonra keser — istemci kendi sıralamasını
 * yapmaya devam edebilir (aynı ölçüt), sıra numaraları bozulmaz. Ölçüt
 * `totalPoints`; ceza ayrı alanda tutuluyor ve istemci sıralaması da bunu
 * kullanıyor, ikisi ayrışmasın diye burada da aynısı.
 *
 * ⚠️ VARSAYILAN SINIR YOK — kasıtlı. Bu uç yalnızca liderlik tablosu için
 * değil, grup/arkadaş panolarının kesişim hesabı için de okunuyor olabilir;
 * sessizce kesmek o yolları bozardı. İstemci `limit` göndererek katılır.
 */
router.get("/totals", async (req, res) => {
  const userId = String(req.query.userId || "");
  const limitRaw = Number(req.query.limit || 0);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 0;

  const { items, updatedAt } = await loadTotals(req.app?.locals?.db || null);

  let out = userId
    ? items.filter((x) => String(x.userId).toLowerCase() === userId.toLowerCase())
    : items;

  if (!userId && limit) {
    out = [...out]
      .sort((a, b) => (Number(b.totalPoints) || 0) - (Number(a.totalPoints) || 0))
      .slice(0, limit);
  }

  res.json({ ok: true, items: out, updatedAt, limited: !userId && !!limit && items.length > limit });
});

module.exports = router;
