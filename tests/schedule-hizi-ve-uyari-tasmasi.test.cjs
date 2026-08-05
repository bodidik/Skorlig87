"use strict";

/**
 * MAÇ LİSTESİ UCU: HIZ + UYARI TAŞMASI.
 *
 * ⚠️ NEREDEN ÇIKTI: oyunun genel denetiminde ana ekran fiilen erişilemezdi.
 * ÖLÇÜLDÜ (kullanıcının sunucusu, 2026-08-02):
 *     /api/live2/schedule → 40-42 sn (6 denemenin 6'sı 40sn'de düştü)
 *     /api/live2/open     → 30 sn+
 * Mobilin `apiFetch` zaman aşımı 15 sn — yani telefon bu listeyi HİÇ
 * alamıyordu; kullanıcı boş ekran görüyordu.
 *
 * PARÇALARA AYRILDI (izole sunucu, arka plan servisleri kapalı):
 *     FixturesStore.loadAll ............ 1706 ms   (1875 fikstür)
 *     sortByPriority ................... 1078 ms
 *     uyarı döngüsü (~102 × dosya kilidi) ~200 ms+
 *     O(n×m) anahtar karşılaştırması ... 1300×1250 ≈ 1.6M dize birleştirme
 *     ölü sağlayıcı beklemesi .......... 6 × 12 sn (TTL dolduğunda)
 *     izole toplam ..................... ~7.7 sn → çekişmeyle 40 sn+
 *
 * ÜÇ DÜZELTME, SONUÇ ÖLÇÜLDÜ: schedule 7.7 → 1.25 sn, open 8.5 → 1.2 sn.
 * Yanıt İÇERİĞİ birebir aynı kaldı (582 maç, aynı öncelik grupları,
 * sıfır fark) — hızlanma davranış değiştirerek alınmadı.
 *
 * ⚠️ EN CİDDİSİ HIZ DEĞİLDİ: uyarı taşması. Bkz. aşağıdaki blok.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

const yalin = (p) => fs.readFileSync(path.join(KOK, p), "utf8")
  /* ⚠️ SATIR SONLARI ÖNCE NORMALLEŞTIRİLİR — CRLF İKİ NÖBETÇİYİ SESSİZCE
   * KÖRELTMİŞTİ. Depoda .gitattributes yok ve core.autocrlf=true, yani Windows
   * checkout unda her satır CR+LF ile bitiyor. İçinde LF geçen bir kalıp — bir
   * fonksiyon gövdesini yeni satır + kapanış parantezi ile kesmek, ya da iki
   * satırlık bir dizgeyi indexOf ile aramak — o checkout ta HİÇBİR ZAMAN
   * eşleşmiyordu: kod doğru olduğu hâlde iddia düşüyor, ya da daha kötüsü gövde
   * çıkarımı -1 dönüp ölçüm YANLIŞ BÖLGEYE kayıyordu. */
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

/* ── 1) Fikstür deposu önbelleği ─────────────────────────────────────────── */

describe("fixtures-store önbelleği", () => {
  const Store = require("../lib/fixtures-store.cjs");

  test("kurulum: önbellek açık", () => {
    assert.equal(typeof Store.invalidateCache, "function",
      "invalidateCache disa acilmamis — saveAll onbellegi dusuremez");
  });

  test("ikinci okuma Mongo'ya GİTMİYOR", async () => {
    /* Sahte db: her `find` çağrısını sayar. */
    let cagri = 0;
    const db = { collection: () => ({
      find: () => { cagri++; return { toArray: async () => [
        { fixtureId: "A", home: "X", away: "Y" },
        { fixtureId: "B", home: "Z", away: "W" },
      ] }; },
      createIndex: async () => {},
      createIndexes: async () => {},
    }) };

    Store.invalidateCache();
    await Store.loadAll(db);
    const sonra = cagri;
    await Store.loadAll(db);
    await Store.loadAll(db);
    assert.equal(cagri, sonra, `onbellek calismiyor — ${cagri - sonra} fazla Mongo taramasi`);
  });

  test("DÖNEN DİZİ KOPYA — çağıran yerinde sıralasa önbellek bozulmuyor", async () => {
    /**
     * ⚠️ Çağıranların bir kısmı listeyi yerinde değiştiriyor. Aynı diziyi
     * paylaştırsaydım önbellek sessizce bozulurdu — hata vermeden yanlış
     * sıra/eksik kayıt. Sessiz bozulma, bu depodaki en pahalı kusur sınıfı.
     */
    const db = { collection: () => ({
      find: () => ({ toArray: async () => [{ fixtureId: "A" }, { fixtureId: "B" }] }),
      createIndex: async () => {}, createIndexes: async () => {},
    }) };
    Store.invalidateCache();
    const bir = await Store.loadAll(db);
    bir.length = 0;                       // çağıran diziyi boşalttı
    const iki = await Store.loadAll(db);
    assert.equal(iki.length, 2, "onbellekteki dizi cagiran tarafindan bozuldu");
  });

  test("eşzamanlı soğuk okuma TEK tarama yapıyor", async () => {
    /* TTL dolduğu anda biriken istekler yükü katlamamalı. */
    let cagri = 0;
    const db = { collection: () => ({
      find: () => { cagri++; return { toArray: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return [{ fixtureId: "A" }];
      } }; },
      createIndex: async () => {}, createIndexes: async () => {},
    }) };
    Store.invalidateCache();
    await Promise.all([Store.loadAll(db), Store.loadAll(db), Store.loadAll(db), Store.loadAll(db)]);
    assert.equal(cagri, 1, `4 escamanli istek ${cagri} tarama baslatti — ucusan istek paylasilmiyor`);
  });

  test("OKU-DEĞİŞTİR-YAZ yolu önbelleği ATLIYOR", async () => {
    /**
     * ⚠️ BU, ÖNBELLEĞİN AÇTIĞI GERÇEK BİR VERİ KAYBI PENCERESİYDİ — ve onu
     * ben açtım, tam takım koşusu yakaladı (`manual-fixtures` testinde çift
     * kayıt olarak göründü).
     *
     * `saveAll` TAM DEĞİŞTİRME yapıyor: listede olmayan belgeler SİLİNİYOR.
     * `services/fixture-sync.cjs readFixtures()` DÖRT oku-değiştir-yaz
     * noktasını besliyor (syncOnce, mackolik ×2, manual-fixtures-restore).
     * Bayat bir liste okunup üzerine yazılsaydı, arada eklenen maçlar
     * sessizce silinirdi.
     *
     * Süreç içi yazmalar önbelleği düşürdüğü için risk BAŞKA süreçten gelir
     * (migration betiği, ikinci instance) — ama önbellek penceresi kadar
     * gerçektir. Salt-okuyan sıcak yollar önbelleği kullanmaya devam ediyor.
     */
    let cagri = 0;
    const db = { collection: () => ({
      find: () => { cagri++; return { toArray: async () => [{ fixtureId: "A" }] }; },
      createIndex: async () => {}, createIndexes: async () => {},
    }) };
    Store.invalidateCache();
    await Store.loadAll(db);                    // önbelleği doldur
    const sonra = cagri;
    await Store.loadAll(db, { taze: true });    // RMW okuması
    assert.equal(cagri, sonra + 1, "taze:true onbellegi atlamiyor — RMW bayat liste uzerine yazar");
  });

  test("NÖBETÇİ: fixture-sync readFixtures TAZE okuyor", () => {
    const src = yalin("services/fixture-sync.cjs");
    assert.ok(/loadAll\(undefined, \{ taze: true \}\)/.test(src),
      "RMW okumasi onbellekten geliyor — tam degistirme silme yapabilir");
  });

  test("NÖBETÇİ: saveAll önbelleği İKİ kez düşürüyor", () => {
    /**
     * ⚠️ İKİSİ DE GEREKLİ, ve ilk yazımımda yalnızca baştakini koymuştum.
     * Yalnızca baştaki: yazma SÜRERKEN gelen `loadAll` Mongo'dan henüz ESKİ
     * listeyi okuyup önbelleğe koyar, yazma bitince önbellek bayat kalır.
     * Yalnızca sondaki: yazma boyunca eski önbellek servis edilir.
     */
    const src = yalin("lib/fixtures-store.cjs");
    const govde = src.slice(src.indexOf("async function saveAll"));
    const adet = (govde.match(/invalidateCache\(\)/g) || []).length;
    assert.ok(adet >= 2, `saveAll icinde ${adet} kez dusuruluyor — yarisa acik`);
  });
});

/* ── 2) Uyarı taşması — asıl ciddi bulgu ─────────────────────────────────── */

describe("sağlayıcı-eksik uyarısı taşmıyor", () => {
  /**
   * ⚠️ ÖLÇÜLEN DURUM: `data/admin-alerts.json` 500 kaydın 499'u
   * `provider_missing_schedule` ve TAMAMI **3 DAKİKALIK** pencereye
   * sığıyordu. Tavan 500, TTL 14 gün — ama dosya dakikalar içinde tümüyle
   * devriliyordu, yani `mongo_down` dahil GERÇEK her uyarı görülmeden
   * siliniyordu. Bu bir performans sorunu değil, TEŞHİS KÖRLÜĞÜ.
   *
   * ⚠️ KÖK NEDEN — İDDİA YANLIŞTI: sağlayıcı yalnızca dün/bugün/yarın
   * çekiliyor, manuel pencere -1..+60 gün. O üç günün dışındaki manuel
   * maçın provider'da olmaması ANOMALİ DEĞİL, TASARIM. İstek başına ~102
   * maç bu duruma girip uyarı yazıyordu.
   */
  const src = yalin("routes/live2.cjs");

  test("uyarı yalnızca sağlayıcının kapsadığı günler için üretiliyor", () => {
    const govde = src.slice(src.indexOf("function saglayiciEksikleriniBildir"));
    assert.ok(/kapsananGunler\.has\(ymdInTZ\(koMs, TZ\)\)/.test(govde),
      "kapsam gunu suzgeci yok — pencere disi maclar yine uyari yazar");
  });

  test("TEK özet uyarı yazılıyor, maç başına değil", () => {
    const govde = src.slice(src.indexOf("function saglayiciEksikleriniBildir"));
    const cagri = (govde.slice(0, govde.indexOf("\n}")).match(/appendAdminAlert\(/g) || []).length;
    assert.equal(cagri, 1, `${cagri} appendAdminAlert cagrisi — dongu icinde yazim geri gelmis`);
    assert.ok(/eksikler\.length/.test(govde), "ozet sayisi bildirilmiyor");
  });

  test("yanıt yolunda BEKLETİLMİYOR", () => {
    const govde = src.slice(src.indexOf("function saglayiciEksikleriniBildir"));
    const bas = govde.slice(0, govde.indexOf("\n}"));
    assert.ok(!/await appendAdminAlert/.test(bas),
      "uyari yaziminin beklenmesi yanit suresine ekleniyor (268KB dosyada kilit)");
    assert.ok(/\.catch\(/.test(bas), "beklenmeyen sozun hatasi yutuluyor");
  });

  test("O(n×m) tarama Set'e çevrildi", () => {
    const govde = src.slice(src.indexOf("function saglayiciEksikleriniBildir"));
    assert.ok(/new Set\(saglayici\.map\(sameFixtureKey\)\)/.test(govde),
      "anahtar kumesi kurulmuyor — her manuel mac icin tum liste taranir");
  });

  test("NÖBETÇİ: /schedule ve /open AYNI gövdeyi kullanıyor", () => {
    /**
     * ⚠️ İKİ KOPYA VARDI ve ben önce yalnızca /schedule'ı düzeltmiştim;
     * /open aynı hatayla 8.5 sn'de kalmıştı. Bu depodaki en sık kusur
     * şekli: aynı savunma/kusur iki yerde, biri unutuluyor.
     */
    /* ⚠️ TANIM DA SAYILMASIN: fonksiyon yıkıcı parametre aldığı için
     * `function saglayiciEksikleriniBildir({` kalıbı çağrılara benziyor.
     * İlk yazımımda bunu kaçırıp 3 saydım ve testi kod doğruyken kırdım. */
    const cagri = (src.match(/(?<!function )saglayiciEksikleriniBildir\(\{/g) || []).length;
    assert.equal(cagri, 2, `ortak govde ${cagri} yerden cagriliyor — beklenen 2 (/schedule, /open)`);
    assert.ok(!/for \(const mf of manualFiltered\)/.test(src),
      "eski mac-basina uyari donguse geri gelmis");
  });
});

/* ── 3) Bayat servis et, arkada tazele ───────────────────────────────────── */

describe("ölü sağlayıcı kullanıcıyı bekletmiyor", () => {
  const src = yalin("routes/live2.cjs");

  test("TTL dolunca bayat kopya dönüyor, tazeleme arkada", () => {
    /**
     * ⚠️ Eskiden TTL dolduğu anda gelen İSTEK, ölü sağlayıcıların zaman
     * aşımını kullanıcı beklerken ödüyordu: 12 sn × 2 sağlayıcı × 3 gün.
     * Bugünün TTL'i 30 dk olduğu için yarım saatte bir bir kullanıcı bu
     * faturayı yiyordu.
     */
    assert.ok(/readFxCacheBayat/.test(src), "bayat okuma yolu yok");
    assert.ok(/_fxTazelemeBaslat\(isoDate\)/.test(src), "arka plan tazeleme yok");
  });

  test("bayatlığın ÜST SINIRI var", () => {
    /* Sınırsız bayat veri de yanlış olurdu; bir noktada beklemek doğrusu. */
    assert.ok(/EN_FAZLA_BAYAT_MS/.test(src), "bayatlik ust siniri yok");
    assert.ok(/yas <= EN_FAZLA_BAYAT_MS/.test(src), "ust sinir uygulanmiyor");
  });

  test("aynı gün için tek tazeleme uçuşta", () => {
    assert.ok(/_fxTazeleme\.get\(isoDate\)/.test(src),
      "her istek ayri tazeleme baslatabilir — saglayici kotasi yanar");
  });

  test("BOŞ sonuç dolu önbelleği EZMİYOR", () => {
    /**
     * ⚠️ ÖLÇÜLDÜ, ve bunu ancak düzeltmeyi yaptıktan SONRA fark ettim:
     * arka plan tazelemesi çalıştı ve bugünün listesi için `0 kayıt` döndü
     * (TSDB kapalı, AF askıda). Önceki kopyadaki 3 maç üzerine yazılıp
     * listeden düştü — yani ölü sağlayıcılar elimizdeki veriyi zamanla
     * SİLİYOR. Aynı kural depoda zaten vardı (`fixture-sync.cjs`: "Hiç maç
     * gelmediyse YAZMA"); buraya uygulanmamıştı.
     */
    assert.ok(/if \(!out\.length\)/.test(src), "bos sonuc kontrolu yok");
    assert.ok(/onbellek KORUNDU/.test(fs.readFileSync(path.join(KOK, "routes/live2.cjs"), "utf8"),),
      "koruma sessiz — operatör saglayicinin oldugunu gormez");
  });

  test("CANLI SKOR bu yoldan gelmiyor — bayat kopya yanlış skor göstermez", () => {
    /**
     * Bayat fikstür servis etmenin güvenli olmasının SEBEBİ bu: durum
     * `data/live/*.json` dosyalarından ayrıca okunuyor.
     */
    assert.ok(/effectiveStatusForFixture/.test(src), "durum ayri okunmuyor");
  });
});
