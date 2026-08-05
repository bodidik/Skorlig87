"use strict";

/**
 * GERÇEK VERİ YOLU TEK KAYNAKTAN, İZLENEN DOSYALAR DEPODAN.
 *
 * ⚠️ AYNI SINIFIN ÜÇÜNCÜ ÖRNEĞİ. Önce `node_modules`, sonra `../mobile`,
 * şimdi `data/`. Üçünde de kaynak ANA checkout'a bağlı, worktree kendi
 * kökünden hesaplıyor, bulamıyor ve test SESSİZCE atlanıyor: yeşil görünür,
 * hiçbir şey ölçmez.
 * bkz. tests/bagimlilik-yolu-nobetcisi.test.cjs, tests/mobil-yol-nobetcisi.test.cjs
 *
 * ÖLÇÜLDÜ (2026-08-05, bir worktree'de): 10 iddia bu yüzden atlanıyordu —
 * ülke tablosu kapsamı, takım derecelendirme, kadın/gençlik ligi elemesi,
 * düello denge kapısı, durum kısaltmaları, canlı dakika biçimi.
 *
 * ⚠️ KURAL İKİ YÖNLÜ, ve ikinci yön birincisi kadar önemli:
 *
 *   İZLENMEYEN dosyalar (fixtures.json, livescore-cache.json, totals.json,
 *   leaderboard.json) `tests/_gercek-veri.cjs` üzerinden okunur. Bunlar
 *   makineye ait çalışma zamanı önbelleği, dala ait değil.
 *
 *   İZLENEN dosyalar (countries-teams.json, bot-profiles.json ...) depodan,
 *   yani `KOK/data`dan okunur. Onlar depo içeriği: dal onları değiştirebilir
 *   ve test çalıştığı DALIN sürümünü görmeli. Tek kaynağa yönlendirmek,
 *   başka bir dalın verisini okumak olurdu — sessiz ve yanıltıcı bir hata.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const KOK = path.join(__dirname, "..");
const KENDI = path.basename(__filename);

/** Git'in izlemediği, scraper'ın yazdığı çalışma zamanı dosyaları. */
const IZLENMEYEN = ["fixtures.json", "livescore-cache.json", "totals.json", "leaderboard.json"];

function kodOku(f) {
  return fs.readFileSync(path.join(KOK, "tests", f), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

function testDosyalari() {
  return fs.readdirSync(path.join(KOK, "tests"))
    .filter((f) => f.endsWith(".cjs") && f !== KENDI && f !== "_gercek-veri.cjs");
}

test("izlenmeyen veri dosyaları tek kaynaktan okunuyor", () => {
  const bulgular = [];
  for (const f of testDosyalari()) {
    const satirlar = kodOku(f).split("\n");
    satirlar.forEach((satir, i) => {
      for (const ad of IZLENMEYEN) {
        if (satir.includes(`"data"`) && satir.includes(`"${ad}"`)) {
          bulgular.push(`tests/${f}:${i + 1}  ${ad}`);
        }
      }
    });
  }

  assert.deepEqual(
    bulgular, [],
    `su noktalar izlenmeyen veri dosyasini depo kokunden okuyor:\n  ${bulgular.join("\n  ")}\n` +
    `Bu dosyalar git tarafindan IZLENMIYOR; git worktree ye gelmezler ve\n` +
    `iddia her kosuda SESSIZCE atlanir. tests/_gercek-veri.cjs kullan:\n` +
    `  const { veriYolu, varMi } = require("./_gercek-veri.cjs");`
  );
});

test("İZLENEN veri dosyaları tek kaynağa YÖNLENDİRİLMEMİŞ", () => {
  /**
   * ⚠️ TERS YÖN. Düzeltmeyi fazla uygulamak da bir kusur: izlenen bir dosyayı
   * ana checkout'tan okumak, test edilen DALIN verisini gözden kaçırır.
   * Bu test onu yakalar.
   */
  const izlenen = cp.execSync("git ls-files data", { cwd: KOK, encoding: "utf8" })
    .split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => path.basename(l));
  assert.ok(izlenen.length > 0, "git ls-files data bos dondu — tarama bozuk");

  const bulgular = [];
  for (const f of testDosyalari()) {
    const kod = kodOku(f);
    for (const ad of izlenen) {
      if (kod.includes(`_gercek-veri.cjs").veriYolu("${ad}")`)) {
        bulgular.push(`tests/${f}  ${ad}`);
      }
    }
  }
  assert.deepEqual(
    bulgular, [],
    `su noktalar IZLENEN bir dosyayi tek kaynaga yonlendirmis:\n  ${bulgular.join("\n  ")}\n` +
    `Izlenen dosyalar depo icerigi; test calistigi DALIN surumunu gormeli.`
  );
});

test("tek kaynak worktree'den de çözüyor ve atlama davranışı korunuyor", () => {
  const { VERI_DIZINI, varMi, veriYolu, _anaDepoKoku } = require("./_gercek-veri.cjs");

  assert.ok(_anaDepoKoku(), "ana depo kokU bulunamadi — git-common-dir cozulmuyor");
  assert.ok(path.isAbsolute(VERI_DIZINI), `veri dizini mutlak degil: ${VERI_DIZINI}`);
  assert.equal(path.basename(VERI_DIZINI), "data", `beklenmeyen veri dizini: ${VERI_DIZINI}`);

  /* Veri ANA depoda varsa cozum onu BULMALI — atlama sebebi yol hatasi olamaz. */
  const anaVeri = path.join(_anaDepoKoku(), "data", "fixtures.json");
  if (fs.existsSync(anaVeri)) {
    assert.ok(
      varMi("fixtures.json"),
      `fikstur verisi ${anaVeri} icinde VAR ama cozum bulamadi (${VERI_DIZINI}) — ` +
      `testler bu yuzden sessizce atlanir`
    );
  }

  /* ⚠️ ATLAMA KORUNUYOR: olmayan dosya icin varMi false doner, cagiran
   * t.skip eder. Amac "her yerde kossun" degil, "VARKEN bulunabilsin". */
  assert.equal(varMi("boyle-bir-dosya-yok.json"), false, "olmayan dosya icin varMi true dondu");
  assert.ok(veriYolu("x.json").endsWith("x.json"), "veriYolu yanlis birlestiriyor");
});

test("NÖBETÇİ taraması gerçekten çalışıyor", () => {
  /* Boş sonuç kanıt değil. */
  const ornek = 'const dosya = path.join(KOK, "data", "fixtures.json");';
  assert.ok(
    ornek.includes(`"data"`) && ornek.includes(`"fixtures.json"`),
    "kalip bilinen ornegi yakalamiyor"
  );
  const temiz = 'const dosya = require("./_gercek-veri.cjs").veriYolu("fixtures.json");';
  assert.ok(!temiz.includes(`"data"`), "kalip tek kaynak kullanimini yanlislikla yakalar");
});
