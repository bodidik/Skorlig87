"use strict";

/**
 * CANLI DAKİKA + KİLİT KURALININ İSTEMCİYE ULAŞMASI.
 *
 * ⚠️ BULMA YÖNTEMİ (uçtan uca denetim, 2026-08-03): istemci tipinin okuduğu
 * ama sunucunun hiç göndermediği ALANLAR tarandı. `Fx` tipinin 17 alanından
 * 5'i hiç gelmiyordu. Ölçüm üçünü kusur olmaktan ÇIKARDI, ikisi gerçekti:
 *
 *   score/homeGoals (open) — open'da 268 maçın 268'i NS; başlamamış maçın
 *                            skoru zaten yok. KUSUR DEĞİL.
 *   note            — 1904 fikstürün 0'ında dolu; hiçbir yazan yok.
 *                     KUSUR DEĞİL, kullanılmayan alan.
 *   lock/lockAtISO  — mobil `live.tsx` tipte tanımlıyor ama HİÇ OKUMUYOR.
 *                     Göndermek görünür bir şey değiştirmez. KUSUR DEĞİL.
 *   minute          — GERÇEK: canlı maç ana ekranda "62'" yerine düz
 *                     "CANLI" görünüyordu.
 *
 * ⚠️ DAKİKA KAYNAKTA AYRI ALAN DEĞİL. Ölçüldü: scraper önbelleğinde canlı
 * maçların `minute` alanı `undefined`; dakika `status` DİZESİNİN içinde
 * ("62'", "45+2'", "İY"). Bu yüzden `parseMinute` yazıldı ve durum dosyasına
 * yazılıyor.
 *
 * ⚠️ AYRICA BEŞİNCİ KİLİT KOPYASI BULUNDU: `app/(tabs)/predict.tsx`
 * `computePredLock` kilit anını `kickoffMs - 10 * 60 * 1000` ile KENDİ
 * hesaplıyordu. Sunucudaki dört kopya bugün `lib/ekonomi.cjs
 * TAHMIN_KILIT_DK` altında birleştirilmişti; istemcideki kalmıştı. Değer
 * bugün aynı (10) ama sabit değişirse ekran maçı açık gösterip gönderim
 * reddedilirdi — bu ürün o hatayı bir kez yaşadı (liste 5 dk diyordu,
 * sunucu 10 uyguluyordu). `/api/rt/live-gs` artık `lockBeforeMin` gönderiyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
process.env.SKORLIG_BG = "0";

const { parseMinute } = require("../services/livescore-sync.cjs");
const { TAHMIN_KILIT_DK } = require("../lib/ekonomi.cjs");

const yalin = (p) => fs.readFileSync(path.join(KOK, p), "utf8")
  /* ⚠️ SATIR SONLARI ÖNCE NORMALLEŞTIRİLİR — CRLF İKİ NÖBETÇİYİ SESSİZCE
   * KÖRELTMİŞTİ. Depoda .gitattributes yok ve core.autocrlf=true, yani Windows
   * checkout unda her satır CR+LF ile bitiyor. İçinde LF geçen bir kalıp — bir
   * fonksiyon gövdesini yeni satır + kapanış parantezi ile kesmek, ya da iki
   * satırlık bir dizgeyi indexOf ile aramak — o checkout ta HİÇBİR ZAMAN
   * eşleşmiyordu: kod doğru olduğu hâlde iddia düşüyor, ya da daha kötüsü gövde
   * çıkarımı -1 dönüp ölçüm YANLIŞ BÖLGEYE kayıyordu. */
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

/* ── Dakika ayrıştırma ───────────────────────────────────────────────────── */

describe("parseMinute", () => {
  test("normal dakika", () => {
    assert.equal(parseMinute("62'"), 62);
    assert.equal(parseMinute("7'"), 7);
    assert.equal(parseMinute("90'"), 90);
  });

  test("uzatmada ANA dakika alınıyor, toplanmıyor", () => {
    /**
     * ⚠️ 45+2 için 47 yazmak, var olmayan bir anı göstermek olurdu; futbolda
     * uzatma ayrı gösterilir. Ana dakika doğru ve güvenli olan.
     */
    assert.equal(parseMinute("45+2'"), 45);
    assert.equal(parseMinute("90+5'"), 90);
  });

  test("DAKİKA OLMAYAN durumlarda null — uydurma yok", () => {
    /* Devre arası/bitmiş/ertelenmiş maça sayı yazmak yanlış bilgi olurdu. */
    for (const s of ["İY", "MS", "Ert.", "", null, undefined, "21:00", "Devre"]) {
      assert.equal(parseMinute(s), null, `${JSON.stringify(s)} icin dakika uretildi`);
    }
  });

  test("saçma değerler eleniyor", () => {
    assert.equal(parseMinute("0'"), null, "0. dakika diye bir sey yok");
    assert.equal(parseMinute("131'"), null, "131 bir ayristirma hatasidir");
  });

  test("GERÇEK scraper verisinde çalışıyor", (t) => {
    /**
     * ⚠️ Sentetik dizeler geçip gerçek kaynak biçimi geçmezse test hiçbir şey
     * kanıtlamaz. Ölçüldü: 16 canlı maçın 10'unda dakika çözüldü, kalanlar
     * devre arası ("İY") — yani null dönmesi DOĞRU.
     */
    const dosya = path.join(KOK, "data", "livescore-cache.json");
    if (!fs.existsSync(dosya)) return t.skip("scraper onbellegi yok");
    const c = JSON.parse(fs.readFileSync(dosya, "utf8"));
    let canli = 0, cozulen = 0, sacma = 0;
    for (const lg of Object.values(c.leagues || {})) {
      for (const m of lg.matches || []) {
        if (!m.isLive) continue;
        canli++;
        const dk = parseMinute(m.status);
        if (dk != null) {
          cozulen++;
          if (dk <= 0 || dk > 130) sacma++;
        }
      }
    }
    if (!canli) return t.skip("su an canli mac yok");
    assert.equal(sacma, 0, "gecersiz dakika uretildi");
    /* ⚠️ KÜÇÜK ÖRNEKLEMDE İDDİA ATILIR. Devre arasindaki macin null cozmesi
     * DOGRU (yukaridaki not); gece tek canli mac varsa ve o da devre
     * arasindaysa cozulen=0 olur ve test bicim degisikligi OLMADIGI halde
     * kirilir — 2026-08-03 sabahi tam boyle oldu (1 canli, İY). Bicim
     * degisikligini yakalamak icin anlamli orneklem gerekir. */
    if (canli < 3) return t.skip(`yalnizca ${canli} canli mac — orneklem kucuk, bicim iddiasi atlandi`);
    assert.ok(cozulen > 0, `${canli} canli macin hicbirinde dakika cozulemedi — bicim degismis olabilir`);
  });
});

/* ── Durum dosyasına yazım ───────────────────────────────────────────────── */

describe("dakika durum dosyasına yazılıyor", () => {
  const src = yalin("services/livescore-sync.cjs");

  test("writeLiveState dakikayı ayrıştırıp yazıyor", () => {
    assert.ok(/parseMinute\(liveMatch\.status\)/.test(src),
      "dakika ayristirilmiyor — ana ekranda 'CANLI' yazar");
  });

  test("FT olunca dakika SİLİNİYOR", () => {
    /**
     * ⚠️ Bitmiş maçın yanında son dakika asılı kalırsa kullanıcı maçın hâlâ
     * oynandığını sanır. `delete` şart — alanı yazmamak eski değeri korurdu
     * çünkü durum dosyası `...prev` ile başlıyor.
     */
    const i = src.indexOf("if (scores.isFT) {\n    delete st.minute;");
    assert.ok(i > 0, "FT'de dakika silinmiyor");
  });

  test("devre arasında dakika taşınmıyor", () => {
    assert.ok(/else delete st\.minute;/.test(src),
      "dakika cozulemeyince eski deger korunuyor — devre arasinda yanlis dakika kalir");
  });
});

/* ── Yanıta ulaşıyor ─────────────────────────────────────────────────────── */

describe("dakika istemciye gidiyor", () => {
  const src = yalin("routes/live2.cjs");

  test("durum okuyucu dakikayı döndürüyor", () => {
    assert.ok(/minute: Number\.isFinite\(Number\(st\.minute\)\)/.test(src),
      "effectiveStateForFixture dakikayi dondurmuyor");
  });

  test("dakika YOKSA alan eklenmiyor", () => {
    assert.ok(/\.\.\.\(eff\.minute != null \? \{ minute: eff\.minute \} : \{\}\)/.test(src),
      "dakika kosulsuz ekleniyor — bitmis maca dakika yazilir");
  });
});

/* ── Kilit kuralı: beşinci kopya kapatıldı ───────────────────────────────── */

describe("kilit kuralı tek kaynaktan", () => {
  test("live-gs lockBeforeMin gönderiyor", () => {
    const src = yalin("routes/rt.live-gs.cjs");
    assert.ok(/lockBeforeMin: TAHMIN_KILIT_DK/.test(src),
      "kilit kurali istemciye bildirilmiyor");
    assert.ok(!/lockBeforeMin:\s*\d/.test(src), "kilit sayiyla yazilmis — yeni kopya");
  });

  test("predict ekranı sabit 10 kullanmıyor", (t) => {
    const MOB = path.join(KOK, "..", "mobile", "app", "(tabs)", "predict.tsx");
    if (!fs.existsSync(MOB)) return t.skip("mobil depo yok");
    const m = fs.readFileSync(MOB, "utf8")
      .split("\n")
      .filter((l) => {
        const s = l.trim();
        return !(s.startsWith("*") || s.startsWith("//") || s.startsWith("/*"));
      })
      .join("\n");
    assert.ok(!/kickoffMs - 10 \* 60 \* 1000/.test(m),
      "predict ekrani kilit suresini sabit yaziyor — sunucu degisirse ayrisir");
    assert.ok(/lockBeforeMin/.test(m), "sunucu degeri okunmuyor");
  });

  test("sunucu değeri makul", () => {
    assert.ok(TAHMIN_KILIT_DK > 0 && TAHMIN_KILIT_DK <= 60);
  });
});
