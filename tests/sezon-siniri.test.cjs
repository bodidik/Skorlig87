"use strict";

/**
 * PUAN, MAÇIN SEZONUNA YAZILIR — ÖDÜLÜN SEZONUNA DEĞİL.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-08-02, 1024 eşleşen gerçek snapshot): 9 uzlaştırma yanlış
 * sezona düşmüş. Hepsi aynı desende:
 *
 *     MK-LLANEL-2026-07-31-NEWPOR  mac=2026-07  odul=2026-08
 *     MK-SALISB-2026-07-31-HAVWAT  mac=2026-07  odul=2026-08
 *
 * `Season.seasonKey()` argümansız çağrılıyordu, yani ŞU AN. Ayın son akşamı
 * oynanan maç gece yarısını geçince ödülü ertesi aya yazılıyordu.
 *
 * ⚠️ NADİR BİR KAZA DEĞİL, HER AY TEKRARLAYAN SINIR DAVRANIŞI: ayın son günü
 * geç başlayan maçların tamamı. Etkisi sıralamada — o puanlar Temmuz'un
 * tablosunda hiç görünmüyor, Ağustos'unkini şişiriyor. Oyuncu maçı Temmuz'da
 * oynadı, sırası Temmuz'da belirlenmeli.
 *
 * ⚠️ KICKOFF FİKSTÜR KAYDINDAN OKUNUYOR, canlı durum dosyasından DEĞİL:
 * ölçüldü, 200 durum dosyasının 199'unda `kickoffISO` yok. Aynı sebeple bugün
 * home/away/country da fikstürden tamamlanmıştı (puanlama çarpanları bozuktu).
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const Season = require("../lib/season.cjs");

/**
 * ⚠️ CANLI `data/` DİZİNİ OKUNURKEN YARIŞ VAR — SÜİT ARADA BİR KIRILIYORDU.
 *
 * Sunucu çalışırken bu dosyalara sürekli yazılıyor (`livescore-sync` 30sn,
 * `mackolik-fixture-sync` 3dk, uzlaştırma anlık) ve yazma ATOMİK: önce
 * `*.tmp`, sonra rename. Okuma tam o ana denk gelirse dosya bir an yok olur
 * ya da yarım görünür — test ürün kusuru olmadığı hâlde kırılır.
 *
 * ÖLÇÜLDÜ (2026-08-02): 12 tam koşunun 1'inde kırılma. Bugün aynı kökten bir
 * kırılganlık `guvenli-yol-siniri` testinde de bulundu ve orada da atlanarak
 * çözüldü.
 *
 * ⚠️ SESSİZCE GEÇMİYOR: okunamazsa iddia ATLANIR ve sebep yazılır. Gerçek
 * veri üzerindeki bu kontroller birer akıl sağlığı ölçümü; çekirdek değişmez
 * değiller. Onları yüzünden süitin güvenilirliğini kaybetmek daha pahalı.
 */
function canliVeriOku(dosyaYolu) {
  for (let deneme = 0; deneme < 2; deneme++) {
    try {
      return JSON.parse(fs.readFileSync(dosyaYolu, "utf8"));
    } catch (e) {
      if (deneme === 1) {
        console.warn(`[test] canli veri okunamadi (${dosyaYolu}): ${e.message} — iddia atlaniyor`);
        return null;
      }
    }
  }
  return null;
}

describe("sezon sınırı", () => {
  test("saat dilimi Europe/Istanbul — UTC değil", () => {
    /* ⚠️ Sunucu UTC çalışıyor (Render). `getMonth()` kullanmak ayın ilk/son
     * gününde sezonu 3 saat kaydırırdı; aynı hata fikstür filtresinde
     * yaşanmıştı. Bu iddia düşerse aşağıdaki sınır testleri de anlamsızlaşır. */
    assert.equal(Season.seasonKey(new Date("2026-07-31T18:00:00Z")), "2026-07",
      "18:00 UTC = 21:00 Istanbul, hala Temmuz");
    assert.equal(Season.seasonKey(new Date("2026-07-31T21:30:00Z")), "2026-08",
      "21:30 UTC = 00:30 Istanbul, artik Agustos");
  });

  test("settle2 sezonu MAÇTAN türetiyor (kaynak kapısı)", () => {
    /**
     * ⚠️ Kusur tam olarak argümansız çağrıydı. Biri "sadeleştireyim" diye
     * geri alırsa her ay sonunda aynı kayma başlar ve HATA VERMEZ — yalnızca
     * puanlar yanlış tabloda görünür.
     */
    const src = fs.readFileSync(path.join(KOK, "routes", "settle2.cjs"), "utf8");
    const i = src.indexOf("Kümülatif sezon toplamları");
    assert.ok(i > 0, "sezon toplami blogu bulunamadi — test bir sey olcmuyor");
    const govde = src.slice(i, i + 2500);
    assert.ok(/FixturesStore\.getOne/.test(govde),
      "sezon yazmasi fikstur kaydini OKUMUYOR — mac sezonu bilinemez");
    assert.ok(/Season\.seasonKey\(new Date\(ko\)\)/.test(govde),
      "sezon MACIN kickoff undan turetilmiyor — ay sonu maclari sonraki aya yazilir");
  });

  test("sınır: ayın son gecesi oynanan maç ÖNCEKİ aya yazılır", () => {
    /* Gerçek veride görülen vakanın simülasyonu: maç 31 Temmuz akşamı,
     * ödül birkaç saat sonra — takvim günü aynı, sezon farklı. */
    const kickoff = new Date("2026-07-31T20:00:00Z");   // 23:00 Istanbul
    const odulAni = new Date("2026-07-31T22:15:00Z");   // 01:15 Istanbul, 1 Agustos
    assert.equal(Season.seasonKey(kickoff), "2026-07");
    assert.equal(Season.seasonKey(odulAni), "2026-08", "odul ani gercekten sonraki sezonda olmali");
    assert.notEqual(Season.seasonKey(kickoff), Season.seasonKey(odulAni),
      "senaryo sinirda degil — test bir sey olcmuyor");
  });

  test("TERS RİSK: normal maçlarda sezon DEĞİŞMEZ", () => {
    /**
     * ⚠️ ASIL TEHLİKE AŞIRI DÜZELTME. Sezonu geçmişe kaydırmak, ayın
     * ortasındaki maçlarda da olsaydı sıralama toptan bozulurdu. Ay içindeki
     * maçlarda kickoff ile ödül anı AYNI sezonda olmalı.
     */
    for (const [ko, odul] of [
      ["2026-07-15T12:00:00Z", "2026-07-15T14:00:00Z"],
      ["2026-08-10T18:00:00Z", "2026-08-10T20:30:00Z"],
      ["2026-08-01T09:00:00Z", "2026-08-01T11:00:00Z"],
    ]) {
      assert.equal(Season.seasonKey(new Date(ko)), Season.seasonKey(new Date(odul)),
        `${ko} ve ${odul} ayni sezonda olmali — asiri duzeltme`);
    }
  });

  test("season_totals'a YAZAN HERKES sezonu olaydan türetir", () => {
    /**
     * ⚠️ TEK KURAL, İKİ YAZAN. Bu koleksiyona yalnızca `routes/settle2.cjs`
     * ve `lib/kupon-settle.cjs` yazıyor. settle2 maçın kickoff'una geçtiğinde
     * kupon tarafı "şimdi"de kalmıştı ve ikisi AYRIŞMIŞTI — aynı tabloya iki
     * farklı kuralla yazmak sıralamayı sessizce tutarsız yapar.
     *
     * ⚠️ ÜÇÜNCÜ BİR YAZAN EKLENİRSE bu test onu yakalar. Kusurun bugünkü
     * biçimi tam olarak buydu: savunma bir yerde var, öbüründe yok.
     */
    const yazanlar = [];
    for (const dizin of ["lib", "routes", "services"]) {
      const d = path.join(KOK, dizin);
      if (!fs.existsSync(d)) continue;
      for (const ad of fs.readdirSync(d)) {
        if (!ad.endsWith(".cjs")) continue;
        const src = fs.readFileSync(path.join(d, ad), "utf8");
        // Yorum satırlarını sayma; yalnızca gerçek yazma çağrıları.
        const yaziyor = /collection\("season_totals"\)\s*\.\s*(bulkWrite|updateOne|updateMany|insertOne|insertMany)/.test(src);
        if (yaziyor) yazanlar.push({ yol: `${dizin}/${ad}`, src });
      }
    }

    assert.ok(yazanlar.length >= 2,
      `season_totals'a yazan ${yazanlar.length} dosya bulundu — tarama bozuk, test bir sey olcmuyor`);

    const kurallsiz = [];
    for (const { yol, src } of yazanlar) {
      /* Olaydan türetme izi: seasonKey'e BİR ARGÜMAN veriliyor mu?
       * `Season.seasonKey()` tek başına "şimdi" demektir. */
      if (!/Season\.seasonKey\(\s*[^)\s]/.test(src)) kurallsiz.push(yol);
    }
    assert.deepEqual(kurallsiz, [],
      "season_totals a SIMDIKI sezonla yazan dosya(lar): " + kurallsiz.join(", ") +
      "  — ay sonu puanlari yanlis aya duser");
  });

  test("GERÇEK veri: sapma oranı küçük kalmalı", () => {
    /**
     * Sapma büyükse sorun sınır değil, uzlaştırmanın topluca gecikmesidir —
     * o zaman bu düzeltme belirtiyi örter ve asıl neden aranmalı.
     */
    const D = process.env.SKORLIG_DATA_DIR || path.join(KOK, "data");
    const pr = path.join(D, "match-results.json");
    const pf = path.join(D, "fixtures.json");
    if (!fs.existsSync(pr) || !fs.existsSync(pf)) return;

    const rr = canliVeriOku(pr);
    if (!rr) return;
    const arr = Array.isArray(rr) ? rr : (rr.items || rr.snapshots || rr.list || []);
    const ff = canliVeriOku(pf);
    if (!ff) return;
    const fx = Array.isArray(ff) ? ff : (ff.list || ff.fixtures || []);
    if (!arr.length || !fx.length) return;

    const ko = new Map(fx.map((f) => [String(f.fixtureId), f.kickoffISO]));
    let eslesen = 0, sapma = 0;
    for (const s of arr) {
      const k = ko.get(String(s.fixtureId));
      if (!k || !s.awardedAt) continue;
      eslesen++;
      if (Season.seasonKey(new Date(k)) !== Season.seasonKey(new Date(s.awardedAt))) sapma++;
    }
    assert.ok(eslesen > 100, `yalnizca ${eslesen} kayit eslesti — tarama bozuk`);
    assert.ok(sapma / eslesen < 0.05,
      `snapshot'larin %${Math.round((sapma / eslesen) * 100)}'i sezon sinirinda (${sapma}/${eslesen}) — ` +
      "bu sinir davranisi degil, toplu gecikme olabilir; uzlastirma zinciri incelenmeli");
  });
});
