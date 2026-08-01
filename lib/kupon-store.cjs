"use strict";

/**
 * HAFTALIK KUPON DEPOSU — Mongo birincil.
 *
 * İKİ KOLEKSİYON:
 *   kuponlar        → kupon tanımı (hafta, tür, ülke, maçlar, kilit saati)
 *   kupon_katilim   → oyuncu başına KATILIM (tahminler, ödeme, sonuç)
 *
 * ⚠️ KATILIM AYRI BELGEDE. Katılımcıları kuponun içine gömmek iki sorun
 * doğururdu: 16MB belge sınırı (bir ülke kuponunda binlerce oyuncu olabilir)
 * ve "tümünü oku → birini değiştir → tümünü yaz" deseni — bu oturumda o desen
 * defalarca yarış koşulu üretti (bkz. lib/social-store.cjs notları).
 *
 * ⚠️ DOSYA AYNASI YOK. Bu yeni bir oyun; hiç dosya çağı olmadı. Render'da
 * kalıcı disk bulunmadığı için dosyaya yazmak zaten kayıp demekti.
 */

const COLL_KUPON = "kuponlar";
const COLL_KATILIM = "kupon_katilim";

async function getDbSafe(db) {
  if (db) return db;
  try {
    const { getDb } = require("./mongo.cjs");
    return await getDb();
  } catch {
    return null;
  }
}

const lower = (x) => String(x || "").trim().toLowerCase();

// bkz. diğer depolar: BAYRAK DEĞİL SÖZ önbeklenir. Bayrak `await createIndex`
// bitmeden kalkarsa eşzamanlı ikinci çağrı indeks HENÜZ YOKKEN upsert yapar ve
// kopya belge oluşur — para korumaları benzersizliğe dayandığı için kritik.
let _indexPromise = null;
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      await db.collection(COLL_KUPON).createIndex({ id: 1 }, { unique: true, background: true });
      // Aynı hafta + tür + ülke için TEK kupon olmalı; ikinci bir kupon
      // oyuncuyu iki kez ödetir ve tabloyu böler.
      await db.collection(COLL_KUPON).createIndex(
        { haftaKey: 1, tur: 1, ulke: 1 }, { unique: true, background: true }
      );
      await db.collection(COLL_KUPON).createIndex({ durum: 1 }, { background: true });

      // ⚠️ PARA KORUMASI: bir oyuncu bir kupona BİR KEZ katılır. Benzersizlik
      // olmazsa aynı kişi iki kez ödeyip iki kez ödül alabilir.
      await db.collection(COLL_KATILIM).createIndex(
        { kuponId: 1, userIdLower: 1 }, { unique: true, background: true }
      );
      await db.collection(COLL_KATILIM).createIndex({ userIdLower: 1 }, { background: true });
    } catch (e) {
      console.error("[kupon-store] indeks kurulamadi:", e?.message || e);
    }
  })();
  return _indexPromise;
}

const strip = (d) => {
  if (!d) return null;
  const { _id, ...rest } = d;
  return rest;
};

/* ── Kupon ───────────────────────────────────────────────────────────────── */

/** Kuponu oluşturur; aynı hafta+tür+ülke varsa MEVCUDU döner (idempotent). */
async function kuponOlustur(kupon, db) {
  const conn = await getDbSafe(db);
  if (!conn) return { ok: false, reason: "NO_DB" };
  await ensureIndexes(conn);
  try {
    await conn.collection(COLL_KUPON).insertOne(kupon);
    return { ok: true, kupon: strip(kupon), yeni: true };
  } catch (e) {
    if (e?.code === 11000) {
      const mevcut = await conn.collection(COLL_KUPON).findOne({
        haftaKey: kupon.haftaKey, tur: kupon.tur, ulke: kupon.ulke ?? null,
      });
      return { ok: true, kupon: strip(mevcut), yeni: false };
    }
    console.error("[kupon-store] kupon olusturulamadi:", e?.message || e);
    return { ok: false, reason: "WRITE_FAILED" };
  }
}

async function kuponGetir(id, db) {
  const conn = await getDbSafe(db);
  if (!conn) return null;
  await ensureIndexes(conn);
  return strip(await conn.collection(COLL_KUPON).findOne({ id: String(id || "") }));
}

/** Belirli tür/ülke için AÇIK kupon (kilit saati geçmemiş). */
async function acikKupon({ tur, ulke = null }, db) {
  const conn = await getDbSafe(db);
  if (!conn) return null;
  await ensureIndexes(conn);
  const d = await conn.collection(COLL_KUPON).findOne({
    tur, ulke: ulke ?? null, durum: "open",
  });
  return strip(d);
}

/** Sonuçlanmayı bekleyen kuponlar (settle taraması için). */
async function bekleyenKuponlar(db) {
  const conn = await getDbSafe(db);
  if (!conn) return [];
  await ensureIndexes(conn);
  const d = await conn.collection(COLL_KUPON).find({ durum: { $in: ["open", "locked"] } }).toArray();
  return d.map(strip);
}

/**
 * ⚠️ KUPONU ATOMİK MÜHÜRLE SONUÇLANDIR.
 * Koşul (`durum` hâlâ settled değil) yazmanın İÇİNDE — settle taraması
 * zamanlayıcıdan ve elle çağrıdan tetiklenebiliyor; iki çağrı da geçerse
 * ödül İKİ KEZ dağıtılır. Aynı ilke claimAward/claimTournamentSettle'da.
 */
async function kuponMuhurle(id, alanlar, db) {
  const conn = await getDbSafe(db);
  if (!conn) return false;
  await ensureIndexes(conn);
  try {
    const r = await conn.collection(COLL_KUPON).updateOne(
      { id: String(id || ""), durum: { $ne: "settled" } },
      { $set: { ...alanlar, durum: "settled" } }
    );
    return !!r.modifiedCount;
  } catch (e) {
    console.error("[kupon-store] muhur alinamadi:", e?.message || e);
    return false;
  }
}

/** Kilit saati geçen kuponu "locked" yapar (katılım kapanır). */
async function kuponKilitle(id, db) {
  const conn = await getDbSafe(db);
  if (!conn) return false;
  await ensureIndexes(conn);
  const r = await conn.collection(COLL_KUPON).updateOne(
    { id: String(id || ""), durum: "open" },
    { $set: { durum: "locked", kilitlendiAt: new Date().toISOString() } }
  );
  return !!r.modifiedCount;
}

/* ── Katılım ─────────────────────────────────────────────────────────────── */

/**
 * ⚠️ ATOMİK KATILIM. Benzersiz indeks (kuponId+userIdLower) sayesinde ikinci
 * katılım denemesi 11000 ile düşer — yani oyuncu İKİ KEZ ÖDEYEMEZ.
 * Çağıran ücreti bu fonksiyon TRUE döndükten SONRA tahsil etmeli değil,
 * ÖNCE tahsil edip başarısızlıkta iade etmeli (bkz. routes/kupon.cjs notu).
 *
 * @returns {{ok:boolean, reason?:string}}
 */
async function katilimEkle(katilim, db) {
  const conn = await getDbSafe(db);
  if (!conn) return { ok: false, reason: "NO_DB" };
  await ensureIndexes(conn);
  try {
    await conn.collection(COLL_KATILIM).insertOne({
      ...katilim,
      userIdLower: lower(katilim.userId),
    });
    return { ok: true };
  } catch (e) {
    if (e?.code === 11000) return { ok: false, reason: "ALREADY_JOINED" };
    console.error("[kupon-store] katilim eklenemedi:", e?.message || e);
    return { ok: false, reason: "WRITE_FAILED" };
  }
}

async function katilimGetir(kuponId, userId, db) {
  const conn = await getDbSafe(db);
  if (!conn) return null;
  await ensureIndexes(conn);
  return strip(await conn.collection(COLL_KATILIM).findOne({
    kuponId: String(kuponId || ""), userIdLower: lower(userId),
  }));
}

/** Kuponun tüm katılımları (tablo ve sonuçlandırma için). */
async function katilimlar(kuponId, db) {
  const conn = await getDbSafe(db);
  if (!conn) return [];
  await ensureIndexes(conn);
  const d = await conn.collection(COLL_KATILIM).find({ kuponId: String(kuponId || "") }).toArray();
  return d.map(strip);
}

/** Oyuncunun katılımları (en yeniden eskiye). */
async function oyuncuKatilimlari(userId, db, limit = 20) {
  const conn = await getDbSafe(db);
  if (!conn) return [];
  await ensureIndexes(conn);
  const d = await conn.collection(COLL_KATILIM)
    .find({ userIdLower: lower(userId) })
    .sort({ katildiAt: -1 }).limit(limit).toArray();
  return d.map(strip);
}

/**
 * Tahminleri günceller — YALNIZCA kupon açıkken çağrılmalı (çağıran kontrol
 * eder; burada da koşul filtreye konuyor ki yarış olmasın).
 */
async function tahminleriYaz(kuponId, userId, tahminler, db) {
  const conn = await getDbSafe(db);
  if (!conn) return { ok: false, reason: "NO_DB" };
  await ensureIndexes(conn);
  const r = await conn.collection(COLL_KATILIM).updateOne(
    { kuponId: String(kuponId || ""), userIdLower: lower(userId), sonuclandiMi: { $ne: true } },
    { $set: { tahminler, guncellendiAt: new Date().toISOString() } }
  );
  if (!r.matchedCount) return { ok: false, reason: "NOT_JOINED_OR_SETTLED" };
  return { ok: true };
}

/** Sonuçlandırma sonrası katılım kaydına puan/ödül yazar. */
async function katilimSonucYaz(kuponId, userId, sonuc, db) {
  const conn = await getDbSafe(db);
  if (!conn) return false;
  const r = await conn.collection(COLL_KATILIM).updateOne(
    { kuponId: String(kuponId || ""), userIdLower: lower(userId) },
    { $set: { ...sonuc, sonuclandiMi: true } }
  );
  return !!r.modifiedCount;
}

/**
 * KÜMÜLATİF SIRALAMA — sonuçlanmış tüm kuponların toplamı.
 *
 * ⚠️ SEZONA GÖRE SÜZÜLÜR. Sezon aylık (bkz. lib/season.cjs) ve ana tablo her
 * ay sıfırlanıyor; kupon sıralaması sonsuza kadar birikirse ikisi ayrışır ve
 * yeni oyuncu asla yetişemez.
 *
 * ⚠️ SIRALAMA PUANA GÖRE, ÖDÜLE DEĞİL. Ödül LC'dir ve harcanabilir; sıralama
 * beceriyi göstermeli. `toplamOdul` yalnızca bilgi olarak dönüyor.
 *
 * @param {"ulke"|"avrupa"|null} tur  null ise her ikisi
 * @param {string|null} ulke          ülke kuponları için (avrupa'da yok sayılır)
 */
async function siralama({ tur = null, ulke = null, haftaOnEk = null, limit = 200 }, db) {
  const conn = await getDbSafe(db);
  if (!conn) return [];
  await ensureIndexes(conn);

  const eslesme = { sonuclandiMi: true };
  if (tur) eslesme.tur = tur;
  if (tur === "ulke" && ulke) eslesme.ulke = ulke;
  /* Sezon süzgeci hafta anahtarının ön ekiyle ("2026-W" gibi) — kupon
   * belgesinde sezon alanı yok, hafta var.
   *
   * ⚠️ REGEX KAÇIŞI YERİNE BEYAZ LİSTE: ön ek dışarıdan gelebiliyor ve
   * kaçırılmamış bir regex hem hatalı sonuç hem ReDoS riski demek. Yalnızca
   * rakam, harf ve tire kabul ediliyor; başka bir şey gelirse süzgeç hiç
   * uygulanmıyor (sessizce yanlış sonuç dönmesindense süzgeçsiz dön). */
  const onEk = String(haftaOnEk || "");
  if (onEk && /^[A-Za-z0-9-]{1,16}$/.test(onEk)) {
    eslesme.haftaKey = { $regex: `^${onEk}` };
  }

  try {
    return await conn.collection(COLL_KATILIM).aggregate([
      { $match: eslesme },
      {
        $group: {
          _id: "$userIdLower",
          userId: { $last: "$userId" },
          toplamPuan: { $sum: { $ifNull: ["$puan", 0] } },
          toplamDogru: { $sum: { $ifNull: ["$dogru", 0] } },
          toplamMac: { $sum: { $ifNull: ["$toplam", 0] } },
          toplamOdul: { $sum: { $ifNull: ["$odulLc", 0] } },
          kuponSayisi: { $sum: 1 },
          /* ⚠️ "TAM KUPON" ROZETİ ÖNCE HERKESE DAĞILIYORDU.
           *
           * Koşul yalnızca `dogru == toplam` idi. İade edilen kupon
           * (`lib/kupon-settle.cjs iadeEt`) katılım kaydına tam olarak
           * `dogru: 0, toplam: 0` yazıyor — sıfır sıfıra eşit olduğu için
           * PUANLANMAMIŞ bir kupon "tam kupon" sayılıyordu. Alanları hiç
           * olmayan eski kayıtlarda da `$eq` iki eksik alanı eşit sayıyor.
           *
           * ÖLÇÜLDÜ (7 katılım, 1'i gerçekten 8/8): rozet 5 kez veriliyordu.
           * Hiç puan almamış bir oyuncu tabloda "3 tam kupon 🎯" ile
           * görünüyordu — rozet mobil sıralamada gösteriliyor
           * (mobile/app/(tabs)/stats.tsx).
           *
           * Kural: puanlanmış olmalı (toplam > 0) VE hepsi tutmuş olmalı. */
          tamKupon: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: [{ $ifNull: ["$toplam", 0] }, 0] },
                    { $eq: [{ $ifNull: ["$dogru", -1] }, { $ifNull: ["$toplam", 0] }] },
                  ],
                },
                1, 0,
              ],
            },
          },
          sonKatilim: { $max: "$sonuclandiAt" },
        },
      },
      { $sort: { toplamPuan: -1, toplamDogru: -1, _id: 1 } },
      { $limit: Math.max(1, Math.min(Number(limit) || 200, 1000)) },
    ]).toArray();
  } catch (e) {
    console.error("[kupon-store] siralama okunamadi:", e?.message || e);
    return [];
  }
}

module.exports = {
  COLL_KUPON, COLL_KATILIM,
  siralama,
  kuponOlustur, kuponGetir, acikKupon, bekleyenKuponlar, kuponMuhurle, kuponKilitle,
  katilimEkle, katilimGetir, katilimlar, oyuncuKatilimlari, tahminleriYaz, katilimSonucYaz,
};
