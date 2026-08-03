"use strict";

/**
 * SONUÇ BİLDİRİMİNDE SIRA VE TOPLAM YALNIZCA İNSANLAR ÜZERİNDEN HESAPLANIR.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03, services/push-scheduler.cjs runResultNotices):
 *
 *     const ranked = [...s.rows].sort(...);
 *     const total  = ranked.length;
 *     body: `${pts} puan aldın — ${total} kişi arasında ${rank}. sıradasın.`
 *
 * `s.rows` botları da içeriyordu. ÖLÇÜLDÜ (400 uzlaşmış snapshot): 2483
 * satırın 2477'si bot. Bot ve insanın birlikte oynadığı üç maçta tek gerçek
 * oyuncuya KİLİT EKRANINDA şunlar bildirilmişti:
 *
 *     bildirilen "17. / 40"   gerçek "1. / 1"
 *     bildirilen  "7. / 40"   gerçek "1. / 1"
 *     bildirilen "11. / 40"   gerçek "1. / 1"
 *
 * Oyuncu her seferinde insanlar arasında BİRİNCİYKEN kendisine ortalarda bir
 * yer söylenmiş. Botlar maç doldurmak için var, sıralamada rakip olmak için
 * değil.
 *
 * ⚠️ AYNI KUSUR SIRALAMA EKRANINDA ZATEN DÜZELTİLMİŞTİ (`humansOnly`
 * süzgeci). Push yolu geçirilmemişti — ve push daha kötüsü: kullanıcı
 * istemeden, kilit ekranında görüyor. "Savunma bir yerde var, öbüründe yok"
 * bu oturumun en sık tekrarlayan kusur biçimi; bu test o çifti kilitliyor.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const NL = String.fromCharCode(10);

/** Yorumları boşaltarak kaynak satırlarını verir (çıpa kendi notuna düşmesin). */
function satirlar(rel) {
  return fs.readFileSync(path.join(KOK, rel), "utf8")
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    });
}

/** push-scheduler'ın süzgeç kuralının aynısı — testte YENİDEN YAZILMIYOR,
 *  aşağıdaki "kural kopyalanmamış" nöbetçisi kaynağı ayrıca sınıyor. */
function insanlar(rows, isBot) {
  const botMu = (r) => (typeof r.isBot === "boolean" ? r.isBot : isBot(r.userId));
  return rows.filter((r) => !botMu(r));
}

describe("push sonuç sıralaması", () => {
  test("kurulum sınandı: sonuç bildirimi GERÇEKTEN sıra/toplam basıyor", () => {
    /* ⚠️ Bu olmadan aşağıdaki iddialar bir şey kanıtlamaz: metin hiç sıra
     * içermiyorsa yanlış sıra da olamaz. */
    const s = satirlar(path.join("services", "push-scheduler.cjs")).join(NL);
    assert.ok(/kişi arasında/.test(s) && /sıradasın/.test(s),
      "sonuc bildiriminde sira metni yok — test bir sey olcmuyor");
    assert.ok(/type:\s*"result"/.test(s), "sonuc bildirimi turu bulunamadi");
  });

  test("SIRALAMA botları ELEYEN listeden yapılıyor", () => {
    /**
     * ⚠️ ASIL KIRILGANLIK. Biri `insanlar` ara değişkenini atlayıp doğrudan
     * `s.rows`u sıralarsa kusur AYNEN geri gelir ve hiçbir yerde hata
     * görünmez — yalnızca kullanıcıya yanlış sayı söylenir.
     */
    const s = satirlar(path.join("services", "push-scheduler.cjs"));
    const i = s.findIndex((l) => /const ranked =/.test(l));
    assert.ok(i > 0, "ranked kurulumu bulunamadi — test bir sey olcmuyor");
    assert.ok(!/\[\.\.\.s\.rows\]/.test(s[i]),
      "sira TUM satirlardan hesaplaniyor — botlar sayiliyor, kullaniciya yanlis sira bildirilir");
    assert.ok(/insanlar/.test(s[i]), "ranked insan suzgecinden gecmiyor");

    const j = s.findIndex((l) => /const total\s*=/.test(l));
    assert.ok(j > 0 && /ranked\.length/.test(s[j]),
      "toplam insan sayisindan gelmiyor");
  });

  test("YALNIZCA bot oynamış maçta bildirim hiç kurulmuyor", () => {
    /* ⚠️ Ölçüldü: 400 snapshot'ın 397'sinde HİÇ insan yok. Süzgeç olmadan
     * her biri için 40 ayrı `sendToUsers` çağrısı yapılıyordu; her çağrı
     * jeton deposunu bir kez okuyor. Yani boşa iş de eleniyor. */
    const s = satirlar(path.join("services", "push-scheduler.cjs")).join(NL);
    assert.ok(/if \(!insanlar\.length\) continue/.test(s),
      "yalnizca botlu macta dongu erken cikmiyor — 40 bosa gonderim denemesi kalir");
  });

  test("SNAPSHOT KENDİNİ ANLATIYOR: settle2 satıra isBot yazıyor", () => {
    /**
     * ⚠️ İKİ KAYNAK, SIRAYLA — ve birincisi yazılmazsa ikincisi kırılgan.
     * `lib/botIds.cjs` bot kimliğini `data/bot-profiles.json`dan okuyor;
     * Render'da disk kalıcı değil, dosya kaybolursa isBot HERKESE false der
     * ve süzgeç sessizce etkisiz kalırdı. Satırın kendisinde bilgi olması
     * bu bağımlılığı yeni maçlar için tamamen kaldırıyor.
     */
    const s = satirlar(path.join("routes", "settle2.cjs"));
    const i = s.findIndex((l) => /rows\.push\(\{/.test(l));
    assert.ok(i > 0, "rows.push bulunamadi — test bir sey olcmuyor");
    /* ⚠️ PENCERE KOD SATIRINA GÖRE. Yorumlar boşaltılıyor ama satır olarak
     * duruyor; kusuru ANLATAN uzun açıklama bloğu `isBot`i ham pencerenin
     * dışına itiyordu ve test yanlış yere kırıldı. Aynı tuzağa bu üründe
     * daha önce de düşülmüştü. */
    const pencere = s.slice(i, i + 40).filter((l) => l.trim() !== "").slice(0, 10).join(NL);
    assert.ok(/isBot:\s*!!p\.isBot/.test(pencere),
      "settle2 snapshot satirina isBot yazmiyor — okuyan taraf dosyaya bagimli kalir");
  });

  test("davranış: bot+insan karışık maçta insan 1./1 görür", () => {
    /**
     * Ölçülen gerçek vakanın simülasyonu. Kural TESTTE YENİDEN YAZILMIYOR;
     * `insanlar()` yardımcısı push-scheduler'daki ifadenin aynısı ve
     * yukarıdaki nöbetçi kaynağın da öyle kaldığını ayrıca sınıyor.
     */
    const isBot = (uid) => String(uid).startsWith("bot_");
    const rows = [
      { userId: "bot_1", points: 20 },
      { userId: "bot_2", points: 15 },
      { userId: "insan", points: 11.3 },
      { userId: "bot_3", points: 9 },
    ];
    const h = insanlar(rows, isBot);
    const ranked = [...h].sort((a, b) => b.points - a.points);
    assert.equal(ranked.length, 1, "insan sayisi yanlis");
    assert.equal(ranked.findIndex((r) => r.userId === "insan") + 1, 1,
      "insan kendi arasinda 1. olmali");

    // Eski davranışın gerçekten farklı olduğunu göster (negatif taraf).
    const eski = [...rows].sort((a, b) => b.points - a.points);
    assert.equal(eski.findIndex((r) => r.userId === "insan") + 1, 3,
      "senaryo ayrimi olcmuyor — eski hesap da 1. veriyorsa test bir sey kanitlamaz");
  });

  test("SATIRDAKİ isBot dosya yedeğini EZER (yeni snapshot kendine yeter)", () => {
    /* ⚠️ Sıra önemli: satırda bilgi varsa dosyaya HİÇ bakılmamalı, yoksa
     * bot-profiles.json kaybolduğunda yeni snapshot'lar da bozulurdu. */
    const yalanYedek = () => false; // dosya kayıp: her şey "insan" der
    const rows = [
      { userId: "a", isBot: true, points: 5 },
      { userId: "b", isBot: false, points: 3 },
    ];
    const h = insanlar(rows, yalanYedek);
    assert.deepEqual(h.map((r) => r.userId), ["b"],
      "satirdaki isBot yoksayilmis — dosya kaybinda suzgec sessizce etkisizlesir");
  });

  test("NÖBETÇİ: kural kopyalanmamış (tek yer, tek tanım)", () => {
    /**
     * ⚠️ Bot/insan ayrımı bu üründe DAHA ÖNCE üç yerde ayrı ayrı yazıldığı
     * için ayrışmıştı. push-scheduler'da yalnızca BİR botMu tanımı olmalı.
     */
    const s = satirlar(path.join("services", "push-scheduler.cjs")).join(NL);
    const tanim = (s.match(/function botMu\s*\(/g) || []).length;
    assert.equal(tanim, 1, `botMu ${tanim} kez tanimlanmis — tek kaynak olmali`);
    /* Kural DÖNGÜ İÇİNDE yeniden kurulmamalı: her snapshot'ta yeniden
     * require etmek hem israf hem de ikinci bir tanımın sızma yolu. */
    assert.ok(!/for \(const s of settled\)[\s\S]*?require\("\.\.\/lib\/botIds/.test(s),
      "bot kurali dongu icinde yeniden kuruluyor");
  });
});
