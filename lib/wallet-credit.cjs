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
const COLL_LEDGER = "lc_wallet_ledger";

function txId() {
  return "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
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
  const tutar = Number(amount || 0);
  if (!db || !uid || !Number.isFinite(tutar) || tutar <= 0) return false;

  const uidLower = uid.toLowerCase();
  const nowISO = new Date().toISOString();

  try {
    await db.collection(COLL_USERS).updateOne(
      { userIdLower: uidLower },
      {
        $inc: { balance: tutar, totalEarned: tutar },
        $set: { updatedAt: nowISO },
        $setOnInsert: {
          userId: uid,
          userIdLower: uidLower,
          createdAt: nowISO,
          lastDailyAt: null,
          totalSpent: 0,
        },
      },
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
async function spendLc(db, userId, amount, reason, meta = null, initialBalance = 30) {
  const uid = String(userId || "").trim();
  const tutar = Number(amount || 0);
  if (!db || !uid || !Number.isFinite(tutar) || tutar <= 0) {
    return { ok: false, lc: null, reason: "NO_DB" };
  }

  const uidLower = uid.toLowerCase();
  const nowISO = new Date().toISOString();
  const users = db.collection(COLL_USERS);

  // Kontrol ve yazma TEK işlemde: filtredeki $gte bakiyeyi eksiye düşürmez.
  // Sürücü 5 `{ value: doc }`, sürücü 6 doğrudan `doc` döner — ikisi de olur.
  const dus = async () => {
    const r = await users.findOneAndUpdate(
      { userIdLower: uidLower, balance: { $gte: tutar } },
      {
        $inc: { balance: -tutar, totalSpent: tutar },
        $set: { updatedAt: nowISO },
      },
      { returnDocument: "after" }
    );
    if (!r) return null;
    return "value" in r ? r.value : r;
  };

  try {
    let doc = await dus();
    if (!doc) {
      // Eşleşmedi: ya cüzdan yok ya da bakiye yetersiz. İkisi farklı sonuç.
      const mevcut = await users.findOne({ userIdLower: uidLower }, { projection: { balance: 1 } });
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
      id: txId(),
      userId: uid,
      userIdLower: uidLower,
      kind: "spend",
      amount: -tutar,
      reason,
      meta,
      createdAt: nowISO,
    });
    return { ok: true, lc: Number(doc.balance || 0) };
  } catch (e) {
    console.error(`[wallet-credit] ${reason} dusulemedi (${uid}):`, e?.message || e);
    return { ok: false, lc: null, reason: "ERROR" };
  }
}

module.exports = { creditLc, spendLc, COLL_USERS, COLL_LEDGER };
