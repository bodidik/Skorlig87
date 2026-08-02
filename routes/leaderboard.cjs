"use strict";

const express = require("express");
const SeasonTotals = require("../lib/season-totals.cjs");
const router  = express.Router();
const path    = require("path");
const fs      = require("fs");
const fsp     = fs.promises;

// ⚠️ SKORLIG_DATA_DIR: sabit yol testleri GERÇEK data/ dizinine yazdırır.
const DATA_DIR         = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const TOTALS_FILE      = path.join(DATA_DIR, "totals.json");

// Sıralama: kümülatif puan değil, güven ağırlıklı ortalama (bkz. lib/ranking.cjs)
const { rankRows, rankingMeta } = require("../lib/ranking.cjs");
// Bot ayrimi: kullanici kiminle yaristigini gormeli (bkz. scopedRank).
const { BOT_PROFILE_MAP } = require("../lib/botIds.cjs");
const { attachCountries, countryOfUser } = require("../lib/user-country.cjs");
const { normalizeCountry } = require("../lib/countries.cjs");
const Season = require("../lib/season.cjs");
const premium = require("../lib/premium.cjs");

async function readJson(file, fb=null){
  try{
    const txt = await fsp.readFile(file,"utf8");
    return JSON.parse(txt);
  }catch{
    return fb;
  }
}

/**
 * Ham satırları kapsama göre süzer, sonra sıralar.
 *
 * SIRA ÖNEMLİ — önce süz, sonra sırala. rankRows() havuz ortalamasını
 * (priorMean) aldığı listeden hesaplar; ülke listesi kendi ortalamasına göre
 * daraltılmalı. Önce sıralayıp sonra süzmek, oyuncuyu küresel havuza göre
 * puanlayıp ülke etiketi yapıştırmak olurdu — sıra numaraları da delik delik
 * çıkardı (1., 4., 9. ...).
 *
 * @returns {{ rows, scope, country, poolSize }}
 */
async function scopedRank(rawRows, { scope, country, humansOnly }, db) {
  const withCountry = await attachCountries(rawRows, db);

  // BOT İŞARETİ — ölçüldü (2026-07-29): tablodaki 1589 kaydın TAMAMI bot ve
  // yanıt bunu hiçbir yerde söylemiyordu. Kullanıcı 1589 kişiyle yarıştığını
  // sanıyor, ilk 20 sıranın tamamı bot. Bot listeyi canlı gösteriyor ama
  // kiminle yarıştığını gizlemek dürüst değil.
  const isaretli = withCountry.map((r) => ({
    ...r,
    isBot: BOT_PROFILE_MAP.has(String(r.userId || "").toLowerCase()),
  }));

  // ?humans=1 → yalnızca gerçek oyuncular. Botlar maç doldurmak için var,
  // sıralamada rakip olmak için değil.
  const insanFiltreli = humansOnly ? isaretli.filter((r) => !r.isBot) : isaretli;

  /* ⚠️ ÜLKE KARŞILAŞTIRMASI KANONİK AD ÜZERİNDEN.
   *
   * BULUNAN: filtre HAM eşitlikti (`r.country === wantCountry`). `country`
   * parametresi istemciden geliyor ve ucun kendi belgesi `country=Japan`
   * diyor — yani ad bekleniyor, ama takma adı gönderen sessizce BOŞ liste
   * alıyordu.
   *
   * ÖLÇÜLDÜ (gerçek rota, üç Türkiyeli oyuncu):
   *     ?country=Türkiye  → 3 satır
   *     ?country=Turkey   → 0 satır   applied:"country", poolSize:0
   *     ?country=Turkiye  → 0 satır
   *     ?country=TÜRKİYE  → 0 satır
   * Hata yok, uyarı yok — yalnızca boş tablo.
   *
   * `lib/countries.cjs` tam bu iş için var ve kullanıcı ülkesi yazılırken
   * (routes/live2.cjs) zaten kullanılıyordu; OKUMA tarafında kullanılmıyordu.
   *
   * ⚠️ İKİ TARAF DA NORMALLEŞTİRİLİYOR: satırdaki ülke eski/ham yazımda
   * kalmış olabilir (bot segment haritası, göç öncesi kayıtlar). Tek tarafı
   * çevirmek aynı bölünmeyi başka yönden üretirdi. */
  const wantCountry = scope === "country" ? String(country || "").trim() : null;
  const wantKanonik = wantCountry ? normalizeCountry(wantCountry) : null;
  const pool = wantKanonik
    ? insanFiltreli.filter((r) => r.country && normalizeCountry(r.country) === wantKanonik)
    : insanFiltreli;

  return {
    rows: rankRows(pool),
    scope: wantCountry ? "country" : "global",
    // Yanıtta KANONİK ad dönüyor: istemci ne gönderirse göndersin aynı etiket.
    country: wantKanonik || null,
    poolSize: pool.length,
    humansOnly: !!humansOnly,
    botCount: isaretli.filter((r) => r.isBot).length,
    humanCount: isaretli.filter((r) => !r.isBot).length,
  };
}

/**
 * Kapsam parametrelerini çözer.
 *   ?scope=country&userId=...   → kullanıcının kendi ülkesi
 *   ?scope=country&country=Japan → açıkça belirtilen ülke
 *   (varsayılan)                → küresel
 *
 * Ülke istenip de çözülemezse (kullanıcı henüz ülke seçmemiş) küresele
 * düşer ve `requestedScope` alanıyla bunu istemciye bildirir — sessizce boş
 * liste dönmek, ekranda "kimse yok" gibi görünürdü.
 */
/**
 * İstenen satır sınırını okur. Yoksa `null` — yani KIRPMA YOK.
 * ⚠️ Varsayılan bilinçli olarak sınırsız: sessizce kırpmak, alt sıradaki
 * oyuncunun kendini hiç görememesi demek. Kırpma çağıranın açık tercihi.
 */
function limitOku(req) {
  const ham = String(req.query.limit || "").trim();
  if (!ham) return null;
  const n = Number(ham);
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.max(1, Math.min(5000, Math.floor(n)));
}

/**
 * Satırları kırpar. ⚠️ META VERİ ÖNCE HESAPLANMIŞ OLMALI: `ranking` ve
 * `scope` (poolSize/botCount/humanCount) TAM kümeden gelir, kırpılmıştan
 * değil — ters sıra sıraları ve havuz sayısını bozar.
 *
 * ⚠️ MODÜL DÜZEYİNDE, bilerek: üç ayrı yanıt yolu var (Mongo, ara yol,
 * dosya yedeği) ve ilk yazımda bunu tek bir handler'ın içinde tanımlamıştım —
 * diğer iki yol `kirp is not defined` fırlatıp yanıtı HİÇ göndermedi, istek
 * asıldı. Aynı dersin bugünkü üçüncü hâli: bir dalı düzeltip öbürünü bırakmak.
 */
function kirp(satirlar, limit) {
  if (!limit || !Array.isArray(satirlar) || satirlar.length <= limit) return satirlar;
  return satirlar.slice(0, limit);
}

async function resolveScope(req, db) {
  // ?humans=1 → botları sıralamadan çıkar. Bot kadrosu maçları doldurmak için
  // var; sıralamada rakip olmak için değil.
  const humansOnly = String(req.query.humans || "") === "1";

  /**
   * ⚠️ YANIT SINIRSIZDI — TABLO BÜYÜDÜKÇE İSTEMCİ ŞİŞER.
   *
   * ÖLÇÜLDÜ (2026-08-02, canlı sunucu): varsayılan istek 1575 satır,
   * 256 KB, 660 ms. `app/(tabs)/stats.tsx` bunun İLK 100'ünü çiziyor
   * ("Daha fazla göster" ile 100'er açılıyor) — yani 16 katı veri
   * indiriliyordu. Ekran tarafındaki donma zaten bir kez düzeltilmiş
   * (bkz. stats.tsx `gosterilecek` notu) ama AĞ tarafı öylece kalmış.
   *
   * ⚠️ VARSAYILAN DEĞİŞTİRİLMİYOR: sınır yalnızca İSTENİRSE uygulanıyor.
   * Sessizce kırpmak, 2000. sıradaki oyuncunun kendini hiç görememesi
   * demekti — bu yüzden kırpma çağıranın açık tercihi.
   *
   * ⚠️ SIRALAMA META VERİSİ TAM KÜMEDEN hesaplanır, kırpılmıştan değil:
   * `ranking` ve `scope` (poolSize, humanCount, botCount) önce hesaplanıp
   * satırlar SONRA kesiliyor. Ters sıra, sıraları ve havuz sayısını bozardı.
   */


  const scope = String(req.query.scope || "global").trim().toLowerCase();
  if (scope !== "country") return { scope: "global", country: null, fellBack: false, humansOnly };

  let country = String(req.query.country || "").trim();
  if (!country) {
    const uid = String(req.query.userId || req.uid || "").trim();
    if (uid) country = (await countryOfUser(uid, db)) || "";
  }
  if (!country) return { scope: "global", country: null, fellBack: true, humansOnly };
  return { scope: "country", country, fellBack: false, humansOnly };
}

/**
 * GET /api/leaderboard
 *
 * Sorgu:
 *  scope=global (varsayılan) | country
 *  country=Japan   — açık ülke; yoksa userId'nin ülkesi kullanılır
 *  userId=...      — scope=country için ülke kaynağı
 *
 * Öncelik sırası:
 *  1) MongoDB (season_totals koleksiyonu) – varsa
 *  2) totals.json – varsa
 *  3) leaderboard.json üzerinden elde edilen toplamlar (eski davranış)
 *
 * Çıktı:
 *  leaderboard: [
 *    { userId, total, played, penalties, avg, rating, country }
 *  ]
 *  ranking: { sortedBy, method, confidenceK, priorMean, note }
 *  scope:   { requested, applied, country, poolSize }
 *
 * Sıralama `rating`'e göredir (güven ağırlıklı ortalama) — kümülatif `total`
 * değil. Sebep: 1280 bot her maça girdiği için kümülatifte insan yetişemez;
 * düz ortalamada da tek şanslı tahmin zirve getirir. bkz. lib/ranking.cjs
 *
 * ÜLKE KAPSAMI: kullanıcı kendi ülkesinde yarışabilsin diye var. Tek küresel
 * havuzda Türk kullanıcılar ve 200 Türk botu baskındı; Portekizli kullanıcı
 * için oyun "başkasının ligine misafir olmak" gibiydi.
 */
router.get("/", async (req,res)=>{
  const db = req.app?.locals?.db || null;
  const sc = await resolveScope(req, db);

  // Geçersiz sezon anahtarı sessizce güncel sezona düşer — istemci hatası
  // yüzünden boş tablo göstermek, kullanıcıya "kimse yok" demek olurdu.
  const istenen = String(req.query.season || "").trim();
  let sezon = Season.isValidKey(istenen) ? istenen : Season.seasonKey();

  // ARŞİV DERİNLİĞİ — premium ayrıcalığı (erişim grubu; LC akışına dokunmaz).
  // Ücretsiz kullanıcı 1 sezon geriye bakabilir, premium 12. Sınırın ötesi
  // sessizce güncel sezona düşürülür ve `archiveLimited` ile bildirilir —
  // boş tablo göstermek "o sezonda kimse yok" gibi görünürdü.
  let arsivKisitli = false;
  if (sezon !== Season.seasonKey()) {
    const uid = String(req.query.userId || req.uid || "").trim();
    const isPrem = uid ? await premium.isPremium(uid, db) : false;
    const derinlik = premium.seasonArchiveDepth(isPrem);
    let k = Season.seasonKey();
    let bulundu = false;
    for (let i = 0; i < derinlik; i++) {
      k = Season.previousKey(k);
      if (!k) break;
      if (k === sezon) { bulundu = true; break; }
    }
    if (!bulundu) { sezon = Season.seasonKey(); arsivKisitli = true; }
  }
  const scopeInfo = (r) => ({
    requested: String(req.query.scope || "global").toLowerCase(),
    applied: r.scope,
    country: r.country,
    poolSize: r.poolSize,
    // Hangi sezonun tablosuna bakıldığı görünür olmalı.
    season: sezon,
    seasonLabel: Season.label(sezon),
    isCurrentSeason: sezon === Season.seasonKey(),
    previousSeason: Season.previousKey(sezon),
    ...(arsivKisitli ? { archiveLimited: true } : {}),
    // Kullanıcı kiminle yarıştığını görmeli: kaçı bot, kaçı gerçek.
    humansOnly: r.humansOnly,
    botCount: r.botCount,
    humanCount: r.humanCount,
    ...(sc.fellBack ? { fellBackReason: "COUNTRY_UNKNOWN" } : {}),
  });

  // 1) 🔵 Mongo sezon toplamları
  if (db) {
    try {
      const col = db.collection("season_totals");
      // Sıralama uygulama tarafında (rating) yapılır; Mongo sort'u sadece
      // deterministik bir okuma sırası için.
      //
      // SEZON: varsayılan içinde bulunulan sezon. `?season=2026-06` ile arşiv.
      // Sezon alanı eklenmeden önceki kayıtlarda `season` yok — geçiş
      // döneminde onlar da güncel sezona sayılır (bkz. lib/season-totals.cjs).
      const suzgec = sezon === Season.seasonKey()
        ? { $or: [{ season: sezon }, { season: { $exists: false } }] }
        : { season: sezon };
      /* ⚠️ ESKI (sezonsuz) + YENI belge ayni kullaniciya aitse BIRLESTIR.
       * Yazma tarafi `filter: { season, userIdLower }` kullaniyor; eski
       * belgede `season` olmadigi icin eslesmiyor ve ikinci belge yaratiliyor.
       * Birlestirmezsek ayni kullanici siralamada IKI KEZ gorunur ve puani
       * bolunur. bkz. lib/season-totals.cjs belgeleriBirlestir */
      const ham = await col.find(suzgec).toArray();
      const docs = SeasonTotals.belgeleriBirlestir(ham)
        .sort((a, b) => Number(b.totalPoints || 0) - Number(a.totalPoints || 0));

      // ⚠️ BOŞ SEZON GEÇERLİ — dosyaya düşülmez. Aksi hâlde 1 Ağustos'ta
      // yeni sezon boş olduğu için totals.json'daki TEMMUZ verisi AĞUSTOS
      // etiketiyle gösterilirdi, yani sezon hiç sıfırlanmazdı.
      // bkz. lib/season-totals.cjs — aynı ayrım orada da yapıldı.
      if (!docs.length) {
        const bosR = await scopedRank([], sc, db);
        return res.json({
          ok: true,
          leaderboard: [],
          ranking: rankingMeta([]),
          scope: scopeInfo(bosR),
          updatedAt: null,
          source: "mongo_season_totals",
          note: "Bu sezonda henuz sonuclanmis mac yok.",
        });
      }

      if (docs && docs.length) {
        const r = await scopedRank(
          docs.map(d => ({
            userId: d.userId || d.userIdLower || "anon",
            // Kesirli puanlar $inc ile birikince kayan nokta artığı
            // bırakıyor (10.700000000000001) — bkz. lib/season-totals.cjs
            total: Math.round(Number(d.totalPoints || 0)),
            played: Number(d.matches || 0),
            penalties: Math.round(Number(d.totalPenalty || 0)),
          })),
          sc,
          db
        );

        const updatedAt =
          docs[0]?.updatedAt ||
          docs[0]?.lastAt ||
          new Date().toISOString();

        return res.json({
          ok: true,
          leaderboard: kirp(r.rows, limitOku(req)),
          ranking: rankingMeta(r.rows),
          scope: scopeInfo(r),
          updatedAt,
          source: "mongo_season_totals",
        });
      }
    } catch (e) {
      console.error("[leaderboard] Mongo read failed, falling back to files:", e);
      // Sessizce dosya moduna düşeceğiz
    }
  }

  // 2) 🟢 totals.json (yeni dosya tabanlı sezon toplamları)
  const totals = await readJson(TOTALS_FILE, null);
  if (totals && Array.isArray(totals.items) && totals.items.length) {
    const r = await scopedRank(
      totals.items.map(t => ({
        userId: t.userId,
        total: Number(t.totalPoints || 0),
        played: Number(t.matches || 0),
        penalties: Number(t.totalPenalty || 0),
      })),
      sc,
      db
    );

    return res.json({
      ok: true,
      leaderboard: kirp(r.rows, limitOku(req)),
      ranking: rankingMeta(r.rows),
      scope: scopeInfo(r),
      updatedAt: totals.updatedAt || null,
      source: "totals_json",
    });
  }

  // 3) Eski davranış: leaderboard.json içinden kullanıcı bazlı toplama
  const lb = await readJson(LEADERBOARD_FILE, { items:[], totals:{} });
  const items  = Array.isArray(lb.items) ? lb.items : [];
  const byUser = new Map();

  for (const r of items) {
    const uid = r.userId || "anon";
    if (!byUser.has(uid)) {
      byUser.set(uid, { userId: uid, total: 0, played: 0, penalties: 0 });
    }
    const acc = byUser.get(uid);
    acc.total     += Number(r.points   || 0);
    acc.played    += 1;
    // Yeni settle2 şemasında penalty farklı alanlarda; eski kayıtlarda r.penalty varsa onu da toplar
    acc.penalties += Number(r.penalty  || 0);
  }

  const r = await scopedRank(Array.from(byUser.values()), sc, db);

  return res.json({
    ok:true,
    leaderboard: kirp(r.rows, limitOku(req)),
    ranking: rankingMeta(r.rows),
    scope: scopeInfo(r),
    updatedAt: lb.updatedAt || null,
    source: "leaderboard_json_legacy",
  });
});

/**
 * GET /api/leaderboard/countries
 * Ülke sekmesi için: hangi ülkelerde kaç yarışmacı var.
 * Boş ülkeyi listelemeyiz — kullanıcı tıklayıp kendinden başka kimse
 * olmadığını görmesin.
 */
router.get("/countries", async (req, res) => {
  try {
    const totals = await readJson(TOTALS_FILE, null);
    let raw = [];
    if (totals && Array.isArray(totals.items)) {
      raw = totals.items.map(t => ({ userId: t.userId }));
    } else {
      const lb = await readJson(LEADERBOARD_FILE, { items: [] });
      const seen = new Set();
      for (const it of (Array.isArray(lb.items) ? lb.items : [])) {
        const u = it.userId || "anon";
        if (!seen.has(u)) { seen.add(u); raw.push({ userId: u }); }
      }
    }

    const withCountry = await attachCountries(raw, req.app?.locals?.db || null);
    const counts = new Map();
    for (const r of withCountry) {
      if (!r.country) continue;
      counts.set(r.country, (counts.get(r.country) || 0) + 1);
    }

    const items = Array.from(counts, ([country, players]) => ({ country, players }))
      .sort((a, b) => b.players - a.players || a.country.localeCompare(b.country));

    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

module.exports = router;
