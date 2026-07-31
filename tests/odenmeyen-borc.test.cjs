"use strict";

/**
 * ÖDENEMEYEN PARA KALICI İZ BIRAKMALI.
 *
 * ⚠️ TASARIM: para dağıtan her yol "ÖNCE MÜHÜRLE, SONRA ÖDE" deseninde.
 * Bu doğru sıra — çifte ödemeyi engeller — ama ters riski vardır: ödeme
 * başarısız olursa mühür yüzünden TEKRAR DENENMEZ ve para kalıcı kaybolur.
 * Karşılığı `kayipOdulKaydet`: kayıp `failed_awards` koleksiyonuna yazılır ve
 * `GET /api/health` bunu sayar. Sıfırdan büyükse elle telafi edilecek PARA
 * var demektir.
 *
 * ⚠️ BULUNAN: on üç ödeme noktasının DÖRDÜ bu izi bırakmıyordu —
 *   • routes/duels.cjs  settle/kabul-iadesi/iptal-iadesi (amiral para modu)
 *   • routes/tr-league.cjs  haftalık ödül
 *   • lib/pool-store.cjs    havuz ödemesi ve iadeleri
 *   • routes/friends.cjs    davet ödülü
 * Yani operatörün TEK göstergesi olan sağlık sayacı, gerçekten borç varken
 * 0 gösteriyordu.
 *
 * ⚠️ AYRICA ÖLÜ KORUMA: `duels.cjs` iki yerde `if (!iade)` yazıyordu ama o
 * dosyanın YEREL `creditLc`'si başarıda `{ok:true}` NESNESİ döner — nesne her
 * zaman doğrudur, yani koşul hiçbir zaman çalışamazdı. Başarısızlıkta ise
 * dönmüyor, FIRLATIYOR. Güvenlik ağı gibi duran blok her iki durumda da
 * işlevsizdi. Aşağıdaki "ölü koruma" testi bu kalıbı yasaklıyor.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/** Yorum satırlarını BOŞALTIR (silmez): satır numaraları hizalı kalsın. */
function kodu(kaynak) {
  return kaynak
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

function dosyalar() {
  const out = [];
  for (const alt of ["routes", "lib", "services"]) {
    const d = path.join(KOK, alt);
    if (!fs.existsSync(d)) continue;
    for (const ad of fs.readdirSync(d)) {
      if (!ad.endsWith(".cjs")) continue;
      out.push({ ad: `${alt}/${ad}`, kaynak: kodu(fs.readFileSync(path.join(d, ad), "utf8")) });
    }
  }
  return out;
}

/**
 * Ödeme YAPAN dosyalar — `creditLc(` çağrısı olan her dosya.
 *
 * ⚠️ TANIMIN KENDİSİNİ ÖDEME SAYMA. `lib/wallet-credit.cjs` ve
 * `routes/duels.cjs` bu fonksiyonu TANIMLIYOR; `async function creditLc`
 * satırı çağrı değil. İlk sürüm bunu ayırmayınca wallet-credit kendi kendini
 * "iz bırakmıyor" diye işaretledi.
 */
const CAGRI = /(?<!function\s)(?:Wallet\.|WalletCredit\.)?creditLc\s*\(/;

/** Ödeme yapmayan, yalnızca tanımlayan dosya. */
const TANIMLAYAN = new Set(["lib/wallet-credit.cjs"]);

test("ödeme yapan her dosya ödenemeyen parayı kaydediyor", () => {
  const kusurlu = [];
  let bakilan = 0;

  for (const { ad, kaynak } of dosyalar()) {
    if (TANIMLAYAN.has(ad)) continue;
    // Tanım satırlarını at, geriye gerçek çağrılar kalsın.
    const cagriVar = kaynak
      .split("\n")
      .some((l) => CAGRI.test(l) && !/(async\s+)?function\s+creditLc/.test(l));
    if (!cagriVar) continue;
    bakilan++;
    /* ⚠️ ÇAĞRI ARANIYOR, ADIN GEÇMESİ DEĞİL. İlk sürüm `/kayipOdulKaydet/`
     * diyordu; `const { creditLc, kayipOdulKaydet } = require(...)` satırı bunu
     * karşılıyor, yani İÇE AKTARIP HİÇ ÇAĞIRMAYAN dosya da geçiyordu. Negatif
     * kontrolde yakalandı: tr-league'in çağrısını silmek testi kırmadı. */
    if (!/kayipOdulKaydet\s*\(/.test(kaynak)) kusurlu.push(ad);
  }

  assert.ok(bakilan >= 8, `cok az odeme noktasi bulundu (${bakilan}) — tarama bozulmus olabilir`);
  assert.deepStrictEqual(
    kusurlu,
    [],
    "Bu dosyalar LC oduyor ama odenemeyen parayi `failed_awards`e YAZMIYOR.\n" +
      "Odemeler muhurden SONRA yapiliyor, yani basarisiz odeme TEKRAR DENENMEZ:\n" +
      "para kalici olarak kaybolur ve /api/health sayaci 0 gosterir.\n" +
      kusurlu.join("\n")
  );
});

test("ÖLÜ KORUMA: nesne dönen creditLc doğruluk sınamasına sokulmuyor", () => {
  /**
   * `routes/duels.cjs`'in yerel `creditLc`'si `{ok:true}` döner. `if (!x)`
   * ya da `if (x)` biçiminde sınanırsa koşul SABİTTİR — koruma gibi görünen
   * ama hiçbir zaman çalışmayan bir blok doğar. Bu dosyada başarısızlık
   * `ode()` yardımcısıyla yakalanmalı (o hem fırlatmayı hem `{ok:false}`u
   * ele alıyor).
   */
  const src = kodu(fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8"));
  const satirlar = src.split("\n");
  const kusurlu = [];

  satirlar.forEach((satir, i) => {
    const m = /(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*await\s+creditLc\s*\(/.exec(satir);
    if (!m) return;
    const ad = m[1];
    // Sonraki 4 satırda `if (!ad)` / `if (ad)` var mı?
    const pencere = satirlar.slice(i + 1, i + 5).join("\n");
    if (new RegExp(`if\\s*\\(\\s*!?${ad}\\s*\\)`).test(pencere)) {
      kusurlu.push(`routes/duels.cjs:${i + 1} — \`${ad}\` bir NESNE, kosul sabit`);
    }
  });

  assert.deepStrictEqual(
    kusurlu,
    [],
    "Yerel `creditLc` basarida `{ok:true}` NESNESI donuyor; dogrudan dogruluk\n" +
      "sinamasi hiçbir zaman calismaz. `ode(...)` yardimcisini kullan:\n" +
      kusurlu.join("\n")
  );
});

test("ode() hem fırlatmayı hem {ok:false}'u yakalıyor", () => {
  const src = kodu(fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8"));
  const bas = src.indexOf("async function ode(");
  assert.ok(bas > 0, "ode() yardimcisi yok");
  const kalan = src.slice(bas + 10);
  const sonraki = kalan.search(/\r?\n(async function|function|router\.|module\.exports)/);
  const govde = sonraki > 0 ? src.slice(bas, bas + 10 + sonraki) : src.slice(bas);

  assert.ok(/try\s*\{/.test(govde) && /catch/.test(govde), "firlatma yakalanmiyor");
  assert.ok(/ok\s*===\s*false/.test(govde), "`{ok:false}` donusu sinanmiyor");
  assert.ok(/odenemeyen\.push/.test(govde), "basarisizlik biriktirilmiyor");
});

test("beraberlik iadesinde bir hata diğerini KESMİYOR", () => {
  /**
   * ⚠️ Eskiden iki iade tek `try` içinde arka arkaya `await` ediliyordu:
   * kurucunun iadesi fırlarsa karşı tarafınki HİÇ denenmiyordu. Tek arıza iki
   * kişinin parasını götürüyordu. Artık her ödeme `ode()` ile yalıtık.
   */
  const src = kodu(fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8"));
  assert.ok(
    !/await\s+creditLc\(db,\s*duel\.creatorId/.test(src),
    "beraberlik iadesi hala yalitiksiz `creditLc` cagiriyor"
  );
  assert.ok(
    /ode\(db,\s*duel\.creatorId/.test(src) && /ode\(db,\s*duel\.acceptorId/.test(src),
    "beraberlik iadeleri `ode()` ile yalitilmamis"
  );
});
