"use strict";

/**
 * settle2 — LC ödülü, idempotency ve eşzamanlılık.
 *
 * Buradaki testler PARA benzeri davranışı korur: bir maç iki kez
 * sonuçlandırıldığında kullanıcı ödülü İKİ KEZ almamalıdır. Bu hata daha önce
 * gerçekten yaşandı (ocak ayı ledger'ında aynı fixture için iki `match_reward`
 * kaydı bulundu) ve "kontrol et → ödüllendir → yaz" penceresi kilitlenerek
 * düzeltildi. Testler o düzeltmenin bekçisidir.
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const S = require("./helpers/sandbox.cjs");

// Dosya başına TEK kumbara ve TEK modül örneği (bkz. helpers/sandbox.cjs).
const { dir, settle2 } = S.setupFile();

/** Cüzdandaki bakiye ve verilen maç için ödül kayıtları. */
async function walletOf(dir, userId, fixtureId) {
  const w = (await S.readJson(dir, "lc-wallet.json", { users: [], ledger: [] })) || {};
  const u = (w.users || []).find(
    (x) => String(x.userId).toLowerCase() === String(userId).toLowerCase()
  );
  const rewards = (w.ledger || []).filter(
    (t) =>
      String(t.userId).toLowerCase() === String(userId).toLowerCase() &&
      (!fixtureId || t.fixtureId === fixtureId) &&
      Number(t.amount) > 0
  );
  // Kaleme göre say. Toplam sayıya bakmak KIRILGAN: seri bonusu (streak)
  // koşullu ve paralel çalışmada hangi kullanıcıya düşeceği sıralamaya bağlı.
  // İdempotency açısından korunması gereken match_reward'dır.
  const byReason = {};
  for (const t of rewards) byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  return { balance: Number(u?.balance ?? 0), rewards, byReason };
}

describe("settle2 — LC ödül eşiği", () => {
  test("computeLcRewardFromDetail kademeleri artan ve monoton", async () => {
    {
      const { computeLcRewardFromDetail: lc } = settle2;

      assert.equal(lc({ base: 0 }), 0, "hiçbir şey bilmeyen LC almaz");
      assert.equal(lc({ base: 1 }), 1);
      assert.equal(lc({ base: 3 }), 2);
      assert.equal(lc({ base: 6 }), 4);
      assert.equal(lc({ base: 12 }), 7);
      assert.equal(lc({ base: 20 }), 10);
      assert.equal(lc({ base: 30 }), 15);
      assert.equal(lc({ base: 999 }), 15, "üst kademe tavanlı");

      // Monotonluk: daha iyi tahmin asla daha az LC getirmemeli.
      let prev = -1;
      for (let b = 0; b <= 40; b++) {
        const v = lc({ base: b });
        assert.ok(v >= prev, `base=${b} kademede düşüş var (${prev} → ${v})`);
        prev = v;
      }
    }
  });

  test("eksik/bozuk detail 0 LC verir (çökmez)", async () => {
    {
      const { computeLcRewardFromDetail: lc } = settle2;
      assert.equal(lc(null), 0);
      assert.equal(lc({}), 0);
      assert.equal(lc({ base: -5 }), 0);
    }
  });
});

describe("settle2 — idempotency (çift ödül koruması)", () => {
  test("aynı maç iki kez sonuçlandırılınca LC BİR kez verilir", async () => {
    {
      await S.seedFixture(dir, "ID-1", { h: 2, a: 1 }, [
        { userId: "kazanan", outcome: "H", home: 2, away: 1 },
      ]);

      await settle2.scoreFixture("ID-1", { updateTotals: true, db: null });
      const ilk = await walletOf(dir, "kazanan", "ID-1");
      assert.ok(ilk.balance > 0, "ilk sonuçlandırmada LC yatmalı");
      // Tek settle BİRDEN FAZLA pozitif kayıt üretir (match_reward +
      // entry_refund). Değişmez olan sayının SABİT KALMASI, "tam 1" değil.
      assert.ok(ilk.rewards.length >= 1);

      // İkinci kez — ödül tekrarlanmamalı
      await settle2.scoreFixture("ID-1", { updateTotals: true, db: null });
      const ikinci = await walletOf(dir, "kazanan", "ID-1");

      assert.equal(
        ikinci.balance,
        ilk.balance,
        `bakiye değişmemeli (${ilk.balance} → ${ikinci.balance})`
      );
      assert.deepEqual(
        ikinci.byReason,
        ilk.byReason,
        "ikinci settle YENİ ödül kaydı oluşturmamalı"
      );
    }
  });

  test("üç kez üst üste sonuçlandırma da bakiyeyi değiştirmez", async () => {
    {
      await S.seedFixture(dir, "ID-2", { h: 1, a: 0 }, [
        { userId: "u", outcome: "H", home: 1, away: 0 },
      ]);

      await settle2.scoreFixture("ID-2", { updateTotals: true, db: null });
      const ref = await walletOf(dir, "u", "ID-2");

      for (let i = 0; i < 2; i++) {
        await settle2.scoreFixture("ID-2", { updateTotals: true, db: null });
      }
      const son = await walletOf(dir, "u", "ID-2");

      assert.equal(son.balance, ref.balance);
      assert.deepEqual(son.byReason, ref.byReason);
    }
  });
});

describe("settle2 — eşzamanlılık", () => {
  test("PARALEL sonuçlandırma çift ödül üretmez", async () => {
    // Asıl yarış: "ödüllendirildi mi?" kontrolü ile yazma arasındaki pencere.
    // Kilit olmasaydı beş eşzamanlı çağrı da kontrolü 'hayır' görüp ödül yazardı.
    {
      await S.seedFixture(dir, "CC-1", { h: 3, a: 2 }, [
        { userId: "yaris", outcome: "H", home: 3, away: 2 },
      ]);

      await Promise.all(
        Array.from({ length: 5 }, () =>
          settle2.scoreFixture("CC-1", { updateTotals: true, db: null })
        )
      );

      const w = await walletOf(dir, "yaris", "CC-1");
      // Kilit olmasaydı 5 kat yatardı — gerçekten ölçüldü (bakiye 50, 10 kayıt).
      assert.equal(
        w.byReason.match_reward,
        1,
        `maç ödülü tam 1 kez yazılmalı, ${w.byReason.match_reward} kez yazıldı`
      );
      assert.equal(w.byReason.entry_refund, 1, "giriş bedeli tam 1 kez iade edilmeli");
    }
  });

  test("farklı maçlar paralel sonuçlandırılabilir (kilit birbirini bloklamaz)", async () => {
    {
      for (const fid of ["CC-A", "CC-B", "CC-C"]) {
        await S.seedFixture(dir, fid, { h: 1, a: 0 }, [
          { userId: `u_${fid}`, outcome: "H", home: 1, away: 0 },
        ]);
      }

      const sonuclar = await Promise.all(
        ["CC-A", "CC-B", "CC-C"].map((fid) =>
          settle2.scoreFixture(fid, { updateTotals: true, db: null })
        )
      );

      assert.equal(sonuclar.length, 3);
      for (const fid of ["CC-A", "CC-B", "CC-C"]) {
        const w = await walletOf(dir, `u_${fid}`, fid);
        assert.equal(w.byReason.match_reward, 1, `${fid} için maç ödülü tam 1 kez`);
        assert.ok(w.balance > 0, `${fid} kullanıcısı LC almalı`);
      }
    }
  });

  test("cüzdan yazımı atomik: paralel ödüller birbirini ezmez", async () => {
    // WALLET dosyası read-modify-write edilir. Kilitsizken son yazan diğerini
    // ezer ve bazı kullanıcılar LC'sini hiç görmez ("lost update").
    {
      const fids = Array.from({ length: 6 }, (_, i) => `LU-${i}`);
      for (const fid of fids) {
        await S.seedFixture(dir, fid, { h: 2, a: 0 }, [
          { userId: `kullanici_${fid}`, outcome: "H", home: 2, away: 0 },
        ]);
      }

      await Promise.all(
        fids.map((fid) => settle2.scoreFixture(fid, { updateTotals: true, db: null }))
      );

      for (const fid of fids) {
        const w = await walletOf(dir, `kullanici_${fid}`, fid);
        assert.ok(w.balance > 0, `${fid}: bakiye kaybolmuş (lost update)`);
      }
    }
  });
});
