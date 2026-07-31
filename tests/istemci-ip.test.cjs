"use strict";

/**
 * HIZ SINIRI ANAHTARI UYDURULAMAMALI.
 *
 * ⚠️ BULUNAN AÇIK: iki yer `x-forwarded-for` başlığının SOLUNDAN okuyordu.
 * O giriş tamamen istemci denetiminde — proxy başlığı silmez, SONUNA ekler.
 * `X-Forwarded-For: uydurma` gönderen istemcinin isteği uygulamaya
 * `uydurma, <gerçek-ip>` olarak ulaşır; soldan okuma "uydurma"yı verir ve
 * saldırgan her istekte kendine YENİ KOVA açar.
 *
 * Kırılan korumalar:
 *   • `/api/auth1987gs/verify` ve `/api/weekly-picks/verify-code` — 5/dk.
 *     Kod doğru girilirse KALICI premium + 60 LC. Sınırsız deneme = kaba kuvvet.
 *   • kupon/düello/havuz akın koruması
 *   • `routes/presets.cjs` PIN denemesi (10 dakikada 5)
 *
 * ⚠️ İKİNCİ KATMAN DA AYNI DELİKTEYDİ: `rateLimit`in IP tavanı, yorumunda
 * "kimliği değiştirerek 1. katmanı atlayan saldırgan buraya takılır" diyor —
 * ama aynı `ipOf`u kullanıyordu. Yedek, yedeklediği şeyle aynı delikteydi.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { istemciIp } = require("../lib/istemci-ip.cjs");

const GERCEK = "5.6.7.8";
const SOKET = "10.0.0.9";

function istek(xff) {
  const h = {};
  if (xff !== undefined) h["x-forwarded-for"] = xff;
  return { headers: h, socket: { remoteAddress: SOKET } };
}

/** Verilen hop sayısıyla çalıştır. */
function hopla(hop, fn) {
  const eskiH = process.env.SKORLIG_PROXY_HOPS;
  const eskiN = process.env.NODE_ENV;
  process.env.SKORLIG_PROXY_HOPS = String(hop);
  try { return fn(); }
  finally {
    if (eskiH === undefined) delete process.env.SKORLIG_PROXY_HOPS; else process.env.SKORLIG_PROXY_HOPS = eskiH;
    if (eskiN === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = eskiN;
  }
}

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

test("istemcinin yazdığı çöp anahtarı DEĞİŞTİRMEZ", () => {
  hopla(1, () => {
    // Proxy gerçek adresi SONA ekler; ne kadar çöp öne konursa konsun sonuç aynı.
    const cop = ["uydurma", "1.1.1.1, 2.2.2.2", "a, b, c, d, e"];
    for (const c of cop) {
      assert.equal(
        istemciIp(istek(`${c}, ${GERCEK}`)),
        GERCEK,
        `"${c}" onune konunca anahtar degisti — sinir atlatilabilir`
      );
    }
  });
});

test("aynı istemci farklı çöplerle AYNI kovaya düşer", () => {
  hopla(1, () => {
    const a = istemciIp(istek(`rastgele-1, ${GERCEK}`));
    const b = istemciIp(istek(`rastgele-2, ${GERCEK}`));
    assert.equal(a, b, "her istekte yeni kova aciliyor — hiz siniri islevsiz");
  });
});

test("iki proxy hop'unda da doğru giriş okunuyor", () => {
  hopla(2, () => {
    // istemci "cop" yazar; kenar gerçek IP'yi, ikinci proxy kenarın IP'sini ekler.
    assert.equal(istemciIp(istek(`cop, ${GERCEK}, 172.16.0.1`)), GERCEK);
  });
});

/* ── Kapalı tarafta hata ─────────────────────────────────────────────────── */

test("beklenen zincir yoksa SOKET adresine düşer", () => {
  hopla(2, () => {
    // Tek girişli başlık, iki hop bekleniyor → zincir beklenmedik.
    assert.equal(istemciIp(istek(GERCEK)), SOKET, "eksik zincirde basliga guveniliyor");
  });
  hopla(1, () => {
    assert.equal(istemciIp(istek(undefined)), SOKET);
    assert.equal(istemciIp(istek("")), SOKET);
    assert.equal(istemciIp(istek("   ,  ")), SOKET);
  });
});

test("YEREL (hop=0) başlığa hiç bakmaz", () => {
  hopla(0, () => {
    /* Yerelde proxy yoktur; başlığa bakmak, kendi makinesinden istek atan
     * birinin kendini istediği IP gibi göstermesi demek olurdu. */
    assert.equal(istemciIp(istek(`${GERCEK}, 1.2.3.4`)), SOKET);
  });
});

test("varsayılan: üretimde 1 hop, yerelde 0", () => {
  const eskiH = process.env.SKORLIG_PROXY_HOPS;
  const eskiN = process.env.NODE_ENV;
  const eskiR = process.env.RENDER;
  delete process.env.SKORLIG_PROXY_HOPS;
  delete process.env.RENDER;
  try {
    process.env.NODE_ENV = "production";
    assert.equal(istemciIp(istek(`cop, ${GERCEK}`)), GERCEK, "uretimde proxy okunmuyor");

    delete process.env.NODE_ENV;
    assert.equal(istemciIp(istek(`cop, ${GERCEK}`)), SOKET, "yerelde basliga guveniliyor");
  } finally {
    if (eskiH !== undefined) process.env.SKORLIG_PROXY_HOPS = eskiH;
    if (eskiN === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = eskiN;
    if (eskiR !== undefined) process.env.RENDER = eskiR;
  }
});

test("bozuk SKORLIG_PROXY_HOPS varsayılana düşer (sessiz 0'a değil)", () => {
  const eskiH = process.env.SKORLIG_PROXY_HOPS;
  const eskiN = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    for (const bozuk of ["abc", "-3"]) {
      process.env.SKORLIG_PROXY_HOPS = bozuk;
      assert.equal(
        istemciIp(istek(`cop, ${GERCEK}`)), GERCEK,
        `"${bozuk}" degeri hop'u sifirladi — uretimde proxy okunmaz olurdu`
      );
    }
  } finally {
    if (eskiH === undefined) delete process.env.SKORLIG_PROXY_HOPS; else process.env.SKORLIG_PROXY_HOPS = eskiH;
    if (eskiN === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = eskiN;
  }
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kimse x-forwarded-for'u ham okumuyor", () => {
  /**
   * `lib/istemci-ip.cjs` tek okuyucu. Yeni bir sayaç başlığı kendi okursa
   * aynı tuzağa düşer — özellikle `split(",")[0]` biçimi.
   *
   * MUAF: `isInternalCaller` ve `rateLimit.isInternal` başlığın VARLIĞINA
   * bakıyor (değerine değil) — "başlık varsa istek dışarıdan gelmiştir".
   * Bu kullanım uydurulabilir değil: istemci başlığı EKLEYEBİLİR ama
   * SİLEMEZ, yani yalnızca kendini "daha dış" gösterebilir.
   */
  const MUAF = new Set([
    "lib/istemci-ip.cjs",
    "lib/internal-caller.cjs",
    "middleware/rateLimit.cjs",
  ]);
  const kusurlu = [];
  let bakilan = 0;

  for (const alt of ["routes", "lib", "services", "middleware"]) {
    const d = path.join(__dirname, "..", alt);
    if (!fs.existsSync(d)) continue;
    for (const dosya of fs.readdirSync(d)) {
      if (!dosya.endsWith(".cjs")) continue;
      const ad = `${alt}/${dosya}`;
      const satirlar = fs.readFileSync(path.join(d, dosya), "utf8").split("\n");
      satirlar.forEach((satir, i) => {
        const t = satir.trim();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
        if (!/x-forwarded-for/.test(satir)) return;
        bakilan++;
        if (MUAF.has(ad)) return;
        kusurlu.push(`${ad}:${i + 1}`);
      });
    }
  }

  assert.ok(bakilan >= 3, `cok az kullanim bulundu (${bakilan}) — tarama bozulmus olabilir`);
  assert.deepStrictEqual(
    kusurlu,
    [],
    "Bu yerler `x-forwarded-for`u dogrudan okuyor. Baslik istemci denetiminde:\n" +
      "soldan okumak uydurma bir deger verir ve sayac her istekte sifirlanir.\n" +
      "`lib/istemci-ip.cjs` kullan:\n" + kusurlu.join("\n")
  );
});

test("NÖBETÇİ: iki hız sınırı katmanı da aynı kaynaktan okuyor", () => {
  /**
   * IP tavanının varlık sebebi 1. katmanı atlayanı yakalamak. İkisi farklı
   * kaynaklardan okursa tavan yeniden delinir — nitekim ikisi de aynı kusurlu
   * `ipOf`u kullandığı için yedek işe yaramıyordu.
   */
  const ham = fs.readFileSync(path.join(__dirname, "..", "middleware", "rateLimit.cjs"), "utf8");
  /* ⚠️ YORUMLAR AYIKLANMALI. İlk sürüm ham metinde arıyordu ve `rateLimit`in
   * kendi düzeltme notundaki `xff.split(",")[0]` ÖRNEĞİNE takıldı: hata
   * anlatılıyordu, yapılmıyordu. Bu oturumda aynı tuzağa beşinci düşüş —
   * metin tarayan her nöbetçi yorum/kod ayrımını yapmak zorunda. */
  const src = ham
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    /istemciIp[^\n]*require\([^\n]*istemci-ip/.test(src),
    "rateLimit ortak IP okuyucusunu kullanmiyor"
  );
  assert.ok(!/split\(","\)\s*\[\s*0\s*\]/.test(src), "hala soldan okuma kalibi var");
});
