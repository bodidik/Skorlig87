"use strict";

/**
 * MOBİL DEPONUN YERİ TEK KAYNAKTAN OKUNUR, ELLE HESAPLANMAZ.
 *
 * ⚠️ NEDEN VAR: 30 test dosyası yolu kendi hesaplıyordu —
 *
 *     const MOBIL = path.join(KOK, "..", "mobile");
 *
 * Normal checkout'ta doğru, GIT WORKTREE'de değil: orada `KOK` bir worktree
 * dizini ve `..` `worktrees` klasörünü gösteriyor. Depo bulunamayınca testler
 * çökmüyor, `t.skip`/`return` ile SESSİZCE atlanıyor — sonuç yeşil, iddia hiç
 * koşmamış.
 *
 * ÖLÇÜLDÜ (2026-08-05, bir worktree'de): 33 mobil bağımlı iddia atlanıyordu.
 * İçinde istemci jetonu, ham `fetch` yasağı, yönetici başlığı, bahis
 * sözleşmesi ve i18n kapsamı nöbetçileri vardı.
 *
 * ⚠️ SINIF YARIM KAPATILMIŞTI: `istemci-uc-eslesme.test.cjs` bunu fark edip
 * `SKORLIG_MOBILE_DIR` override'ı eklemişti — ama yalnızca kendi dosyasına.
 * Kalan 29 dosya aynı sabit yolu gömmeye devam etti. Bu depoda tekrarlayan
 * şekil bu: aynı kural birçok kopyada yaşıyor ve biri düzeltilince ötekiler
 * geride kalıyor.
 *
 * KURAL: mobil yol `tests/_mobil-dizin.cjs` üzerinden alınır.
 * Orası sırayla `SKORLIG_MOBILE_DIR` → git ana deposunun yanı → yan klasör
 * deniyor, yani worktree'de de elle bir şey ayarlamadan çözülüyor.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const KENDI = path.basename(__filename);

/**
 * Mobil depo yolunu ELLE kuran ifade: `.join(...)` çağrısı içinde "mobile".
 *
 * `_mobil-dizin.cjs`in kendi içindeki yedek hesap meşru — tek kaynağın TA
 * KENDİSİ orası. Onu ve bu nöbetçiyi taramanın dışında tutuyoruz.
 */
const ELLE = /\.join\([^)]*"mobile"/;

function taranacak() {
  const d = path.join(KOK, "tests");
  return fs.readdirSync(d)
    .filter((f) => f.endsWith(".cjs") && f !== KENDI && f !== "_mobil-dizin.cjs");
}

/** Yorumlar elenir: bu dosyanın başlığı örnek içeriyor. */
function kodOku(f) {
  return fs.readFileSync(path.join(KOK, "tests", f), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

test("hiçbir test mobil yolu elle hesaplamıyor", () => {
  const bulgular = [];
  for (const f of taranacak()) {
    kodOku(f).split("\n").forEach((satir, i) => {
      if (ELLE.test(satir)) bulgular.push(`tests/${f}:${i + 1}`);
    });
  }

  assert.deepEqual(
    bulgular, [],
    `su dosyalar mobil depo yolunu elle kuruyor:\n  ${bulgular.join("\n  ")}\n` +
    `Git worktree'de ../mobile COZULMEZ ve iddia sessizce ATLANIR — yesil\n` +
    `gorunur ama hicbir sey olcmez. tests/_mobil-dizin.cjs kullan:\n` +
    `  const { MOBIL, mobilYol } = require("./_mobil-dizin.cjs");`
  );
});

test("tek kaynak worktree'den de çözüyor", () => {
  /**
   * ⚠️ Asıl iddia bu: kural yalnızca "tek yerden okuyun" değil, o tek yerin
   * DOĞRU cevap vermesi. `git-common-dir` worktree'de bile ANA depoyu
   * gösterdiği için yol elle bir değişken ayarlamadan bulunuyor.
   *
   * Bu test hem normal checkout'ta hem worktree'de anlamlı: ikisinde de
   * mobil depo yan klasörde olmalı ve bulunmalı.
   */
  const { MOBIL, mobilVarMi, _anaDepoKoku } = require("./_mobil-dizin.cjs");

  assert.ok(_anaDepoKoku(), "ana depo kokU bulunamadi — git-common-dir cozulmuyor");
  assert.ok(
    path.isAbsolute(MOBIL),
    `mobil yol mutlak degil: ${MOBIL}`
  );
  assert.equal(
    path.basename(MOBIL), "mobile",
    `beklenmeyen mobil yol: ${MOBIL}`
  );

  /* Depo gerçekten yanda mı? Değilse bu bir kusur DEĞİL (başka checkout);
   * ama varsa, çözümün onu BULMASI şart — atlama sebebi yol hatası olamaz. */
  const yanda = path.join(path.dirname(_anaDepoKoku()), "mobile");
  if (fs.existsSync(yanda)) {
    assert.ok(
      mobilVarMi(),
      `mobil depo ${yanda} icinde VAR ama cozum onu bulamadi (${MOBIL}) — ` +
      `nobetciler bu yuzden sessizce atlanir`
    );
  }
});

test("SKORLIG_MOBILE_DIR override ediyor", () => {
  /* Açık override en yüksek öncelikte kalmalı: kardeş checkout'ta ya da CI'da
   * depo başka yerdeyse tek çıkış yolu bu. */
  const yol = require.resolve("./_mobil-dizin.cjs");
  const onceki = process.env.SKORLIG_MOBILE_DIR;
  try {
    process.env.SKORLIG_MOBILE_DIR = path.join(KOK, "tests");
    delete require.cache[yol];
    const { MOBIL } = require("./_mobil-dizin.cjs");
    assert.equal(
      MOBIL, path.join(KOK, "tests"),
      `override yok sayildi: ${MOBIL}`
    );
  } finally {
    if (onceki === undefined) delete process.env.SKORLIG_MOBILE_DIR;
    else process.env.SKORLIG_MOBILE_DIR = onceki;
    delete require.cache[yol];
  }
});

test("NÖBETÇİ taraması gerçekten çalışıyor", () => {
  /* Boş sonuç kanıt değil: kalıp bir gün kırılırsa nöbetçi sessizce yeşil
   * kalır ve desen geri gelir. */
  assert.ok(
    ELLE.test('const MOBIL = path.join(KOK, "..", "mobile");'),
    "kalip bilinen elle-yol ornegini yakalamiyor"
  );
  assert.ok(
    ELLE.test('const ekran = nodePath.join(__dirname, "..", "..", "mobile", "app", "x.tsx");'),
    "kalip cok parcali ornegi yakalamiyor"
  );
  assert.ok(
    !ELLE.test('const MOBIL = require("./_mobil-dizin.cjs").MOBIL;'),
    "kalip tek kaynak kullanimini yanlislikla yakaliyor"
  );
  assert.ok(
    !ELLE.test('const p = path.join(KOK, "routes", "mini.cjs");'),
    "kalip alakasiz join cagrisini yakaliyor"
  );
});
