"use strict";

/**
 * DÜELLO DURUM ADLARI TEK KAYNAKLA UYUMLU.
 *
 * ⚠️ BU TURDA KUSUR BULUNMADI. "Savunma tek modülde asılı kalmış" kalıbını
 * (bu oturumda üç kez kusur üretti) `lib/` ve `middleware/` genelinde taradım:
 * her dışa açılan yardımcının çalışma zamanı çağrı kapsamını koddan türettim.
 * İki aday çıktı, ikisi de temiz:
 *
 *   • `lib/istemci-ip.cjs istemciIp` tek yerde görünüyordu (routes/presets).
 *     KAYNAĞI DOĞRULADIM: `middleware/rateLimit.cjs` onu `ipOf` TAKMA ADIYLA
 *     alıyor — taramam yeniden adlandırmayı kaçırmıştı. Hız sınırı korumasız
 *     değil.
 *   • `lib/duel-durum.cjs` sabitleri (`DURUM`, `KAPANMIS`) `routes/duels.cjs`
 *     içinde HİÇ kullanılmıyor; orası durum adlarını düz metin yazıyor
 *     ("open", "active", "settled", "cancelled"). ÖLÇTÜM: yazılan metinler şu
 *     an sabitlerle BİREBİR aynı, yani canlı bir ayrışma yok.
 *
 * ⚠️ AMA BU AYRIŞMA DAHA ÖNCE GERÇEKTEN OLDU VE PARAYA MAL OLDU. Modülün
 * kendi başlığı anlatıyor: bayat maç temizleyicisi para tutan düelloları
 * `["open", "accepted"]` diye sorguluyordu; kabul edilmiş düellonun durumu
 * aslında "active" — yani temizleyici tam da kurtarmak için yazıldığı parayı
 * HİÇ GÖRMÜYORDU. Testler de yakalamadı çünkü test verisi aynı yanlış sabitle
 * tohumlanmıştı.
 *
 * Bu test o yüzden bir düzeltmeyi değil, TEKRARI engelliyor: kodda geçen
 * düello durum metinleri tek kaynaktaki değerlerin dışına çıkamaz.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { DURUM, PARA_TUTAN, KAPANMIS, bahisYatiranSayisi } = require("../lib/duel-durum.cjs");

const GECERLI = new Set(Object.values(DURUM));

/** Yorumları boşaltıp kaynağı döndürür. */
const kaynak = (rel) =>
  fs.readFileSync(path.join(KOK, rel), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tek kaynak beş durumu tanımlıyor", () => {
    assert.equal(GECERLI.size, 5, `beklenen 5 durum, gelen: ${[...GECERLI].join(", ")}`);
    assert.ok(GECERLI.has("active"), "kabul edilmis duello durumu 'active' olmali");
    assert.ok(!GECERLI.has("accepted"), "'accepted' gecerli bir durum DEGIL — eski hatanin adi");
  });

  test("para tutan ve kapanmış kümeler örtüşmüyor", () => {
    const kesisim = PARA_TUTAN.filter((d) => KAPANMIS.includes(d));
    assert.deepEqual(kesisim, [], `bir durum hem para tutuyor hem kapanmis: ${kesisim.join(", ")}`);
    assert.equal(
      PARA_TUTAN.length + KAPANMIS.length, GECERLI.size,
      "durumlarin tamami iki kumeye bolunmemis — biri siniflandirilmamis"
    );
  });

  test("bahis sayısı durumla tutarlı", () => {
    assert.equal(bahisYatiranSayisi(DURUM.AKTIF), 2, "kabul edilende IKI taraf odedi");
    assert.equal(bahisYatiranSayisi(DURUM.ACIK), 1);
    for (const k of KAPANMIS) assert.equal(bahisYatiranSayisi(k), 0, `${k} icin bahis sayisi 0 olmali`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("koddaki durum metinleri tek kaynağın dışına çıkmıyor", () => {
  const DOSYALAR = [
    "routes/duels.cjs",
    "services/bayat-temizleyici.cjs",
    "lib/social-store.cjs",
  ];

  for (const rel of DOSYALAR) {
    test(`${rel} geçersiz durum adı kullanmıyor`, () => {
      const src = kaynak(rel);
      const kotu = new Set();

      /* `status: "x"`, `status === "x"`, `status !== "x"` kalıpları.
       * Yalnızca DÜELLO durumu bağlamındakiler; başka koleksiyonların
       * durumları (turnuva, havuz) aynı adları paylaşıyor ama ayrı yaşıyor —
       * o yüzden yalnızca tanınmayan bir değer varsa bayrak kalkıyor. */
      for (const m of src.matchAll(/status\s*(?::|===|!==|==)\s*"([a-z_]+)"/g)) {
        if (!GECERLI.has(m[1])) kotu.add(m[1]);
      }
      for (const m of src.matchAll(/status:\s*\{\s*\$in:\s*\[([^\]]+)\]/g)) {
        for (const p of m[1].split(",")) {
          const t = p.trim().replace(/^["']|["']$/g, "");
          if (/^[a-z_]+$/.test(t) && !GECERLI.has(t)) kotu.add(t);
        }
      }

      assert.deepEqual(
        [...kotu], [],
        `${rel} tek kaynakta olmayan durum adi kullaniyor: ${[...kotu].join(", ")} — ` +
          "bu ayrisma bir kez bayat temizleyicinin parayi hic gormemesine yol acti"
      );
    });
  }

  test("'accepted' hiçbir KOD satırında geçmiyor (yalnızca yorumlarda)", () => {
    /**
     * ⚠️ Modülün kendi notu: "'accepted' kelimesi kod tabanında hâlâ geçiyor
     * ama YALNIZCA YORUMLARDA — o yorumlar da yanıltıcı." Yorumları temizleyip
     * bakıyoruz; koda sızarsa eski hata geri gelmiş demektir.
     */
    const suclu = [];
    for (const rel of ["routes/duels.cjs", "services/bayat-temizleyici.cjs", "lib/social-store.cjs"]) {
      if (/"accepted"|'accepted'/.test(kaynak(rel))) suclu.push(rel);
    }
    assert.deepEqual(suclu, [], `'accepted' koda sizmis: ${suclu.join(", ")}`);
  });
});

describe("temizleyici tek kaynağı kullanıyor", () => {
  test("bayat temizleyici durumları SABİTLERDEN alıyor, elle yazmıyor", () => {
    /**
     * Kusurun yaşandığı yer burasıydı. Elle liste yazımına dönerse aynı
     * sessiz kayıp tekrarlanır.
     */
    /**
     * ⚠️ DÜRÜST SINIR: negatif kontrolde sorguyu elle listeye çevirdim
     * (`$in: ["open", "accepted"]`) ve BU test kırılmadı — `PARA_TUTAN`
     * kelimesi import satırında durduğu için eşleşme sürüyor. Ayrışmayı
     * yakalayan, yukarıdaki "geçersiz durum adı" testi. Buradaki kontrol daha
     * zayıf ama yine de değerli: sabitlerin import'u tümden kaldırılırsa
     * bayrak kalkar.
     */
    const src = kaynak("services/bayat-temizleyici.cjs");
    assert.ok(/PARA_TUTAN/.test(src), "temizleyici para tutan durumlari tek kaynaktan almiyor");
    assert.ok(/DURUM\.(AKTIF|GECERSIZ)/.test(src), "temizleyici durum sabitlerini kullanmiyor");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: istemci IP yardımcısı hız sınırında bağlı", () => {
  /**
   * ⚠️ TARAMAMIN KAÇIRDIĞI ŞEY. `istemciIp` tek yerde görünüyordu; oysa
   * `middleware/rateLimit.cjs` onu TAKMA ADLA alıyor. Yeniden adlandırma
   * kapsamı gizleyebiliyor — bu nöbetçi bağlantıyı adından bağımsız
   * doğruluyor.
   */
  const src = kaynak("middleware/rateLimit.cjs");
  assert.ok(
    /require\("\.\.\/lib\/istemci-ip\.cjs"\)/.test(src),
    "hiz siniri istemci IP yardimcisini kullanmiyor — x-forwarded-for soldan okunursa sinir atlatilir"
  );
});
