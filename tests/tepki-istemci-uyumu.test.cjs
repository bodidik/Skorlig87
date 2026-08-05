"use strict";

/**
 * TEPKİ LİSTESİ SUNUCU ↔ İSTEMCİ UYUMU + ÇUBUK EKRANA BAĞLI.
 *
 * İKİ AYRI SESSİZ KOPUŞ KORUNUYOR:
 *
 * 1) ANAHTAR AYRIŞMASI. İzin verilen liste sunucuda (`TEPKILER`), metin
 *    istemcide (`react_*`). Sunucuya yeni tepki eklenip i18n unutulursa düğmede
 *    HAM ANAHTAR görünür ("react_vole"). Ters yön daha kötü: i18n'de olup
 *    sunucuda olmayan bir anahtar, basıldığında 400 döner — kullanıcı sebebini
 *    hiç öğrenemez. İkisi de hata vermeden yanlış çalışır.
 *
 *    ⚠️ İstemci `t(\`react_${k}\` as any)` kullanıyor; `as any` tsc'nin bu
 *    ayrışmayı yakalamasını ENGELLİYOR. Tür denetimi burada yardım etmediği
 *    için koruma bu teste düşüyor.
 *
 * 2) BAĞLANMAMIŞ BİLEŞEN. Aynı gün `DailyMatchCard` yazılmış ama hiçbir ekrana
 *    bağlanmamış hâlde bulundu — ölü kod, ortada hata yok. Aynı kopuş burada
 *    tekrarlanmasın.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { mobilYol, mobilVarMi } = require("./_mobil-dizin.cjs");
const { TEPKILER } = require(path.join(KOK, "lib", "reactions-store.cjs"));

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

describe("kurulum", () => {
  test("mobil depo GERÇEKTEN bulunuyor", () => {
    /* Atlanan nöbetçi, yalan söyleyen nöbetçidir — bkz. tests/_mobil-dizin.cjs. */
    assert.ok(mobilVarMi(), "mobil depo bulunamadi — asagidaki iddialar sessizce atlanirdi");
  });

  test("sunucu listesi BOŞ DEĞİL", () => {
    /* Negatif kontrol: liste boşalsa aşağıdaki döngüler sıfır iddia çalıştırır
     * ve test hiçbir şey ölçmeden geçerdi. */
    assert.ok(TEPKILER.length >= 4, `sunucu tepki listesi cok kisa: ${TEPKILER.length}`);
  });
});

describe("anahtar uyumu", () => {
  test("her sunucu anahtarının tr VE en karşılığı var", () => {
    const src = kaynak("lib", "i18n.ts");
    assert.ok(src, "i18n.ts okunamadi");

    const eksik = [];
    for (const k of TEPKILER) {
      const kere = (src.match(new RegExp(`\\breact_${k}\\s*:`, "g")) || []).length;
      if (kere < 2) eksik.push(`react_${k} (${kere} dil)`);
    }
    assert.deepEqual(
      eksik, [],
      "i18n karsiligi eksik — dugmede HAM ANAHTAR gorunur: " + eksik.join(", ")
    );
  });

  test("i18n'de sunucuda OLMAYAN tepki anahtarı yok", () => {
    /* Ters yön: kullanıcı basar, sunucu 400 der, sebep hiç görünmez. */
    const src = kaynak("lib", "i18n.ts");
    const bulunanlar = new Set(
      [...src.matchAll(/\breact_([a-z0-9]+)\s*:/g)].map((m) => m[1])
    );
    const sunucu = new Set(TEPKILER);
    const fazla = [...bulunanlar].filter((k) => !sunucu.has(k));
    assert.deepEqual(
      fazla, [],
      "i18n'de sunucunun tanimadigi tepki var — basildiginda sessizce 400 doner: " +
      fazla.join(", ")
    );
  });

  test("her sunucu anahtarının bir emojisi var", () => {
    const src = kod(kaynak("components", "ReactionBar.tsx"));
    assert.ok(src, "ReactionBar.tsx okunamadi");
    const emojiBlok = src.slice(src.indexOf("const EMOJI"), src.indexOf("const EMOJI") + 600);

    const eksik = TEPKILER.filter((k) => !new RegExp(`\\b${k}\\s*:`).test(emojiBlok));
    assert.deepEqual(eksik, [], "emoji tablosunda eksik anahtar: " + eksik.join(", "));
  });
});

describe("çubuk ekrana bağlı", () => {
  test("match-race ReactionBar'ı içe aktarıyor VE çiziyor", () => {
    const src = kod(kaynak("app", "match-race", "[fixtureId].tsx"));
    assert.ok(src, "match-race ekrani okunamadi");

    assert.ok(/import\s+ReactionBar\s+from/.test(src), "ReactionBar ice aktarilmiyor");
    assert.ok(
      /<ReactionBar[\s/>]/.test(src),
      "ReactionBar ice aktarilmis ama CIZILMIYOR — ice aktarim tek basina " +
      "bileseni ekrana koymaz, olu kod kalir"
    );
  });

  test("çubuk maç ÖNCESİ ve CANLI iki dalda da var", () => {
    /* Yalnızca canlı dala koymak, maç öncesi odayı bomboş bırakırdı — oysa
     * kullanıcıların çoğu maçtan önce giriyor. */
    const src = kod(kaynak("app", "match-race", "[fixtureId].tsx"));
    const kere = (src.match(/<ReactionBar/g) || []).length;
    assert.ok(kere >= 2, `ReactionBar yalnizca ${kere} yerde — mac oncesi ve canli dallarin ikisinde de olmali`);
  });

  test("fixtureId geçiliyor", () => {
    const src = kod(kaynak("app", "match-race", "[fixtureId].tsx"));
    const m = src.match(/<ReactionBar([^/>]*)/);
    assert.ok(m, "ReactionBar cagrisi bulunamadi");
    assert.ok(
      /fixtureId=/.test(m[1]),
      `fixtureId gecilmiyor — cubuk hangi macin odasini gosterecegini bilemez: ${m[1].trim()}`
    );
  });

  test("istemci ucu DOĞRU yola çağırıyor", () => {
    /* Bilesen kusursuz olsa bile yol yanlissa 404 doner ve oda hep bos gorunur
     * — hatasiz sessiz basarisizlik. */
    const src = kod(kaynak("components", "ReactionBar.tsx"));
    assert.ok(/\/api\/rt\/reactions/.test(src), "istemci /api/rt/reactions yolunu kullanmiyor");
  });

  test("istemci izin verilen listeyi SUNUCUDAN okuyor", () => {
    /* Sabit liste tutmak, ayrismanin ta kendisini geri getirirdi. */
    const src = kod(kaynak("components", "ReactionBar.tsx"));
    assert.ok(
      /data\?\.keys|data!\.keys/.test(src),
      "istemci sunucudan donen `keys` alanini hic okumuyor — liste sabitlenmis"
    );
  });
});
