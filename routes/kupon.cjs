"use strict";

/**
 * HAFTALIK KUPON — uçlar.
 *
 * OYUN (bkz. lib/kupon.cjs): bir haftanın maçları TEK kupon olur, oyuncu
 * bedelini ödeyip hepsine tahmin girer, hafta bitince başarısına göre puan ve
 * LC kazanır. Ödül HAVUZDAN DEĞİL, başarıdan üretilir.
 *
 *   ulke   → her ülke kendi ligi, hafta sonu, kendi tablosu
 *   avrupa → hafta ortası kupa maçları, TEK kupon, tüm ülkeler aynı tabloda
 *
 * KATILIM PENCERESİ: ilk maçtan 1 SAAT ÖNCE kapanır (bkz. lib/kupon.cjs
 * KILIT_ONCE_DK — fikstür saatleri dış kaynaklardan geliyor ve gecikmeli
 * olabiliyor; tampon olmadan maç başlamışken katılmak mümkün olurdu).
 * Kilit `kilitISO` ile tutuluyor
 * ve her istekte kontrol ediliyor — zamanlayıcıya güvenilmiyor, çünkü Render
 * ücretsiz katmanda süreç uyutulabiliyor.
 */

const express = require("express");
const router = express.Router();

const { verifyToken } = require("../middleware/verifyToken.cjs");
const { requireAdmin } = require("../middleware/requireAdmin.cjs");
const Kupon = require("../lib/kupon.cjs");
const Store = require("../lib/kupon-store.cjs");
const FixturesStore = require("../lib/fixtures-store.cjs");
// ⚠️ Ülke adı karşılaştırması GEVŞEK olmalı: fikstürler "Turkey" yazıyor,
// kullanıcı profili "Türkiye". Düz eşitlik kullanınca Türk kullanıcıya HİÇ
// kupon çıkmıyordu (üretim verisinde ölçüldü: 0 maç). Beşinci bir
// karşılaştırma yazmak yerine fikstür boru hattının kullandığı yardımcıyı
// kullanıyoruz.
const { sameCountry } = require("../lib/fixture-priority.cjs");
const WalletCredit = require("../lib/wallet-credit.cjs");
const UsersStore = require("../lib/users-store.cjs");

const getDb = (req) => req?.app?.locals?.db || null;

/* ── Hafta anahtarı (ISO) ────────────────────────────────────────────────── */

/**
 * ⚠️ tr-league'den taşındı. Orada yerel bir fonksiyondu; kupon da aynı hafta
 * tanımını kullanmak zorunda, ikinci bir kopya sapma demekti (bu oturumda
 * açılış bakiyesi dört adla tanımlıydı, aynı sınıf).
 */
function isoHaftaKey(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const gun = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - gun);
  const yilBasi = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const hafta = Math.ceil(((t - yilBasi) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(hafta).padStart(2, "0")}`;
}

/** Avrupa kupası maçı mı? (kupon türünü ayırmak için) */
const AVRUPA_RE = /champions\s*league|europa\s*league|conference\s*league|uefa/i;
const avrupaMaci = (fx) =>
  AVRUPA_RE.test(String(fx?.league || "")) || /^(world|europe)$/i.test(String(fx?.country || ""));

/* ── Kupon kurma ─────────────────────────────────────────────────────────── */

/**
 * Verilen hafta için maçları seçer.
 * ⚠️ Maçlar KICKOFF'A GÖRE sıralanıp baştan alınır — "haftanın ilk N maçı"
 * deterministik olsun; rastgele seçim her çağrıda farklı kupon üretirdi.
 */
function maclariSec(hepsi, { tur, ulke, haftaKey, adet }) {
  const simdi = Date.now();
  const uygun = (hepsi || []).filter((f) => {
    const ko = new Date(f?.kickoffISO || f?.kickoffDate || "").getTime();
    if (!Number.isFinite(ko) || ko <= simdi) return false;      // geçmiş maç kupona girmez
    if (isoHaftaKey(new Date(ko).toISOString()) !== haftaKey) return false;
    return tur === Kupon.TUR.AVRUPA
      ? avrupaMaci(f)
      : !avrupaMaci(f) && sameCountry(f.country, ulke);
  });
  uygun.sort((a, b) =>
    new Date(a.kickoffISO || a.kickoffDate).getTime() -
    new Date(b.kickoffISO || b.kickoffDate).getTime());
  return uygun.slice(0, adet);
}

async function kuponKur({ tur, ulke, haftaKey }, db) {
  const adet = Kupon.MAC_SAYISI[tur];
  const hepsi = await FixturesStore.loadAll(db);
  const maclar = maclariSec(hepsi, { tur, ulke, haftaKey, adet });

  // ⚠️ EKSİK KUPON KURULMAZ. Yarım kupon (5/8) hem puanlamayı hem ödül
  // oranlarını bozar; oran bazlı kademeler maç sayısına duyarlı.
  if (maclar.length < adet) {
    return { ok: false, reason: "YETERSIZ_MAC", bulunan: maclar.length, gereken: adet };
  }

  const ilkKickoff = maclar[0].kickoffISO || maclar[0].kickoffDate;
  // Katılım ilk maçtan KILIT_ONCE_DK dakika önce kapanır (bkz. lib/kupon.cjs).
  const kilitMs = new Date(ilkKickoff).getTime() - Kupon.KILIT_ONCE_DK * 60 * 1000;
  const kupon = {
    id: `kp_${tur}_${ulke || "AVRUPA"}_${haftaKey}`.replace(/\s+/g, "-"),
    tur, ulke: ulke ?? null, haftaKey,
    fixtureIds: maclar.map((m) => String(m.fixtureId)),
    maclar: maclar.map((m) => ({
      fixtureId: String(m.fixtureId), home: m.home, away: m.away,
      kickoffISO: m.kickoffISO || m.kickoffDate, league: m.league || null,
    })),
    girisBedeli: Kupon.GIRIS_BEDELI[tur],
    ilkKickoffISO: ilkKickoff,
    kilitISO: new Date(kilitMs).toISOString(),
    durum: "open",
    olusturulduAt: new Date().toISOString(),
  };
  return Store.kuponOlustur(kupon, db);
}

/** Kilit saati geçtiyse kuponu kapat (tembel kilitleme). */
async function kilidiUygula(kupon, db) {
  if (!kupon || kupon.durum !== "open") return kupon;
  if (Date.now() < new Date(kupon.kilitISO).getTime()) return kupon;
  await Store.kuponKilitle(kupon.id, db);
  return { ...kupon, durum: "locked" };
}

/* ── Uçlar ───────────────────────────────────────────────────────────────── */

/**
 * GET /api/kupon/aktif
 * Oyuncunun ülke kuponu + herkese ortak Avrupa kuponu.
 */
router.get("/aktif", verifyToken, async (req, res) => {
  try {
    const db = getDb(req);
    const uid = String(req.uid || "").trim();
    const kul = await UsersStore.getUser(uid, db).catch(() => null);
    const ulke = kul?.country || null;

    const cikti = { ok: true, ulke, kuponlar: [] };
    for (const [tur, u] of [[Kupon.TUR.ULKE, ulke], [Kupon.TUR.AVRUPA, null]]) {
      if (tur === Kupon.TUR.ULKE && !ulke) continue;   // ülkesi yoksa ülke kuponu yok
      let k = await Store.acikKupon({ tur, ulke: u }, db);
      if (k) k = await kilidiUygula(k, db);
      if (!k) continue;
      const katilim = await Store.katilimGetir(k.id, uid, db);
      cikti.kuponlar.push({
        ...k,
        katildiMi: !!katilim,
        tahminlerim: katilim?.tahminler || null,
        kalanSaniye: Math.max(0, Math.round((new Date(k.kilitISO).getTime() - Date.now()) / 1000)),
      });
    }
    res.json(cikti);
  } catch (e) {
    res.status(500).json({ ok: false, error: "KUPON_AKTIF_FAILED", detail: String(e?.message || e) });
  }
});

/**
 * POST /api/kupon/katil  { kuponId }
 *
 * ⚠️ SIRA BİLİNÇLİ: ÖNCE TAHSİLAT, SONRA KATILIM KAYDI. Kayıt benzersiz
 * indekse takılırsa (zaten katılmış) ücret İADE EDİLİR. Tersi sırada kayıt
 * atılıp tahsilat başarısız olsa oyuncu bedava katılmış olurdu — aynı ikilem
 * düello kabulünde de vardı ve orada da bu sıra seçildi.
 */
router.post("/katil", verifyToken, express.json(), async (req, res) => {
  try {
    const db = getDb(req);
    if (!db) return res.status(503).json({ ok: false, error: "NO_DB" });
    const uid = String(req.uid || "").trim();
    const kuponId = String(req.body?.kuponId || "").trim();
    if (!kuponId) return res.status(400).json({ ok: false, error: "KUPON_ID_REQUIRED" });

    let kupon = await Store.kuponGetir(kuponId, db);
    if (!kupon) return res.status(404).json({ ok: false, error: "KUPON_NOT_FOUND" });
    kupon = await kilidiUygula(kupon, db);
    if (kupon.durum !== "open") {
      return res.status(409).json({ ok: false, error: "KUPON_KAPALI", kilitISO: kupon.kilitISO });
    }

    const bedel = Number(kupon.girisBedeli || 0);
    const harcama = await WalletCredit.spendLc(db, uid, bedel, "kupon_giris", { kuponId });
    if (!harcama.ok) {
      return res.status(400).json({
        ok: false,
        error: harcama.reason === "INSUFFICIENT" ? "INSUFFICIENT_LC" : "ENTRY_CHARGE_FAILED",
        lc: harcama.lc, needed: bedel,
      });
    }

    const kayit = await Store.katilimEkle({
      kuponId, userId: uid, tur: kupon.tur, ulke: kupon.ulke ?? null,
      haftaKey: kupon.haftaKey, odenen: bedel,
      tahminler: {}, katildiAt: new Date().toISOString(), sonuclandiMi: false,
    }, db);

    if (!kayit.ok) {
      // Katılım yazılamadı → parayı geri ver. Sessiz kalma: iade de
      // başarısız olursa borç doğar (bkz. lib/wallet-credit kayipOdulKaydet).
      const iade = await WalletCredit.creditLc(db, uid, bedel, "kupon_giris_iade", { kuponId });
      if (!iade) {
        console.error(`[kupon] IADE EDILEMEDI kupon=${kuponId} kullanici=${uid} tutar=${bedel}`);
        await WalletCredit.kayipOdulKaydet(db, {
          kaynak: "kupon_giris_iade", kuponId,
          odemeler: [{ userIdLower: uid.toLowerCase(), tutar: bedel }], beklenen: 1, eksik: 1,
        });
      }
      const kod = kayit.reason === "ALREADY_JOINED" ? 409 : 500;
      return res.status(kod).json({ ok: false, error: kayit.reason });
    }

    res.json({ ok: true, kuponId, odenen: bedel, lc: harcama.lc });
  } catch (e) {
    res.status(500).json({ ok: false, error: "KUPON_KATIL_FAILED", detail: String(e?.message || e) });
  }
});

/**
 * POST /api/kupon/tahmin  { kuponId, tahminler: { fixtureId: "H"|"D"|"A" } }
 * Kupon açıkken istenildiği kadar güncellenebilir.
 */
router.post("/tahmin", verifyToken, express.json(), async (req, res) => {
  try {
    const db = getDb(req);
    const uid = String(req.uid || "").trim();
    const kuponId = String(req.body?.kuponId || "").trim();
    const gelen = req.body?.tahminler || {};
    if (!kuponId) return res.status(400).json({ ok: false, error: "KUPON_ID_REQUIRED" });

    let kupon = await Store.kuponGetir(kuponId, db);
    if (!kupon) return res.status(404).json({ ok: false, error: "KUPON_NOT_FOUND" });
    kupon = await kilidiUygula(kupon, db);
    if (kupon.durum !== "open") {
      return res.status(409).json({ ok: false, error: "KUPON_KAPALI" });
    }

    // ⚠️ YALNIZCA KUPONDAKİ MAÇLAR ve yalnızca geçerli sonuçlar. Aksi hâlde
    // istemci uydurma fixtureId gönderip puanlamayı bozabilirdi.
    const izinli = new Set(kupon.fixtureIds.map(String));
    const temiz = {};
    for (const [fid, deger] of Object.entries(gelen)) {
      if (!izinli.has(String(fid))) continue;
      const d = String(deger || "").toUpperCase();
      if (!["H", "D", "A"].includes(d)) continue;
      temiz[String(fid)] = d;
    }

    const r = await Store.tahminleriYaz(kuponId, uid, temiz, db);
    if (!r.ok) return res.status(409).json({ ok: false, error: r.reason });

    res.json({ ok: true, kuponId, tahminler: temiz, eksik: kupon.fixtureIds.length - Object.keys(temiz).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: "KUPON_TAHMIN_FAILED", detail: String(e?.message || e) });
  }
});

/** GET /api/kupon/tablo?kuponId= — sıralama (sonuçlanmışsa puanlı). */
router.get("/tablo", async (req, res) => {
  try {
    const db = getDb(req);
    const kuponId = String(req.query.kuponId || "").trim();
    if (!kuponId) return res.status(400).json({ ok: false, error: "KUPON_ID_REQUIRED" });
    const kupon = await Store.kuponGetir(kuponId, db);
    if (!kupon) return res.status(404).json({ ok: false, error: "KUPON_NOT_FOUND" });

    const hepsi = await Store.katilimlar(kuponId, db);
    // ⚠️ KUPON AÇIKKEN TAHMİNLER GİZLİ. Aksi hâlde tablodan rakiplerin
    // seçimleri okunur — bu oturumda aynı sızıntı /pred/my'de bulundu.
    const acik = kupon.durum === "open";
    const satirlar = hepsi
      .map((k) => ({
        userId: k.userId,
        dogru: k.dogru ?? null,
        puan: k.puan ?? null,
        odulLc: k.odulLc ?? null,
        ...(acik ? {} : { tahminler: k.tahminler || {} }),
      }))
      .sort((a, b) => (b.puan ?? -1) - (a.puan ?? -1) || String(a.userId).localeCompare(String(b.userId)));

    res.json({ ok: true, kupon: { ...kupon, tahminlerGizli: acik }, katilimci: hepsi.length, tablo: satirlar });
  } catch (e) {
    res.status(500).json({ ok: false, error: "KUPON_TABLO_FAILED", detail: String(e?.message || e) });
  }
});

/** GET /api/kupon/benim — oyuncunun katılımları. */
router.get("/benim", verifyToken, async (req, res) => {
  try {
    const db = getDb(req);
    const liste = await Store.oyuncuKatilimlari(String(req.uid || ""), db);
    res.json({ ok: true, count: liste.length, katilimlar: liste });
  } catch (e) {
    res.status(500).json({ ok: false, error: "KUPON_BENIM_FAILED", detail: String(e?.message || e) });
  }
});

/**
 * POST /api/kupon/olustur  { tur, ulke?, haftaKey? }  — YÖNETİCİ
 * Haftalık kuponları kurar. İdempotent: aynı hafta+tür+ülke için ikinci çağrı
 * mevcudu döner.
 */
router.post("/olustur", requireAdmin, express.json(), async (req, res) => {
  try {
    const db = getDb(req);
    if (!db) return res.status(503).json({ ok: false, error: "NO_DB" });
    const tur = String(req.body?.tur || Kupon.TUR.ULKE);
    if (!Object.values(Kupon.TUR).includes(tur)) {
      return res.status(400).json({ ok: false, error: "GECERSIZ_TUR" });
    }
    const ulke = tur === Kupon.TUR.ULKE ? String(req.body?.ulke || "").trim() : null;
    if (tur === Kupon.TUR.ULKE && !ulke) {
      return res.status(400).json({ ok: false, error: "ULKE_REQUIRED" });
    }
    const haftaKey = String(req.body?.haftaKey || isoHaftaKey(new Date().toISOString()));

    const r = await kuponKur({ tur, ulke, haftaKey }, db);
    if (!r.ok) return res.status(400).json({ ok: false, ...r });
    res.json({ ok: true, yeni: r.yeni, kupon: r.kupon });
  } catch (e) {
    res.status(500).json({ ok: false, error: "KUPON_OLUSTUR_FAILED", detail: String(e?.message || e) });
  }
});

/**
 * POST /api/kupon/sonuclandir  — YÖNETİCİ (elle tetikleme).
 * Normal akışta gerek yok: settle2 her maç sonuçlandığında tarıyor.
 */
router.post("/sonuclandir", requireAdmin, express.json(), async (req, res) => {
  try {
    const db = getDb(req);
    if (!db) return res.status(503).json({ ok: false, error: "NO_DB" });
    const KuponSettle = require("../lib/kupon-settle.cjs");
    const r = await KuponSettle.bekleyenleriSonuclandir(db);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: "KUPON_SONUCLANDIR_FAILED", detail: String(e?.message || e) });
  }
});

/**
 * GET /api/kupon/siralama?tur=ulke|avrupa&ulke=&hafta=2026-W
 *
 * KÜMÜLATİF kupon sıralaması — sonuçlanmış tüm kuponların toplamı.
 * Açık uç: tablo herkese görünür (tahmin içeriği DEĞİL, yalnızca sonuçlar).
 *
 * ⚠️ Varsayılan olarak İÇİNDE BULUNULAN SEZONLA sınırlı. Sonsuza kadar
 * biriken bir tablo, ana sıralama her ay sıfırlanırken ikisini ayrıştırır ve
 * yeni oyuncu asla yetişemez.
 */
router.get("/siralama", async (req, res) => {
  try {
    const db = getDb(req);
    const tur = req.query.tur ? String(req.query.tur) : null;
    if (tur && !Object.values(Kupon.TUR).includes(tur)) {
      return res.status(400).json({ ok: false, error: "GECERSIZ_TUR" });
    }
    const ulke = req.query.ulke ? String(req.query.ulke).trim() : null;
    // "2026-07" sezonundan "2026-W" ön eki: yıl aynı, hafta anahtarı yıl+W.
    const Season = require("../lib/season.cjs");
    const varsayilanOnEk = `${Season.seasonKey().slice(0, 4)}-W`;
    const hafta = req.query.hafta ? String(req.query.hafta) : varsayilanOnEk;

    const satirlar = await Store.siralama(
      { tur, ulke, haftaOnEk: hafta, limit: Number(req.query.limit) || 200 }, db);

    res.json({
      ok: true,
      tur: tur || "hepsi",
      ulke: ulke || null,
      haftaOnEk: hafta,
      count: satirlar.length,
      siralama: satirlar.map((r, i) => ({
        sira: i + 1,
        userId: r.userId || r._id,
        toplamPuan: Math.round((r.toplamPuan || 0) * 10) / 10,
        kuponSayisi: r.kuponSayisi || 0,
        toplamDogru: r.toplamDogru || 0,
        toplamMac: r.toplamMac || 0,
        isabetYuzde: r.toplamMac ? Math.round((r.toplamDogru / r.toplamMac) * 100) : 0,
        tamKupon: r.tamKupon || 0,
        toplamOdul: r.toplamOdul || 0,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "KUPON_SIRALAMA_FAILED", detail: String(e?.message || e) });
  }
});

module.exports = router;
module.exports._isoHaftaKey = isoHaftaKey;
module.exports._maclariSec = maclariSec;
module.exports._kuponKur = kuponKur;
