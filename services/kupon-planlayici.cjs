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
 * ⚠️ DÖRT HAFTA İLERİ BAKAR (bkz. haftaAnahtarlari): fikstürler ilerideki
 * haftalarda yoğunlaşıyor, dar ufuk hiç kupon kuramıyordu.
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

/**
 * Önümüzdeki N haftanın ISO anahtarları.
 *
 * ⚠️ ÖNCE 2 HAFTAYDI, YETMEDİ. Üretim verisinde ölçüldü (2026-07-30, Avrupa
 * ligleri hazırlık döneminde): önümüzdeki iki haftada 3 ve 17 maç var, oysa
 * W33'te 51, W34'te 83. Yani fikstürler ilerideki haftalarda yoğunlaşıyor ve
 * dar ufuk hiçbir kupon kuramıyordu.
 *
 * Erken kurulan kupon zararsız: kendi `kilitISO`suna kadar açık kalır,
 * oyuncuya hazırlık süresi verir. Birden fazla haftanın kuponu aynı anda
 * açık olabilir — bilinçli.
 */
const UFUK_HAFTA = Number(process.env.SKORLIG_KUPON_UFUK_HAFTA || 4);

function haftaAnahtarlari() {
  const simdi = Date.now();
  const out = [];
  for (let i = 0; i < UFUK_HAFTA; i++) {
    const k = KuponRota._isoHaftaKey(new Date(simdi + i * 7 * 24 * 3600 * 1000).toISOString());
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
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
