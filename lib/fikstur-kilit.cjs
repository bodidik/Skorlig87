"use strict";

/**
 * FİKSTÜR KİLİDİ — maç başladıktan sonra para yatırmayı engeller.
 *
 * ⚠️ NEDEN ORTAK: kilit her oyun modunda AYRI yazılmıştı — düelloda
 * `isFixtureLocked`, tahminde `computePredLock`, kuponda `kilitISO`. HAVUZDA
 * İSE HİÇ YOKTU. `POST /api/pool/:fixtureId/bet` yalnızca "havuz
 * sonuçlandı mı" diye bakıyordu; maçın başlayıp başlamadığına bakmıyordu.
 *
 * Sonuç: oyuncu canlı skoru uygulamada görüp 89'da 2-0 olan maça kazanan
 * tarafa bahis koyabiliyordu. Sonuç belli olduktan sonra bahis = bedava para.
 * Uzlaşma maç bitince çalıştığı için arada gerçek bir pencere vardı.
 *
 * Üç kopya + bir eksik: kopyalanan savunma, kopyalanmayan yerde yok demektir.
 * Bu yüzden tek kaynak burası.
 *
 * ⚠️ FAIL-CLOSED. Fikstür bulunamazsa, saat okunamazsa ya da depoya
 * ulaşılamazsa KİLİTLİ sayılır. Ters varsayım (bilinmiyorsa açık) tam da
 * verinin bozuk olduğu anda para yatırmaya izin verirdi.
 *
 * ⚠️ İKİ BAĞIMSIZ SİNYAL, ikisi de tek başına yeterli:
 *   1) `status !== "NS"` — maç fiilen başlamış. Saat yanlışsa bile yakalar.
 *   2) Kickoff saati geçmiş — durum güncellenmemişse bile yakalar.
 * Biri bayatlarsa diğeri tutar; tek sinyale güvenmek ikisinin de kör olduğu
 * ana bağlı kalmaktı.
 */

const path = require("path");
const fsp = require("fs").promises;

const { guvenliYol } = require("./guvenli-dosya.cjs");
const FixturesStore = require("./fixtures-store.cjs");

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const LIVE_DIR = path.join(DATA_DIR, "live");

async function readJson(file, fb) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fb;
  }
}

/**
 * Maça para yatırılabilir mi?
 *
 * @param {string} fixtureId
 * @param {object} [secenek]
 * @param {number} [secenek.oncekiDk=0]  kickoff'tan kaç dakika ÖNCE kapansın
 * @param {*} [secenek.db]               Mongo bağlantısı (fikstür deposu için)
 * @returns {Promise<{locked:boolean, reason:string|null, kickoffISO?:string, status?:string}>}
 */
async function fiksturKilidi(fixtureId, { oncekiDk = 0, db = null } = {}) {
  const fid = String(fixtureId || "").trim();
  if (!fid) return { locked: true, reason: "NO_FIXTURE" };

  let st = await readJson(guvenliYol(LIVE_DIR, fid, ".json"), null);

  if (!st || typeof st !== "object") {
    // Canlı durum dosyası yok (Render'da geçici disk her deploy'da siliyor) —
    // fikstür deposu yetkili kaynak.
    try {
      const hepsi = await FixturesStore.loadAll(db);
      const fx = (hepsi || []).find((f) => String(f?.fixtureId || "") === fid);
      if (!fx) return { locked: true, reason: "FIXTURE_NOT_FOUND" };
      st = { status: fx.status || "NS", kickoffISO: fx.kickoffISO || fx.kickoff || null };
    } catch (e) {
      console.error("[fikstur-kilit] fikstur dogrulanamadi, kilitli sayiliyor:", e?.message || e);
      return { locked: true, reason: "FIXTURE_CHECK_FAILED" };
    }
  }

  const status = String(st.status || "").toUpperCase();
  if (status && status !== "NS") {
    return { locked: true, reason: "MATCH_ALREADY_STARTED", status };
  }

  const kickoffISO = st.kickoffISO || st.kickoff || null;
  if (!kickoffISO) return { locked: true, reason: "NO_KICKOFF" };

  const koMs = new Date(String(kickoffISO)).getTime();
  if (!Number.isFinite(koMs)) return { locked: true, reason: "BAD_KICKOFF" };

  const kilitMs = koMs - Number(oncekiDk || 0) * 60 * 1000;
  if (Date.now() >= kilitMs) {
    return {
      locked: true,
      reason: "LOCKED_BEFORE_KICKOFF",
      kickoffISO,
      lockAtISO: new Date(kilitMs).toISOString(),
    };
  }
  return { locked: false, reason: null, kickoffISO };
}

module.exports = { fiksturKilidi, _LIVE_DIR: LIVE_DIR };
