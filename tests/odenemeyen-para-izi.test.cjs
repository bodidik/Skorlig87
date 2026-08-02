"use strict";

/**
 * ÖDENEMEYEN PARA HER ZAMAN KALICI İZ BIRAKIR.
 *
 * ⚠️ SORUNUN ŞEKLİ: bu kod tabanında ödemeler MÜHÜRDEN SONRA yapılır (çifte
 * ödeme olmasın diye — doğru sıra). Bedeli şu: ödeme başarısız olursa TEKRAR
 * DENENMEZ. O yüzden her ödeme yolu, ödeyemediği parayı `failed_awards`e
 * yazmak zorunda; `GET /api/health` o kaydı sayıyor ve elle telafi oradan
 * yapılıyor.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-02, services/tournament.cjs `ucretIadeEt`):
 * savunma VARDI ama ETKİSİZDİ — yanlış başarısızlık modunu bekliyordu.
 *
 *     try { await creditLc(...) } catch (e) { console.error(...) }
 *
 * `creditLc` HİÇ FIRLATMAZ; hatayı yutup `false` döner. Ampirik ölçüldü:
 *     db yok      → false, fırlatmadı
 *     mongo çöktü → false, fırlatmadı
 * Yani catch bloğu ölü koddu, iade sessizce düşüyordu. Oyuncu giriş ücretini
 * ödemiş, turnuvaya yazılamamış, iadesini de alamamıştı. Bu dal zaten Mongo
 * tökezlediği için çalışıyor — iadenin de patlaması EN OLASI senaryo.
 *
 * ⚠️ AYNI DOSYA DOĞRUSUNU YAPIYORDU (ödül ödemesinde `kayipOdulKaydet`).
 * Bugünün baskın kusur şekli: aynı savunma bir yerde var, öbüründe yok.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

describe("ödenemeyen para izi", () => {
  test("creditLc FIRLATMAZ — false döner (savunmanın dayanağı)", async () => {
    /* Bu iddia kırılırsa yukarıdaki tüm `if (!ok)` savunmaları yanlış
     * varsayıma dayanıyor demektir; onlar da gözden geçirilmeli. */
    const { creditLc } = require("../lib/wallet-credit.cjs");
    const bozuk = { collection() { throw new Error("mongo coktu"); } };
    let firlatti = false;
    let sonuc = null;
    try { sonuc = await creditLc(bozuk, "kim", 5, "deneme", {}); } catch { firlatti = true; }
    assert.equal(firlatti, false, "creditLc firlatiyor — try/catch tabanli savunmalar yeniden dogru olur");
    assert.equal(sonuc, false, "basarisiz odeme false donmeli");
  });

  test("turnuva giriş iadesi başarısızsa KALICI İZ yazılır", async () => {
    /**
     * ⚠️ ASIL KUSURU YAKALAYAN TEST. Sahte bir wallet-credit modülü
     * yerleştirip iadeyi başarısız kılıyoruz; `kayipOdulKaydet` çağrıldı mı?
     */
    const wcYol = require.resolve(path.join(KOK, "lib", "wallet-credit.cjs"));
    const asil = require.cache[wcYol];
    const trYol = require.resolve(path.join(KOK, "services", "tournament.cjs"));
    const asilTr = require.cache[trYol];

    const izler = [];
    require.cache[wcYol] = { id: wcYol, filename: wcYol, loaded: true, exports: {
      creditLc: async () => false,               // ödeme BAŞARISIZ
      spendLc: async () => ({ ok: true }),
      kayipOdulKaydet: async (_db, kayit) => { izler.push(kayit); return true; },
    }};
    delete require.cache[trYol];

    try {
      const T = require(path.join(KOK, "services", "tournament.cjs"));
      const iade = T._ucretIadeEt || T.ucretIadeEt;
      assert.ok(iade, "ucretIadeEt disa aktarilmali (test bunu cagiriyor)");
      await iade({}, "ODEMEYEN", 25, "join_save_failed");
    } finally {
      if (asil) require.cache[wcYol] = asil; else delete require.cache[wcYol];
      delete require.cache[trYol];
      if (asilTr) require.cache[trYol] = asilTr;
    }

    assert.equal(izler.length, 1, "iade basarisizken KALICI IZ YAZILMADI — para sessizce kayboluyor");
    assert.equal(izler[0].kaynak, "tournament_entry_refund");
    assert.equal(izler[0].odemeler[0].tutar, 25, "kaybolan tutar ize yazilmali");
    assert.equal(izler[0].odemeler[0].userIdLower, "odemeyen", "kimin kaybettigi ize yazilmali");
  });

  test("SINIF NÖBETİ: hiçbir ödeme çağrısı dönüşü düşürülmüş olmasın", () => {
    /**
     * ⚠️ BU TEST GELECEKTEKİ AYNI KUSURU YAKALAR. `creditLc` sessizce
     * `false` döndüğü için, dönüşü yakalamayan bir çağrı = izsiz para kaybı.
     * Kusur tam olarak böyle gizlenmişti (tek satır, gözden kaçar).
     */
    const dosyalar = [];
    for (const dizin of ["lib", "routes", "services"]) {
      for (const ad of fs.readdirSync(path.join(KOK, dizin))) {
        if (ad.endsWith(".cjs")) dosyalar.push(path.join(dizin, ad));
      }
    }

    const suphe = [];
    for (const rel of dosyalar) {
      const satirlar = fs.readFileSync(path.join(KOK, rel), "utf8").split(/\r?\n/);
      satirlar.forEach((s, i) => {
        const t = s.trim();
        if (t.startsWith("*") || t.startsWith("//")) return;      // yorum
        if (!/\bcreditLc\s*\(/.test(t)) return;
        if (/function\s+creditLc/.test(t)) return;                // tanımın kendisi
        // Dönüş yakalanıyor mu? (= await / if (await / return await / (await
        if (/(=|return|if\s*\(|\(|\?|&&|\|\|)\s*await[\s\S]*creditLc\s*\(/.test(t)) return;
        suphe.push(`${rel}:${i + 1}  ${t}`);
      });
    }

    assert.ok(dosyalar.length > 20, "tarama dosya bulamadi — test bir sey olcmuyor");
    assert.deepEqual(suphe, [], `donusu dusurulmus odeme cagrisi:\n${suphe.join("\n")}`);
  });
});
