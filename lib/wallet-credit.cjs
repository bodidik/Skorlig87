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

module.exports = { creditLc, COLL_USERS, COLL_LEDGER };
