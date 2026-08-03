"use strict";

/**
 * İLK GOLÜ SKORDAN TÜRETME — tek kaynak.
 *
 * NEDEN VAR (2026-08-03): `st.firstGoal`ü yalnızca `services/af-sync.cjs`
 * dolduruyordu (API-Football events) ve o kaynak askıda. Sonuç ölçüldü:
 * 14518 ilk-gol tahmininin TAMAMI ceza aldı, tek ödül yok — bahis
 * kazanılamıyordu. Tahmin ekranından seçeneği kaldırmak yerine veri, yaşayan
 * kaynaktan (skor) türetiliyor.
 *
 * İKİ KURAL:
 *
 * 1) KESİN ÇIKARIM — `ilkGolTuret(h, a)`:
 *    Bir taraf gol atmış ve öteki 0 ise ilk golü atan TARTIŞMASIZ bellidir
 *    (2-0'da ilk gol ev sahibinin; başka olasılık yok). Maç bittikten sonra
 *    bile çalışır. ÖLÇÜLDÜ (üretim, 1356 uzlaşmış maç): %39.5'i böyle.
 *
 * 2) CANLI İZLEME — livescore-sync her ~30 sn'de skoru görüyor; herhangi bir
 *    anda kural (1) tutarsa `firstGoal` durum dosyasına DAMGALANIR ve skor
 *    sonradan 3-1 olsa da korunur (bkz. writeLiveState). İki tarafın golü
 *    aynı 30 sn'lik pencereye düşmedikçe iki-taraflı maçlar da yakalanır.
 *
 * ⚠️ BİLİNMİYORSA NULL — TAHMİN YOK. 1-1 ilk gözlemde kimin önce attığı
 * bilinemez; null dönmek settle2'nin veri kapısıyla (hasFG) birleşince
 * "puanlanmaz" demek. Yanlış türetim, hiç türetmemekten kötü: oyuncuya
 * haksız ceza/ödül yazar.
 *
 * ⚠️ AF İLE ÇELİŞMEZ: af-sync gol OLAYINDAN yazar ve önceliklidir; buradaki
 * türetim yalnızca `firstGoal` HÂLÂ boşken devreye girer.
 */

/**
 * Skordan kesin ilk gol çıkarımı.
 * @returns {"H"|"A"|null} bilinemiyorsa null
 */
function ilkGolTuret(h, a) {
  const eh = Number(h), ea = Number(a);
  if (!Number.isFinite(eh) || !Number.isFinite(ea)) return null;
  if (eh > 0 && ea === 0) return "H";
  if (ea > 0 && eh === 0) return "A";
  return null;
}

module.exports = { ilkGolTuret };
