"use strict";

/**
 * PREMIUM SÜRESİ — belge ile kod aynı şeyi söylemeli.
 *
 * ⚠️ BULUNAN ÇELİŞKİ: `lib/premium.cjs` başlığı şöyle diyordu —
 *   "premiumUntil: ISO tarih (yoksa/expired ise premium sayılmaz)"
 * ama kod şunu yapıyordu:
 *   if (!u.premiumUntil) return true;  // süresiz premium
 *
 * Yani belge "yoksa premium değil", kod "yoksa sonsuza kadar premium".
 *
 * Tehlike doğrudan değil, dolaylı: sözleşmeden akıl yürüten biri — bir
 * yönetici aracı, bir taşıma betiği, elle bir DB düzeltmesi — `premium: true`
 * yazıp süreyi boş bırakınca KALICI premium vermiş olurdu ve bunu fark
 * etmezdi. Ayrıcalıklar (daha ucuz maç girişi, daha çok açık düello, aylık
 * LC kasası) sessizce ömür boyu açılırdı.
 *
 * ⚠️ DEĞİŞİKLİK MEVCUT KULLANICILARI ETKİLEMİYOR: kodda premium veren TEK yol
 * `premium/subscribe` ve o her zaman `premiumUntil` yazıyor; 1987 üyeliği ise
 * daha önceki dalda dönüyor.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { isActivePremiumRecord } = require("../lib/premium.cjs");

const GELECEK = new Date(Date.now() + 30 * 86400000).toISOString();
const GECMIS = new Date(Date.now() - 86400000).toISOString();

test("geçerli süreli premium aktiftir", () => {
  assert.equal(isActivePremiumRecord({ premium: true, premiumUntil: GELECEK }), true);
});

test("süresi geçmiş premium aktif DEĞİLDİR", () => {
  assert.equal(isActivePremiumRecord({ premium: true, premiumUntil: GECMIS }), false);
});

test("SÜRE YOKSA premium değil (fail-closed)", () => {
  // ⚠️ Asıl düzeltme bu: eskiden `true` dönüyordu ve dosyanın kendi başlığıyla
  // çelişiyordu. Sözleşmeden akıl yürüten bir yönetici aracı, süreyi boş
  // bırakarak kalıcı premium verirdi.
  assert.equal(isActivePremiumRecord({ premium: true }), false);
  assert.equal(isActivePremiumRecord({ premium: true, premiumUntil: null }), false);
  assert.equal(isActivePremiumRecord({ premium: true, premiumUntil: "" }), false);
});

test("bozuk tarih premium vermez", () => {
  assert.equal(isActivePremiumRecord({ premium: true, premiumUntil: "yarin" }), false);
});

test("premium bayrağı yoksa aktif değil", () => {
  assert.equal(isActivePremiumRecord({ premiumUntil: GELECEK }), false);
  assert.equal(isActivePremiumRecord(null), false);
  assert.equal(isActivePremiumRecord({}), false);
});

test("1987 üyeliği DEĞİŞMEDİ — süre aranmaz", () => {
  // Geriye uyum dalı `premiumUntil` kontrolünden ÖNCE dönüyor; düzeltme onu
  // etkilememeli, yoksa mevcut 1987 üyeleri ayrıcalıklarını kaybederdi.
  assert.equal(isActivePremiumRecord({ is1987: true }), true);
  assert.equal(isActivePremiumRecord({ segment: "1987" }), true);
  assert.equal(isActivePremiumRecord({ segment: "1987", premiumUntil: GECMIS }), true);
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: premium veren her yol süre de yazıyor", () => {
  /**
   * Fail-closed davranış, "süre her zaman yazılıyor" varsayımına dayanıyor.
   * Yeni bir yol `premium: true` yazıp süreyi atlarsa, o kullanıcı hiç
   * premium olamaz — sessiz ve ters yönde bir hata. Bu test o varsayımı
   * yazılı tutuyor.
   */
  const kok = path.join(__dirname, "..");
  const kusurlu = [];
  let bakilan = 0;

  for (const alt of ["routes", "lib", "services"]) {
    const d = path.join(kok, alt);
    if (!fs.existsSync(d)) continue;
    for (const dosya of fs.readdirSync(d)) {
      if (!dosya.endsWith(".cjs")) continue;
      const satirlar = fs.readFileSync(path.join(d, dosya), "utf8").split("\n");
      satirlar.forEach((satir, i) => {
        const t = satir.trim();
        if (t.startsWith("*") || t.startsWith("//")) return;   // yorum
        if (!/premium:\s*true/.test(satir)) return;
        bakilan++;
        if (/premiumUntil/.test(satir)) return;                // aynı yazımda süre var
        kusurlu.push(`${alt}/${dosya}:${i + 1}`);
      });
    }
  }

  assert.ok(bakilan >= 1, `premium veren yol bulunamadi (${bakilan}) — tarama bozulmus olabilir`);
  assert.deepStrictEqual(
    kusurlu,
    [],
    "Bu yerler premium veriyor ama sure yazmiyor; fail-closed kural geregi\n" +
      "o kullanicilar HIC premium olmaz:\n" + kusurlu.join("\n")
  );
});

test("NÖBETÇİ: dosya başlığı ile kod aynı şeyi söylüyor", () => {
  // Çelişkinin kendisi hataydı; geri gelmesin.
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "premium.cjs"), "utf8");
  assert.ok(
    /premiumUntil.*yoksa.*premium sayılmaz/i.test(src),
    "baslikta sozlesme aciklamasi yok"
  );
  assert.ok(
    /if \(!u\.premiumUntil\) return false;/.test(src),
    "kod hala sure yoksa premium veriyor — baslikla celisiyor"
  );
});
