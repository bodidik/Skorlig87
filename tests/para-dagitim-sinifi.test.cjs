"use strict";

/**
 * PARA DAĞITIM SINIFI — havuzu bölen her yol uzlaştırılmalı.
 *
 * ⚠️ NEDEN VAR: aynı yuvarlama kusuru bu depoda İKİ AYRI para yolunda çıktı ve
 * ikisi de ölçülene kadar sessizdi:
 *
 *     TURNUVA (services/tournament.cjs) — 1536 senaryo:
 *         %23.4 havuzdan FAZLA ödeme, %6.6 eksik
 *     MAÇ HAVUZU (lib/pool-store.cjs) — 210 senaryo:
 *         %49.0 havuzdan FAZLA dağıtım, en kötü +10 LC (havuz 200)
 *
 * Turnuva önce düzeltildi; kural o dosyada kaldığı için HAVUZ aynı hatayı
 * taşımaya devam etti. Bu test o tekrarı bir daha yaşamamak için SINIFI
 * tarıyor: LC'yi birden çok kullanıcıya dağıtan her modül burada KAYITLI
 * olmalı ve kategorisine uygun davranmalı.
 *
 * ⚠️ İKİ KATEGORİ AYRI KURALA TABİ — karıştırmak yanlış düzeltme üretir:
 *
 *   HAVUZ (korunması gereken toplam): giriş bedelleri/bahisler toplanır ve
 *     dağıtılır. `ödenen + kesinti === havuz` DEĞİŞMEZ. Bağımsız yuvarlama
 *     ya LC üretir ya yakar → `lib/pay-dagitim.cjs` (en büyük kalan) ŞART.
 *
 *   ÜRETİLEN (havuz yok): ödül yoktan basılır. Korunacak toplam olmadığı için
 *     en büyük kalan GEREKMEZ; eşit pay daha adildir. ÖLÇÜLDÜ (mini, ödül 20):
 *     15 kazananda kayıp 1 LC ve TÜM kazananlar aynı miktarı alıyor. En büyük
 *     kalan uygulamak bazı kazananlara 0.1 fazla verip eşitliği bozardı.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/** Yorumları soyar: tarihçe anlatan yorum nöbetçiyi tetiklemesin. */
function kod(rel) {
  return fs.readFileSync(path.join(KOK, rel), "utf8")
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

/**
 * LC'yi birden çok kullanıcıya yazan BİLİNEN modüller.
 * Yeni bir modül eklenirse aşağıdaki tarama kırılır ve bilinçli karar
 * vermeye zorlar — kategorisiz para yolu olmamalı.
 */
const KAYIT = {
  // ── HAVUZ: toplam korunmalı, ortak dağıtım ŞART ──────────────────────────
  "lib/pool-store.cjs":            "havuz",
  "services/tournament.cjs":       "havuz",
  // ── ÜRETİLEN: havuz yok, eşit/sabit pay ──────────────────────────────────
  "routes/mini.cjs":               "uretilen",
  "lib/kupon-settle.cjs":          "uretilen",
  "routes/kupon.cjs":              "uretilen",
  "routes/tr-league.cjs":          "uretilen",
  "routes/friends.cjs":            "uretilen",
  // ── İADE: 1:1 geri verme, bölüşme yok ────────────────────────────────────
  "services/bayat-temizleyici.cjs": "iade",
  "routes/duels.cjs":               "iade",
  // ── Altyapı: kendisi dağıtmaz, yazma aracı ───────────────────────────────
  "lib/wallet-credit.cjs":          "altyapi",
};

describe("para dağıtım sınıfı", () => {
  test("kurulum sınandı: tarama GERÇEKTEN dosya buluyor", () => {
    /* ⚠️ Bu olmadan "kayıtsız modül yok" sonucu, taramanın hiçbir şey
     * bulamamasından da gelebilirdi — bu oturumun tekrar eden dersi. */
    const bulunan = tarayanlar();
    assert.ok(bulunan.length >= 8, `tarama cok az dosya buldu (${bulunan.length})`);
    assert.ok(bulunan.includes("lib/pool-store.cjs"), "bilinen para yolu taramada yok");
  });

  function tarayanlar() {
    const out = [];
    for (const d of ["lib", "routes", "services"]) {
      for (const ad of fs.readdirSync(path.join(KOK, d))) {
        if (!ad.endsWith(".cjs")) continue;
        const rel = `${d}/${ad}`;
        if (/creditLc\s*\(/.test(kod(rel))) out.push(rel);
      }
    }
    return out;
  }

  test("KAYITSIZ para yolu yok (yeni modül bilinçli karar ister)", () => {
    /**
     * ⚠️ KUSURUN KÖKÜ: yeni bir dağıtım yolu eklenince hangi kurala tabi
     * olduğu hiçbir yerde sorulmuyordu. Havuz kuralı gerektiren bir yol
     * sessizce eklenirse LC üretir.
     */
    const eksik = tarayanlar().filter((f) => !KAYIT[f]);
    assert.deepEqual(eksik, [],
      "kayitsiz LC dagitan modul(ler): " + eksik.join(", ") +
      " — havuz mu uretilen mi oldugunu belirleyip KAYIT'a ekleyin");
  });

  test("HAVUZ yolları ortak dağıtımı kullanıyor", () => {
    for (const [f, tur] of Object.entries(KAYIT)) {
      if (tur !== "havuz") continue;
      const s = kod(f);
      assert.ok(/odemeDagit\(/.test(s), `${f}: havuz yolu ortak dagitimi kullanmiyor`);
    }
  });

  test("HAVUZ yollarında bağımsız yuvarlama KALMADI", () => {
    /* ⚠️ Ölçülen iki kusurun ikisi de bu kalıptı: payı tek başına yuvarla,
     * toplamı hiç kontrol etme. */
    assert.ok(!/Math\.round\(Number\(b\.amount \|\| 0\) \* carpan\)/.test(kod("lib/pool-store.cjs")),
      "havuz kazanc basina kendi yuvarlamasina donmus");
    assert.ok(!/Math\.round\(\s*t\.pool\s*\*/.test(kod("services/tournament.cjs")),
      "turnuva odeme basina kendi yuvarlamasina donmus");
  });

  test("ORTAK DAĞITIM toplamı ASLA aşmıyor (saf matematik)", () => {
    /**
     * Kuralın kendisi burada sınanıyor; iki çağıran da buna bağlı.
     * Kopya yazmıyorum — gerçek fonksiyon çağrılıyor.
     */
    const { odemeDagit } = require(path.join(KOK, "lib", "pay-dagitim.cjs"));
    for (let toplam = 0; toplam <= 200; toplam += 7) {
      for (const n of [1, 2, 3, 5, 8, 13, 20]) {
        const oranlar = Array(n).fill(1 / n);
        const paylar = odemeDagit(toplam, oranlar);
        const dagitilan = paylar.reduce((a, b) => a + b, 0);
        assert.equal(dagitilan, Math.floor(toplam),
          `toplam=${toplam} n=${n}: dagitilan ${dagitilan}`);
        assert.ok(Math.max(...paylar) - Math.min(...paylar) <= 1,
          `toplam=${toplam} n=${n}: esit oranlarda ${Math.max(...paylar) - Math.min(...paylar)} fark`);
      }
    }
  });

  test("ÜRETİLEN yol: mini EŞİT pay veriyor (en büyük kalan GEREKMEZ)", () => {
    /**
     * ⚠️ TERS RİSK: bu yola da en büyük kalan uygulamak kazananları eşitsiz
     * yapardı. Havuz yok, korunacak toplam yok — eşitlik daha değerli.
     * Ölçüldü (ödül 20): en kötü kayıp 1 LC, tüm kazananlar aynı miktarda.
     */
    const s = kod("routes/mini.cjs");
    assert.ok(/Math\.floor\(\(MINI_WIN_LC \/ n\) \* 10\) \/ 10/.test(s),
      "mini esit pay hesabini degistirmis — kazananlar esitsiz olabilir");
    assert.ok(!/odemeDagit\(/.test(s),
      "mini havuz kuralina gecmis — uretilen odulde esitlik bozulur");
  });

  test("İADE yolu: düello ödemesi POT'tan TÜRETİLİYOR (korunum yapısal)", () => {
    /**
     * Düelloda kazanan payı `pot - houseCut` olarak türetiliyor, yani ikisinin
     * toplamı tanım gereği pot'a eşit. Sayı kopyalamıyorum — korunumun
     * YAPISAL olduğunu tutuyorum; biri iki payı ayrı hesaplarsa kırılır.
     */
    /* ⚠️ HESAP 2026-08-05'te `lib/duello-kesinti.cjs`e taşındı (kesinti yüzde
     * yerine kademeli TAM SAYI oldu — gerekçe o dosyada). Türetme aynı kaldı:
     * `winAmount: pot - houseCut`. Yuvarlama artık gerekmiyor, çünkü iki taraf
     * da tam sayı. */
    const s = kod("lib/duello-kesinti.cjs");
    assert.ok(/winAmount:\s*pot\s*-\s*houseCut/.test(s),
      "kazanan payi pot'tan turetilmiyor — kesinti ve pay ayrisabilir");
    const rota = kod("routes/duels.cjs");
    assert.ok(/require\("\.\.\/lib\/duello-kesinti\.cjs"\)/.test(rota),
      "rota bu hesabi kullanmiyor — test yanlis kaynagi olcuyor");
    assert.ok(!/houseCut\s*=\s*Math\./.test(rota),
      "rota kendi kesinti hesabini yeniden yazmis — iki kural ayrisir");
  });
});
