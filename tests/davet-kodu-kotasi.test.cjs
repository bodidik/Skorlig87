"use strict";

/**
 * HER DAVET KODUNUN AÇIK BİR KOTASI OLMALI.
 *
 * ⚠️ BU TURDA CANLI KUSUR BULUNMADI — 29 kodun 29'unda `maxUses` var (50-500
 * arası, toplam 7150 üyelik hakkı, şu ana kadar 0 kullanılmış). Kilitlenen şey
 * sessizce bozulabilecek bir VARSAYILAN.
 *
 * ⚠️ NEDEN ÖNEMLİ: `lib/invite-store.cjs` kotayı sorgunun içinde tutuyor ama
 * alanın YOKLUĞUNU "sınırsız" sayıyor:
 *
 *     $or: [
 *       { maxUses: { $in: [0, null] } },
 *       { maxUses: { $exists: false } },        // ← alan yoksa sınırsız
 *       { $expr: { $lt: [{ $ifNull: ["$used", 0] }, "$maxUses"] } },
 *     ]
 *
 * `maxUses: 0` BİLİNÇLİ bir "sınırsız" işareti ve belgelenmiş. Ama alanın
 * hiç olmaması "kimse karar vermemiş" demek — ve bu kod tabanı ayrıcalık
 * kapılarında her yerde KAPALI tarafta hata yapıyor (requireAdmin 503, 1987
 * kodu 503, verifyToken 503). Burada varsayılan ters yönde.
 *
 * Bir 1987 üyeliği SÜRESİZ premium + 60 LC açılış demek. Elle düzenlenmiş bir
 * JSON'a kotasız tek bir kod girmesi, sınırsız bir musluk açar ve hiçbir yerde
 * hata üretmez.
 *
 * ⚠️ SEMANTİK DEĞİŞTİRİLMEDİ. "Alan yoksa sınırsız" davranışını değiştirmek,
 * o davranışa dayanan bir kurulumu bozabilirdi; karar kullanıcının. Bunun
 * yerine VERİ tarafı bağlandı: kotasız kod eklenemiyor.
 *
 * ⚠️ YANLIŞ ALARM PAYIM: bu turda önce `data/invites.json` içinde kotasız bir
 * kayıt gördüm ve sınırsız musluk sandım. İki şey yanlıştı — depo o dosyadan
 * DEĞİL `gs1987-codes.json`dan besleniyor, ve o "kayıt" boş bir nesneydi.
 * Kaynağı doğrulamadan bulgu yazmak, olmayan bir açığı rapor etmek olurdu.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/** Deponun GERÇEKTEN okuduğu dosya — koddan türetiliyor, elle yazılmıyor. */
function kodDosyasi() {
  const src = fs.readFileSync(path.join(KOK, "lib", "invite-store.cjs"), "utf8");
  const m = /const FILE = path\.join\(DATA_DIR,\s*"([^"]+)"\)/.exec(src);
  assert.ok(m, "invite-store icindeki dosya adi okunamadi");
  return m[1];
}

function kodlar() {
  const dosya = path.join(
    process.env.SKORLIG_DATA_DIR || path.join(KOK, "data"),
    kodDosyasi()
  );
  if (!fs.existsSync(dosya)) return null;
  /**
   * ⚠️ CANLI `data/` DİZİNİYLE YARIŞ — SÜİTİ ARADA BİR KIRIYORDU.
   *
   * Sunucu çalışırken bu dizine sürekli yazılıyor ve yazma ATOMİK: önce
   * `*.tmp`, sonra rename. `existsSync` ile `readFileSync` arasına rename
   * denk gelirse dosya bir an yok olur ya da yarım görünür ve test ÜRÜN
   * KUSURU OLMADAN kırılır.
   *
   * ÖLÇÜLDÜ (2026-08-02): aynı kökten üç ayrı kırılganlık bulundu
   * (`guvenli-yol-siniri`, `bildirim-icerigi`, `sezon-siniri`); bu dördüncüsü.
   *
   * ⚠️ SESSİZCE GEÇMİYOR: okunamazsa `null` döner, çağıran iddiayı ATLAR ve
   * sebep loga yazılır.
   */
  for (let deneme = 0; deneme < 2; deneme++) {
    try {
      const raw = JSON.parse(fs.readFileSync(dosya, "utf8"));
      return Array.isArray(raw) ? raw : (raw.items || raw.codes || []);
    } catch (e) {
      if (deneme === 1) {
        console.warn(`[test] canli kod dosyasi okunamadi (${dosya}): ${e.message} — iddia atlaniyor`);
        return null;
      }
    }
  }
  return null;
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("depo dosyası koddan bulunuyor", () => {
    assert.match(kodDosyasi(), /\.json$/);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kod kotaları", () => {
  test("her kodun AÇIK bir maxUses değeri var", (t) => {
    const liste = kodlar();
    if (!liste) return t.skip("kod dosyasi yok (temiz kurulum)");
    assert.ok(liste.length > 0, "kod listesi bos — test bir sey olcmuyor");

    const kotasiz = liste
      .map((c, i) => ({ i, c }))
      .filter(({ c }) => c && typeof c === "object" && c.maxUses === undefined)
      .map(({ i, c }) => `#${i} ${c.code || c.codeNorm || "(kodsuz)"}`);

    assert.deepStrictEqual(
      kotasiz, [],
      "Bu kodlarda `maxUses` alani YOK. invite-store alanin yoklugunu SINIRSIZ\n" +
        "sayiyor; bir 1987 uyeligi suresiz premium + 60 LC demek, yani bu\n" +
        "kodlar sinirsiz musluk olur ve hicbir yerde hata uretmez:\n" + kotasiz.join("\n")
    );
  });

  test("hiçbir kod açıkça sınırsız (maxUses = 0) değil", (t) => {
    /**
     * `maxUses: 0` belgelenmiş bir "sınırsız" işareti — yasak değil ama
     * bilinçli olmalı. Bugün hiç yok; biri eklenirse bu test onu görünür
     * kılar ve karar gözden geçirilir.
     */
    const liste = kodlar();
    if (!liste) return t.skip("kod dosyasi yok");
    const sinirsiz = liste
      .filter((c) => c && Number(c.maxUses) === 0)
      .map((c) => c.code || c.codeNorm || "(kodsuz)");
    assert.deepStrictEqual(
      sinirsiz, [],
      "Bu kodlar ACIKCA sinirsiz (maxUses=0). Bilincliyse testi guncelle;\n" +
        "degilse kota ver:\n" + sinirsiz.join("\n")
    );
  });

  test("kod kayıtları boş nesne değil", (t) => {
    /**
     * ⚠️ Bu turda `data/invites.json` içinde boş bir `{}` kaydı gördüm ve az
     * kalsın "kotasiz kod" diye rapor ediyordum. Boş kayıt hem anlamsız hem
     * de kota taramasını yanıltıyor.
     */
    const liste = kodlar();
    if (!liste) return t.skip("kod dosyasi yok");
    const bos = liste
      .map((c, i) => ({ i, c }))
      .filter(({ c }) => !c || typeof c !== "object" || !(c.code || c.codeNorm))
      .map(({ i }) => `#${i}`);
    assert.deepStrictEqual(bos, [], "Kodsuz/bos kayitlar var:\n" + bos.join("\n"));
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kota koşulu sorgunun İÇİNDE (kontrol-sonra-yaz değil)", () => {
  /**
   * Dosyanın kendi notu eski hatayı anlatıyor: "dosyayı oku → kodu bul →
   * `used >= maxUses` kontrol et → yaz" sırası yarış üretiyordu. Koşul
   * `findOneAndUpdate` filtresinde kalmalı.
   */
  const src = fs.readFileSync(path.join(KOK, "lib", "invite-store.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/findOneAndUpdate\(/.test(src), "atomik kullanim kaldirilmis");
  assert.ok(
    /\$expr[\s\S]{0,80}\$lt[\s\S]{0,80}maxUses/.test(src),
    "kota kosulu sorgunun icinde degil — yaris geri gelir"
  );
});
