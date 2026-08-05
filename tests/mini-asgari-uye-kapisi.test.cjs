"use strict";

/**
 * MİNİ TURNUVA ÖDÜLÜ ASGARİ GERÇEK ÜYE İSTİYOR — KARŞILIKSIZ LC MUSLUĞU.
 *
 * ⚠️ KUSUR (2026-08-05 ölçüldü, canlı): mini turnuva girişi ÜCRETSİZ ve
 * turnuva TEK üyeyle de bitebiliyordu. Kurucu puan alırsa `MINI_WIN_LC`'nin
 * TAMAMINI alıyordu — yani tek hesapla, hiçbir karşılık ödemeden LC
 * üretilebiliyordu. Asgari üye şartı YOKTU (`routes/mini.cjs` içinde
 * `MIN_MEMBERS` diye bir kavram hiç geçmiyordu).
 *
 * Freni yalnızca eşzamanlı açık turnuva kotasıydı (lib/premium.cjs
 * `miniMaxOpen`: ücretsiz 2, premium 6) ve maçların gerçekten oynanması
 * gerekliliği. Bunlar debiyi sınırlıyordu ama musluğu KAPATMIYORDU — kodun
 * kendi notu da bunu yazıyor: "mini turnuva girişi ÜCRETSİZ ama kazanana
 * MINI_WIN_LC veriliyor, yani karşılığı olmayan LC üretimi."
 *
 * ⚠️ ÖDÜL TAVANI AYNI GÜN 20 → 50'YE ÇIKARILDI. Bu kapı olmasaydı yükseltme
 * tek hesapla üretilebilen LC'yi 2.5 kat artıracaktı. Kapı ve tavan birlikte
 * anlamlı: biri kaldırılırsa diğeri tehlikeli hâle gelir.
 *
 * ⚠️ KAPI YARATMADA DEĞİL ÖDEMEDE. Turnuva her zaman TEK üyeyle kurulur
 * (kurucu), arkadaşlar sonra kodla katılır — yaratmada asgari üye şart koşmak
 * turnuva kurmayı imkânsız kılardı.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const mini = require("../routes/mini.cjs");
const sartSaglandiMi = mini._odulUyeSartiSaglandiMi;
const gercekUyeler = mini._gercekUyeler;
const MIN_UYE = mini._MIN_ODUL_UYE;

/** Gerçek bir bot kimliği — süzgecin çalıştığını kanıtlamak için şart. */
function botKimligi() {
  const { BOT_ID_SET } = require("../lib/botIds.cjs");
  const ilk = BOT_ID_SET && BOT_ID_SET.values().next();
  return ilk && !ilk.done ? ilk.value : null;
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("kapı GERÇEKTEN dışa açılmış ve şart makul", () => {
    assert.equal(typeof sartSaglandiMi, "function", "odul uye sarti disa acilmamis");
    assert.ok(Number.isInteger(MIN_UYE) && MIN_UYE >= 2,
      `MIN_ODUL_UYE=${MIN_UYE} — 2'nin altinda sart musluğu kapatmaz`);
  });

  test("ÖLÇÜMÜN DAYANAĞI: bot kimliği bulunabiliyor", () => {
    /* ⚠️ Bot süzgecini sınayan iddialar, elde gerçek bir bot kimliği yoksa
     * hiçbir şey ölçmez — sessizce geçerdi. */
    assert.ok(botKimligi(), "BOT_ID_SET bos — bot suzgeci iddialari olcmez");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("ödül şartı", () => {
  test("TEK gerçek üyeli turnuva ödül ALAMAZ (musluğun kendisi)", () => {
    assert.equal(sartSaglandiMi(["u_tek"]), false);
  });

  test("iki gerçek üyeli turnuva ödül alabilir", () => {
    assert.equal(sartSaglandiMi(["u_bir", "u_iki"]), true);
  });

  test("boş / bozuk üye listesi ödül ALAMAZ", () => {
    for (const girdi of [[], null, undefined, [null], [""], [{}]]) {
      assert.equal(sartSaglandiMi(girdi), false, `girdi kabul edildi: ${JSON.stringify(girdi)}`);
    }
  });

  test("BOTLARLA doldurmak şartı GEÇEMEZ", () => {
    /**
     * ⚠️ EN OLASI KAÇIŞ YOLU. Botlar turnuvaya katılabiliyor (bot doldurma
     * özelliği var). Sayılsalardı kurucu turnuvayı botlarla doldurup şartı
     * geçer ve musluk açık kalırdı — kapı yalnızca kâğıt üzerinde olurdu.
     */
    const bot = botKimligi();
    assert.equal(sartSaglandiMi(["u_tek", bot]), false,
      "bot uye sayilmis — turnuvayi botlarla doldurup sart gecilir");
    assert.equal(sartSaglandiMi(["u_tek", bot, bot]), false);
    assert.equal(sartSaglandiMi(["u_bir", bot, "u_iki"]), true,
      "gercek iki uye varken bot varligi odulu engellememeli");
  });

  test("nesne biçimli üye kaydı da sayılıyor", () => {
    /* Üye bugün kimlik dizisi; belge zenginleşirse şart sessizce "hic gercek
     * uye yok" deyip ödülü kesmesin. */
    assert.equal(gercekUyeler([{ userId: "u_bir" }, { userId: "u_iki" }]).length, 2);
  });
});

/* ── Nöbetçi: kapı ÖDEME yolunda gerçekten bağlı ─────────────────────────── */

describe("nöbetçi", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "routes", "mini.cjs"), "utf8")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  test("kapı finalize yolunda ÇAĞRILIYOR", () => {
    /**
     * ⚠️ Saf fonksiyonu sınamak yetmez: kapı doğru çalışıp ödeme yolunda hiç
     * çağrılmasa bu dosya YEŞİL kalırdı ve musluk açık olurdu. Bu depodaki en
     * sık kusur şekli, doğru kuralın canlı yola bağlanmaması.
     */
    const i = src.indexOf("async function finalizeIfDone");
    assert.ok(i > 0, "finalizeIfDone bulunamadi — tarama bozuk");
    const govde = src.slice(i, src.indexOf("\n}", src.indexOf("finally", i)));
    assert.ok(/odulUyeSartiSaglandiMi\(/.test(govde),
      "asgari uye kapisi odeme yolunda cagrilmiyor — musluk acik");
  });

  test("şart sağlanmayınca ÖDEME FONKSİYONU hiç çağrılmıyor", () => {
    /* `rewardLc: 0` yazıp yine de `awardMiniWinLc` çağırmak parayı yatırırdı;
     * ekranda 0 görünür, cüzdana LC geçerdi. */
    const i = src.indexOf("const uyeSarti");
    assert.ok(i > 0, "uyeSarti bulunamadi — tarama bozuk");
    const pencere = src.slice(i, i + 1800);
    assert.ok(/uyeSarti\s*\?\s*kazananPayi/.test(pencere),
      "kisi basi pay uye sartina baglanmamis");
    assert.ok(/winners\.length\s*&&\s*!uyeSarti/.test(pencere),
      "odeme dali uye sartina baglanmamis — LC yine yatabilir");
  });

  test("ödül kesildiyse KAYDA geçiyor", () => {
    /* Yoksa "kimse puan alamadı" ile "şart sağlanmadı" ayırt edilemez ve
     * ödenmemiş bir ödül, ödenmeye değmeyen bir ödül gibi görünür. */
    assert.ok(/odulKesildi/.test(src), "odul kesilme nedeni kaydedilmiyor");
  });
});
