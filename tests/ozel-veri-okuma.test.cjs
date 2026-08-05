"use strict";

/**
 * ÖZEL VERİ OKUMA — kimlik doğrulaması olmadan başkasının verisi okunmamalı.
 *
 * ⚠️ BULUNAN: `GET /api/users/groups/list?userId=` kimliksizdi ve yanıtı
 * `groupSummary` üretiyor — KATILIM KODU ve TAM ÜYE LİSTESİ dahil. Yani
 * sıralama tablosunda görünen bir kimliği alıp o kişinin tüm özel gruplarının
 * kodunu öğrenmek ve `POST /api/groups/join` ile o gruplara girmek mümkündü.
 *
 * Bu, kod tabanlı özel grup fikrini tamamen geçersiz kılıyordu: bir önceki
 * turda kodları tahmin edilemez yaptım (`Math.random` → `crypto.randomInt`),
 * ama bu uç onları bedavaya dağıtıyordu. Güçlendirilen bir savunmanın yanında
 * açık duran bir kapı, savunmayı hiç yapmamakla aynı.
 *
 * ⚠️ TEKRAR EDEN BİÇİM: "yazma uçları korundu, okuma uçları unutuldu."
 * Cüzdanda böyleydi (yazmalarda verifyToken, okumalarda yok), hazır tahmin
 * listesinde böyleydi (soft-delete/restore düzeltilmiş, GET açık kalmış),
 * burada da böyleydi. Nöbetçi bu biçimi hedef alıyor.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROTA_DIZIN = path.join(__dirname, "..", "routes");

/**
 * Kullanıcıya ÖZEL veri döndüren, `?userId=` ile çağrılan okuma uçları.
 *
 * Liste bilinçli olarak dar ve gerekçeli. Herkese açık olması DOĞRU olan
 * uçlar (sıralama, toplamlar, profil, açık düellolar) burada YOK — onlar
 * başkasının verisini göstermek için var.
 */
const OZEL_OKUMALAR = [
  ["users.cjs", "/groups/list", "ozel grup kodlari + uye listesi"],
  ["presets.cjs", "/user-presets", "kullanicinin hazir tahmin listesi"],
  ["friends.cjs", "/blocks/:userId", "kimleri engelledigi"],
  ["lc-wallet.cjs", "/lc-wallet/summary", "bakiye ve kazanc/harcama toplami"],
  ["lc-wallet.cjs", "/lc-wallet/ledger", "tum islem gecmisi"],
];

/** Bir rotanın bildirim satırını ve gövdesini döner. */
function rota(dosya, yol) {
  const satirlar = fs.readFileSync(path.join(ROTA_DIZIN, dosya), "utf8").split("\n");
  const baslar = [];
  satirlar.forEach((l, i) => {
    if (/^router\.(get|post|put|patch|delete)\(/.test(l)) baslar.push(i);
  });
  const k = baslar.findIndex((i) => satirlar[i].includes(`"${yol}"`));
  if (k < 0) return null;
  const son = k + 1 < baslar.length ? baslar[k + 1] : satirlar.length;
  return { bildirim: satirlar[baslar[k]], govde: satirlar.slice(baslar[k], son).join("\n") };
}

test("özel veri okuyan uçlar kimlik doğrulaması ister", () => {
  const kusurlu = [];
  for (const [dosya, yol, ne] of OZEL_OKUMALAR) {
    const r = rota(dosya, yol);
    assert.ok(r, `${dosya} ${yol} bulunamadi — tarama kalibi bozulmus olabilir`);
    if (!r.bildirim.includes("verifyToken")) {
      kusurlu.push(`${dosya} ${yol} — kimliksiz okunuyor (${ne})`);
    }
  }
  assert.deepStrictEqual(kusurlu, [], "Kimliksiz ozel veri ucu:\n" + kusurlu.join("\n"));
});

test("özel veri okuyan uçlar sahiplik denetimi yapar", () => {
  // `verifyToken` tek başına yetmez: kimlik doğrulanmış bir kullanıcı yine
  // `?userId=<baskasi>` gonderebilir. Karari `kimlikVeyaHata` veriyor.
  const kusurlu = [];
  for (const [dosya, yol, ne] of OZEL_OKUMALAR) {
    const r = rota(dosya, yol);
    if (r && !r.govde.includes("kimlikVeyaHata")) {
      kusurlu.push(`${dosya} ${yol} — sahiplik denetimi yok (${ne})`);
    }
  }
  assert.deepStrictEqual(kusurlu, [], "Sahiplik denetimi eksik uc:\n" + kusurlu.join("\n"));
});

/**
 * NÖBETÇİ — "yazma korundu, okuma unutuldu" biçimini yakalar.
 *
 * Bir dosyada aynı yol hem POST hem GET olarak varsa ve POST kimlik istiyorsa,
 * GET de istemeli. Farklı davranmak neredeyse her zaman gözden kaçmadır:
 * yazmayı düzelten kişi okumayı fark etmemiştir.
 */
/**
 * Bilerek muaf tutulanlar — her biri GEREKÇELİ.
 *
 * Muafiyet listesi boş bırakılsaydı nöbetçi gürültü üretir ve zamanla
 * kapatılırdı. Gerekçeyi yazılı tutmak, sonradan "bu neden muaftı" sorusunu
 * cevaplanabilir kılıyor.
 */
const MUAF = [
  // Adı "admin" ama içerik canlı SKOR: normal kullanıcı ekranı (live.tsx)
  // bu ucu çağırıyor ve aynı veri uygulamada zaten herkese görünür.
  // Kilitlemek uygulamayı kırardı, koruduğu bir şey de yok.
  ["rt.live-gs.cjs", "/admin-live-gs"],

  /* Maç odası tepkileri: YAZMA kimlik ister (kimse başkasının adına tepki
   * basamasın), OKUMA bilerek herkese açık. Dönen veri zaten kamuya açık
   * olanın aynısı — görünen ad + kapalı listeden bir tepki, yani sıralamada
   * hâlihazırda görünenden fazlası yok. Asıl gerekçe ürün tarafında: odanın
   * DOLU görünmesi, kayıt olmamış kullanıcıyı içeri çeken şeyin ta kendisi;
   * misafire boş oda göstermek özelliğin amacını tersine çevirirdi.
   * (tests/mac-tepkileri.test.cjs "misafir odayı OKUYABİLİYOR" bunu koruyor.) */
  ["reactions.cjs", "/reactions"],
];

test("NÖBETÇİ: yazması korunan bir yolun okuması da korunmalı", () => {
  const kusurlu = [];
  for (const dosya of fs.readdirSync(ROTA_DIZIN)) {
    if (!dosya.endsWith(".cjs")) continue;
    const satirlar = fs.readFileSync(path.join(ROTA_DIZIN, dosya), "utf8").split("\n");

    const yollar = new Map(); // yol -> {get:bool|null, post:bool|null}
    for (const satir of satirlar) {
      const m = /^router\.(get|post)\(\s*"([^"]+)"/.exec(satir);
      if (!m) continue;
      const korunmus = satir.includes("verifyToken") || satir.includes("requireAdmin");
      const kayit = yollar.get(m[2]) || {};
      kayit[m[1]] = korunmus;
      yollar.set(m[2], kayit);
    }

    for (const [yol, k] of yollar) {
      if (k.post === true && k.get === false) {
        if (MUAF.some(([d2, y2]) => d2 === dosya && y2 === yol)) continue;
        kusurlu.push(`${dosya} ${yol} — POST korunuyor ama GET korunmuyor`);
      }
    }
  }

  assert.deepStrictEqual(
    kusurlu,
    [],
    "Ayni yolun yazmasi korunmus, okumasi acik:\n" + kusurlu.join("\n")
  );
});
