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

  test("neden ve kural İSTEMCİYE gönderiliyor", () => {
    /* Ekran "ödül neden verilmedi" sorusunu ancak bu ikisiyle cevaplayabilir:
     * `odulKesildi` publicView'da, `odulKurali` board yanıtında. */
    assert.ok(/odulKesildi:\s*t\.odulKesildi/.test(src),
      "odulKesildi publicView ile gonderilmiyor — ekran nedeni goremez");
    assert.ok(/odulKurali:\s*\{\s*minUye:\s*MIN_ODUL_UYE/.test(src),
      "odulKurali board yanitinda yok — ekran asgari uyeyi TAHMIN etmek zorunda kalir");
  });
});

/* ── Açıklama metni: 21 dilin hepsinde ────────────────────────────────────── */

describe("ödülsüz bitişin açıklaması", () => {
  const { MOBIL, mobilVarMi } = require("./_mobil-dizin.cjs");
  const ANAHTAR = "minMembersNoReward";

  test("metin 21 SÖZLÜĞÜN HEPSİNDE var", (t) => {
    /**
     * ⚠️ NEDEN 21 DİL. Deponun 2026-08-03 kapsam kararı "yeni anahtarlar
     * yalnız tr+en, diğerleri İngilizce yedeğe düşer" diyor (bkz. lib/i18n.ts
     * `t` notu). Bu metin için kural BİLEREK aşıldı: kullanıcı şampiyon olup
     * ödül alamadığında gördüğü tek açıklama bu — İngilizce yedek, "neden
     * param yok" sorusunun cevabı olarak yetersiz.
     *
     * ⚠️ İDDİA SAYIYA BAĞLI: yeni bir dil eklenip bu anahtar atlanırsa kırılır
     * ve kırılması DOĞRUDUR — o dilin kullanıcısı sessizce yedeğe düşerdi.
     */
    if (!mobilVarMi()) return t.skip("mobil depo yok");
    const src = fs.readFileSync(path.join(MOBIL, "lib", "i18n.ts"), "utf8");

    const sozlukSayisi = (src.match(/^ {2}[a-z]{2}: \{$/gm) || []).length;
    assert.ok(sozlukSayisi >= 21, `yalnizca ${sozlukSayisi} sozluk bulundu — tarama bozuk`);

    const kaç = (src.match(new RegExp(`${ANAHTAR}:`, "g")) || []).length;
    assert.equal(kaç, sozlukSayisi,
      `${ANAHTAR} ${kaç} sozlukte var ama ${sozlukSayisi} sozluk mevcut — ` +
      `bir dil atlanmis, o dilin kullanicisi Ingilizce yedege duser`);
  });

  test("hiçbir çeviri {n} yer tutucusunu KAYBETMEMİŞ", (t) => {
    /* ⚠️ Yer tutucu düşerse metin dilbilgisel olarak doğru ama SAYISIZ olur:
     * "en az gerçek üye gerekiyor". Sessiz bir bozulma. */
    if (!mobilVarMi()) return t.skip("mobil depo yok");
    const src = fs.readFileSync(path.join(MOBIL, "lib", "i18n.ts"), "utf8");
    const eksik = [];
    for (const satir of src.split("\n")) {
      if (!satir.includes(`${ANAHTAR}:`)) continue;
      if (!satir.includes("{n}")) eksik.push(satir.trim());
    }
    assert.deepEqual(eksik, [], "yer tutucusu dusen ceviriler: " + eksik.join(" | "));
  });

  test("sayı uyumu zorlu dillerde {n} SAYDIĞI ADDAN AYRI duruyor", (t) => {
    /**
     * ⚠️ SESSİZ ÇEVİRİ HATASI SINIFI. Slav dillerinde ve Arapçada sayılan ad,
     * SAYIYA göre çekimlenir:
     *     Lehçe   2 → "prawdziwi członkowie"  ·  5 → "prawdziwych członków"
     *     Rusça   2 → "участника"             ·  5 → "участников"
     *     Arapça  2 → ikil (عضوان)            ·  3-10 çoğul  ·  11+ tekil
     *
     * `{n}` değişken olduğu için TEK bir dizge hepsini doğru veremez.
     * `MIN_ODUL_UYE` bugün 2 ama env ile değişebilir — 5 yapıldığında bu
     * diller sessizce bozuk dilbilgisi gösterirdi ve hiçbir test kırılmazdı.
     *
     * Çözüm: bu dillerde sayı, saydığı addan AYRILDI — "az üye var
     * (en az: {n})". Ad sabit çekimde kalıyor, sayı parantez içinde duruyor.
     *
     * Bu iddia, birinin metni "en az {n} üye" biçimine geri sadeleştirmesini
     * yakalar. Sadeleştirme n=2'de doğru görünür, n=5'te bozulur.
     */
    if (!mobilVarMi()) return t.skip("mobil depo yok");
    const src = fs.readFileSync(path.join(MOBIL, "lib", "i18n.ts"), "utf8");

    const ZOR = ["pl", "ru", "uk", "hr", "sr", "cs", "sk", "ar"];
    const satirlar = src.split("\n");
    const basliklar = new Map();
    satirlar.forEach((l, i) => {
      const m = /^ {2}([a-z]{2}): \{\s*$/.exec(l);
      if (m) basliklar.set(i, m[1]);
    });

    const bulunan = new Set();
    const bozuk = [];
    satirlar.forEach((l, i) => {
      if (!l.includes(`${ANAHTAR}:`)) return;
      let dil = null;
      for (const [j, d] of [...basliklar].reverse()) if (j < i) { dil = d; break; }
      if (!ZOR.includes(dil)) return;
      bulunan.add(dil);
      /* `{n}` hemen ardından bir SÖZCÜK geliyorsa sayı adı sayıyor demektir. */
      if (/\{n\}\s+\S/.test(l)) bozuk.push(`${dil}: ${l.trim()}`);
    });

    assert.equal(bulunan.size, ZOR.length,
      `zor dillerin hepsi taranamadi (${[...bulunan].join(",")}) — tarama bozuk`);
    assert.deepEqual(bozuk, [],
      "sayi dogrudan bir adi sayiyor; n degisince dilbilgisi bozulur:\n" + bozuk.join("\n"));
  });

  test("ekran metni SUNUCU değeriyle basıyor", (t) => {
    /* Ekran asgari üye sayısını sabit yazsaydı sunucudaki MIN_ODUL_UYE
     * değişince yanlış sayı gösterirdi — bu depodaki tekrar eden kusur sınıfı
     * (bkz. duello odulTablosu). */
    if (!mobilVarMi()) return t.skip("mobil depo yok");
    const ekran = path.join(MOBIL, "app", "mini", "[id].tsx");
    if (!fs.existsSync(ekran)) return t.skip("ekran yok");
    const src = fs.readFileSync(ekran, "utf8");

    assert.ok(new RegExp(`${ANAHTAR}[^)]*odulKurali\\.minUye`).test(src),
      "ekran asgari uye sayisini sunucudan almiyor");
    assert.ok(/odulKesildi === "MIN_UYE"/.test(src),
      "aciklama odul kesilme nedenine baglanmamis — her odulsuz bitisde gorunur");
  });
});
