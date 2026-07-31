"use strict";

/**
 * ENGELLEME DENETİMİ — engeli atlatan bir yol kalmamalı.
 *
 * ⚠️ BULUNAN AÇIK: davet kodu (`POST /api/friends/use-invite`) doğrudan
 * arkadaşlık kuruyordu ve engelleme kontrolü YOKTU. Engellenen biri,
 * engelleyenin kodunu kullanarak arkadaş olabiliyordu — engelin tamamını
 * atlayarak. Üstelik ikisine de LC yatıyordu: engelleyen kişi istemediği bir
 * arkadaşlığı bildirimle birlikte alıyordu.
 *
 * Kodlar PAYLAŞILMAK İÇİN üretiliyor (6 karakter, arkadaşa gönderilsin diye),
 * yani engellenen kişi kodu ortak bir arkadaştan ya da paylaşılmış bir
 * gönderiden alabilir. Saldırı kuramsal değil.
 *
 * ⚠️ İKİNCİ AÇIK: `GET /api/friends/blocks/:userId` kimlik doğrulaması
 * istemiyordu — herkes herkesin engel listesini okuyabiliyordu. Taciz eden
 * biri kurbanın kimleri engellediğini ve KENDİSİNİN engellenip
 * engellenmediğini öğrenebiliyordu.
 *
 * ⚠️ NÖBETÇİ: asıl tekrar eden hata "engelleme kontrolü YENİ bir uçta
 * unutuldu" biçiminde. Arkadaşlık KURAN her uç denetimden geçmeli.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");
process.env.SKORLIG_DATA_DIR = nodePath.join(os.tmpdir(), "skorlig-engel-test");
fs.mkdirSync(process.env.SKORLIG_DATA_DIR, { recursive: true });

const test = require("node:test");
const assert = require("node:assert");

const KAYNAK = fs.readFileSync(
  nodePath.join(__dirname, "..", "routes", "friends.cjs"),
  "utf8"
);

/** Bir rota gövdesini (bir sonraki router. bildirimine kadar) döner. */
function govde(yol) {
  const satirlar = KAYNAK.split("\n");
  const baslar = [];
  satirlar.forEach((l, i) => {
    if (/^router\.(get|post|put|patch|delete)\(/.test(l)) baslar.push(i);
  });
  const k = baslar.findIndex((i) => satirlar[i].includes(`"${yol}"`));
  if (k < 0) return null;
  const son = k + 1 < baslar.length ? baslar[k + 1] : satirlar.length;
  return satirlar.slice(baslar[k], son).join("\n");
}

test("davet kodu ucu engelleme denetiminden geçer", () => {
  const g = govde("/use-invite");
  assert.ok(g, "/use-invite bulunamadi");
  assert.ok(
    g.includes("isBlockedEither"),
    "use-invite engelleme denetimi yapmiyor — engellenen kisi davet koduyla arkadas olabilir"
  );
});

test("engelleme denetimi arkadaşlık KURULMADAN önce gelir", () => {
  const g = govde("/use-invite");
  const denetim = g.indexOf("isBlockedEither");
  const kurulum = g.indexOf("SocialStore.addLink");
  assert.ok(denetim > 0 && kurulum > 0, "beklenen cagrilar bulunamadi");
  assert.ok(
    denetim < kurulum,
    "engelleme denetimi addLink'ten SONRA — arkadaslik zaten kurulmus olur"
  );
});

test("engel listesi kimlik doğrulaması ister", () => {
  const satir = KAYNAK.split("\n").find((l) => l.includes('router.get("/blocks/:userId"'));
  assert.ok(satir, "/blocks/:userId bulunamadi");
  assert.ok(
    satir.includes("verifyToken"),
    "engel listesi kimliksiz okunabiliyor"
  );
  assert.ok(
    govde("/blocks/:userId").includes("kimlikVeyaHata"),
    "engel listesinde sahiplik denetimi yok — baskasinin listesi okunabilir"
  );
});

/**
 * NÖBETÇİ — arkadaşlık kuran her uç engelleme denetiminden geçmeli.
 *
 * `addLink` arkadaşlık kuran TEK çağrı; yeni bir uç onu çağırıp denetimi
 * atlarsa engel yine baypas edilir. Bu test o durumu yakalar.
 */
test("NÖBETÇİ: addLink çağıran her uç engelleme denetimi yapar", () => {
  const satirlar = KAYNAK.split("\n");
  const baslar = [];
  satirlar.forEach((l, i) => {
    if (/^router\.(get|post|put|patch|delete)\(/.test(l)) baslar.push(i);
  });

  const kusurlu = [];
  baslar.forEach((bas, k) => {
    const m = /^router\.(get|post)\(\s*"([^"]+)"/.exec(satirlar[bas]);
    if (!m) return;
    const son = k + 1 < baslar.length ? baslar[k + 1] : satirlar.length;
    const g = satirlar.slice(bas, son).join("\n");
    if (!g.includes("SocialStore.addLink")) return;
    if (g.includes("isBlockedEither")) return;
    kusurlu.push(`${m[1].toUpperCase()} ${m[2]} (satir ${bas + 1})`);
  });

  assert.deepStrictEqual(
    kusurlu,
    [],
    "Bu uclar engelleme denetimi olmadan arkadaslik kuruyor:\n" + kusurlu.join("\n")
  );
});

test("isBlockedEither iki yönü de kapsar", () => {
  // Engel tek yönlü saklanıyor (by → target) ama etkisi ÇİFT yönlü olmalı:
  // engellenen kişi de engelleyene ulaşamamalı.
  const fn = KAYNAK.slice(KAYNAK.indexOf("function isBlockedEither"));
  const govdeFn = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(govdeFn.includes("=== A") && govdeFn.includes("=== B"), "tek yonlu kontrol");
});
