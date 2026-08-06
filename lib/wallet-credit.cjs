"use strict";

/**
 * CÜZDANA LC YATIRMA — tek yer.
 *
 * NEDEN VAR (canlı para hatası, 2026-07-28'de bulundu): mini turnuva,
 * TR-Lig ve haftalık seçim ödülleri LC'yi YALNIZCA dosyalara yazıyordu
 * (users.json + lc-wallet.json). Bakiye ise SKORLIG_WALLET_FILE_MIRROR=0
 * ile birlikte Mongo'dan (`lc_wallet_users`) okunuyor. Sonuç: kullanıcı
 * turnuvayı kazanıyor, ödül kimsenin okumadığı bir dosyaya yazılıyor,
 * bakiyesi artmıyor. Hata da üretilmiyor.
 *
 * settle2 doğru deseni zaten uyguluyordu ama kod oraya gömülüydü; kopyalamak
 * yerine buraya çıkarıldı — dördüncü bir ödül yolu eklendiğinde aynı tuzağa
 * düşülmesin.
 *
 * `$inc` GÖRELİ çalışır: dosyadan okunan bir değere dayanmaz, bu yüzden ayna
 * kapalıyken de doğrudur ve eşzamanlı ödüller birbirini ezmez.
 */

const COLL_USERS = "lc_wallet_users";

/** Yeni cuzdanin acilis bakiyesi (spendLc ile ayni varsayilan). */
const { ACILIS_BAKIYESI: ACILIS_VARSAYILAN, BONUS_1987_TAVAN } = require("./ekonomi.cjs");
const COLL_LEDGER = "lc_wallet_ledger";

/**
 * ⚠️ BENZERSİZ İNDEKS = PARA KORUMASI, sadece hız değil.
 *
 * Aşağıdaki yazımların hepsi `upsert:true` ile `{userIdLower}` üzerinden
 * gidiyor. MongoDB'de benzersiz indeks YOKKEN iki eşzamanlı upsert eşleşme
 * bulamazsa İKİSİ DE ekler — aynı kullanıcıya iki cüzdan belgesi.
 *
 * Ölçüldü (aynı yeni kullanıcıya 40 eşzamanlı creditLc(+5), bellek-içi Mongo):
 *     indekssiz : 2 belge · bakiyeler [195, 5] · toplam 200
 *     indeksli  : 1 belge · bakiye   [200]     · toplam 200
 * Toplam doğru ama bölünmüş. `findOne` birini döndürdüğü için kullanıcı 200
 * yerine 5 LC görür, defter 200 yatırıldığını yazar; sonraki `$inc`'ler de
 * yalnızca bir belgeyi büyütür. Sessiz para kaybı.
 *
 * ⚠️ BAYRAK DEĞİL SÖZ (promise) önbelleklenir — diğer depolarda bu hata
 * yapılmıştı: bayrak `await createIndex` bitmeden kalkınca eşzamanlı ikinci
 * çağrı "indeks hazır" sanıp indeks HENÜZ YOKKEN upsert yapıyordu, yani
 * korumanın kendisi yarışa açıktı.
 */
let _indexPromise = null;
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      await db.collection(COLL_USERS).createIndex(
        { userIdLower: 1 },
        { unique: true, background: true }
      );
      await db.collection(COLL_LEDGER).createIndex({ userIdLower: 1, createdAt: -1 }, { background: true });
    } catch (e) {
      // Sessiz kalmıyoruz: indeks yoksa yukarıdaki bölünme yeniden mümkün.
      console.error("[wallet-credit] indeks kurulamadi (KOPYA CUZDAN RISKI):", e?.message || e);
      /* ⚠️ GECICI ARIZADA ONBELLEGI DUSUR — yoksa hata KALICI olur.
      * Soz bir kez cozulunce ensureIndexes bir daha hic denemez; tek bir
      * gecici Mongo hatasi indeksleri SUREC BOYUNCA kurulmamis birakir.
      * OLCULDU (gercek pool-store, ilk createIndex cagrisi patlatildi):
      *   indeks: hicbiri  ->  ayni kullanici ayni maca IKI bahis yazabildi
      * Yani kaybolan yalnizca hiz degil, BENZERSIZLIK GARANTISI. */
      _indexPromise = null;
    }
  })();
  return _indexPromise;
}

/**
 * ÖDENEMEYEN ÖDÜLÜ KALICI OLARAK KAYDET.
 *
 * ⚠️ NEDEN VAR: para dağıtan yolların hepsi "önce mühürle, sonra öde"
 * deseninde. Bu, çift ödemeyi engeller (doğru sıra) ama ters riski vardır:
 * ödeme başarısız olursa mühür atılmış olduğu için TEKRAR DENENMEZ ve ödül
 * kalıcı olarak kaybolur.
 *
 * Eskiden bu durumlarda yalnızca `console.error` vardı. Render'da log akıp
 * gider; kimsenin bakmadığı bir satır kaybolmuş parayı geri getirmez.
 *
 * Kayıt `failed_awards` koleksiyonuna düşer ve `GET /api/health` bunu sayar —
 * sıfırdan büyükse elle telafi edilecek PARA var demektir.
 *
 * ⚠️ Kendi hatasıyla çağıranı düşürmez: kayıt yazılamazsa ayırt edilebilir
 * bir işaretle log'a basar ve sessizce döner.
 */
async function kayipOdulKaydet(db, kayit) {
  if (!db) {
    console.error("[wallet] ⛔ ODENEMEYEN ODUL (db yok):", JSON.stringify(kayit));
    return false;
  }
  try {
    await db.collection("failed_awards").insertOne({
      createdAt: new Date().toISOString(),
      ...kayit,
    });
    return true;
  } catch (e) {
    console.error("[wallet] ⛔⛔ FAILED_AWARDS KAYDI YAZILAMADI:", e?.message || e,
      JSON.stringify(kayit));
    return false;
  }
}

function txId() {
  return "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/* ─── KAYAN NOKTA SERTLEŞTİRMESİ ─────────────────────────────────────────────
 *
 * ⚠️ NEDEN VAR (2026-08-05 ölçüldü): bakiye `$inc: { balance: tutar }` ile
 * büyütülüyordu ve HİÇ yuvarlanmıyordu. Kesirli bir ödül tekrar tekrar
 * yatınca IEEE754 artığı BİRİKİYOR — ve `$inc` göreli olduğu için artık
 * belgede KALICI hâle geliyor:
 *
 *     düello ödülü 1.9 × 20 kredi        → 37.999999999999986
 *     mini turnuva payı 6.6 × 50 kredi   → 330.0000000000001
 *
 * Düello tarafı kaynağında düzeltildi (ödüller artık tam sayı, bkz.
 * lib/duello-kesinti.cjs) ama bu YETMEZ: mini turnuva payı hâlâ 0.1
 * adımlarında (`Math.floor((MINI_WIN_LC / n) * 10) / 10` — n=1..20 aralığında
 * 13'ü kesirli) ve eklenecek her yeni ödül yolu aynı tuzağa yeniden düşebilir.
 * Kaynakları tek tek temizlemek, kuralı her yeni yolda yeniden hatırlamayı
 * gerektirir; SINIR burada kapatılırsa hatırlamaya gerek kalmaz.
 *
 * İKİ KATMAN:
 *   1) TUTAR normalleştiriliyor — defterde `0.30000000000000004` yazamayız.
 *   2) BAKİYE her yazımda yuvarlanıyor. Bu, `$inc`in yerine toplama+`$round`
 *      yapan bir TOPLU İŞ HATTI (aggregation pipeline) güncellemesiyle
 *      sunucu tarafında yapılıyor.
 *
 * ⚠️ NİYE HÂLÂ ATOMİK. `$inc`i "oku → hesapla → yaz"a çevirmek eşzamanlı
 * ödülleri birbirine ezdirirdi — dosya kodunun tam da bu yüzden terk edilen
 * deseni. İş hattı güncellemesi toplamayı SUNUCUDA, tek belge üzerinde ve tek
 * işlemde yapıyor: `$inc` gibi göreli, `$inc` gibi yarışa kapalı. Dosya aynası
 * kapalıyken de doğru kalıyor.
 *
 * ⚠️ ARTIK YALNIZCA GİZLENMİYOR, TEMİZLENİYOR. `mobile/lib/lcBicim.ts`
 * gösterimi düzeltmişti ama depodaki değer kirli kalıyordu; kirli değer bir
 * sonraki `$inc`in TABANI olduğu için hata büyümeye devam ediyordu. Yuvarlama
 * yazımda olduğu için eski kirli bakiyeler de ilk işlemde kendiliğinden
 * düzeliyor (elle toplu onarım: scripts/cuzdan-yuvarla.cjs).
 */

/** LC'nin anlamlı en küçük basamağı. 0.1 adımlı ödüller var; 2 basamak bunu
 *  bozmadan artığı kesiyor. */
const BASAMAK = 2;

/** Tutarı LC hassasiyetine indirger. */
function tutarNormalle(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100) / 100;
}

/** `$inc` yerine: alanı `mevcut + delta` yapıp yuvarlayan ifade. */
function artir(alan, delta) {
  return { $round: [{ $add: [{ $ifNull: [`$${alan}`, 0] }, delta] }, BASAMAK] };
}

/**
 * CÜZDANI AÇILIŞ BAKİYESİYLE KURAR (yoksa). Varsa hiçbir şey yapmaz.
 *
 * ⚠️ NEDEN AYRI FONKSİYON: `spendLc` cüzdanı açılış bakiyesiyle kuruyordu,
 * `creditLc` kurmuyordu — yalnızca kredi tutarıyla yaratıyordu. Açılış
 * bakiyesini veren yollar ise "belge var mı?" diye bakıp atlıyor; kod
 * tabanında hiçbir yerde "açılış verildi" işareti yok, belgenin VARLIĞI bu
 * sorunun yerine geçiyor.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo):
 *   creditLc(yeni, +15) → 15   ← açılış 30 KAYIP
 *   spendLc(yeni,  -3)  → 27   ← açılış verilmiş, sonra düşülmüş
 *
 * Gerçek senaryo: davet linkiyle gelen kullanıcı. `applyPendingRef` açılışta
 * `/use-invite` çağırıyor, `invite_welcome` kredisi cüzdanı yaratıyor — yani
 * davet özelliğinin GETİRDİĞİ kullanıcı 45 yerine 15 LC ile başlıyordu.
 *
 * ⚠️ NEDEN `creditLc`İN İÇİNE KONMADI: `creditLc` İADELER için de kullanılıyor.
 * Hesabı silinmiş birine geç bir iade gelirse cüzdanı 30 LC ile DİRİLTİRDİ.
 * Ayrıca 25 test `creditLc`yi "bakiyeyi N yap" kurulumu olarak kullanıyor;
 * ilkelin sözleşmesini değiştirmek onları sessizce yanlış hâle getirirdi.
 * Bunun yerine kurulum AÇIK: yeni kullanıcının girebileceği yollar çağırır.
 *
 * @returns {Promise<boolean>} true ise cüzdan BU çağrıda kuruldu
 */
/**
 * @param {object}  db
 * @param {string}  userId
 * @param {number}  [acilisBakiyesi]
 * @param {object}  [opts]
 * @param {boolean} [opts.is1987]  true ise bonus1987 alanı da kurulur
 */
async function cuzdanKur(db, userId, acilisBakiyesi = ACILIS_VARSAYILAN, opts = {}) {
  if (!db) return false;
  const uid = String(userId || "").trim();
  const uidLower = uid.toLowerCase();
  if (!uidLower) return false;

  await ensureIndexes(db);
  const nowISO = new Date().toISOString();
  const tutar = tutarNormalle(Number(acilisBakiyesi) || 0) || 0;

  const insert = {
    userId: uid,
    userIdLower: uidLower,
    balance: tutar,
    totalEarned: tutar,
    totalSpent: 0,
    lastDailyAt: null,
    createdAt: nowISO,
    updatedAt: nowISO,
  };
  if (opts.is1987) insert.bonus1987 = BONUS_1987_TAVAN;

  const r = await db.collection(COLL_USERS).updateOne(
    { userIdLower: uidLower },
    { $setOnInsert: insert },
    { upsert: true }
  );
  return !!r.upsertedCount;
}

/**
 * Kullanıcıya LC yatırır ve defter kaydı düşer.
 *
 * @param {object} db          Mongo bağlantısı (yoksa hiçbir şey yapılmaz)
 * @param {string} userId      Kullanıcı kimliği (küçük harfli anahtar türetilir)
 * @param {number} amount      Yatırılacak LC (>0 değilse atlanır)
 * @param {string} reason      Defterde görünecek sebep (örn. "mini_tournament_win")
 * @param {object} [meta]      Serbest ek bilgi
 * @returns {Promise<boolean>} yazıldıysa true
 */
async function creditLc(db, userId, amount, reason, meta = null) {
  const uid = String(userId || "").trim();
  const ham = Number(amount || 0);
  const tutar = tutarNormalle(ham);
  if (!db || !uid || !Number.isFinite(tutar) || tutar <= 0) {
    /* ⚠️ Yuvarlama bir ödülü SIFIRA indirdiyse sessiz kalmıyoruz: 0.004 LC
     * anlamsız bir ödüldür ama sessizce yutulması, ödül yolunun kırık olduğunu
     * gizler. Kayıp para sınıfının en sinsi hâli budur. */
    if (db && uid && Number.isFinite(ham) && ham > 0 && tutar <= 0) {
      console.error(`[wallet-credit] ${reason} tutari yuvarlamada sifirlandi (${uid}): ${ham}`);
    }
    return false;
  }

  const uidLower = uid.toLowerCase();
  const nowISO = new Date().toISOString();

  try {
    await ensureIndexes(db);   // upsert'ten ÖNCE — bkz. dosya başındaki not
    /* İŞ HATTI GÜNCELLEMESİ: toplama sunucuda, tek belgede, tek işlemde —
     * `$inc` kadar atomik ama sonucu yuvarlıyor. Bkz. yukarıdaki not.
     * `$setOnInsert` iş hattında kullanılamadığı için yeni belge alanları
     * `$ifNull` ile korunuyor: mevcut belgede alan varsa DOKUNULMUYOR. */
    await db.collection(COLL_USERS).updateOne(
      { userIdLower: uidLower },
      [{
        $set: {
          userId:      { $ifNull: ["$userId", { $literal: uid }] },
          userIdLower: { $ifNull: ["$userIdLower", { $literal: uidLower }] },
          balance:     artir("balance", tutar),
          totalEarned: artir("totalEarned", tutar),
          totalSpent:  { $ifNull: ["$totalSpent", 0] },
          lastDailyAt: { $ifNull: ["$lastDailyAt", null] },
          createdAt:   { $ifNull: ["$createdAt", { $literal: nowISO }] },
          updatedAt:   { $literal: nowISO },
        },
      }],
      { upsert: true }
    );

    await db.collection(COLL_LEDGER).insertOne({
      id: txId(),
      userId: uid,
      userIdLower: uidLower,
      kind: "reward",
      amount: tutar,
      reason,
      meta,
      createdAt: nowISO,
    });
    return true;
  } catch (e) {
    // Ödül yolunu tamamen durdurmuyoruz (dosya tarafı yazılmış olabilir),
    // ama sessiz kalmıyoruz: bu kayıp PARA demek.
    console.error(`[wallet-credit] ${reason} yatirilamadi (${uid}):`, e?.message || e);
    return false;
  }
}

/**
 * Kullanıcıdan LC düşer. `creditLc`'nin kardeşi — aynı sebeple var.
 *
 * NEDEN AYRI BİR FONKSİYON: harcama yolu, yatırma yolundan iki yönden zor.
 *   1) Bakiye eksiye düşmemeli. Dosya kodu bunu "oku → karşılaştır → yaz" ile
 *      yapıyordu; iki eşzamanlı istek aynı bakiyeyi okuyup ikisi de geçebilir.
 *      Burada koşul SORGUNUN İÇİNDE (`balance: { $gte: tutar }`), yani kontrol
 *      ve yazma tek atomik işlem — yarış koşulu kalmıyor.
 *   2) `$inc` ile borçlandırma da GÖRELİDİR, dosyadan okunan değere dayanmaz;
 *      ayna kapalıyken de doğrudur.
 *
 * Cüzdan kaydı yoksa açılış bakiyesiyle yaratılır (yeni oyuncunun ilk işlemi
 * harcama olabilir), sonra borçlandırma bir kez daha denenir.
 *
 * @returns {Promise<{ok:boolean, lc:number|null, reason?:string}>}
 *          ok=false & reason="INSUFFICIENT" → bakiye yetersiz (hata değil)
 *          ok=false & reason="NO_DB"|"ERROR" → yazılamadı, çağıran karar versin
 */
/**
 * @param {object}  db
 * @param {string}  userId
 * @param {number}  amount
 * @param {string}  reason
 * @param {object}  [meta]
 * @param {number}  [initialBalance=30]
 * @param {object}  [opts]
 * @param {string}  [opts.kanal]  "1987" ise bonus1987'den harcar, bitince balance
 */
async function spendLc(db, userId, amount, reason, meta = null, initialBalance = 30, opts = {}) {
  const uid = String(userId || "").trim();
  const tutar = tutarNormalle(amount || 0);
  if (!db || !uid || !Number.isFinite(tutar) || tutar <= 0) {
    return { ok: false, lc: null, reason: "NO_DB" };
  }

  const uidLower = uid.toLowerCase();
  const nowISO = new Date().toISOString();
  await ensureIndexes(db);
  const users = db.collection(COLL_USERS);

  // 1987 kanalı: önce bonus1987'den, yetmezse balance'tan
  if (opts.kanal === "1987") {
    const bonusDus = await users.findOneAndUpdate(
      { userIdLower: uidLower, bonus1987: { $gte: tutar } },
      [{
        $set: {
          bonus1987:  artir("bonus1987", -tutar),
          totalSpent: artir("totalSpent", tutar),
          updatedAt:  { $literal: nowISO },
        },
      }],
      { returnDocument: "after" }
    );
    const bonusDoc = bonusDus && ("value" in bonusDus ? bonusDus.value : bonusDus);
    if (bonusDoc) {
      await db.collection(COLL_LEDGER).insertOne({
        id: txId(), userId: uid, userIdLower: uidLower,
        kind: "spend", amount: -tutar, reason, meta: { ...meta, kaynak: "bonus1987" },
        createdAt: nowISO,
      });
      return { ok: true, lc: Number(bonusDoc.balance || 0), bonus1987: Number(bonusDoc.bonus1987 || 0) };
    }
    // bonus1987 yetmedi — normal balance'a düş (aşağıdaki standart yol)
  }

  const dus = async () => {
    const r = await users.findOneAndUpdate(
      { userIdLower: uidLower, balance: { $gte: tutar } },
      [{
        $set: {
          balance:    artir("balance", -tutar),
          totalSpent: artir("totalSpent", tutar),
          updatedAt:  { $literal: nowISO },
        },
      }],
      { returnDocument: "after" }
    );
    if (!r) return null;
    return "value" in r ? r.value : r;
  };

  try {
    let doc = await dus();
    if (!doc) {
      const mevcut = await users.findOne({ userIdLower: uidLower }, { projection: { balance: 1, bonus1987: 1 } });
      if (mevcut) {
        return { ok: false, lc: Number(mevcut.balance || 0), reason: "INSUFFICIENT" };
      }
      await users.updateOne(
        { userIdLower: uidLower },
        {
          $setOnInsert: {
            userId: uid,
            userIdLower: uidLower,
            balance: Number(initialBalance) || 0,
            totalEarned: Number(initialBalance) || 0,
            totalSpent: 0,
            lastDailyAt: null,
            createdAt: nowISO,
            updatedAt: nowISO,
          },
        },
        { upsert: true }
      );
      doc = await dus();
      if (!doc) {
        const s = await users.findOne({ userIdLower: uidLower }, { projection: { balance: 1 } });
        return { ok: false, lc: Number(s?.balance || 0), reason: "INSUFFICIENT" };
      }
    }

    await db.collection(COLL_LEDGER).insertOne({
      id: txId(), userId: uid, userIdLower: uidLower,
      kind: "spend", amount: -tutar, reason, meta,
      createdAt: nowISO,
    });
    return { ok: true, lc: Number(doc.balance || 0) };
  } catch (e) {
    console.error(`[wallet-credit] ${reason} dusulemedi (${uid}):`, e?.message || e);
    return { ok: false, lc: null, reason: "ERROR" };
  }
}

/**
 * 1987 bonus bakiyesini tavana tamamlar (aylık yenileme).
 * Yalnızca eksikse yazar — zaten tavanda veya üstündeyse hiçbir şey yapmaz.
 */
async function bonus1987Tamamla(db, userId) {
  if (!db) return false;
  const uid = String(userId || "").trim();
  const uidLower = uid.toLowerCase();
  if (!uidLower) return false;

  await ensureIndexes(db);
  const nowISO = new Date().toISOString();
  const r = await db.collection(COLL_USERS).findOneAndUpdate(
    { userIdLower: uidLower, $or: [
      { bonus1987: { $lt: BONUS_1987_TAVAN } },
      { bonus1987: { $exists: false } },
    ]},
    [{ $set: {
      bonus1987: { $literal: BONUS_1987_TAVAN },
      updatedAt: { $literal: nowISO },
    }}],
    { returnDocument: "after" }
  );
  const doc = r && ("value" in r ? r.value : r);
  if (doc) {
    const onceki = Number(doc.bonus1987 || 0);
    const fark = BONUS_1987_TAVAN - onceki;
    if (fark > 0) {
      await db.collection(COLL_LEDGER).insertOne({
        id: txId(), userId: uid, userIdLower: uidLower,
        kind: "reward", amount: fark, reason: "bonus1987_monthly",
        meta: { onceki, yeni: BONUS_1987_TAVAN },
        createdAt: nowISO,
      });
    }
  }
  return !!doc;
}

module.exports = {
  cuzdanKur, bonus1987Tamamla,
  kayipOdulKaydet, creditLc, spendLc, COLL_USERS, COLL_LEDGER,
  tutarNormalle, BASAMAK };
