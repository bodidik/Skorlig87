"use strict";

/**
 * `ok:false` HER ZAMAN 200 DIŞI BİR DURUMLA GELMELİ.
 *
 * ⚠️ NEDEN ÖNEMLİ: `mobile/lib/apiFetch.ts` başlığı dört ekranın aylarca bozuk
 * kaldığı bir olayı anlatıyor ve kök nedeni açıkça yazıyor:
 *
 *   "`catch {}` ya da `if (!j.ok) return` — hata yutuluyor, ekran boş kalıyor,
 *    hiçbir yerde iz yok."
 *
 * O turda eklenen çözüm İSTEMCİ TARAFINDA: `apiFetch` 2xx dışındaki her yanıtı
 * loglar. Ama bu koruma tamamen HTTP DURUMUNA dayanıyor. Sunucu 200 döndürüp
 * gövdede `ok:false` yazarsa loglama HİÇ çalışmaz ve istemcideki
 * `if (!j.ok) return` onu sessizce yutar — yani tam olarak düzeltilen hata
 * geri gelir.
 *
 * ⚠️ ŞU AN TEMİZ (ölçüldü): tek satırlı ve çok satırlı tarama, `ok:false`
 * dönen her yerin bir `res.status(...)` ile eşleştiğini gösterdi. Bu test o
 * durumu KORUYOR — düzeltmenin dayandığı varsayımı kilitliyor.
 *
 * ⚠️ İstemci tarafında `apiJson` yalnızca AĞ/AYRIŞTIRMA hatalarını `ok:false`
 * üretmek için kullanıyor (`NETWORK`, `EMPTY_RESPONSE`, `BAD_JSON`) — onlar
 * sunucudan gelmiyor, bu kuralın kapsamı dışında.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROTA_DIZIN = path.join(__dirname, "..", "routes");

/**
 * Yorum satırlarını BOŞALTIR (silmez) — metin taramaları açıklamalara
 * takılmasın ama satır numaraları orijinal dosyayla hizalı kalsın.
 *
 * ⚠️ İLK SÜRÜM SATIRLARI SİLİYORDU ve bildirilen satır numaraları orijinal
 * dosyada bambaşka yerlere denk geliyordu: `kupon.cjs:155` diye rapor edilen
 * yer aslında zararsız bir `res.json(cikti)` satırıydı. Yanlış konum bildiren
 * bir nöbetçi, kendisine güvenilmemesine yol açar.
 */
function kodu(kaynak) {
  return kaynak
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

test("ok:false dönen her yanıt 200 dışı bir durum taşıyor", () => {
  const kusurlu = [];
  let bakilan = 0;

  for (const dosya of fs.readdirSync(ROTA_DIZIN)) {
    if (!dosya.endsWith(".cjs")) continue;
    const kaynak = kodu(fs.readFileSync(path.join(ROTA_DIZIN, dosya), "utf8"));

    /* ⚠️ KALIP `.json(` ARIYOR, `res.json(` DEĞİL. İlk sürüm `res.json(`
     * bekliyordu; oysa çoğu yer `res.status(400).json({...})` biçiminde, yani
     * HİÇBİRİNİ bulamadı. Testteki "çok az bulundu" sağlık kontrolü bunu
     * yakaladı — o kontrol olmasaydı test boşlukta yeşil kalırdı. */
    /* ⚠️ PENCERE DAR VE SATIR SONU İÇERMİYOR.
     *
     * İlk sürüm 400 karakterlik çok satırlı bir pencere kullanıyordu ve
     * `.json(` ile BAŞKA bir ifadedeki `ok: false`u eşleştirip ÜÇ yanlış
     * pozitif üretti. `ok: false` bu kod tabanında her zaman açılış süslü
     * parantezinin hemen ardından geliyor; pencereyi oraya sabitlemek hem
     * doğru hem anlaşılır.
     */
    const re = /\.json\(\s*\{\s*ok:\s*false/g;
    let m;
    while ((m = re.exec(kaynak))) {
      bakilan++;
      /* ⚠️ DURUM DEĞİŞKEN OLABİLİR. Kod tabanında dört yer `.status(status)`,
       * `.status(kod)`, `.status(altyapi ? 503 : 400)` biçiminde yazıyor.
       * Yalnızca sayı sabiti kabul eden ilk sürüm dördünü de yanlış işaretledi.
       *
       * Statik analiz değişkenin değerini çözemez; kural buna göre dürüst
       * tutuldu: `.status(...)` çağrısı VARSA kabul, YALNIZCA açıkça `200`
       * yazılmışsa reddet. Yani kaçırdığı tek durum "değişken çalışma anında
       * 200 oluyor" — onu ancak davranış testi yakalar. */
      const genis = kaynak.slice(Math.max(0, m.index - 120), m.index);
      if (/\.status\(/.test(genis) && !/\.status\(\s*200\s*\)/.test(genis)) continue;
      const satir = kaynak.slice(0, m.index).split("\n").length;
      kusurlu.push(`${dosya}:${satir}`);
    }
  }

  assert.ok(bakilan >= 20, `cok az ok:false bulundu (${bakilan}) — tarama kalibi bozulmus olabilir`);
  assert.deepStrictEqual(
    kusurlu,
    [],
    "Bu yerler 200 + ok:false donduruyor. `apiFetch` loglamasi HTTP durumuna\n" +
      "dayaniyor, yani bu yanitlar sessizce yutulur ve ekran bos kalir —\n" +
      "dort ekranin aylarca bozuk kalmasinin kok nedeni tam olarak buydu:\n" +
      kusurlu.join("\n")
  );
});

test("istemci tarafındaki loglama HTTP durumuna dayanıyor (varsayımın kaynağı)", () => {
  /**
   * Bu testin varlık sebebi: yukarıdaki kural, istemcinin YALNIZCA durum
   * koduna baktığı gerçeğinden doğuyor. İstemci bir gün gövdedeki `ok`
   * alanına da bakmaya başlarsa kural gevşetilebilir — ama o zamana kadar
   * bağımlılık yazılı kalsın.
   */
  const istemci = require("./_mobil-dizin.cjs").mobilYol("lib", "apiFetch.ts");
  if (!fs.existsSync(istemci)) return;      // mobil depo yoksa atla

  const src = fs.readFileSync(istemci, "utf8");
  assert.ok(
    /res\.ok|res\.status\s*>=|status\s*>=\s*[45]/.test(src),
    "apiFetch artik HTTP durumuna bakmiyor — bu testin dayanagi degismis olabilir"
  );
});
