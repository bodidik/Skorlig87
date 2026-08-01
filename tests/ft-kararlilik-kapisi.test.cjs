"use strict";

/**
 * UZLAŞMA, SKOR KARARLI HÂLE GELMEDEN TETİKLENMEZ.
 *
 * ⚠️ NEDEN: uzlaşma `claimAward` ile MÜHÜRLÜ — aynı maç iki kez ödeme
 * yapmasın diye. Doğru bir koruma ama geri dönüşü yok: skor sonradan
 * düzelirse puanlar ve LC kalıcı olarak yanlış kalıyor, çünkü yeniden
 * uzlaşma OLMUYOR (dağıtılmış LC'yi geri almak bakiyeyi eksiye düşürebilir).
 *
 * ÖLÇÜLDÜ (üretim, 636 uzlaşmış maç): 4'ünde (%0.63) ödenen skor bugünkü
 * skordan FARKLI ve İKİSİNDE 1X2 SONUCU DEĞİŞMİŞ:
 *     1-0 → 2-2   (ev kazandı sanıldı, berabere bitmiş)
 *     2-3 → 2-2   (deplasman kazandı sanıldı, berabere bitmiş)
 * Yani para yanlış kişilere gitmiş.
 *
 * ⚠️ SABİT SAYAÇ DEĞİL KARARLILIK KOŞULU. Kapı "FT'den N dk geçti" demiyor,
 * "SKOR N dk'dır DEĞİŞMİYOR" diyor: `skorSabitAt` skor her değiştiğinde
 * sıfırlanıyor. Böylece bekleme kendi kendine uyarlanıyor — skor oturmuşsa
 * kısa, hâlâ oynuyorsa oturana kadar.
 *
 * ⚠️ SÜRE TAHMİNLE SEÇİLDİ, VE BUNU AÇIKÇA YAZIYORUM. Düzeltmenin ne kadar
 * sonra geldiğini ÖLÇEMEDİM: durum dosyasındaki `updatedAt` her turda
 * yeniden yazılıyor, yani "en son ne zaman görüldü" demek. İlk analizimde
 * onu "düzeltme zamanı" sanıp +204/+607 dk gibi sayılar çıkarmıştım; yanlıştı.
 * Bu yüzden 10 dk bir BAŞLANGIÇ değeri ve `ilkFtAt` + `ftSonrasiDegisim`
 * damgaları tam da bu soruyu ölçülebilir kılmak için yazılıyor.
 *
 * ⚠️ BEKLEME KAYBA YOL AÇMAZ: sonraki senkron turu aynı maçı yeniden görüyor
 * ve kapı açıldığında uzlaştırıyor. Sonuç hiç oturmazsa `lib/bayat-mac.cjs`
 * 48 saatte parayı iade ediyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const Sync = require("../services/livescore-sync.cjs");
const { ftBeklemesiDoldu, FT_BEKLEME_DK } = Sync;

const DK = 60 * 1000;
const T0 = Date.parse("2026-08-01T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("kapı fonksiyonu dışa açık ve süre pozitif", () => {
    assert.equal(typeof ftBeklemesiDoldu, "function", "kapi disa acilmamis");
    assert.ok(FT_BEKLEME_DK > 0, `bekleme ${FT_BEKLEME_DK} — kapi kapali, test bir sey olcmuyor`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kararlılık kapısı", () => {
  test("skor YENİ sabitlendi → BEKLET", () => {
    const st = { status: "FT", skorSabitAt: iso(T0), ilkFtAt: iso(T0) };
    const r = ftBeklemesiDoldu(st, T0 + 1 * DK);
    assert.equal(r.hazir, false, "yeni sabitlenen skorla hemen uzlasiliyor");
    assert.ok(r.kalanDk > 0, "kalan sure bildirilmiyor");
  });

  test("skor yeterince uzun sabit → GEÇİR", () => {
    const st = { status: "FT", skorSabitAt: iso(T0), ilkFtAt: iso(T0) };
    const r = ftBeklemesiDoldu(st, T0 + (FT_BEKLEME_DK + 1) * DK);
    assert.equal(r.hazir, true, `${FT_BEKLEME_DK}+1 dk sonra hala bekletiliyor`);
  });

  test("tam sınırda GEÇİRİYOR (kapali aralik)", () => {
    const st = { status: "FT", skorSabitAt: iso(T0) };
    assert.equal(ftBeklemesiDoldu(st, T0 + FT_BEKLEME_DK * DK).hazir, true);
  });

  test("skor DEĞİŞİNCE sayaç sıfırlanmış sayılır", () => {
    /**
     * Asıl fikir bu: FT'den 30 dk geçmiş olabilir ama skor 1 dk önce
     * değiştiyse hâlâ beklenmeli. `skorSabitAt` sıfırlandığı için kapı
     * kapalı kalır — düz "FT+N dk" sayacı burada geçirirdi.
     */
    const st = {
      status: "FT",
      ilkFtAt: iso(T0),                       // FT 30 dk önce
      skorSabitAt: iso(T0 + 29 * DK),         // ama skor 1 dk önce degisti
      ftSonrasiDegisim: 1,
    };
    const r = ftBeklemesiDoldu(st, T0 + 30 * DK);
    assert.equal(r.hazir, false, "skor yeni degistigi halde uzlasmaya izin verildi");
  });
});

/* ── Geriye uyum ─────────────────────────────────────────────────────────── */

describe("eski kayıtlar engellenmiyor", () => {
  /**
   * ⚠️ Bu özellikten ÖNCE yazılmış durum dosyalarında damga yok. Onları
   * bekletmek, hiç uzlaşmayan maç yaratırdı — fail-closed burada YANLIŞ yön.
   */
  test("damgasız durum dosyası GEÇİYOR", () => {
    assert.equal(ftBeklemesiDoldu({ status: "FT", score: { home: 1, away: 0 } }, T0).hazir, true);
  });

  test("durum dosyası hiç yoksa GEÇİYOR", () => {
    assert.equal(ftBeklemesiDoldu(null, T0).hazir, true);
  });

  test("bozuk damga GEÇİYOR", () => {
    assert.equal(ftBeklemesiDoldu({ skorSabitAt: "abc" }, T0).hazir, true);
  });
});

describe("kapatma anahtarı", () => {
  test("SKORLIG_FT_BEKLEME_DK=0 iken kapı devre dışı", () => {
    /**
     * Süre yanlış seçilirse ödemeler gecikir; operatörün tek komutla eski
     * davranışa dönebilmesi gerekiyor. Ayrı süreçte sınanıyor, çünkü değer
     * modül yüklenirken okunuyor.
     */
    const { execFileSync } = require("child_process");
    const betik = `
      process.env.SKORLIG_FT_BEKLEME_DK = "0";
      process.env.SKORLIG_DATA_DIR = require("os").tmpdir();
      const S = require(${JSON.stringify(path.join(KOK, "services", "livescore-sync.cjs").replace(/\\/g, "/"))});
      const st = { status: "FT", skorSabitAt: new Date().toISOString() };
      console.log("SONUC:" + JSON.stringify(S.ftBeklemesiDoldu(st, Date.now())));
    `;
    const cikti = execFileSync(process.execPath, ["-e", betik], { cwd: KOK, encoding: "utf8", timeout: 60000 });
    const satir = cikti.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("SONUC:")).pop();
    assert.ok(satir, `alt surec cikti uretmedi:\n${cikti.slice(-300)}`);
    const r = JSON.parse(satir.slice(6));
    assert.equal(r.hazir, true, "kapatma anahtari calismiyor — operator geri donemez");
    assert.equal(r.sebep, "bekleme-kapali");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

const kaynak = fs.readFileSync(path.join(KOK, "services", "livescore-sync.cjs"), "utf8")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

/**
 * ⚠️ İŞ BÖLÜMÜ, VE SINIRI AÇIKÇA YAZIYORUM. Yukarıdaki davranış testleri saf
 * `ftBeklemesiDoldu` fonksiyonunu çağırıyor — yani KAPININ MANTIĞINI kilitler,
 * kapının KULLANILDIĞINI değil. Negatif kontrolde tetikteki `if (beklendi.hazir)`
 * koşulunu sildim ve o testler KIRILMADI; yalnızca aşağıdaki iki nöbetçi
 * ateşledi. İkisi birlikte gerekli.
 */
test("NÖBETÇİ: settle tetiği kapıdan geçiyor", () => {
  assert.ok(
    /if \(beklendi\.hazir\)[\s\S]{0,120}settleQueue\.push\(fid\)/.test(kaynak),
    "settle tetigi kararlilik kapisina bagli degil"
  );
});

test("NÖBETÇİ: skor değişince sayaç sıfırlanıyor", () => {
  /**
   * `skorSabitAt` yalnızca skor AYNIYSA korunmalı. Koşul kaybolursa kapı
   * düz bir FT sayacına döner ve asıl korumayı kaybederiz.
   */
  assert.ok(/skorAyni/.test(kaynak), "skor karsilastirmasi kalkmis");
  assert.ok(
    /st\.skorSabitAt = skorAyni && prev\?\.skorSabitAt \? prev\.skorSabitAt : nowISO;/.test(kaynak),
    "skorSabitAt skor degisince sifirlanmiyor"
  );
  /* ⚠️ `ilkFtAt` yalnızca gerçek LIVE→FT geçişinde damgalanmalı; aksi hâlde
   * özellikten önce bitmiş maçlara sahte zaman basılır ve gecikme ölçümü
   * kirlenir (ilk yazımımdaki hata tam buydu). */
  assert.ok(
    /else if \(!oncedenFT\) st\.ilkFtAt = nowISO;/.test(kaynak),
    "ilkFtAt LIVE->FT gecisi disinda da damgalaniyor — olcum kirlenir"
  );
});

test("NÖBETÇİ: ölçüm damgaları yazılıyor", () => {
  /**
   * Süre tahminle seçildi; `ilkFtAt` ve `ftSonrasiDegisim` olmadan onu
   * sonradan VERİYLE düzeltemeyiz.
   */
  assert.ok(/st\.ilkFtAt =/.test(kaynak), "ilkFtAt yazilmiyor");
  assert.ok(/st\.ftSonrasiDegisim =/.test(kaynak), "ftSonrasiDegisim sayaci yok");
});
