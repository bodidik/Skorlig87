"use strict";

/**
 * CAP'E ÇARPAN OTOMATİK BİRİKİMDE ARTAN SÜRE YANAR.
 *
 * ⚠️ BULUNAN: `applyRegen`, `earned` cap sınırına (`cap - bal`) takıldığında
 * sayacı yalnızca KULLANILAN tik kadar ilerletiyordu. Geri kalan tikler
 * `lastRegenAt` içinde BANKALANMIŞ olarak kalıyordu. Cüzdana dokunan yollar
 * önce `applyRegen` çağırıp SONRA harcamayı düşüyor (bkz. routes/pred.cjs
 * satır ~216, routes/lc-wallet.cjs ~452), yani oyuncu cap'e dolduğu istekte
 * parasını harcayınca bir sonraki dokunuşta bankalanmış süre NAKDE çevriliyor.
 *
 * ÖLÇÜLDÜ (cap 15, tik 1 LC / 4 saat, 48 saat uzak kalmış, bakiye 14):
 *     1) giriş                       → +1 LC, bakiye 15; sayaç HÂLÂ 44 saat geride
 *     2) aynı istekte 15 LC harcandı → bakiye 0
 *     3) 1 saniye sonra              → +11 LC
 *     toplam 12 LC — hak edilen 1 LC
 *
 * ⚠️ CAP FİİLEN ANLAMSIZLAŞIYORDU: yeterince uzun kalan biri, harcadıktan
 * hemen sonra CAP KADAR bedava dolum çekebiliyordu. Uzak kalma süresi
 * uzadıkça sömürü büyüyor.
 *
 * Kural modülün kendi başlığında zaten yazılı: "cap doluyken süre bankada
 * birikmez". Bu düzeltme aynı kuralı cap'e ÇARPARAK dolan birikime de
 * uyguluyor.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { applyRegen, REGEN_CAP, REGEN_LC, REGEN_HOURS } = require("../lib/lc-regen.cjs");

const SAAT = 3600_000;
const TIK = REGEN_HOURS * SAAT;
const kullanici = (balance, saatOnce) => ({
  balance,
  totalEarned: 0,
  lastRegenAt: new Date(Date.now() - saatOnce * SAAT).toISOString(),
});

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("birikim gerçekten çalışıyor", () => {
    // Cap açık, tik pozitif olmasa aşağıdaki testler boşlukta geçerdi.
    assert.ok(REGEN_CAP > 1, `cap ${REGEN_CAP} — birikim kapali, test bir sey olcmuyor`);
    const u = kullanici(0, REGEN_HOURS * 3);
    assert.equal(applyRegen(u), 3 * REGEN_LC, "3 tiklik sure 3 tik vermedi");
  });

  test("cap üstündeki bakiyeye dokunulmuyor", () => {
    const u = kullanici(REGEN_CAP + 5, 100);
    assert.equal(applyRegen(u), 0);
    assert.equal(u.balance, REGEN_CAP + 5);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("cap'e çarpan birikim", () => {
  test("harcadıktan sonra bankalanmış süre NAKDE çevrilemiyor", () => {
    const t0 = Date.now();
    const u = { balance: REGEN_CAP - 1, totalEarned: 0, lastRegenAt: new Date(t0 - 48 * SAAT).toISOString() };

    const ilk = applyRegen(u, t0);
    assert.equal(ilk, REGEN_LC, "cap'e 1 kalmisken tam bir tik alinmali");
    assert.equal(u.balance, REGEN_CAP);

    // pred.cjs sırası: önce applyRegen, SONRA harcama.
    u.balance = 0;

    const ikinci = applyRegen(u, t0 + 1000);
    assert.equal(
      ikinci, 0,
      `harcamadan hemen sonra ${ikinci} LC birikti — cap'e carpan artan sure bankalanmis, ` +
        "cap fiilen anlamsiz"
    );
  });

  test("uzak kalma süresi uzadıkça sömürü büyümüyor", () => {
    /* Eski davranışta bedava LC, uzak kalınan süreyle orantılı büyüyordu. */
    const olc = (saat) => {
      const t0 = Date.now();
      const u = { balance: REGEN_CAP - 1, totalEarned: 0, lastRegenAt: new Date(t0 - saat * SAAT).toISOString() };
      const a = applyRegen(u, t0);
      u.balance = 0;
      return a + applyRegen(u, t0 + 1000);
    };
    for (const saat of [24, 48, 24 * 7, 24 * 30]) {
      assert.equal(olc(saat), REGEN_LC, `${saat} saat uzak kalinca toplam ${olc(saat)} LC alindi`);
    }
  });

  test("cap'e DEĞMEYEN birikimde artan süre korunuyor", () => {
    /**
     * ⚠️ Ters yöne kaçmadığımızın kanıtı: cap'e değmeyen normal birikimde
     * tikin artan kısmı bir sonrakine sayılmalı, yoksa oyuncu her dokunuşta
     * biraz süre KAYBEDERDİ.
     */
    const t0 = Date.now();
    const artan = TIK / 2;
    const u = { balance: 0, totalEarned: 0, lastRegenAt: new Date(t0 - (2 * TIK + artan)).toISOString() };
    const a = applyRegen(u, t0);
    assert.equal(a, 2 * REGEN_LC, "iki tam tik alinmali");

    // Yarım tik daha geçsin: üçüncü tik gelmiş olmalı.
    const b = applyRegen(u, t0 + (TIK - artan) + 10);
    assert.equal(b, REGEN_LC, "artan sure kaybedilmis — oyuncu her dokunusta sure kaybeder");
  });

  test("tam cap'te sayaç şimdiye sabitleniyor (eski davranış korundu)", () => {
    const t0 = Date.now();
    const u = { balance: REGEN_CAP, totalEarned: 0, lastRegenAt: new Date(t0 - 100 * SAAT).toISOString() };
    assert.equal(applyRegen(u, t0), 0);
    assert.equal(new Date(u.lastRegenAt).getTime(), t0);
  });
});

describe("premium parametreleri", () => {
  test("yükseltilmiş cap ile de süre bankalanmıyor", () => {
    const opts = { cap: REGEN_CAP * 2, hours: REGEN_HOURS };
    const t0 = Date.now();
    const u = { balance: opts.cap - 1, totalEarned: 0, lastRegenAt: new Date(t0 - 200 * SAAT).toISOString() };
    applyRegen(u, t0, opts);
    u.balance = 0;
    assert.equal(applyRegen(u, t0 + 1000, opts), 0, "premium capte bankalanma suruyor");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: cap'e ulaşınca sayaç şimdiye sabitleniyor", () => {
  const src = fs.readFileSync(path.join(KOK, "lib", "lc-regen.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    /if \(user\.balance >= cap\)/.test(src),
    "cap'e carpan birikimde sayac sifirlanmiyor — bankalanma geri gelir"
  );
});
