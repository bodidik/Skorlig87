"use strict";

/**
 * BİLDİRİM TERCİHİ HER GÖNDERİMDE UYGULANMALI.
 *
 * ⚠️ BU TURDA KUSUR BULUNMADI — tüm çağrı noktaları `type` gönderiyor, yani
 * tercihler bugün uygulanıyor. Kilitlenen şey, sessizce bozulabilecek olması.
 *
 * ⚠️ NEDEN KIRILGAN: `services/push.cjs` süzgeci KOŞULLU —
 *
 *     if (type && PREF_KEYS.includes(type) && prefs[type] === false) continue;
 *
 * `type` YOKSA tercih hiç bakılmıyor. Yani yeni bir çağıran `type` koymayı
 * unutursa, bildirimi KAPATMIŞ kullanıcıya da gönderilir ve bu hiçbir yerde
 * hata üretmez — sessizce yanlış davranır. Play Store, kullanıcının bildirimi
 * kapatabilmesini şart koşuyor.
 *
 * ÖLÇÜLDÜ (bu tur): `sendToUsers` çağıran 5 nokta var, `routes/push.cjs`
 * içindeki yönetici deneme ucu dışında hepsi `type` taşıyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const push = require("../services/push.cjs");

/** Yorumları boşaltır. */
function kodu(p) {
  return fs.readFileSync(p, "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

/**
 * `type` taşımadan gönderim yapması KABUL EDİLEN yerler.
 * Her biri gerekçeli — gerekçesiz muafiyet, kuralın kendisini boşa çıkarır.
 */
const MUAF = {
  "routes/push.cjs":
    "yonetici deneme ucu (POST /api/push/test): tanilama amacli, kullanicinin " +
    "tercihine bakmadan gonderiyor ve yalnizca yonetici jetonuyla cagrilabilir",
};

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tercih anahtarları ve varsayılanlar okunabiliyor", () => {
    assert.ok(Array.isArray(push.PREF_KEYS) && push.PREF_KEYS.length >= 3,
      `PREF_KEYS beklenenden kucuk: ${JSON.stringify(push.PREF_KEYS)}`);
    for (const k of push.PREF_KEYS) {
      assert.ok(k in push.DEFAULT_PREFS, `${k} icin varsayilan yok`);
    }
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("gönderim çağrıları", () => {
  test("her sendToUsers çağrısı `type` taşıyor", () => {
    const kusurlu = [];
    let bakilan = 0;

    for (const alt of ["routes", "services", "lib"]) {
      const d = path.join(KOK, alt);
      if (!fs.existsSync(d)) continue;
      for (const dosya of fs.readdirSync(d)) {
        if (!dosya.endsWith(".cjs")) continue;
        const ad = `${alt}/${dosya}`;
        if (ad === "services/push.cjs") continue;          // tanımın kendisi
        const src = kodu(path.join(d, dosya));

        // `sendToUsers(<hedef>, { ... })` VEYA
        // `sendBulkPersonalized` girişlerindeki `payload: { ... }`.
        // Her ikisi de `type` taşımalı — yoksa tercih süzgeci devre dışı kalır.
        const re = /(?:sendToUsers\(\s*[^,]+,\s*\{|payload:\s*\{)([\s\S]{0,220})/g;
        let m;
        while ((m = re.exec(src))) {
          bakilan++;
          if (/\btype\s*:/.test(m[1])) continue;
          if (MUAF[ad]) continue;
          const satir = src.slice(0, m.index).split("\n").length;
          kusurlu.push(`${ad}:${satir}`);
        }
      }
    }

    /* ⚠️ ÖNCESİ: 5 sendToUsers çağrısı. Sonuç bildirimi sendBulkPersonalized'a
     * taşındı — artık `payload:` kalıbı yakalanıyor, sendToUsers sayısı düştü
     * ama toplam gönderim noktası aynı kalmalı. */
    assert.ok(bakilan >= 3, `cok az cagri bulundu (${bakilan}) — tarama bozulmus olabilir`);
    assert.deepStrictEqual(
      kusurlu, [],
      "Bu gonderimler `type` tasimiyor. Suzgec kosullu oldugu icin tercih HIC\n" +
        "bakilmaz: bildirimi kapatmis kullaniciya da gider ve hata uretmez:\n" +
        kusurlu.join("\n")
    );
  });

  test("muafiyet listesi bayat değil", () => {
    // Muaf dosya artık `sendToUsers` çağırmıyorsa muafiyet de kalkmalı.
    const gereksiz = Object.keys(MUAF).filter((ad) => {
      const p = path.join(KOK, ad);
      if (!fs.existsSync(p)) return true;
      return !/sendToUsers\(|sendBulkPersonalized\(/.test(kodu(p));
    });
    assert.deepStrictEqual(
      gereksiz, [],
      "Bu dosyalar artik gonderim yapmiyor, MUAF listesinden cikarilmali:\n" +
        gereksiz.join("\n")
    );
  });

  test("kullanılan her `type` gerçek bir tercih anahtarı", () => {
    /**
     * `type: "duello"` gibi yanlış yazılmış bir değer, `PREF_KEYS.includes`
     * denetiminden geçemez ve süzgeç yine devre dışı kalır — `type` koymayı
     * unutmakla aynı sonuç, ama gözle fark edilmez.
     */
    const kusurlu = [];
    for (const alt of ["routes", "services"]) {
      const d = path.join(KOK, alt);
      for (const dosya of fs.readdirSync(d)) {
        if (!dosya.endsWith(".cjs") || `${alt}/${dosya}` === "services/push.cjs") continue;
        const src = kodu(path.join(d, dosya));
        for (const m of src.matchAll(/\btype:\s*"([a-zA-Z_]+)"/g)) {
          // Yalnızca gönderim bağlamındakiler; başka `type` alanları olabilir.
          const once = src.slice(Math.max(0, m.index - 260), m.index);
          if (!/sendToUsers\(|notify\(/.test(once)) continue;
          if (!push.PREF_KEYS.includes(m[1])) {
            kusurlu.push(`${alt}/${dosya}: "${m[1]}" bir tercih anahtari degil`);
          }
        }
      }
    }
    assert.deepStrictEqual(
      kusurlu, [],
      "Tanimsiz bildirim turu — suzgec devre disi kalir:\n" + kusurlu.join("\n")
    );
  });
});

/* ── Süzgecin kendisi ────────────────────────────────────────────────────── */

test("NÖBETÇİ: süzgeç tercihi `false` olanı atlıyor", () => {
  const src = kodu(path.join(KOK, "services", "push.cjs"));
  assert.ok(
    /PREF_KEYS\.includes\(type\)[\s\S]{0,40}prefs\[type\] === false[\s\S]{0,20}continue/.test(src),
    "tercih suzgeci kaldirilmis ya da degismis"
  );
});
