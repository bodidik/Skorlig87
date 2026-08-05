"use strict";

/**
 * DÜELLO SABİTLERİ SUNUCU İLE İSTEMCİDE AYRIŞMIYOR.
 *
 * ⚠️ NEDEN VAR: `routes/duels.cjs` kesinti oranını ve bahis sınırlarını
 * istemciye BİLDİRİYOR (`houseCutPct`, `minStake`, `maxStake`) — çünkü mobil
 * ekran bir dönem kazancı kendi hesaplıyordu ve kuralı tahmin etmesi
 * riskliydi. O düzeltme YARIM KALDI:
 *
 *   düzeltilmiş : `duel/[fixtureId].tsx:183` → `pot * (1 - houseCutPct)`
 *   KALAN       : `duel/[fixtureId].tsx:62`  → `const STAKES = [1,2,3,5,8,10,12]`
 *   KALAN       : `arena.tsx:114`            → `Math.round(duel.pot * 0.95 * 10) / 10`
 *
 * ÖLÇÜLDÜ (bugün): sunucu MIN_STAKE=1, MAX_STAKE=12, HOUSE_CUT_PCT=0.05;
 * mobil STAKES min=1 max=12, arena çarpanı 0.95. Yani CANLI KUSUR YOK —
 * kapatılan şey sapma ihtimali.
 *
 * ⚠️ AMA BU SINIF BU DEPODA BİR KEZ PAHALIYA PATLADI: `lib/ekonomi.cjs`
 * `macOdulu` notu, ekranın 3009 LC vaat edip cüzdana ≤15 LC geçtiğini
 * ölçüyor. Kazanç vaadi bahis KONMADAN ÖNCE gösteriliyor; yanlış vaat
 * kullanıcının parasını yanlış beklentiyle riske attırır.
 *
 * Bu test sapmayı yakalar: sunucu sabiti değişip mobil kopya güncellenmezse
 * kırılır ve kırılması DOĞRUDUR.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

const KOK = nodePath.join(__dirname, "..");
const MOBIL = require("./_mobil-dizin.cjs").MOBIL;

/* Sabitler artık `lib/duello-kesinti.cjs`te — regex yerine MODÜL okunuyor. */
const KESINTI = require("../lib/duello-kesinti.cjs");

function sunucuSabitleri() {
  return { min: KESINTI.MIN_STAKE, max: KESINTI.MAX_STAKE };
}

describe("kurulum", () => {
  test("sunucu sabitleri GERÇEKTEN okunuyor", () => {
    const s = sunucuSabitleri();
    for (const [ad, deger] of Object.entries(s)) {
      assert.ok(Number.isFinite(deger), `${ad} okunamadi (${deger}) — tarama bozuk`);
    }
    assert.ok(s.min < s.max, `MIN_STAKE ${s.min} >= MAX_STAKE ${s.max}`);
  });

  test("rota sabitleri bu modülden alıyor", () => {
    /* Rota kendi kopyasına dönerse aşağıdaki karşılaştırmalar yanlış kaynağı
     * sınamaya başlar ve sapmayı göremez. */
    const src = fs.readFileSync(nodePath.join(KOK, "routes", "duels.cjs"), "utf8");
    assert.ok(/require\("\.\.\/lib\/duello-kesinti\.cjs"\)/.test(src),
      "duels.cjs kesinti modulunu kullanmiyor");
  });
});

describe("istemci sabitleri sunucuyla uyumlu", () => {
  test("bahis seçenekleri MIN/MAX sınırları içinde ve uçları tutuyor", () => {
    const ekran = nodePath.join(MOBIL, "app", "duel", "[fixtureId].tsx");
    if (!fs.existsSync(ekran)) return; // başka checkout

    const src = fs.readFileSync(ekran, "utf8");
    /* `YEDEK_STAKES` de aranıyor: liste artık sunucudan geliyor ama eski
     * sunucular için bir yedek duruyor ve o da aralık dışına taşabilir. */
    const m = src.match(/const (?:YEDEK_)?STAKES\s*=\s*\[([^\]]+)\]/);
    if (!m) return; // hiç sabit liste yok (tamamen sunucudan) → sorun yok

    const stakes = m[1].split(",").map((x) => Number(x.trim())).filter(Number.isFinite);
    assert.ok(stakes.length > 0, "STAKES listesi cozulemedi — tarama bozuk");

    const s = sunucuSabitleri();
    const disari = stakes.filter((x) => x < s.min || x > s.max);
    assert.deepEqual(
      disari, [],
      `mobil STAKES sunucu sinirlari disinda deger tasiyor: ${disari.join(", ")} ` +
      `(sunucu ${s.min}..${s.max}) — kullanici secip REDDEDILIR`
    );
    assert.equal(
      Math.max(...stakes), s.max,
      `mobil en yuksek bahis ${Math.max(...stakes)}, sunucu MAX_STAKE ${s.max} — ` +
      `sunucu sinirı yukseldiyse kullanici yeni secenekleri HIC goremez`
    );
    assert.equal(
      Math.min(...stakes), s.min,
      `mobil en dusuk bahis ${Math.min(...stakes)}, sunucu MIN_STAKE ${s.min}`
    );
  });

  test("arena kazancı SABİT ÇARPANLA hesaplamıyor", () => {
    /**
     * ⚠️ İDDİA TERSİNE DÖNDÜ (2026-08-05). Eskiden çarpanın sunucudaki
     * `HOUSE_CUT_PCT` ile eşit KALMASI sınanıyordu. Kesinti artık kademeli
     * TAM SAYI LC (bkz. lib/duello-kesinti.cjs) ve tek bir çarpanla ifade
     * EDİLEMEZ: bahis 5'te %10, bahis 12'de %4.2, bahis 1-4'te %0. Eşitliği
     * sınamak yerine çarpanın hiç bulunmamasını sınıyoruz — ekran ödülü
     * sunucudan alıyor (`duel.winAmount`).
     *
     * Ayrışmanın bedeli değişmedi: aynı sınıf bir kez 3009 LC vaat edip
     * cüzdana 15 LC geçirmişti (bkz. lib/ekonomi.cjs macOdulu notu).
     */
    const ekran = nodePath.join(MOBIL, "app", "(tabs)", "arena.tsx");
    if (!fs.existsSync(ekran)) return;

    const src = fs.readFileSync(ekran, "utf8")
      .split("\n")
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");

    const m = src.match(/\bpot\s*\*\s*([\d.]+)/);
    assert.equal(
      m, null,
      `arena kazanci hala sabit ${m && m[1]} carpaniyla hesapliyor — kesinti ` +
      `kademeli tam sayi, tek carpan yanlis odul vaat eder`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: sunucu sabitleri istemciye GÖNDERİLMEYE devam ediyor", () => {
  /**
   * Yukarıdaki iddialar sabit kopyaların DOĞRU olmasını sınıyor. Asıl çözüm
   * kopyayı hiç tutmamak: sunucu değerleri gönderiyor. O alanlar yanıttan
   * kaldırılırsa istemci tahmin etmeye geri döner.
   */
  const src = fs.readFileSync(nodePath.join(KOK, "routes", "duels.cjs"), "utf8");
  for (const alan of ["odulTablosu", "houseCutPct", "minStake", "maxStake"]) {
    assert.ok(
      new RegExp(`${alan}\\s*:`).test(src),
      `duels yaniti ${alan} gondermiyor — istemci kurali tahmin etmek zorunda kalir`
    );
  }
});
