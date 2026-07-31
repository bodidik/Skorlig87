"use strict";

/**
 * HIZ SINIRI KAPSAMI — para harcayan her uç açık bir kurala bağlı olmalı.
 *
 * ⚠️ BULUNAN BOŞLUK: `/api/kupon/katil` ve `/api/kupon/tahmin` bu oturumda
 * eklendi ama kural listesine yazılmadı; varsayılana (dk/120) düşüyorlardı.
 * Katılım her denemede LC düşüp iade ettiği için dakikada 120 cüzdan yazması
 * + 120 defter kaydı demekti. Para kaybı yok, yük gerçek.
 *
 * ⚠️ YOLLAR ELLE YAZILMIYOR, KODDAN TÜRETİLİYOR. Bu testi yazarken önce
 * `/api/rt/pred/submit` diye bir yol uydurdum, "kural eşleşmiyor" sanıp az
 * kalsın yanlış bulgu bildiriyordum — gerçek yol `/api/pred/submit`. Elle
 * yazılan yol listesi, kuralın gerçekten eşleşip eşleşmediğini DEĞİL, yazarın
 * hatırladığını sınar. O yüzden montaj öneki server.cjs'den, rota yolu da
 * dosyanın kendisinden okunuyor.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const rateLimit = require("../middleware/rateLimit.cjs");

const KOK = path.join(__dirname, "..");
const ROTA_DIZIN = path.join(KOK, "routes");

/** Para harcadığı bilinen çağrılar. */
const HARCAMA = /\b(spendLc|deductLc|spendLC)\s*\(/;

/**
 * Dolaylı harcayanlar: parayı bir kütüphane üzerinden düşüyorlar, o yüzden
 * dosyada `spendLc` geçmiyor. Otomatik tarama bunları göremez — elle eklendi.
 */
const DOLAYLI = [
  { yol: "/api/pool/123/bet", aciklama: "Pool.placeBet -> Wallet.spendLc" },
];

/** server.cjs'deki `app.use("<onek>", require("./routes/<dosya>"))` eşlemesi. */
function montajOnekleri() {
  const src = fs.readFileSync(path.join(KOK, "server.cjs"), "utf8");
  const harita = new Map();
  const re = /app\.use\(\s*"([^"]+)"\s*,\s*require\(\s*"\.\/routes\/([^"]+)"\s*\)/g;
  let m;
  while ((m = re.exec(src))) harita.set(m[2], m[1]);
  return harita;
}

/**
 * Bir rota dosyasındaki, gövdesinde para harcayan POST yolları.
 *
 * ⚠️ GÖVDE SINIRI SABİT SATIR SAYISI DEĞİL. İlk sürüm "sonraki 45 satır" diye
 * bakıyordu; `duels.cjs`'e maç dengesi kapısı eklenince `deductLc` çağrısı
 * pencerenin dışına taştı ve tarama o ucu GÖREMEZ oldu. Sabit pencere,
 * işleyici uzadıkça sessizce körleşir. Artık gövde bir sonraki `router.`
 * bildirimine kadar sürer.
 *
 * (O körleşmeyi aşağıdaki `bakilan.length >= 4` sağlık denetimi yakaladı —
 * o olmasaydı kapsam sessizce daralır, test yine yeşil görünürdü.)
 */
function harcayanRotalar(dosyaYolu) {
  const satirlar = fs.readFileSync(dosyaYolu, "utf8").split("\n");

  const baslangiclar = [];
  satirlar.forEach((satir, i) => {
    if (/^\s*router\.(get|post|put|patch|delete|use)\(/.test(satir)) baslangiclar.push(i);
  });

  const out = [];
  baslangiclar.forEach((bas, k) => {
    const m = /router\.post\(\s*"([^"]+)"/.exec(satirlar[bas]);
    if (!m) return;
    const son = k + 1 < baslangiclar.length ? baslangiclar[k + 1] : satirlar.length;
    if (!HARCAMA.test(satirlar.slice(bas, son).join("\n"))) return;
    out.push(m[1]);
  });
  return out;
}

test("para harcayan her uç açık bir hız sınırı kuralına bağlı", () => {
  const onekler = montajOnekleri();
  const kusurlu = [];
  const bakilan = [];

  for (const dosya of fs.readdirSync(ROTA_DIZIN)) {
    if (!dosya.endsWith(".cjs")) continue;
    const tam = path.join(ROTA_DIZIN, dosya);
    const kaynak = fs.readFileSync(tam, "utf8");
    if (!HARCAMA.test(kaynak)) continue;

    const onek = onekler.get(dosya);
    if (!onek) {
      // Montaj bulunamadıysa yol kurulamaz — sessizce atlamak, kapsamı
      // olduğundan geniş göstermek olurdu.
      kusurlu.push(`${dosya}: server.cjs'de montaj oneki bulunamadi`);
      continue;
    }

    for (const rota of harcayanRotalar(tam)) {
      // ":fixtureId" gibi parametreleri örnek bir değerle doldur.
      const yol = (onek + rota).replace(/:[A-Za-z0-9_]+/g, "1").replace(/\/{2,}/g, "/");
      bakilan.push(yol);
      const kural = rateLimit._ruleFor(yol);
      if (!kural || kural === rateLimit._DEFAULT_RULE) {
        kusurlu.push(`${yol}  (${dosya}) — varsayilana dusuyor`);
      }
    }
  }

  assert.ok(bakilan.length >= 4, `cok az uc bulundu (${bakilan.length}) — tarama bozulmus olabilir`);
  assert.deepStrictEqual(
    kusurlu,
    [],
    "Para harcayan bu uclarin ozel hiz siniri kurali yok:\n" + kusurlu.join("\n")
  );
});

test("dolaylı harcayan uçlar da kurala bağlı", () => {
  const kusurlu = [];
  for (const { yol, aciklama } of DOLAYLI) {
    const kural = rateLimit._ruleFor(yol);
    if (!kural || kural === rateLimit._DEFAULT_RULE) kusurlu.push(`${yol} (${aciklama})`);
  }
  assert.deepStrictEqual(kusurlu, [], "Kuralsiz dolayli harcama ucu:\n" + kusurlu.join("\n"));
});

test("varsayılan kural sınırsız değil", () => {
  // Eski sürümde kural eşleşmeyen rota tamamen muaftı; o açık geri gelmesin.
  assert.ok(Number.isFinite(rateLimit._DEFAULT_RULE.max));
  assert.ok(rateLimit._DEFAULT_RULE.max > 0);
});
