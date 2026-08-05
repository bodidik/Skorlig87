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
const MOBIL = nodePath.join(KOK, "..", "mobile");

function sunucuSabitleri() {
  const src = fs.readFileSync(nodePath.join(KOK, "routes", "duels.cjs"), "utf8");
  const sayi = (re) => {
    const m = src.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    min: sayi(/MIN_STAKE\s*=\s*([\d.]+)/),
    max: sayi(/MAX_STAKE\s*=\s*([\d.]+)/),
    kesinti: sayi(/HOUSE_CUT_PCT\s*=\s*([\d.]+)/),
  };
}

describe("kurulum", () => {
  test("sunucu sabitleri GERÇEKTEN okunuyor", () => {
    /* ⚠️ Sıfır sonuç kanıt değil: regex tutmazsa `null` gelir ve aşağıdaki
     * karşılaştırmalar sessizce anlamsızlaşırdı. */
    const s = sunucuSabitleri();
    for (const [ad, deger] of Object.entries(s)) {
      assert.ok(
        Number.isFinite(deger),
        `${ad} okunamadi (${deger}) — duels.cjs bicimi degisti mi? tarama bozuk`
      );
    }
    assert.ok(s.min < s.max, `MIN_STAKE ${s.min} >= MAX_STAKE ${s.max}`);
    assert.ok(s.kesinti > 0 && s.kesinti < 1, `HOUSE_CUT_PCT mantiksiz: ${s.kesinti}`);
  });
});

describe("istemci sabitleri sunucuyla uyumlu", () => {
  test("bahis seçenekleri MIN/MAX sınırları içinde ve uçları tutuyor", () => {
    const ekran = nodePath.join(MOBIL, "app", "duel", "[fixtureId].tsx");
    if (!fs.existsSync(ekran)) return; // başka checkout

    const src = fs.readFileSync(ekran, "utf8");
    const m = src.match(/const STAKES\s*=\s*\[([^\]]+)\]/);
    if (!m) return; // sabit liste kaldırılmış (sunucudan alınıyor) → sorun yok

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

  test("arena kazanç çarpanı kesinti oranıyla tutuyor", () => {
    const ekran = nodePath.join(MOBIL, "app", "(tabs)", "arena.tsx");
    if (!fs.existsSync(ekran)) return;

    const src = fs.readFileSync(ekran, "utf8")
      .split("\n")
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");

    /* `pot * <sayı>` biçiminde sabit bir çarpan kalmış mı? */
    const m = src.match(/\bpot\s*\*\s*([\d.]+)/);
    if (!m) return; // sabit çarpan yok — sunucudan geliyor, sorun yok

    const carpan = Number(m[1]);
    const s = sunucuSabitleri();
    assert.equal(
      carpan, 1 - s.kesinti,
      `arena kazanci ${carpan} carpaniyla hesapliyor ama sunucu kesintisi ` +
      `${s.kesinti} (yani ${1 - s.kesinti} olmali). Ekran bahis KONMADAN ONCE ` +
      `yanlis kazanc vaat eder; ayni sinif bir kez 3009 LC vaat edip cuzdana ` +
      `15 LC gecirmisti (bkz. lib/ekonomi.cjs macOdulu notu).`
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
  for (const alan of ["houseCutPct", "minStake", "maxStake"]) {
    assert.ok(
      new RegExp(`${alan}\\s*:`).test(src),
      `duels yaniti ${alan} gondermiyor — istemci kurali tahmin etmek zorunda kalir`
    );
  }
});
