"use strict";

/**
 * VERİTABANI ADI TEK KAYNAKTAN — ÇIPLAK `client.db()` YASAK.
 *
 * ⚠️ KUSUR (2026-08-05, canlıda yakalandı): `scripts/cuzdan-yuvarla.cjs`
 * bağlantıyı kurduktan sonra `client.db()` diyordu — argümansız. Uygulama ise
 * adı `lib/mongo.cjs` içindeki `DB_NAME()`ten alıyor
 * (`process.env.MONGODB_DB || "skorlig"`).
 *
 * MONGODB_URI'de veritabanı adı YOK. Argümansız `db()` bu durumda sürücünün
 * varsayılanına ("test") düşüyor. Betik canlı veriye bakıyor sanıp BOŞ bir
 * veritabanını taradı ve şunu yazdı:
 *
 *     taranan cuzdan : 0
 *     kirli belge    : 0
 *
 * ⚠️ HATA ÜRETMEDİ. Çıktı "her şey temiz" gibi görünüyordu; doğrusu "hiçbir
 * şey ölçülmedi" idi. Bu betik PARA belgelerini onarmak için var — yanlış
 * veritabanına `--uygula` ile koşulsaydı hiçbir şey düzelmez, ama rapor
 * düzeldiğini söylerdi.
 *
 * Düzeltildikten sonra: `veritabani: skorlig · taranan cuzdan: 2`.
 *
 * Bu depodaki tekrar eden kusur sınıfı: aynı kuralın ikinci kopyası, sessizce
 * ayrışıyor. Kural artık `lib/mongo.cjs`ten dışa açık.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const KLASORLER = ["scripts", "lib", "services", "routes"];

/** Yorum satırları atılmış kaynak — nöbetçi kendi belgesine takılmasın. */
function kod(dosya) {
  return fs.readFileSync(dosya, "utf8")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

describe("kurulum", () => {
  test("veritabanı adı GERÇEKTEN dışa açık", () => {
    const { DB_NAME } = require("../lib/mongo.cjs");
    assert.equal(typeof DB_NAME, "function",
      "lib/mongo.cjs DB_NAME'i disa acmiyor — betikler adi kendi turetmek zorunda kalir");
    assert.ok(String(DB_NAME()).length > 0, "veritabani adi bos");
  });

  test("tarama gerçekten dosya okuyor", () => {
    let n = 0;
    for (const alt of KLASORLER) {
      const d = path.join(KOK, alt);
      if (fs.existsSync(d)) n += fs.readdirSync(d).filter((f) => f.endsWith(".cjs")).length;
    }
    assert.ok(n > 20, `yalnizca ${n} dosya tarandi — tarama bozuk`);
  });
});

describe("nöbetçi", () => {
  test("hiçbir yerde argümansız .db() yok", () => {
    const bulunan = [];
    for (const alt of KLASORLER) {
      const d = path.join(KOK, alt);
      if (!fs.existsSync(d)) continue;
      for (const dosya of fs.readdirSync(d)) {
        if (!dosya.endsWith(".cjs")) continue;
        kod(path.join(d, dosya)).split("\n").forEach((l, i) => {
          if (/\.db\(\s*\)/.test(l)) bulunan.push(`${alt}/${dosya}:${i + 1}  ${l.trim()}`);
        });
      }
    }
    assert.deepEqual(
      bulunan, [],
      "Argumansiz .db() — MONGODB_URI'de veritabani adi olmadigi icin surucunun\n" +
      "varsayilanina duser ve YANLIS (bos) veritabani taranir. Hata uretmez,\n" +
      "yalnizca 0 kayit doner; bu 'temiz' degil 'olculmedi' demektir.\n" +
      "Dogrusu: const { DB_NAME } = require('../lib/mongo.cjs') · client.db(DB_NAME())\n" +
      bulunan.join("\n")
    );
  });

  test("onarım betiği SIFIR kayıtta sessiz kalmıyor", () => {
    /**
     * ⚠️ Doğru veritabanına bakmak yetmez: bağlantı ya da koleksiyon adı bir
     * gün değişirse betik yine 0 görür. Para onaran bir betiğin "0 kayıt"ı
     * başarı gibi raporlaması, kusurun kendisiydi.
     */
    const src = kod(path.join(KOK, "scripts", "cuzdan-yuvarla.cjs"));
    assert.ok(/if \(!taranan\)/.test(src),
      "sifir kayit durumu denetlenmiyor — yanlis olcum temiz sonuc gibi gorunur");
    assert.ok(/process\.exitCode = 3/.test(src),
      "sifir kayitta cikis kodu ayarlanmiyor — otomasyon basarili sanir");
    assert.ok(/DB_NAME\(\)/.test(src), "betik veritabani adini tek kaynaktan almiyor");
  });
});
