"use strict";

/**
 * ARENA VİTRİNİ — arena boşken gösterilen "ilk sen aç" kartları.
 *
 * NEDEN VAR: Arena yalnızca açık düelloları listeliyordu; hiç düello yoksa
 * ekran tamamen boştu ve kullanıcı düello açma fikrine hiç varmıyordu.
 *
 * BU TESTİN ASIL İŞİ vitrinin SAHTE DÜELLO ÜRETMEDİĞİNİ korumak. Para söz
 * konusu; olmayan bir rakibi varmış gibi göstermek kullanıcıyı kandırmak olur.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const {
  vitrinAdaylari, vitrinleZenginlestir, HEDEF_KART, ASGARI_DK, AZAMI_SAAT,
} = require(path.join(KOK, "lib", "arena-vitrin.cjs"));

const SIMDI = Date.parse("2026-08-05T12:00:00Z");
const saatSonra = (h) => new Date(SIMDI + h * 3600 * 1000).toISOString();

function fx(id, ek = {}) {
  return {
    fixtureId: id, home: `H${id}`, away: `A${id}`,
    league: "Premier League", country: "England",
    kickoffISO: saatSonra(6), status: "NS", ...ek,
  };
}

test("vitrin karti SAHTE DUELLO uretmez: openCount 0, preview bos, bayrak acik", async () => {
  const r = await vitrinleZenginlestir([], { fixtures: [fx("1")], simdi: SIMDI });
  assert.equal(r.length, 1, "bir vitrin karti bekleniyordu");

  const k = r[0];
  assert.equal(k.vitrin, true, "vitrin bayragi acik olmali");
  assert.equal(k.openCount, 0, "vitrin kartinda acik duello SAYISI 0 olmali");
  assert.deepEqual(k.preview, [], "vitrin kartinda ONIZLEME duellosu OLMAMALI");
  assert.equal(k.minStake, 0);
  assert.equal(k.maxStake, 0);
});

test("gercek duellolar korunur ve HER ZAMAN ustte kalir", async () => {
  const gercek = {
    fixtureId: "G", home: "X", away: "Y", openCount: 3,
    minStake: 1, maxStake: 5, preview: [{ id: "d1" }], vitrin: false,
  };
  const r = await vitrinleZenginlestir([gercek], {
    fixtures: [fx("1"), fx("2")], simdi: SIMDI,
  });

  assert.equal(r[0].fixtureId, "G", "gercek mac ilk sirada olmali");
  assert.equal(r[0].openCount, 3, "gercek macin verisi bozulmamali");
  assert.ok(r.length > 1, "eksik kart vitrinle tamamlanmaliydi");
  assert.ok(r.slice(1).every(x => x.vitrin === true), "sonrakiler vitrin olmali");
});

test("gercek duellosu olan mac vitrinde TEKRARLANMAZ", async () => {
  const gercek = { fixtureId: "1", home: "X", away: "Y", openCount: 1, preview: [] };
  const r = await vitrinleZenginlestir([gercek], {
    fixtures: [fx("1"), fx("2")], simdi: SIMDI,
  });

  const kere = r.filter(x => String(x.fixtureId) === "1").length;
  assert.equal(kere, 1, "ayni mac hem gercek hem vitrin olarak gorunmemeli");
});

test("fixtureId buyuk/kucuk harf farkiyla da tekrarlanmaz", async () => {
  const gercek = { fixtureId: "AbC", home: "X", away: "Y", openCount: 1, preview: [] };
  const r = await vitrinleZenginlestir([gercek], {
    fixtures: [fx("abc"), fx("2")], simdi: SIMDI,
  });

  const idler = r.map(x => String(x.fixtureId).toLowerCase());
  assert.equal(idler.filter(x => x === "abc").length, 1,
    "harf buyuklugu farkli ayni mac iki kez girmemeli");
});

test("hedef karta ulasilmissa vitrin HIC eklenmez", async () => {
  const dolu = Array.from({ length: HEDEF_KART }, (_, i) => ({
    fixtureId: `G${i}`, openCount: 2, preview: [],
  }));
  const r = await vitrinleZenginlestir(dolu, {
    fixtures: [fx("1"), fx("2"), fx("3")], simdi: SIMDI,
  });

  assert.equal(r.length, HEDEF_KART, "hedef doluyken liste uzamamali");
  assert.ok(r.every(x => !x.vitrin), "hic vitrin karti eklenmemeliydi");
});

test("kilide COK YAKIN mac vitrine girmez", () => {
  /* Duello kilidi kickoff'tan 10 dk once kapaniyor. Kilide yakin bir maci
   * vitrine koymak, kullanici karta dokundugunda "duello kapandi" ile
   * karsilasmasi demek. */
  const yakin = fx("Y", { kickoffISO: new Date(SIMDI + (ASGARI_DK - 5) * 60000).toISOString() });
  const uzak  = fx("U", { kickoffISO: new Date(SIMDI + (ASGARI_DK + 5) * 60000).toISOString() });

  const a = vitrinAdaylari([yakin, uzak], new Set(), null, SIMDI);
  const idler = a.map(x => x.fixtureId);
  assert.ok(!idler.includes("Y"), "kilide yakin mac elenmeliydi");
  assert.ok(idler.includes("U"), "yeterince ileri mac gecmeliydi");
});

test("COK ILERI tarihli mac vitrine girmez", () => {
  const ileri = fx("I", { kickoffISO: saatSonra(AZAMI_SAAT + 24) });
  const a = vitrinAdaylari([ileri], new Set(), null, SIMDI);
  assert.equal(a.length, 0, "pencere disindaki mac 'yaklasan' sayilmaz");
});

test("baslamis / bitmis mac vitrine girmez", () => {
  const durumlar = ["1H", "HT", "2H", "FT", "LIVE", "PST", "CANC"];
  for (const d of durumlar) {
    const a = vitrinAdaylari([fx("D", { status: d })], new Set(), null, SIMDI);
    assert.equal(a.length, 0, `oynanmis/oynanan durum vitrine girmemeli: ${d}`);
  }
  // Oynanmamis sayilan durumlar gecmeli.
  for (const d of ["NS", "TBD", "SCHEDULED", ""]) {
    const a = vitrinAdaylari([fx("D", { status: d })], new Set(), null, SIMDI);
    assert.equal(a.length, 1, `oynanmamis durum vitrine girmeli: "${d}"`);
  }
});

test("gecersiz mac (ayni takim, eksik ad) vitrine girmez", () => {
  const bozuk = [
    fx("S", { home: "Qingdao", away: "Qingdao" }),
    fx("E", { home: "", away: "B" }),
    fx("T", { kickoffISO: "gecersiz-tarih" }),
  ];
  const a = vitrinAdaylari(bozuk, new Set(), null, SIMDI);
  assert.equal(a.length, 0, "isAcceptableFixture elemesi vitrinde de gecerli olmali");
});

test("kullanicinin ulkesi siralamayi belirler, ELEMEZ", () => {
  const tr = fx("TR", { league: "Süper Lig", country: "Turkiye", kickoffISO: saatSonra(20) });
  const en = fx("EN", { league: "Premier League", country: "England", kickoffISO: saatSonra(6) });

  const trIlk = vitrinAdaylari([en, tr], new Set(), "Turkiye", SIMDI).map(x => x.fixtureId);
  assert.equal(trIlk[0], "TR", "kendi ulkesinin maci ustte olmali");
  assert.equal(trIlk.length, 2, "diger ulke maci ELENMEMELI, sadece alta insin");

  const ulkesiz = vitrinAdaylari([en, tr], new Set(), null, SIMDI).map(x => x.fixtureId);
  assert.equal(ulkesiz.length, 2, "ulkesiz kullanici da tum maclari gormeli");
});

test("NEGATIF KONTROL: vitrin devre disi kalirsa liste bos doner", async () => {
  /* Bu testin kendisi bir sey olcuyor mu? Fikstur listesini bosaltinca
   * vitrin uretilmemeli — yani yukaridaki testler gercekten vitrin
   * uretiminden geciyor, sabit bir degerden degil. */
  const r = await vitrinleZenginlestir([], { fixtures: [], simdi: SIMDI });
  assert.equal(r.length, 0, "aday yokken vitrin uretilmemeli");
});

test("arena ucu vitrin yolunu GERCEKTEN cagiriyor", () => {
  /* Modul dogru calissa bile uc onu cagirmiyorsa kullanici hicbir sey gormez.
   * Bu nobetci tam o kopusu yakalar. */
  const src = fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8");
  const bas = src.indexOf('router.get("/duels/arena"');
  assert.ok(bas > 0, "arena ucu bulunamadi");
  const govde = src.slice(bas, bas + 4000);

  assert.ok(/vitrinliListe\s*\(/.test(govde),
    "arena ucu vitrin yardimcisini cagirmiyor — vitrin kullaniciya HIC ulasmaz");
  assert.ok(/require\(["'][^"']*arena-vitrin\.cjs["']\)/.test(src),
    "arena-vitrin modulu duels.cjs icinde hic yuklenmiyor");
});

test("vitrin hatasi arenayi DUSURMEZ", async () => {
  /* Vitrin bir kolaylik. Fikstur deposu patlarsa gercek duello listesi yine
   * donmeli — bu uc arenanin TEK veri kaynagi. */
  const gercek = [{ fixtureId: "G", openCount: 1, preview: [] }];
  const r = await vitrinleZenginlestir(gercek, { fixtures: null, simdi: SIMDI });
  assert.equal(r.length, 1, "fikstur yokken gercek liste korunmali");
  assert.equal(r[0].fixtureId, "G");
});

test("ekran vitrin bayragini okuyor ve 'koltuklar doldu' DEMIYOR", () => {
  /* Vitrin kartinda openCount 0; ekran bunu vitrin olarak ayirt etmezse
   * "Tum koltuklar doldu" yaziyordu — tam tersi bir mesaj. */
  const p = path.join(KOK, "..", "mobile", "app", "(tabs)", "arena.tsx");
  if (!fs.existsSync(p)) return; // mobil depo yoksa bu testi atla

  const src = fs.readFileSync(p, "utf8");
  assert.ok(/match\.vitrin\s*\?/.test(src),
    "arena ekrani vitrin bayragini hic okumuyor");
  assert.ok(/openFirstDuel/.test(src),
    "vitrin kartinda 'ilk duelloyu ac' cagrisi yok");

  const vitrinDali = src.indexOf("match.vitrin ? (");
  const seatsFull = src.indexOf("allSeatsFull");
  assert.ok(vitrinDali > 0 && vitrinDali < seatsFull,
    "vitrin dali 'allSeatsFull' dalindan ONCE gelmeli, yoksa yanlis mesaj cikar");
});

test("ceviri anahtarlari tr ve en'de var", () => {
  const p = path.join(KOK, "..", "mobile", "lib", "i18n.ts");
  if (!fs.existsSync(p)) return;

  const src = fs.readFileSync(p, "utf8");
  /* ⚠️ `beFirst` DEĞİL. O ad zaten "ilk tahminlerden biri ol" için kullanılıyor
   * ve aynı adı ikinci kez tanımlamak sessizce ÜSTÜNE YAZIYOR — tsc yakaladı
   * ama çalışma zamanında yanlış metin çıkardı. */
  for (const anahtar of ["duelBeFirst", "noDuelYetHere", "openFirstDuel"]) {
    const kere = (src.match(new RegExp(`\\b${anahtar}\\s*:`, "g")) || []).length;
    assert.ok(kere >= 2, `${anahtar} en az tr+en olmak uzere 2 kez tanimli olmali (bulundu: ${kere})`);
  }
});
