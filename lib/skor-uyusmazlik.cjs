"use strict";

/**
 * SETTLE SONRASI SKOR DEĞİŞİMİ — kalıcı iz.
 *
 * ⚠️ NEDEN VAR: uzlaşma `claimAward` ile MÜHÜRLENİYOR — aynı maç iki kez
 * ödeme yapmasın diye. Doğru bir koruma, ama bir yan etkisi var: skor
 * uzlaşmadan SONRA değişirse (VAR kararı, kaynak düzeltmesi, yanlış eşleşen
 * maçın düzeltilmesi) yeniden uzlaşma OLMUYOR ve puanlar/LC kalıcı olarak
 * yanlış kalıyor.
 *
 * Daha kötüsü: bunu fark eden hiçbir şey yoktu. Anlık görüntü `finalScore`u
 * saklıyor, canlı akış güncel skoru biliyor — karşılaştırma için veri vardı,
 * kimse karşılaştırmıyordu.
 *
 * ⚠️ OTOMATİK DÜZELTME YAPILMIYOR, BİLEREK. Yeniden uzlaşma, dağıtılmış LC'yi
 * geri almayı gerektirir; oyuncu o parayı çoktan harcamış olabilir ve bakiye
 * eksiye düşerdi. Karar operatörün — bu modül yalnızca durumu GÖRÜNÜR kılıyor.
 *
 * ⚠️ MONGO'YA YAZILIYOR, DOSYAYA DEĞİL. `lib/admin-alerts.cjs` dosya tabanlı
 * ve Render'da `data/` her deploy'da siliniyor. Yanlış uzlaşmanın tek kaydı
 * bir uyarıysa, o kayıt deploy'da yok olur ve sorun unutulur. Aynı gerekçeyle
 * `failed_awards` da Mongo'da tutuluyor.
 */

const COLL = "score_mismatch";

let _soz = null;

/** ⚠️ Bayrak değil SÖZ önbelleklenir (bkz. diğer depolar). */
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_soz) return _soz;
  _soz = (async () => {
    try {
      // Maç başına TEK kayıt: her turda yeniden yazıp gürültü üretmesin.
      await db.collection(COLL).createIndex({ fixtureId: 1 }, { unique: true, background: true });
    } catch (e) {
      console.error("[skor-uyusmazlik] indeks kurulamadi:", e?.message || e);
      _soz = null;
    }
  })();
  return _soz;
}

/** İki skoru karşılaştırır; ikisi de tam okunabiliyorsa ve farklıysa true. */
function farkliMi(a, b) {
  const s = (x) => {
    // ⚠️ `Number(null)` === 0. Once `null`/`undefined` acikca elenmezse
    // `{home:null}` skoru 0 sayilir ve sahte bir "skor degisti" uretilir —
    // bu, senkron servisinde duzeltilen "uydurulmus sifir" hatasinin aynisi.
    const ham = [x?.home, x?.away];
    if (ham.some((v) => v === null || v === undefined || v === "")) return null;
    const h = Number(ham[0]);
    const k = Number(ham[1]);
    return Number.isFinite(h) && Number.isFinite(k) ? `${h}-${k}` : null;
  };
  const x = s(a);
  const y = s(b);
  // ⚠️ Biri okunamıyorsa UYUŞMAZLIK SAYMA: eksik veri "skor değişti" demek
  // değil, ve yanlış alarm operatörü bu kayda güvenmemeye iter.
  if (!x || !y) return false;
  return x !== y;
}

/**
 * Uyuşmazlığı kaydeder (maç başına bir kez).
 *
 * @returns {Promise<boolean>} true ise BU çağrıda kaydedildi
 */
async function kaydet(db, { fixtureId, muhurluSkor, guncelSkor, mac }) {
  if (!db) return false;
  const fid = String(fixtureId || "").trim();
  if (!fid) return false;

  await ensureIndexes(db);
  try {
    await db.collection(COLL).insertOne({
      fixtureId: fid,
      mac: mac || null,
      muhurluSkor: muhurluSkor || null,
      guncelSkor: guncelSkor || null,
      at: new Date(),
    });
    console.error(
      `[skor-uyusmazlik] UZLASMA SONRASI SKOR DEGISTI -> ${fid} (${mac || "?"}): ` +
      `muhurlu ${muhurluSkor?.home}-${muhurluSkor?.away}, ` +
      `guncel ${guncelSkor?.home}-${guncelSkor?.away}. ` +
      `Puanlar/LC eski skora gore dagitildi ve OTOMATIK duzelmez.`
    );
    return true;
  } catch (e) {
    if (e?.code === 11000) return false;   // zaten kaydedilmiş — normal
    console.error("[skor-uyusmazlik] kaydedilemedi:", e?.message || e);
    return false;
  }
}

module.exports = { kaydet, farkliMi, ensureIndexes, COLL };
