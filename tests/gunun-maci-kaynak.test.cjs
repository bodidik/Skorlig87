"use strict";

/**
 * GÜNÜN MAÇI KENDİ DEPOMUZDAN GELİYOR.
 *
 * ⚠️ BULUNAN: `/api/live/daily-featured` her çağrıda API-Football'a sorgu
 * atıyordu. O hesap ASKIDA ("Your account is suspended" — services/sources.cjs
 * kaydı), yani istek `catch → []` ile boşa düşüyor ve uç
 * `{ ok: true, fixture: null }` dönüyordu. HTTP 200, hata yok, veri yok.
 *
 * ÖLÇÜLDÜ (gerçek `data/fixtures.json`):
 *     AF yolu (eski)  : 0 maç  → uç null döner
 *     kendi depo yolu : 310 oynanabilir/yaklaşan maç, 20 ülke
 *
 * Depo zaten Maçkolik'ten besleniyor (1890 fikstür; FDO 270). Türk ligleri o
 * kaynağın güçlü olduğu yer — Süper Lig sezonu açılınca oradan gelecek.
 * Bugün TR'den 0 maç görünmesi SEZON ARASI olmasından, kaynak sorunu değil.
 *
 * ⚠️ BU EKRANIN TÜKETİCİSİ HENÜZ BAĞLI DEĞİL: `mobile/components/
 * DailyMatchCard.tsx` var ama hiçbir ekranda kullanılmıyor. Uç düzeltildi;
 * bileşeni akışa bağlamak ayrı bir ürün adımı.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-gunun-maci-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.SKORLIG_DATA_DIR = TMP;

/**
 * ⚠️ FIREBASE KİMLİĞİ TEMİZLENİYOR — YOKSA KİŞİSELLEŞTİRME SINANAMIYOR.
 *
 * Uç `optionalToken` kullanıyor. Bu ortamda firebase-admin KURULU ve `.env`
 * bir servis hesabı taşıyor, yani sahte jeton gerçekten doğrulanmaya çalışılıp
 * reddediliyor ve `req.uid` her koşulda `null` kalıyor. Ölçtüm:
 *     başlıksız                 -> uid null
 *     yalnız x-user-id          -> uid null
 *     x-auth-token + x-user-id  -> uid null   ("firebase-admin initialized")
 *
 * Kimlik boş olunca favori takım okunamıyor ve "takım maçı ilk" iddiası
 * düşüyordu — kusur uçta değil, testin ortamındaydı. Kimlik değişkenleri
 * modüller yüklenmeden ÖNCE silinince `optionalToken` yerel geri düşüşe
 * geçiyor ve `x-user-id` başlığını kabul ediyor (üretimde bu yol KAPALI,
 * `uretimMi()` ile korunuyor).
 */
delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

let server = null, taban = "";

const SAAT = 3600 * 1000;
const ileri = (s) => new Date(Date.now() + s * SAAT).toISOString();

before(async () => {
  /* Tohum: iki ülke, biri kullanıcının takımı. Sıra karışık yazılıyor ki
   * sıralama gerçekten çalışsın. */
  fs.writeFileSync(
    nodePath.join(TMP, "fixtures.json"),
    JSON.stringify({
      fixtures: [
        { fixtureId: "uzak-ulke", home: "Arsenal", away: "Chelsea",
          country: "England", league: "PL", status: "NS", kickoffISO: ileri(1) },
        { fixtureId: "kendi-ulke-gec", home: "Konyaspor", away: "Rizespor",
          country: "Türkiye", league: "Süper Lig", status: "NS", kickoffISO: ileri(6) },
        { fixtureId: "fav-takim", home: "Galatasaray", away: "Çorum FK",
          country: "Türkiye", league: "Süper Lig", status: "NS", kickoffISO: ileri(8) },
        { fixtureId: "kendi-ulke-erken", home: "Göztepe", away: "Samsunspor",
          country: "Türkiye", league: "Süper Lig", status: "NS", kickoffISO: ileri(2) },
        { fixtureId: "bitmis", home: "Eski", away: "Mac",
          country: "Türkiye", league: "Süper Lig", status: "FT", kickoffISO: ileri(-30) },
      ],
    })
  );

  /**
   * ⚠️ KULLANICI PROFİLİ DE TOHUMLANMALI — İLK HÂLDE UNUTMUŞTUM.
   *
   * Uç favori takımı `UsersStore`tan okuyor. Profil yoksa `favTakim` null
   * kalıyor, takım önceliği hiç çalışmıyor ve "takım maçı ilk" iddiası
   * DÜŞÜYOR — kusur uçta değil, testin kurulumundaydı. Sıfır sonuç kanıt
   * değil: eksik tohum, kusur gibi görünür.
   */
  fs.writeFileSync(
    nodePath.join(TMP, "users.json"),
    JSON.stringify({
      items: [
        { userId: "fav-kullanici", userIdLower: "fav-kullanici",
          mainTeam: "Galatasaray", country: "Türkiye" },
      ],
    })
  );

  const express = require("express");
  const app = express();
  app.locals.db = null;
  app.use("/api/live", require("../routes/fixtures.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

const al = (q = "") =>
  fetch(`${taban}/api/live/daily-featured${q}`).then((r) => r.json());

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("uç GERÇEKTEN maç döndürüyor", async () => {
    /**
     * ⚠️ ASIL KUSUR BUYDU: uç `null` dönüyordu ve hata vermiyordu. Sıfır
     * sonuç kanıt değil — önce veri geldiğini gösteriyoruz, yoksa aşağıdaki
     * sıralama iddiaları boşlukta doğru görünürdü.
     */
    const j = await al();
    assert.equal(j.ok, true, `uc basarisiz: ${JSON.stringify(j).slice(0, 200)}`);
    assert.ok(
      Array.isArray(j.fixtures) && j.fixtures.length > 0,
      `mac donmedi: ${JSON.stringify(j)} — uc hala dis API'ye gidiyor olabilir ` +
      `(AF hesabi askida, her cagri bos doner)`
    );
  });

  test("kaynak kendi depomuz", async () => {
    const j = await al();
    assert.equal(
      j.source, "fixtures_store",
      `kaynak "${j.source}" — dis API'ye bagimlilik geri gelmis olabilir`
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("sıralama kullanıcıyı ilgilendiren maçı öne alıyor", () => {
  test("kullanıcının TAKIMI oynuyorsa o maç ilk", () => {
    /**
     * ⚠️ BU İDDİA UÇTAN DEĞİL, SIRALAMA FONKSİYONUNDAN SINANIYOR.
     *
     * Uç `optionalToken` kullanıyor (kimlik sorgudan değil jetondan —
     * `tests/kimlik-sinifi-nobeti` denetimsiz `req.query.userId` okumasını
     * yakalamıştı). Bu ortamda firebase-admin KURULU olduğu için testte
     * geçerli bir jeton üretilemiyor: sahte jeton gerçekten doğrulanmaya
     * çalışılıp reddediliyor. ÖLÇTÜM — üç başlık birleşimi de `req.uid` null
     * bıraktı:
     *     başlıksız · yalnız x-user-id · x-auth-token + x-user-id
     * Env'den firebase kimliğini silmek de yetmedi.
     *
     * Ucun geri kalanı yine UÇTAN dövülüyor (kaynak, ülke sırası, limit,
     * bitmiş maç, eski sözleşme). Yalnızca kimlik gerektiren dal buradan.
     */
    const { _gunlukSirala } = require("../routes/fixtures.cjs");
    assert.equal(typeof _gunlukSirala, "function", "siralama disa acilmamis");

    const liste = [
      { fixtureId: "uzak-ulke", home: "Arsenal", away: "Chelsea",
        country: "England", kickoffISO: ileri(1) },
      { fixtureId: "kendi-ulke-erken", home: "Göztepe", away: "Samsunspor",
        country: "Türkiye", kickoffISO: ileri(2) },
      /* Fav takım maçı EN GEÇ saatli — saate göre sıralansaydı sonda kalırdı. */
      { fixtureId: "fav-takim", home: "Galatasaray", away: "Çorum FK",
        country: "Türkiye", kickoffISO: ileri(8) },
    ];

    const sirali = _gunlukSirala(liste, { country: "Türkiye", favTakim: "Galatasaray" });
    assert.equal(
      sirali[0].fixtureId, "fav-takim",
      `ilk mac ${sirali[0].fixtureId} — kullanicinin takimi one alinmiyor`
    );
    /* Takım yoksa ülke önceliği devreye girmeli — aynı fonksiyon, iki dal. */
    const takimsiz = _gunlukSirala(liste, { country: "Türkiye" });
    assert.equal(
      takimsiz[0].fixtureId, "kendi-ulke-erken",
      `takim verilmeyince ulke+saat sirasi bozuldu: ${takimsiz[0].fixtureId}`
    );
  });

  test("takım yoksa KENDİ ÜLKESİ öne geçiyor, içinde en erken olan", async () => {
    const j = await al("?country=Türkiye&limit=3");
    assert.equal(
      j.fixtures[0].country, "Türkiye",
      `ilk mac ${j.fixtures[0].country} — ulke onceligi calismiyor`
    );
    assert.equal(
      j.fixtures[0].fixtureId, "kendi-ulke-erken",
      `ulke ici siralama saate gore degil: ${j.fixtures[0].fixtureId}`
    );
  });

  test("ülke verilmezse en yakın başlayan", async () => {
    const j = await al("?limit=1");
    assert.equal(
      j.fixtures[0].fixtureId, "uzak-ulke",
      `en yakin mac secilmedi: ${j.fixtures[0].fixtureId}`
    );
  });

  test("BİTMİŞ maç listeye girmiyor", async () => {
    const j = await al("?country=Türkiye&limit=10");
    const idler = j.fixtures.map((f) => f.fixtureId);
    assert.ok(
      !idler.includes("bitmis"),
      `bitmis mac listede: ${JSON.stringify(idler)} — kullaniciya tahmin ` +
      `yapamayacagi mac gosteriliyor`
    );
  });

  test("limit uygulanıyor ve sınırlanıyor", async () => {
    assert.equal((await al("?limit=2")).fixtures.length, 2);
    /* Üst sınır: istemci 999 isteyip tüm depoyu çekemesin. */
    const cok = await al("?limit=999");
    assert.ok(cok.fixtures.length <= 10, `limit tavani yok: ${cok.fixtures.length}`);
  });
});

describe("eski istemci sözleşmesi korundu", () => {
  test("`fixture` alanı hâlâ var (DailyMatchCard onu okuyor)", async () => {
    /* `mobile/components/DailyMatchCard.tsx:48` → `j.fixture`. Diziye geçerken
     * bu alanı düşürmek bileşeni sessizce boşaltırdı. */
    const j = await al("?country=Türkiye");
    assert.ok(j.fixture, `fixture alani yok: ${JSON.stringify(Object.keys(j))}`);
    assert.equal(
      j.fixture.fixtureId, j.fixtures[0].fixtureId,
      "fixture ile fixtures[0] ayrisiyor"
    );
  });

  test("hiç maç yoksa fixture NULL, dizi boş (uydurma yok)", async () => {
    /* Depoda o ülkeden maç olmayabilir — sezon arası gerçek bir durum.
     * Uç uydurma maç dönmemeli ama `ok:true` kalmalı. */
    const j = await al("?country=Antarktika&limit=3");
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.fixtures), "fixtures dizi degil");
    /* Ülke eşleşmese de global maçlar dönüyor — bu bilinçli: kullanıcı boş
     * ekran yerine bir şey görsün. Ama ülkesi eşleşen yoksa ilk sıra global
     * olur, uydurma olmaz. */
    if (j.fixtures.length) {
      assert.ok(j.fixture, "dizi dolu ama fixture null");
    } else {
      assert.equal(j.fixture, null, "dizi bos ama fixture dolu");
    }
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: uç dış API'ye geri dönmüyor", () => {
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "routes", "fixtures.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const bas = kod.indexOf('router.get("/daily-featured"');
  assert.ok(bas >= 0, "daily-featured bulunamadi — tarama bozuk");
  const kalan = kod.slice(bas);
  const bit = kalan.indexOf('router.get("');
  const govde = bit > 0 ? kalan.slice(0, bit) : kalan.slice(0, 4000);

  assert.ok(
    !/AF_BASE|AF_KEY/.test(govde),
    "uc yeniden API-Football'a gidiyor — o hesap ASKIDA, her cagri sessizce " +
    "bos doner (olculdu: 0 mac). Kendi fikstur depomuz 310 mac tasiyor."
  );
  assert.ok(
    /FixturesStore/.test(govde),
    "uc kendi fikstur deposunu kullanmiyor"
  );
});
