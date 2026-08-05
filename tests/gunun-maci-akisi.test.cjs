"use strict";

/**
 * GÜNÜN MAÇI AKIŞI BAĞLI: KART EKRANDA, TAHMİN SONRASI SIRALAMA VAR.
 *
 * ⚠️ BULUNAN: `components/DailyMatchCard.tsx` tasarlanmış, yazılmış ve
 * HİÇBİR EKRANA BAĞLANMAMIŞTI — ölü kod. Besleyen uç
 * (`/api/live/daily-featured`) de askıdaki API-Football'a gidip her çağrıda
 * `fixture: null` dönüyordu. İkisi birlikte: tasarlanmış bir akış hiç
 * çalışmıyordu ve kimse fark etmiyordu, çünkü ortada hata yoktu.
 *
 * NEDEN ÖNEMLİ: yeni kullanıcı onboarding'den sonra doğrudan ham maç
 * listesine düşüyor ve altı tahmin türü rozetiyle karşılaşıyor. "Ne yapacağım"
 * sorusunun cevabı yok. Kart tek maç için tek soru soruyor (1-X-2), tahmini
 * alıyor ve o maçın sıralamasına götürüyor — kapalı, kısa bir döngü.
 *
 * Bu test AKIŞIN BAĞLI KALMASINI koruyor. Uç tarafı ayrı dosyada
 * (`gunun-maci-kaynak.test.cjs`).
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

const { mobilYol, mobilVarMi } = require("./_mobil-dizin.cjs");

function kaynak(...parcalar) {
  const p = mobilYol(...parcalar);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

/** Yorum satırlarını eler — belge metni koda karışmasın. */
function kod(src) {
  return String(src || "")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("mobil depo GERÇEKTEN bulunuyor", () => {
    /**
     * ⚠️ Bu depoda 33 iddia, mobil yolu bulunamadığı için SESSİZCE atlanıyordu
     * (worktree'de `../mobile` yok). Atlanan nöbetçi, yalan söyleyen
     * nöbetçidir — bkz. tests/_mobil-dizin.cjs.
     */
    assert.ok(
      mobilVarMi(),
      "mobil depo bulunamadi — asagidaki iddialar sessizce atlanirdi"
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kart ekrana bağlı", () => {
  test("live ekranı DailyMatchCard'ı içe aktarıyor VE çiziyor", () => {
    const src = kod(kaynak("app", "(tabs)", "live.tsx"));
    assert.ok(src, "live.tsx okunamadi");

    assert.ok(
      /import\s+DailyMatchCard\s+from/.test(src),
      "live.tsx DailyMatchCard'i ice aktarmiyor"
    );
    assert.ok(
      /<DailyMatchCard[\s/>]/.test(src),
      "DailyMatchCard ice aktarilmis ama CIZILMIYOR — ice aktarim tek basina " +
      "karti ekrana koymaz, bilesen yine olu kalir"
    );
  });

  test("karta ülke ve kullanıcı geçiliyor (kişiselleştirme çalışsın)", () => {
    /* Uç sıralamayı bunlara göre yapıyor: takım → ülke → saat. Prop
     * geçilmezse herkes aynı listeyi görür ve "senin maçın" fikri ölür. */
    const src = kod(kaynak("app", "(tabs)", "live.tsx"));
    const m = src.match(/<DailyMatchCard([^/>]*)/);
    assert.ok(m, "DailyMatchCard cagrisi bulunamadi");
    const proplar = m[1];

    assert.ok(/country=/.test(proplar), `country prop'u yok: ${proplar.trim()}`);
    assert.ok(/userId=/.test(proplar), `userId prop'u yok: ${proplar.trim()}`);
  });

  test("kart yalnızca maç listesi modlarında görünüyor", () => {
    /* Turnuva/1987 modlarında ekran kendi içeriğine odaklı; oraya da koymak
     * kullanıcıyı bölerdi. */
    const src = kod(kaynak("app", "(tabs)", "live.tsx"));
    const i = src.indexOf("<DailyMatchCard");
    assert.ok(i > 0, "DailyMatchCard bulunamadi");

    /* Çağrıdan önceki kısa pencerede bir mod koşulu olmalı. */
    const oncesi = src.slice(Math.max(0, i - 200), i);
    assert.ok(
      /mode\s*===/.test(oncesi),
      "kart mod kosulu OLMADAN ciziliyor — turnuva/1987 ekranlarinda da cikar"
    );
  });
});

describe("tahmin sonrası sıralamaya götürüyor", () => {
  test("kart match-race ekranına yönlendiriyor", () => {
    /**
     * Döngüyü kapatan adım. Kart tahmini alıyordu ama sonrası yoktu:
     * "kaydedildi" yazısı çıkıyor, kullanıcı ne yapacağını bilmiyordu.
     * Asıl geri bildirim "bu maçta kaç kişi arasında neredeyim".
     */
    const src = kod(kaynak("components", "DailyMatchCard.tsx"));
    assert.ok(src, "DailyMatchCard.tsx okunamadi");

    assert.ok(
      /match-race/.test(src),
      "kart match-race ekranina yonlendirmiyor — tahmin sonrasi donguyu " +
      "kapatan adim yok"
    );
  });

  test("yönlendirme tahmin SONRASINA bağlı", () => {
    /* Tahmin yapılmadan sıralamaya göndermek anlamsız: kullanıcı listede
     * olmaz. `submitted` koşulu bunu tutuyor. */
    const src = kod(kaynak("components", "DailyMatchCard.tsx"));
    const i = src.indexOf("match-race");
    assert.ok(i > 0, "match-race bulunamadi");

    const oncesi = src.slice(Math.max(0, i - 400), i);
    assert.ok(
      /submitted/.test(oncesi),
      "match-race baglantisi `submitted` kosuluna bagli degil — tahmin " +
      "yapmamis kullanici kendini bulamayacagi bir siralamaya gonderilir"
    );
  });

  test("fixtureId ve userId taşınıyor", () => {
    /* `match-race/[fixtureId]` ikisini de bekliyor; userId gitmezse ekran
     * "demo1"e düşüyor ve kullanıcı BAŞKASININ sırasını görür. */
    const src = kod(kaynak("components", "DailyMatchCard.tsx"));
    const i = src.indexOf("match-race");
    const pencere = src.slice(i, i + 300);

    assert.ok(/fixtureId/.test(pencere), `fixtureId tasinmiyor: ${pencere.slice(0, 120)}`);
    assert.ok(
      /userId/.test(pencere),
      "userId tasinmiyor — match-race ekrani 'demo1'e dusuyor ve kullanici " +
      "baskasinin sirasini gorur"
    );
  });
});

describe("çeviriler", () => {
  test("yeni anahtar tr ve en'de var", () => {
    const src = kaynak("lib", "i18n.ts");
    assert.ok(src, "i18n.ts okunamadi");
    const kacKez = (src.match(/seeMatchRank\s*:/g) || []).length;
    assert.ok(
      kacKez >= 2,
      `seeMatchRank ${kacKez} dilde tanimli — tr ve en ikisinde de olmali, ` +
      `yoksa bir dilde ham anahtar gorunur`
    );
  });
});
