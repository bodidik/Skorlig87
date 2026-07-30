"use strict";

/**
 * HAFTALIK KUPON PLANLAYICI — kuponları otomatik kurar.
 *
 * Elle `POST /api/kupon/olustur` çağırmak yayında sürdürülebilir değil: her
 * hafta, her ülke için ayrı çağrı gerekirdi. Bu servis periyodik olarak
 * eksik kuponları kurar.
 *
 * ⚠️ İDEMPOTENT. `kuponOlustur` aynı hafta+tür+ülke için ikinci kez
 * çağrıldığında MEVCUDU döner (benzersiz indeks). Yani bu servisin sık
 * çalışması zararsız — kupon çoğalmaz.
 *
 * ⚠️ HANGİ ÜLKELER: kullanıcısı olan ülkeler. Sabit bir liste tutmak,
 * kullanıcı yeni bir ülkeden geldiğinde onu kuponsuz bırakırdı. Bot ülkeleri
 * de dahil — bot kadrosu zaten gerçek ülkelere dağıtılmış durumda.
 *
 * ⚠️ İKİ HAFTA İLERİ BAKAR: bu hafta ve gelecek hafta. Hafta sonu maçları
 * genelde Cuma başlar; Perşembe kurulan kupon için katılım penceresi çok
 * kısa kalırdı. Gelecek haftayı da kurmak oyuncuya hazırlık süresi verir.
 */

const Kupon = require("../lib/kupon.cjs");
const KuponRota = require("../routes/kupon.cjs");

let _timer = null;
let _sonTur = null;

async function getDbSafe() {
  try {
    const { getDb } = require("../lib/mongo.cjs");
    return await getDb();
  } catch {
    return null;
  }
}

/** Kullanıcısı olan ülkeler (tekilleştirilmiş). */
async function ulkeler(db) {
  try {
    const liste = await db.collection("users").distinct("country", {
      country: { $nin: [null, ""] },
    });
    return (liste || []).map((x) => String(x).trim()).filter(Boolean);
  } catch (e) {
    console.error("[kupon-planlayici] ulkeler okunamadi:", e?.message || e);
    return [];
  }
}

/** Bu hafta ve gelecek haftanın ISO anahtarları. */
function haftaAnahtarlari() {
  const simdi = new Date();
  const gelecek = new Date(simdi.getTime() + 7 * 24 * 3600 * 1000);
  return [
    KuponRota._isoHaftaKey(simdi.toISOString()),
    KuponRota._isoHaftaKey(gelecek.toISOString()),
  ].filter(Boolean);
}

/**
 * Bir tur: eksik kuponları kurar.
 * @returns {{kurulan:number, atlanan:number, hata:number}}
 */
async function tur() {
  const db = await getDbSafe();
  if (!db) return { kurulan: 0, atlanan: 0, hata: 0, sebep: "NO_DB" };

  const haftalar = haftaAnahtarlari();
  const ulkeListesi = await ulkeler(db);
  let kurulan = 0, atlanan = 0, hata = 0;

  for (const haftaKey of haftalar) {
    // Avrupa kuponu: ülkeden bağımsız, tek kupon
    try {
      const r = await KuponRota._kuponKur({ tur: Kupon.TUR.AVRUPA, ulke: null, haftaKey }, db);
      if (r.ok && r.yeni) kurulan++;
      else atlanan++;
    } catch (e) {
      hata++;
      console.error(`[kupon-planlayici] avrupa ${haftaKey}:`, e?.message || e);
    }

    for (const ulke of ulkeListesi) {
      try {
        const r = await KuponRota._kuponKur({ tur: Kupon.TUR.ULKE, ulke, haftaKey }, db);
        if (r.ok && r.yeni) kurulan++;
        else atlanan++;   // yeterli maç yok ya da zaten var — ikisi de normal
      } catch (e) {
        hata++;
        console.error(`[kupon-planlayici] ${ulke} ${haftaKey}:`, e?.message || e);
      }
    }
  }

  _sonTur = {
    at: new Date().toISOString(),
    haftalar, ulkeSayisi: ulkeListesi.length, kurulan, atlanan, hata,
  };
  if (kurulan) console.log(`[kupon-planlayici] ${kurulan} kupon kuruldu (${haftalar.join(", ")})`);
  return _sonTur;
}

function start(intervalMs = 6 * 3600 * 1000) {
  if (_timer) return;
  // İlk tur hemen değil: fikstür senkronunun ilk turunu tamamlamasına fırsat
  // ver, yoksa "yeterli maç yok" deyip boş döner.
  setTimeout(() => { tur().catch(() => {}); }, 90 * 1000);
  _timer = setInterval(() => { tur().catch(() => {}); }, intervalMs);
  if (typeof _timer.unref === "function") _timer.unref();
  console.log(`[kupon-planlayici] basladi · her ${Math.round(intervalMs / 3600000)} saatte`);
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, tur, sonTur: () => _sonTur, _ulkeler: ulkeler, _haftaAnahtarlari: haftaAnahtarlari };
