"use strict";

/**
 * MAÇ DENGESİ — tek taraflı maçlara düello kurulmasını engeller.
 *
 * ⚠️ NEDEN VAR: "Real Madrid – Erokspor" maçına düello kurmak anlamsız. Sonuç
 * zaten büyük ölçüde belli; sürprizi ödüllendirme işini TEK MAÇ TAHMİNİ
 * yapıyor (bkz. services/odds-engine.cjs `lcReward` — düşük ihtimalli sonuç
 * daha çok LC getiriyor). Aynı maça bir de düello açmak yeni bir oyun
 * kurmuyor, yalnızca sisteme kayıt/eşleşme/sonuçlandırma yükü ekliyor.
 *
 * ⚠️ EŞİK ÖLÇÜLEREK SEÇİLDİ, uydurulmadı. Üretimdeki 639 fikstür üzerinde
 * favori sonucun olasılığı hesaplandı:
 *
 *     medyan 0.450 · %90 0.621 · %95 0.671 · en yüksek 0.761
 *
 *     eşik 0.60 → %13.1 engellenir
 *     eşik 0.65 → % 8.1 engellenir   ← seçilen
 *     eşik 0.70 → % 3.1 engellenir
 *
 * Örnekler: Real Madrid–Erokspor 0.771, Galatasaray–Erokspor 0.706,
 * Galatasaray–Fenerbahçe 0.450, Trabzonspor–Beşiktaş 0.360.
 *
 * ⚠️ EV AVANTAJI ASİMETRİ YARATIR VE BU DOĞRUDUR: "Erokspor–Galatasaray"
 * 0.621 (açık kalır), tersi 0.706 (kapanır). Zayıf takım kendi sahasında
 * gerçekten daha rekabetçidir; ölçüt bunu yansıtmalı.
 *
 * ⚠️ REYTİNG TABLOSUNUN SINIRI: `odds-engine` 1006 takım tanıyor ama üretim
 * fikstürlerinin %75'inden fazlasında İKİ takım da tabloda yok ve ikisi de
 * DEFAULT_RATING (65) alıyor — yani denge sinyali o maçlarda düzdür ve maç
 * "dengeli" görünür. Kullanıcının örneği çalışıyor çünkü Real Madrid tabloda.
 * İki tarafı da tanınmayan gerçekten dengesiz bir maç bu kapıdan geçer.
 * Çözümü burada değil, reyting tablosunda.
 *
 * ⚠️ BİLİNMİYORSA AÇIK BIRAKILIR (fail-open) — bu dosyada bilinçli olarak
 * para güvenliğinin tersi. Fikstür okunamazsa düelloyu engellemek, veri
 * gecikince oyunun tamamını durdururdu. Buradaki hata bedeli "gereksiz bir
 * düello açıldı"; para yollarındaki gibi "para kayboldu" değil.
 */

const { calcOdds } = require("../services/odds-engine.cjs");

/** Bu olasılığın üstündeki favori → maç tek taraflı sayılır. */
const ESIK = Number(process.env.SKORLIG_DUELLO_DENGE_ESIK || 0.65);

/** Düello dengesi denetimi tamamen kapatılabilir. */
const ACIK = process.env.SKORLIG_DUELLO_DENGE !== "0";

/**
 * En olası sonucun olasılığı (0..1). 0.33 = tam belirsiz, 1 = kesin.
 *
 * `calcOdds` marjlı oran döner; olasılığa çevirirken aynı marj (1.08)
 * bölünür — bu, odds-engine'in kendi kurulumuyla tutarlı kalmak için.
 */
function favoriOlasiligi(home, away) {
  const o = calcOdds(home, away);
  const MARJ = 1.08;
  const p = [MARJ / o.home, MARJ / o.draw, MARJ / o.away];
  return Math.max(...p);
}

/**
 * Fikstürü SUNUCUDAN okuyup düelloya uygun mu karar verir.
 *
 * ⚠️ TAKIM ADLARI İSTEMCİDEN ALINMAZ. `POST /api/duels/create` gövdesinde
 * `home`/`away` var ama onlar istemcinin yazdığı değerler; kapıyı onlara
 * dayasaydık sahte ad göndererek atlatmak bir satırlık iş olurdu.
 *
 * @param {string} fixtureId
 * @param {*} [db]
 * @returns {Promise<{uygun:boolean, sebep:string, olasilik:number|null, home?:string, away?:string}>}
 */
async function duelloyaUygunMu(fixtureId, db = null) {
  if (!ACIK) return { uygun: true, sebep: "DENETIM_KAPALI", olasilik: null };

  const fid = String(fixtureId || "").trim();
  if (!fid) return { uygun: true, sebep: "NO_FIXTURE", olasilik: null };

  let fx = null;
  try {
    const FixturesStore = require("./fixtures-store.cjs");
    // Indeksli tekil arama — bu yol duello ekraninin her acilisinda calisiyor.
    fx = await FixturesStore.getOne(fid, db);
  } catch (e) {
    console.error("[mac-denge] fikstur okunamadi, duello acik birakiliyor:", e?.message || e);
    return { uygun: true, sebep: "FIXTURE_READ_FAILED", olasilik: null };
  }

  const home = fx?.home || fx?.homeTeam || null;
  const away = fx?.away || fx?.awayTeam || null;
  if (!home || !away) return { uygun: true, sebep: "TAKIM_BILINMIYOR", olasilik: null };

  const olasilik = Math.round(favoriOlasiligi(home, away) * 1000) / 1000;
  if (olasilik >= ESIK) {
    return { uygun: false, sebep: "MATCH_TOO_LOPSIDED", olasilik, home, away };
  }
  return { uygun: true, sebep: "DENGELI", olasilik, home, away };
}

module.exports = { duelloyaUygunMu, favoriOlasiligi, ESIK, ACIK };
