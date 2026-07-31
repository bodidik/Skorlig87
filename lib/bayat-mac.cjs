"use strict";

/**
 * BAYAT MAÇ — sonucu hiç gelmeyen maç.
 *
 * ⚠️ NEDEN VAR: bu oyunda paranın TAMAMI bir maçın sonucuna bağlı. Sonuç hiç
 * gelmezse para kilitli kalır ve KENDİLİĞİNDEN ÇÖZÜLMEZ:
 *
 *   düello  — kabul edilmiş düello yalnızca `status: "open"` iken iptal
 *             edilebiliyor. Kabul edildikten sonra iki oyuncunun bahsi de
 *             kalıcı olarak kilitli.
 *   havuz   — `settlePool` yalnızca settle2'den, sonuç geldiğinde çağrılıyor.
 *             Sonuç gelmezse bahisler sonsuza kadar havuzda.
 *   mini    — `settledCount < fixtureCount` iken turnuva hiç bitmiyor:
 *             kazananlar ödülünü almıyor ve turnuva kurucunun kota yuvasını
 *             kalıcı işgal ediyor.
 *
 * Kupon aynı hatayı taşıyordu ve ayrıca düzeltildi (bkz. lib/kupon-settle.cjs).
 * Bu dosya o düzeltmenin ÖLÇÜTÜNÜ ortaklaştırıyor — dört yere dört ayrı eşik
 * yazmak, birinde unutmak demekti.
 *
 * ⚠️ ERTELEME NADİR DEĞİL: hava, kupa takvimi, saha koşulları. Üstelik skor
 * kaynakları fiilen tek şelaleye düşmüş durumda (bkz. services/scraper-health),
 * yani maç oynanmış olsa bile sonucu hiç gelmeyebilir.
 *
 * ⚠️ FAIL-CLOSED: başlama saati okunamıyorsa maç BAYAT SAYILMAZ. Ters varsayım,
 * verisi bozuk bir maçta parayı erken iade edip gerçek sonuç gelince ikinci kez
 * ödeme yapardı.
 */

const MatchResults = require("./match-results.cjs");

/**
 * Sonucun gelmesi için maç saatinden sonra kaç saat beklenir.
 * Kupon tarafındaki bekleme ile aynı varsayılan (48s) — iki eşik ayrışırsa
 * "kupon iade etti ama düello etmedi" gibi tutarsızlıklar çıkardı.
 */
const BEKLEME_SAAT = Number(process.env.SKORLIG_BAYAT_SAAT || 48);

/** Maçın sonucu var mı (settle olmuş sayılır)? */
async function sonucVarMi(fixtureId, db) {
  try {
    const snap = await MatchResults.getSnapshot(String(fixtureId), db);
    const h = Number(snap?.finalScore?.home);
    const a = Number(snap?.finalScore?.away);
    return Number.isFinite(h) && Number.isFinite(a);
  } catch {
    // Okunamadıysa KARAR VEREMEYİZ → sonuç var say, yani bayat sayma.
    // (Bayat saymak, sonucu aslında olan maçta parayı iade etmek olurdu.)
    return true;
  }
}

/**
 * Maç bayat mı?
 *
 * @param {object} o
 * @param {string} o.fixtureId
 * @param {string|null} o.kickoffISO  bilinmiyorsa null (o zaman bayat SAYILMAZ)
 * @param {*} [o.db]
 * @param {number} [o.saat]           bekleme (saat) — varsayılan BEKLEME_SAAT
 * @param {number} [o.simdi]          test için sabit zaman
 * @returns {Promise<{bayat:boolean, sebep:string}>}
 */
async function bayatMi({ fixtureId, kickoffISO, db = null, saat = BEKLEME_SAAT, simdi = null }) {
  const fid = String(fixtureId || "").trim();
  if (!fid) return { bayat: false, sebep: "NO_FIXTURE" };

  let koMs = new Date(String(kickoffISO || "")).getTime();

  /* ⚠️ BAŞLAMA SAATİ İÇİN YEDEK ARAMA.
   *
   * Çağıranların bir kısmı saati KENDİ belgesinden veriyor ve o belge
   * istemci gövdesinden dolmuş olabilir (mini turnuva `fixtures[].kickoffISO`
   * doğrudan istemciden geliyor). Eski kayıtlarda alan boş olabilir; o zaman
   * maç asla bayat sayılmaz ve para sonsuza kadar kilitli kalırdı — tam da
   * bu dosyanın önlemek için yazıldığı durum.
   *
   * Bu yüzden saat okunamıyorsa sunucudaki YETKİLİ fikstür verisine bakılır.
   * O da yoksa fail-closed korunur: bayat SAYILMAZ. */
  if (!Number.isFinite(koMs) && db) {
    try {
      const d = await db
        .collection("fixtures")
        .findOne({ fixtureId: fid }, { projection: { kickoffISO: 1, kickoff: 1, _id: 0 } });
      koMs = new Date(String(d?.kickoffISO || d?.kickoff || "")).getTime();
    } catch (e) {
      console.error("[bayat-mac] fikstur saati okunamadi:", e?.message || e);
    }
  }
  if (!Number.isFinite(koMs)) return { bayat: false, sebep: "BAD_KICKOFF" };

  const now = Number.isFinite(simdi) ? simdi : Date.now();
  if (now < koMs + saat * 3600 * 1000) return { bayat: false, sebep: "BEKLENIYOR" };

  if (await sonucVarMi(fid, db)) return { bayat: false, sebep: "SONUC_VAR" };

  return { bayat: true, sebep: "SONUC_GELMEDI" };
}

module.exports = { bayatMi, sonucVarMi, BEKLEME_SAAT };
