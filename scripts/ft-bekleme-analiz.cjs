"use strict";

/**
 * FT SONRASI SKOR DEĞİŞİMİ — bekleme süresini VERİYLE seçmek için.
 *
 * ⚠️ NEDEN VAR: `services/livescore-sync.cjs` içindeki `FT_BEKLEME_DK`
 * (uzlaşmadan önce skorun kararlı kalması gereken süre) TAHMİNLE seçildi.
 * Seçemedim çünkü durum dosyasındaki `updatedAt` her senkron turunda yeniden
 * yazılıyor — "en son ne zaman görüldü" demek, "ne zaman değişti" değil.
 *
 * Bu betik, o soruyu artık yazılan iki damgadan cevaplıyor:
 *     ilkFtAt      → maçın İLK kez FT görüldüğü an (yalnızca LIVE→FT geçişi)
 *     skorSabitAt  → skorun SON kez değiştiği an (değişince sıfırlanır)
 *     ftSonrasiDegisim → FT'den sonra skorun kaç kez değiştiği
 *
 * `skorSabitAt - ilkFtAt` = SON değişimin ilk FT'ye göre gecikmesi. Birden
 * çok değişim olduysa yalnızca sonuncusu görünür; sayaç kaç tane olduğunu
 * söylüyor. Süreyi seçmek için gereken sayı bu.
 *
 * KULLANIM: node scripts/ft-bekleme-analiz.cjs
 */

require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const LIVE_DIR = path.join(DATA_DIR, "live");
const MEVCUT_DK = Number(process.env.SKORLIG_FT_BEKLEME_DK || 10);

function main() {
  if (!fs.existsSync(LIVE_DIR)) {
    console.log("canli durum dizini yok:", LIVE_DIR);
    return;
  }
  const dosyalar = fs.readdirSync(LIVE_DIR).filter((f) => f.endsWith(".json"));

  let ft = 0, damgali = 0, degisimli = 0;
  const gecikmeler = [];
  const ornekler = [];

  for (const d of dosyalar) {
    let st;
    try { st = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, d), "utf8")); } catch { continue; }
    if (String(st?.status || "").toUpperCase() !== "FT") continue;
    ft++;
    if (!st.ilkFtAt) continue;          // özellikten önce bitmiş — ölçülemez
    damgali++;

    const adet = Number(st.ftSonrasiDegisim || 0);
    if (adet <= 0) continue;
    degisimli++;

    const ilk = Date.parse(st.ilkFtAt);
    const son = Date.parse(st.skorSabitAt || "");
    if (!Number.isFinite(ilk) || !Number.isFinite(son)) continue;
    const dk = (son - ilk) / 60000;
    if (dk < 0) continue;
    gecikmeler.push(dk);
    if (ornekler.length < 10) {
      ornekler.push(`${st.fixtureId}  ${adet} degisim, sonuncusu +${dk.toFixed(1)} dk`);
    }
  }

  console.log(`FT durum dosyasi          : ${ft}`);
  console.log(`ilkFtAt damgasi olan      : ${damgali}   ← olculebilir kume`);
  console.log(`FT sonrasi skoru degisen  : ${degisimli}`);

  if (!damgali) {
    console.log("\nHENUZ VERI YOK.");
    console.log("Damgalar yalnizca LIVE->FT gecisinde yaziliyor; sunucu YENI KODLA");
    console.log("yeniden baslatilmadan ve yeni maclar bitmeden bu kume dolmaz.");
    return;
  }

  const oran = degisimli / damgali;
  console.log(`degisim orani             : %${(100 * oran).toFixed(2)}`);

  if (!gecikmeler.length) {
    console.log("\nOlculebilir kume dolu ama hic degisim yok.");
    console.log(`Bu, mevcut ${MEVCUT_DK} dk beklemenin GEREKSIZ oldugu anlamina GELMEZ:`);
    console.log("kapi zaten beklettigi icin degisimlerin bir kismi uzlasmadan ONCE");
    console.log("yakalanmis olabilir. Karar icin daha fazla gun gerekli.");
    return;
  }

  gecikmeler.sort((a, b) => a - b);
  const q = (r) => gecikmeler[Math.floor(r * (gecikmeler.length - 1))];
  console.log(`\ngecikme (dk), n=${gecikmeler.length}`);
  console.log(`   min ${q(0).toFixed(1)}  medyan ${q(0.5).toFixed(1)}  p90 ${q(0.9).toFixed(1)}  p95 ${q(0.95).toFixed(1)}  max ${q(1).toFixed(1)}`);
  console.log("\nornekler:");
  ornekler.forEach((x) => console.log("   " + x));

  /* ⚠️ ÖNERİ p95'TEN, ORTALAMADAN DEĞİL. Ortalama, birkaç uç değeri gizler;
   * burada önemli olan "değişimlerin %95'ini yakalayan süre". Yine de kör
   * uygulanmamalı: süre uzadıkça oyuncu ödülünü daha geç alır. */
  const oneri = Math.ceil(q(0.95));
  console.log(`\nONERI: SKORLIG_FT_BEKLEME_DK=${oneri}  (p95, su an ${MEVCUT_DK})`);
  if (oneri > 30) {
    console.log("UYARI: 30 dk uzeri bir bekleme oyuncu deneyimini bozar.");
    console.log("Bu durumda gecikmeyi beklemekle degil, YENIDEN UZLASMA yoluyla");
    console.log("cozmek gerekir — ki o da dagitilmis LC'yi geri almayi gerektirir.");
  }
  const kacan = gecikmeler.filter((x) => x > MEVCUT_DK).length;
  console.log(`Mevcut ${MEVCUT_DK} dk ile yakalanamayan degisim: ${kacan}/${gecikmeler.length}`);
}

main();
