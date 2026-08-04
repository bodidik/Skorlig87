"use strict";
const express = require("express");
const { BOT_ID_SET } = require("../lib/botIds.cjs");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

// ⚠️ SKORLIG_DATA_DIR: sabit yol testleri GERÇEK data/ dizinine yazdırır.
const DATA_DIR         = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const SeasonTotals = require("../lib/season-totals.cjs");
const Season = require("../lib/season.cjs");
// Bayrak TEK KAYNAK: lib/countries.cjs (ülke adı takma adlarıyla normalize edilir).
const { flagOf } = require("../lib/countries.cjs");

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

/**
 * GET /api/rt/board2 → kişi bazında liderlik tablosu (+ ham içerik)
 *
 * ⚠️ UÇ İLE TEK İSTEMCİSİ ÜÇ ALANDA UYUŞMUYORDU; her biri tek başına ekranı
 * boşaltmaya yetiyordu:
 *
 *   uç (eski)                  istemci (mobile/app/stats/board2.tsx)
 *   -------------------------- -------------------------------------
 *   { leaderboard: [...] }     `Array.isArray(j.items)`   satır 53
 *   satır: MAÇ bazlı           `x.points` → kişi başı bekleniyor
 *   (bayrak yok)               `x.flag`   → hep boş
 *
 * İlki öldürücüydü: `j.items` undefined → `setItems([])` → boş durum çizilir,
 * `loadError` false kaldığı için HATA DA GÖSTERİLMEZ. Ekranın adı "Bayraklı
 * Liderlik" ve kalıcı olarak boştu.
 *
 * İkincisi daha sinsi: `leaderboard.json` satırları MAÇ BAZLI
 * (`realtime.cjs:303-311`). Yalnızca anahtarı `items` yapmak, aynı kullanıcıyı
 * her maç için ayrı satır olarak listelerdi — liderlik tablosu değil ham döküm.
 *
 * ÖLÇÜLDÜ (3 satır / 2 kullanıcı tohumlandı):
 *     önce  → anahtarlar ["ok","leaderboard","updatedAt"]   (6 iddia düştü)
 *     sonra → items: Ali 16 puan 🇹🇷, Veli 4 puan 🇩🇪
 *
 * ⚠️ NEDEN YAKALANMADI: `istemci-uc-eslesme.test.cjs` yalnızca YOLUN var
 * olduğunu sınıyor, yanıtın ŞEKLİNİ değil — board2.tsx:47-49 yolun bir kez
 * düzeltildiğini belgeliyor, şekil kırık kalmış. Ayrıca
 * `mongo-birincil.test.cjs:63` bu ucu "istemci çağırmıyor" diye muaf tutuyor;
 * o gerekçe artık yanlış.
 *
 * `leaderboard` anahtarı KORUNUYOR (alan ekleniyor, kaldırılmıyor).
 */
router.get("/board2", async (req, res) => {
  const lb = await readJson(LEADERBOARD_FILE, { items: [], updatedAt: null });
  const ham = Array.isArray(lb.items) ? lb.items : [];

  /* Kişi bazında toplama. Anahtar küçük harfe indirgeniyor: kardeş uçlar
   * (satır ~107 bot araması, ~112 userId süzgeci) zaten öyle yapıyor ve
   * "Demo1"/"demo1" iki ayrı satır olmamalı. Görünen ad ilk görülen yazımdır. */
  const kisiler = new Map();
  for (const r of ham) {
    const ad = String(r?.userId || r?.user || "").trim();
    if (!ad) continue;
    const anahtar = ad.toLowerCase();

    let k = kisiler.get(anahtar);
    if (!k) {
      k = { userId: ad, points: 0, penalty: 0, matches: 0, country: null, lastAt: null };
      kisiler.set(anahtar, k);
    }
    k.points  += Number(r?.points  || 0);
    k.penalty += Number(r?.penalty || 0);
    k.matches += 1;
    if (!k.country && r?.country) k.country = r.country;

    const ts = r?.updatedAt || r?.at || null;
    if (ts && (!k.lastAt || new Date(ts) > new Date(k.lastAt))) k.lastAt = ts;
  }

  const items = [...kisiler.values()]
    .map((k) => ({
      ...k,
      /* Ondalık koruma: puanlar kesirli (ölçüldü: -2.06). Tamsayıya
       * yuvarlamak profil ekranıyla çelişirdi — bkz. stats.cjs iki-ondalık notu. */
      points: Math.round(k.points * 100) / 100,
      penalty: Math.round(k.penalty * 100) / 100,
      flag: flagOf(k.country) || "",
      isBot: BOT_ID_SET.has(String(k.userId).trim().toLowerCase()),
    }))
    /* İkincil ölçüt bilerek: yalnız puana bakan sıralama eşitlikte kararsız
     * kalır ve ekran `idx+1` ile derece bastığı için sıra istekten isteğe
     * oynardı. */
    .sort((a, b) => b.points - a.points || a.userId.localeCompare(b.userId, "tr"));

  res.json({
    ok: true,
    items,
    leaderboard: ham,          // eski sözleşme korunuyor
    count: items.length,
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

  /* UYARI: BOT ISARETI + istege bagli suzgec — routes/leaderboard.cjs ile AYNI.
   *
   * Olculdu (2026-07-31): 1707 siralama kaydinin 1706'si BOT. Siralama ekrani
   * (kings.tsx) bu ucu `?limit=300` ile cagiriyor, yani liste fiilen tamamen
   * bot ve YANIT bunu hicbir yerde soylemiyordu: kullanici 300 kisiyle
   * yaristigini saniyor.
   *
   * leaderboard.cjs ayni olcumu 2026-07-29'da yapmis ve karari vermis:
   * botlari SILME, ISARETLE ve `?humans=1` ile istege bagli suz — "bot listeyi
   * canli gosteriyor ama kiminle yaristigini gizlemek durust degil". O karar
   * burada uygulanmamisti; ayni karari uyguluyoruz, tersine cevirmiyoruz.
   */
  const isaretli = items.map((x) => ({
    ...x,
    isBot: BOT_ID_SET.has(String(x.userId || "").trim().toLowerCase()),
  }));
  const humansOnly = String(req.query.humans || "") === "1";

  let out = userId
    ? isaretli.filter((x) => String(x.userId).toLowerCase() === userId.toLowerCase())
    : (humansOnly ? isaretli.filter((x) => !x.isBot) : isaretli);

  if (!userId && limit) {
    out = [...out]
      .sort((a, b) => (Number(b.totalPoints) || 0) - (Number(a.totalPoints) || 0))
      .slice(0, limit);
  }

  /* ⚠️ SEZON BİLGİSİ YANITTA YOKTU — TABLO AYIN 1'İNDE SESSİZCE BOŞALIYOR.
   *
   * Bu uç yalnızca İÇİNDE BULUNULAN sezonun toplamlarını döndürüyor
   * (lib/season-totals.cjs), ama hangi sezon olduğunu söylemiyordu. Tek
   * tüketicisi `app/(tabs)/kings.tsx` ve başlığı "Sezon Liderleri" — yani
   * ekran sezon kavramını gösteriyor, veriyi sağlayan uç göstermiyor.
   *
   * ⚠️ AYNI SAVUNMA KOMŞUSUNDA VAR: `/api/leaderboard` bunları `scope.season`,
   * `scope.seasonLabel`, `scope.isCurrentSeason` olarak gönderiyor ve
   * `stats.tsx` okuyor — oradaki not aynen şöyle: "sezon aylık, yani ayın
   * 1'inde tablo SESSİZCE boşalıyor ve kullanıcı ne olduğunu anlamadan bir
   * aylık emeğini kayıp sanıyor". kings.tsx'te o uyarı hiç görünemiyordu.
   *
   * ÖLÇÜLDÜ: GET /api/rt/totals?limit=300 → alanlar {ok, items, updatedAt,
   * limited}; season/seasonLabel/isCurrentSeason HİÇBİRİ yok.
   *
   * Alan EKLENİYOR, hiçbiri değiştirilmiyor: eski istemciler etkilenmez.
   */
  const sezon = Season.seasonKey();
  res.json({
    ok: true,
    items: out,
    updatedAt,
    limited: !userId && !!limit && items.length > limit,
    season: sezon,
    seasonLabel: Season.label(sezon),
    isCurrentSeason: true,
    humansOnly,
  });
});

module.exports = router;
