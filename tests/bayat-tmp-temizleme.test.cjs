"use strict";

/**
 * ATOMİK YAZMADAN ARTAN GEÇİCİ DOSYALAR SÜPÜRÜLÜYOR.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-08-05, geliştirme makinesi): `data/` altında 39 artık
 * dosya, 38,4 MB. En eskisi 17 Temmuz — üç haftada birikmiş.
 *
 * Sekiz depo modülü de `tmp` yaz + `rename` deseniyle çalışıyor ve hepsi
 * yalnızca YAZMA HATASINDA temizlik yapıyor. Süreç `rename`den ÖNCE ölürse
 * (SIGKILL, çökme, deploy kesintisi) o kol hiç çalışmıyor ve dosya kalıyor.
 *
 * ⚠️ EN KRİTİK İDDİA "SİLİYOR" DEĞİL, "TAZE OLANI SİLMİYOR". Aynı dizine
 * yazan başka bir süreç olabilir; onun O AN yazdığı geçici dosyayı silmek
 * yarım veriyi `rename` ettirir ya da yazmayı patlatır — yani temizlik,
 * temizlemeye çalıştığı sorundan beter bir kusur üretir.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { bayatTmpTemizle, _VARSAYILAN_YAS_MS } = require("../lib/bayat-tmp-temizle.cjs");

function gecici() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-tmp-supurme-"));
}

/** Dosyayi verilen yas ile olusturur (mtime geriye alinir). */
function yaz(dizin, ad, yasMs) {
  const p = path.join(dizin, ad);
  fs.writeFileSync(p, "x".repeat(100));
  if (yasMs) {
    const t = new Date(Date.now() - yasMs);
    fs.utimesSync(p, t, t);
  }
  return p;
}

describe("bayat gecici dosya supurme", () => {
  test("BAYAT artiklari siliyor", async () => {
    const d = gecici();
    try {
      yaz(d, "users.json.tmp-480-1784316987785-1", 3 * 60 * 60 * 1000);
      yaz(d, "push-sent.json.tmp-2852-1785161015457-7", 26 * 60 * 60 * 1000);
      /* ⚠️ ESKİ İKİ PARÇALI AD (sayaç yok) — diskteki artıkların ÇOĞU böyle.
       * Kalıbı önce üç parçayla sınırlı yazmıştım; gerçek dizinde kuru koşu
       * yapınca 6 dosya / 33,6 MB kalıp dışı kaldı, üçü 11 MB'lık preds.json.
       * Yani süpürme çöpün %87'sini görmüyordu. */
      yaz(d, "preds.json.tmp-18516-1785269705267", 40 * 60 * 60 * 1000);

      const r = await bayatTmpTemizle(d);
      assert.equal(r.silinen, 3, `silinen: ${r.silinen}`);
      assert.ok(r.bayt > 0, "bayt sayaci calismiyor");
      assert.deepEqual(fs.readdirSync(d), [], `dizinde kalan: ${fs.readdirSync(d)}`);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test("TAZE artiga DOKUNMUYOR — canli yazmayi bozmamak icin", async () => {
    /**
     * ⚠️ ASIL TEHLİKE BU. Başka bir süreç şu anda yazıyor olabilir; onun
     * geçici dosyasını silmek yarım veri yazdırır. Gerçek bir yazma
     * milisaniyeler sürer, eşik 1 saat — hiçbir canlı yazmaya denk gelmez.
     */
    const d = gecici();
    try {
      yaz(d, "fixtures.json.tmp-999-1785649780414-1", 0);            // az once
      yaz(d, "totals.json.tmp-999-1785649780414-2", 5 * 60 * 1000);  // 5 dk once

      const r = await bayatTmpTemizle(d);
      assert.equal(r.silinen, 0, `taze dosya silindi (${r.silinen}) — canli yazma bozulur`);
      assert.equal(fs.readdirSync(d).length, 2, "taze dosyalar kaybolmus");
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test("GERCEK dosyalara dokunmuyor", async () => {
    /* Kalıp dar: yalnızca `<ad>.tmp-<pid>-<zaman>-<sayac>`. Kullanicinin
     * mesru `.tmp` dosyasi ya da normal JSON silinmemeli. */
    const d = gecici();
    try {
      yaz(d, "fixtures.json", 48 * 60 * 60 * 1000);
      yaz(d, "notlar.tmp", 48 * 60 * 60 * 1000);
      yaz(d, "yedek.json.tmp-abc", 48 * 60 * 60 * 1000);
      yaz(d, "eski.json.tmp-1", 48 * 60 * 60 * 1000);   // tek parca — atomik yazma degil

      const r = await bayatTmpTemizle(d);
      assert.equal(r.silinen, 0, `kalip disi dosya silindi: ${r.silinen}`);
      assert.equal(fs.readdirSync(d).length, 4, "kalip disi dosya kaybolmus");
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test("olmayan dizinde patlamiyor", async () => {
    const r = await bayatTmpTemizle(path.join(os.tmpdir(), "skorlig-yok-boyle-bir-dizin"));
    assert.deepEqual(r, { silinen: 0, bayt: 0, hata: 0 });
  });

  test("esik makul (30 dk - 24 saat)", () => {
    const saat = _VARSAYILAN_YAS_MS / 3600000;
    assert.ok(saat >= 0.5 && saat <= 24, `esik ${saat} saat — bu aralikta olmali`);
  });
});

describe("acilista cagriliyor", () => {
  test("server.cjs supurmeyi tetikliyor", () => {
    /**
     * Davranış testleri yardımcıyı sınıyor; bu nöbetçi ÇAĞRILDIĞINI söylüyor.
     * Yardımcı doğru çalışıp hiç çağrılmazsa çöp yine birikir — ve bunu
     * hiçbir birim testi göstermez.
     */
    const src = fs.readFileSync(path.join(__dirname, "..", "server.cjs"), "utf8");
    const kod = src.split("\n")
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");
    assert.ok(
      /bayatTmpTemizle\(/.test(kod),
      "server.cjs bayat gecici dosya supurmesini cagirmiyor — artiklar birikir"
    );
  });

  test("depolarin hicbiri kendi supurmesini yazmiyor (tek kaynak)", () => {
    /* ⚠️ Aynı kuralı sekiz modüle kopyalamak bu depoda defalarca ayrışmaya
     * yol açtı. Süpürme dizin bazında TEK yerde. */
    const kok = path.join(__dirname, "..");
    const kopya = [];
    for (const dizin of ["lib", "services"]) {
      const d = path.join(kok, dizin);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith(".cjs") || f === "bayat-tmp-temizle.cjs") continue;
        const s = fs.readFileSync(path.join(d, f), "utf8");
        if (/readdir[^\n]*\n?[^\n]*\.tmp-/.test(s)) kopya.push(`${dizin}/${f}`);
      }
    }
    assert.deepEqual(kopya, [], `su modullerde ikinci bir supurme kopyasi var: ${kopya.join(", ")}`);
  });
});
