"use strict";

/**
 * Fikstür kabulü ve önceliklendirme.
 *
 * NEDEN VAR: Sistem maçları ÜLKEYE GÖRE ELİYORDU ve katmanlar üst üste
 * biniyordu — kaynak süzgeci, ALLOWED tablosu, kullanıcı ülkesi süzgeci,
 * ülke başına tavan. Her biri tek başına makul; birlikte ekranı boşaltıyordu.
 *
 * Ölçülen (2026-07-28): Süper Lig sezon arasındayken Türk kullanıcının ilk
 * maçı 14 GÜN sonraydı. Aynı gün kaynaklarda UCL ön elemeleri, Konferans Ligi
 * elemeleri ve Brezilya Série A oynanıyordu; hepsi eleniyordu.
 *
 * Yeni kural: ülke ELEMEZ, SIRALAR. Bu testler iki yönlü koruma sağlıyor —
 * eleme geri gelirse (ekran boşalır) ya da sıralama bozulursa (kullanıcı kendi
 * ülkesinin maçını bulamaz) yakalanır.
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  isAcceptableFixture, priorityOf, sortByPriority, sameCountry,
  P_COUNTRY, P_GLOBAL, P_BIG, P_OTHER, P_FRIENDLY,
} = require("../lib/fixture-priority.cjs");

const mac = (country, league, kickoffISO = "2026-08-01T18:00:00Z") => ({
  fixtureId: `${country}-${league}`, country, league,
  home: "A", away: "B", kickoffISO,
});

describe("kabul — ülke ELEMEZ", () => {
  test("tanınmayan ülkenin maçı da havuza girer", () => {
    // Asıl regresyon: bunlar eskiden sessizce düşüyordu.
    for (const u of ["Uzbekistan", "Iceland", "Faroe Islands", "El Salvador", "Chile"]) {
      assert.equal(isAcceptableFixture(mac(u, "Premier Liga")), true, `${u} kabul edilmeli`);
    }
  });

  test("ülkesi boş olan maç bile kabul edilir", () => {
    assert.equal(isAcceptableFixture({ home: "A", away: "B", league: "Kupa" }), true);
  });

  test("kadın/gençlik ligleri elenir (ürün kararı)", () => {
    assert.equal(isAcceptableFixture(mac("Brazil", "Brasileiro A1 Kadınlar")), false);
    assert.equal(isAcceptableFixture(mac("Europe", "UEFA U19 Championship")), false);
    assert.equal(isAcceptableFixture(mac("USA", "MLS Next Pro")), false);
    assert.equal(isAcceptableFixture(mac("England", "Women's Super League")), false);
  });

  test("takımı eksik maç kabul edilmez", () => {
    assert.equal(isAcceptableFixture({ country: "Brazil", league: "Serie A", home: "A" }), false);
    assert.equal(isAcceptableFixture(null), false);
  });
});

describe("öncelik sınıfları", () => {
  test("kullanıcının ülkesi en üstte", () => {
    assert.equal(priorityOf(mac("Türkiye", "Süper Lig"), "Türkiye"), P_COUNTRY);
  });

  test("Türkiye/Turkey aynı ülke sayılır", () => {
    // Sağlayıcılar iki yazımı da gönderiyor; ayrı sayılırsa kullanıcı kendi
    // ülkesinin maçını üstte göremez.
    assert.equal(priorityOf(mac("Turkey", "Süper Lig"), "Türkiye"), P_COUNTRY);
    assert.equal(priorityOf(mac("Türkiye", "Süper Lig"), "Turkey"), P_COUNTRY);
    assert.equal(sameCountry("Türkiye", "turkey"), true);
  });

  test("küresel turnuvalar ülkeden sonra", () => {
    assert.equal(priorityOf(mac("World", "UEFA Champions League"), "Türkiye"), P_GLOBAL);
    assert.equal(priorityOf(mac("World", "Copa Libertadores"), "Türkiye"), P_GLOBAL);
  });

  test("büyük ligler küreselden sonra", () => {
    assert.equal(priorityOf(mac("England", "Premier League"), "Türkiye"), P_BIG);
    assert.equal(priorityOf(mac("Brazil", "Campeonato Brasileiro Série A"), "Türkiye"), P_BIG);
  });

  test("geri kalan her şey sonda — ama LİSTEDE", () => {
    assert.equal(priorityOf(mac("Uzbekistan", "Super League"), "Türkiye"), P_OTHER);
    assert.equal(priorityOf(mac("Iceland", "1. Deild"), "Türkiye"), P_OTHER);
  });

  test("kullanıcı ülkesi yoksa ülke sınıfı devre dışı", () => {
    assert.equal(priorityOf(mac("Türkiye", "Süper Lig"), ""), P_BIG); // Süper Lig büyük lig
    assert.equal(priorityOf(mac("Uzbekistan", "X"), ""), P_OTHER);
  });

  test("YABANCI hazırlık maçları en sonda", () => {
    // Ölçüldü: hazırlık desenleri GLOBAL_LEAGUES içindeyken ilk 12 maçın 7'si
    // hazırlıktı ve Şampiyonlar Ligi'ni bastırıyordu. O desenler oraya yalnızca
    // ülke süzgecini atlatmak için konmuştu; süzgeç kalkınca yan etki çıktı.
    //
    // DAVRANIŞ İNCELİĞİ: bu indirgeme YABANCI hazırlık maçları içindir.
    // Kullanıcının KENDİ ülkesinin takımı oynuyorsa maç üste çıkar — sezon
    // arasında Türk kullanıcının gördüğü tek içerik o (bkz. team-country testi).
    assert.equal(priorityOf(mac("World", "Club Friendlies"), "Türkiye"), P_FRIENDLY);
    assert.equal(priorityOf(mac("England", "Pre-Season Friendly"), ""), P_FRIENDLY);
  });

  test("kendi ÜLKENDEKİ hazırlık maçı üste çıkar", () => {
    // Ülke etiketi zaten Türkiye ise takım aramaya gerek yok.
    assert.equal(priorityOf(mac("Türkiye", "Hazırlık Maçları"), "Türkiye"), P_COUNTRY);
  });

  test("hazırlık maçı gerçek turnuvanın ÜSTÜNE çıkamaz", () => {
    const liste = [
      mac("World", "Hazırlık Maçları Kulüpler", "2026-08-01T10:00:00Z"),
      mac("Europe", "Şampiyonlar Ligi", "2026-08-01T22:00:00Z"),
    ];
    const s = sortByPriority(liste, "Türkiye");
    assert.equal(s[0].league, "Şampiyonlar Ligi", "saat daha geç olsa bile üstte");
  });
});

describe("grup etiketleri", () => {
  const { priorityGroupOf } = require("../lib/fixture-priority.cjs");

  test("her sınıf için makine-okunur etiket", () => {
    // Arayüz grup başlıklarını buna göre basıyor; etiketler SUNUCUDAN gelir
    // çünkü istemcide yeniden hesaplamak iki ayrı tanım demek olurdu.
    assert.equal(priorityGroupOf(mac("Türkiye", "Süper Lig"), "Türkiye"), "country");
    assert.equal(priorityGroupOf(mac("World", "UEFA Champions League"), "Türkiye"), "global");
    assert.equal(priorityGroupOf(mac("England", "Premier League"), "Türkiye"), "big");
    assert.equal(priorityGroupOf(mac("Uzbekistan", "Super League"), "Türkiye"), "other");
    assert.equal(priorityGroupOf(mac("World", "Hazırlık Maçları"), "Türkiye"), "friendly");
  });

  test("bilinmeyen girdi 'other'a düşer, patlamaz", () => {
    assert.equal(priorityGroupOf({}, "Türkiye"), "other");
    assert.equal(priorityGroupOf(null, ""), "other");
  });

  test("etiket sırası sıralamayla TUTARLI", () => {
    // Başlıklar sıra değiştiğinde basılıyor; etiket sırası bozulursa aynı grup
    // listede iki kez başlık alır.
    const liste = [
      mac("World", "Hazırlık Maçları", "2026-08-01T09:00:00Z"),
      mac("Uzbekistan", "X", "2026-08-01T10:00:00Z"),
      mac("England", "Premier League", "2026-08-01T11:00:00Z"),
      mac("World", "UEFA Champions League", "2026-08-01T12:00:00Z"),
      mac("Türkiye", "Süper Lig", "2026-08-01T13:00:00Z"),
    ];
    const gruplar = sortByPriority(liste, "Türkiye").map((x) => priorityGroupOf(x, "Türkiye"));
    assert.deepEqual(gruplar, ["country", "global", "big", "other", "friendly"]);
    // Aynı etiket bitişik olmayan yerlerde tekrarlanmamalı
    assert.equal(new Set(gruplar).size, gruplar.length);
  });
});

describe("sıralama", () => {
  const liste = [
    mac("Uzbekistan", "Super League", "2026-08-01T12:00:00Z"),
    mac("Brazil", "Campeonato Brasileiro Série A", "2026-08-01T22:00:00Z"),
    mac("World", "UEFA Champions League", "2026-08-01T20:00:00Z"),
    mac("Türkiye", "Süper Lig", "2026-08-01T21:00:00Z"),
    mac("Iceland", "1. Deild", "2026-08-01T10:00:00Z"),
  ];

  test("ülke → küresel → büyük → diğer", () => {
    const s = sortByPriority(liste, "Türkiye");
    // Son iki sıra AYNI grupta (diğer); aralarında saat belirliyor —
    // Iceland 10:00, Uzbekistan 12:00.
    assert.deepEqual(s.map((x) => x.country),
      ["Türkiye", "World", "Brazil", "Iceland", "Uzbekistan"]);
  });

  test("HİÇBİR maç elenmez — sıra değişir, liste kısalmaz", () => {
    // En kritik güvence: sıralama bir süzgeç DEĞİL.
    assert.equal(sortByPriority(liste, "Türkiye").length, liste.length);
    assert.equal(sortByPriority(liste, "").length, liste.length);
    assert.equal(sortByPriority(liste, "Japan").length, liste.length);
  });

  test("aynı grup içinde saate göre sıralanır", () => {
    const ayniGrup = [
      mac("Iceland", "A", "2026-08-01T22:00:00Z"),
      mac("Uzbekistan", "B", "2026-08-01T10:00:00Z"),
      mac("Faroe Islands", "C", "2026-08-01T16:00:00Z"),
    ];
    const s = sortByPriority(ayniGrup, "Türkiye");
    assert.deepEqual(s.map((x) => x.kickoffISO.slice(11, 16)), ["10:00", "16:00", "22:00"]);
  });

  test("tarihi bozuk maç sona düşer, atılmaz", () => {
    const bozuk = [{ ...mac("Brazil", "Serie A"), kickoffISO: "bozuk" }, mac("Brazil", "Serie A")];
    const s = sortByPriority(bozuk, "");
    assert.equal(s.length, 2);
    assert.equal(s[1].kickoffISO, "bozuk");
  });

  test("girdi listesi DEĞİŞTİRİLMEZ", () => {
    const kopya = [...liste];
    sortByPriority(liste, "Türkiye");
    assert.deepEqual(liste, kopya, "sortByPriority yan etkisiz olmalı");
  });

  test("boş/bozuk girdi patlamaz", () => {
    assert.deepEqual(sortByPriority([], "TR"), []);
    assert.deepEqual(sortByPriority(null, "TR"), []);
  });
});
