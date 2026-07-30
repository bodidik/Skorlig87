"use strict";

/**
 * HAFTALIK KUPON — oyun kuralları ve EKONOMİ.
 *
 * ⚠️ EN ÖNEMLİ TEST BURADA: `ekonomi` bloğu. Kupon ödülü HAVUZDAN DEĞİL,
 * başarıdan ÜRETİLİYOR — yani LC basıyor. Kademeler ortalama oyuncu için
 * giriş bedelinin ALTINDA kalacak şekilde ölçülerek seçildi. Biri "ödülü
 * artıralım" diye kademeleri yükseltirse bu test uyarır.
 *
 * Bu oturumda ekonominin sessizce şiştiği birkaç yol kapatıldı (koşulsuz
 * günlük hak, mini turnuva musluğu, mağaza mock modu). Kupon bilinçli bir
 * LC kaynağı ama ölçülü olmak zorunda.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const K = require("../lib/kupon.cjs");

describe("kupon — puanlama ve yüzdesel ceza", () => {
  test("doğru sayısıyla puan artar", () => {
    const p4 = K.puanla(4, 8), p6 = K.puanla(6, 8);
    assert.ok(p6.puan > p4.puan);
  });

  test("eşiğin ALTINDA yüzdesel ceza uygulanır", () => {
    const dusuk = K.puanla(2, 8);   // %25 — eşik %40'ın altında
    assert.ok(dusuk.ceza > 0, "ceza uygulanmamis");
    assert.equal(dusuk.puan, dusuk.taban - dusuk.ceza);
    // Ceza ORANSAL olmalı: kupon boyutundan bağımsız aynı caydırıcılık.
    assert.equal(dusuk.ceza, Math.round(dusuk.taban * K.CEZA_ORANI * 10) / 10);
  });

  test("eşiğin ÜSTÜNDE ceza yok", () => {
    assert.equal(K.puanla(4, 8).ceza, 0, "esik ustunde ceza var");
    assert.equal(K.puanla(8, 8).ceza, 0);
  });

  test("hiç doğru yoksa ceza da 0 — eksiye düşülmez", () => {
    const s = K.puanla(0, 8);
    assert.equal(s.ceza, 0);
    assert.equal(s.puan, 0);
  });

  test("tam kupon bonus alır", () => {
    assert.ok(K.puanla(8, 8).bonus > 0);
    assert.equal(K.puanla(7, 8).bonus, 0);
  });
});

describe("kupon — ödül kademeleri", () => {
  test("ödül orana göre, maç sayısına değil (8 ve 6 maçlık kupon uyumlu)", () => {
    assert.equal(K.odul(8, 8, K.TUR.ULKE), K.odul(6, 6, K.TUR.ULKE));
  });

  test("eşik altı ödül vermez", () => {
    assert.equal(K.odul(4, 8, K.TUR.ULKE), 0, "yarisini bilen odul aliyor");
    assert.ok(K.odul(5, 8, K.TUR.ULKE) > 0);
  });

  test("Avrupa kuponu daha yüksek öder (daha zor, girişi de pahalı)", () => {
    assert.ok(K.odul(6, 6, K.TUR.AVRUPA) > K.odul(8, 8, K.TUR.ULKE));
    assert.ok(K.GIRIS_BEDELI[K.TUR.AVRUPA] > K.GIRIS_BEDELI[K.TUR.ULKE]);
  });
});

describe("kupon — EKONOMİ (LC basıyor, ölçülü olmalı)", () => {
  /**
   * Beklenen ödül, isabet olasılığına göre binom dağılımıyla hesaplanır.
   * Ortalama bir oyuncu 1X2'de %45-50 tutturur; bu aralıkta oyun LC YAKMALI.
   */
  test("rastgele oynayan (%33) net KAYBEDER", () => {
    const b = K.beklenenOdul(1 / 3, 8, K.TUR.ULKE);
    assert.ok(b < K.GIRIS_BEDELI[K.TUR.ULKE],
      `rastgele oyuncu kar ediyor (${b} >= ${K.GIRIS_BEDELI[K.TUR.ULKE]}) — LC muslugu`);
  });

  test("ortalama oyuncu (%50) net KAYBEDER", () => {
    const b = K.beklenenOdul(0.5, 8, K.TUR.ULKE);
    assert.ok(b < K.GIRIS_BEDELI[K.TUR.ULKE],
      `ortalama oyuncuda oyun LC basiyor (${b}) — kademeler fazla comert`);
  });

  test("Avrupa kuponu da ortalama oyuncuda kaybettirir", () => {
    const b = K.beklenenOdul(0.5, 6, K.TUR.AVRUPA);
    assert.ok(b < K.GIRIS_BEDELI[K.TUR.AVRUPA], `avrupa kuponu LC basiyor (${b})`);
  });

  test("gerçekten iyi oyuncu (%60) kazanabilmeli — oyun oynanabilir kalsın", () => {
    const b = K.beklenenOdul(0.6, 8, K.TUR.ULKE);
    assert.ok(b > K.GIRIS_BEDELI[K.TUR.ULKE] * 0.9,
      "cok iyi oyuncu bile kaybediyor — odul anlamsiz, kimse oynamaz");
  });

  test("kupon tek tek oynamaktan UCUZ olmalı", () => {
    const { MAC_GIRIS_BEDELI } = require("../lib/ekonomi.cjs");
    const tekTek = MAC_GIRIS_BEDELI * K.MAC_SAYISI[K.TUR.ULKE];
    assert.ok(K.GIRIS_BEDELI[K.TUR.ULKE] < tekTek,
      `kupon (${K.GIRIS_BEDELI[K.TUR.ULKE]}) tek tek oynamaktan (${tekTek}) pahali — anlamsiz`);
  });
});

describe("kupon planlayıcı — otomatik kurulum", () => {
  /**
   * Kuponları elle kurmak yayında sürdürülebilir değil: her hafta, her ülke
   * için ayrı çağrı gerekirdi. Planlayıcı eksikleri kurar.
   *
   * ⚠️ İDEMPOTENT OLMAK ZORUNDA: servis 6 saatte bir çalışıyor. İkinci tur
   * yeni kupon üretirse aynı hafta için iki kupon oluşur, oyuncu iki kez öder
   * ve tablo bölünür. Benzersiz indeks (haftaKey+tur+ulke) bunu engelliyor
   * ama davranışı burada da sabitliyoruz.
   */
  const P = require("../services/kupon-planlayici.cjs");

  test("birden çok hafta ileri bakar ve anahtarlar tekil", () => {
    // ⚠️ Önce 2 haftaydı; üretim verisinde ölçülünce yetmediği görüldü
    // (önümüzdeki iki haftada 3 ve 17 maç, W33'te 51). Ufuk 4 haftaya çıktı.
    const h = P._haftaAnahtarlari();
    assert.ok(h.length >= 2, "ufuk cok dar — hic kupon kurulamaz");
    assert.equal(new Set(h).size, h.length, "ayni hafta iki kez listelenmis");
    for (const k of h) assert.ok(/^\d{4}-W\d{2}$/.test(k), `gecersiz hafta anahtari: ${k}`);
  });

  test("ana şalter listesinde yer alıyor (test sunucusu servisi açmasın)", () => {
    const fs = require("fs");
    const path = require("path");
    const srv = fs.readFileSync(path.join(__dirname, "..", "server.cjs"), "utf8");
    const i = srv.indexOf("const KAPAT = [");
    const liste = srv.slice(i, srv.indexOf("]", i));
    assert.ok(liste.includes("SKORLIG_KUPON_PLAN"),
      "yeni arka plan servisi ana saltere eklenmemis — SKORLIG_BG=0 onu kapatmaz");
  });
});

describe("kupon — katılım kilidi ilk maçtan ÖNCE kapanır", () => {
  /**
   * ⚠️ Kilit ilk maçın tam başlama anı DEĞİL, ondan KILIT_ONCE_DK dakika önce.
   *
   * Sebep: fikstür saatleri dış kaynaklardan geliyor ve gecikmeli/yanlış
   * olabiliyor. Tampon olmadan, maç fiilen başlamışken kupon "açık" görünür ve
   * sonucu bilerek katılmak mümkün olurdu. Aynı sınıf risk bu oturumda
   * `pred.cjs` ve `duels.cjs` kilitlerinde de bulunmuştu.
   *
   * Tampon KISALTILIRSA bu test uyarır — düşürmeden önce fikstür saatlerinin
   * güvenilirliğini ölç.
   */
  const K = require("../lib/kupon.cjs");
  const fs = require("fs");
  const path = require("path");

  test("tampon tanımlı ve sıfırdan büyük", () => {
    assert.ok(Number.isFinite(K.KILIT_ONCE_DK));
    assert.ok(K.KILIT_ONCE_DK > 0,
      "tampon 0 — mac baslamisken katilim mumkun olur (fikstur saatleri gecikmeli olabiliyor)");
  });

  test("kupon kurulurken kilit ilk kickoff'tan tampon kadar geriye alınıyor", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "kupon.cjs"), "utf8");
    assert.ok(/KILIT_ONCE_DK\s*\*\s*60\s*\*\s*1000/.test(src),
      "kilit hesabinda tampon kullanilmiyor — kilitISO dogrudan kickoff olabilir");
    assert.ok(!/kilitISO:\s*ilkKickoff\s*[,;]/.test(src),
      "kilitISO hala dogrudan ilk kickoff");
  });
});

describe("kupon — ülke eşleşmesi ve kümülatif sıralama", () => {
  /**
   * ⚠️ ÜLKE ADI EŞLEŞMESİ GEVŞEK OLMALI. Fikstürler İngilizce yazıyor
   * ("Turkey"), kullanıcı profili Türkçe ("Türkiye"). Düz eşitlik kullanınca
   * Türk kullanıcıya HİÇ kupon çıkmıyordu — üretim verisinde ölçüldü: 0 maç.
   * Beşinci bir karşılaştırma yazmak yerine fikstür boru hattının kullandığı
   * `sameCountry` kullanılıyor.
   */
  const fs = require("fs");
  const path = require("path");
  const { sameCountry } = require("../lib/fixture-priority.cjs");

  test("Türkiye ↔ Turkey eşleşiyor", () => {
    assert.ok(sameCountry("Turkey", "Türkiye"));
    assert.ok(sameCountry("Türkiye", "turkey"));
    assert.ok(!sameCountry("Turkey", "England"));
  });

  test("kupon maç süzgeci düz eşitlik KULLANMIYOR", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "kupon.cjs"), "utf8");
    assert.ok(/sameCountry\(f\.country, ulke\)/.test(src),
      "ulke suzgeci gevsek karsilastirma kullanmiyor");
    assert.ok(!/String\(f\.country \|\| ""\) === ulke/.test(src),
      "duz esitlik geri gelmis — Turk kullaniciya kupon cikmaz");
  });

  test("planlayıcı ufku 2 haftadan geniş (fikstürler ileride yoğunlaşıyor)", () => {
    const P = require("../services/kupon-planlayici.cjs");
    const h = P._haftaAnahtarlari();
    assert.ok(h.length >= 4,
      `ufuk ${h.length} hafta — uretim verisinde onumuzdeki 2 haftada 3 ve 17 mac vardi, hic kupon kurulamiyordu`);
  });
});
