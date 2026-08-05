"use strict";

/**
 * PUANLAMA GERÇEK TAKIM ADI VE ÜLKEYLE YAPILIR — nötr çarpanla değil.
 *
 * ⚠️ MAJÖR PUANLAMA HATASI. `_scoreFixtureUnlocked` durum dosyasını okuyor:
 *     data/live/<fid>.json = { fixtureId, status, isLive, score,
 *                              updatedAt, source, htScore }
 * İçinde `home`, `away`, `country` YOK. Bu alanları dolduran bootstrap'lar
 * yalnızca `if (!st)` iken çalışıyor — yani durum dosyası VARSA (normal hâl;
 * `livescore-sync` her senkronda yazıyor) hiç devreye girmiyorlar.
 *
 * Sonuç: puanlamanın üç çarpanı da `undefined` ile çağrılıyordu:
 *     getScoreWeight(st.country)          → hep 1.0
 *     MW.oddsMultiplier(st.home, st.away) → hep nötr
 *     MW.matchDifficulty(st.home, st.away)→ hep nötr
 *
 * ÖLÇÜLDÜ (kuru yeniden hesap, gerçek üretim verisi):
 *     Arjantin maçı        : uygulanan ülke ağırlığı 1.000 · doğrusu 1.03
 *     Real Madrid–Erokspor : ev kazanır çarpanı 2.4 uygulanıyor · doğrusu 1.4
 *     aynı maç             : yan kalem zorluğu 1.10 · doğrusu 0.60
 * Yani BARİZ FAVORİYİ TUTMAK olması gerekenden **%71 fazla** ödüyordu.
 * Uygulamanın kendi vaadi "az kişinin tuttuğunu bilirsen daha fazla puan";
 * kusur bunu tersine çeviriyordu.
 *
 * ÜRETİM VERİSİNDE DE GÖRÜLDÜ: mühürlü snapshot'lar bağımsız yeniden
 * hesaplandığında ağırlığı 1.0 OLMAYAN ülkeden gelen 40 satırın 40'ı
 * tutmuyor, 1.0 olanların 2523'ü tutuyordu — hata yalnızca ağırlığın
 * nötr olmadığı yerde GÖRÜNÜR oluyordu.
 *
 * ⚠️ ÇÖZÜM PUANLAMA ANINDA ZENGİNLEŞTİRME, `writeLiveState`'e alan eklemek
 * DEĞİL: ikincisi yalnızca yeni maçları düzeltir, mevcut binlerce durum
 * dosyası eksik kalırdı.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
process.env.SKORLIG_BG = "0";

const MW = require("../services/match-weights.cjs");

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

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("çarpanlar takım adına GERÇEKTEN duyarlı", () => {
    /**
     * ⚠️ Bu test olmadan aşağıdakiler boş yere yeşil olabilirdi: eğer
     * çarpanlar takım adını hiç kullanmasaydı, zenginleştirmenin de bir
     * anlamı kalmazdı.
     */
    const notr = MW.oddsMultiplier(undefined, undefined, "H");
    const favori = MW.oddsMultiplier("Real Madrid", "Erokspor", "H");
    assert.notEqual(notr, favori,
      "takim adi carpani degistirmiyor — derecelendirme tablosu bos olabilir");
    assert.ok(favori < notr, "bariz favori notr degerden UCUZ olmali");

    const zorlukNotr = MW.matchDifficulty(undefined, undefined);
    const zorlukFavori = MW.matchDifficulty("Real Madrid", "Erokspor");
    assert.notEqual(zorlukNotr, zorlukFavori, "zorluk takim adina duyarsiz");
  });

  test("ülke ağırlığı gerçekten ayrışıyor", () => {
    assert.equal(MW.getScoreWeight(undefined), 1);
    assert.notEqual(MW.getScoreWeight("Argentina"), 1,
      "Argentina agirligi 1.0 — test bir sey olcmuyor");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("zenginleştirme", () => {
  const src = yalin("routes/settle2.cjs");

  test("eksik alanlar fikstür kaydından tamamlanıyor", () => {
    assert.ok(/if \(st && \(!st\.home \|\| !st\.away \|\| !st\.country\)\)/.test(src),
      "durum dosyasindaki eksik meta tamamlanmiyor — puanlama notr carpanla yapilir");
    assert.ok(/FixturesStore\.getOne\(fid, db \|\| null\)/.test(src),
      "fikstur kaydi okunmuyor");
  });

  test("MEVCUT değerler EZİLMİYOR", () => {
    /* Bootstrap yolundan gelen `st` bu alanları zaten doldurmuş olabilir. */
    for (const alan of ["home", "away", "country", "league"]) {
      const re = new RegExp(`if \\(!st\\.${alan}\\)\\s*st\\.${alan}\\s*=`);
      assert.ok(re.test(src), `${alan} kosulsuz yaziliyor — mevcut deger ezilir`);
    }
  });

  test("zenginleştirme HATASI puanlamayı durdurmuyor", () => {
    /**
     * Fikstür kaydı okunamazsa eski davranışa (nötr çarpan) düşmek, hiç
     * uzlaşmamaktan iyidir — para kilitli kalmasın. Ama sessiz de kalmamalı.
     */
    const i = src.indexOf("FixturesStore.getOne(fid, db || null)");
    const cevre = src.slice(i - 400, i + 700);
    assert.ok(/catch \(e\)/.test(cevre), "hata puanlamayi dusurebilir");
    assert.ok(/console\.error/.test(cevre), "hata sessizce yutuluyor");
  });

  test("zenginleştirme, çarpanlar KULLANILMADAN ÖNCE yapılıyor", () => {
    /**
     * ⚠️ Sıra kritik: `getScoreWeight(st.country)` zenginleştirmeden ÖNCE
     * çalışsaydı düzeltme hiçbir işe yaramazdı — ve bu, kaynak taramasıyla
     * kolayca gözden kaçabilecek bir hata.
     */
    const zengin = src.indexOf("FixturesStore.getOne(fid, db || null)");
    const kullanim = src.indexOf("getScoreWeight(st.country)");
    assert.ok(zengin > 0 && kullanim > 0, "beklenen satirlar bulunamadi");
    assert.ok(zengin < kullanim,
      "zenginlestirme carpan hesabindan SONRA — duzeltme etkisiz");
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: durum dosyası hâlâ meta taşımıyor (zenginleştirme şart)", () => {
  /**
   * `writeLiveState` bir gün home/away/country yazmaya başlarsa bu test
   * kırılır — o zaman zenginleştirme gereksizleşmiş olabilir ve gerekçe
   * gözden geçirilmeli. Kırılması BİLGİ, kusur değil.
   */
  /* ⚠️ `home:` DİYE ARAMAK YANLIŞ: gövdede `score: { home: ... }` ve
   * `htScore = { home: ... }` var — ikisi SKOR, takım adı değil. İlk
   * yazımımda bu yüzden test kod doğruyken kırıldı. Takım adı alanı
   * `st.home` ataması olarak aranıyor. */
  const src = yalin("services/livescore-sync.cjs");
  const i = src.indexOf("async function writeLiveState");
  const govde = src.slice(i, src.indexOf("await writeJsonAtomic(stateFile, st);", i));
  const takimAdiYaziyor = /st\.home\s*=/.test(govde) || /st\.country\s*=/.test(govde);
  assert.equal(takimAdiYaziyor, false,
    "writeLiveState artik takim adi/ulke yaziyor — zenginlestirmenin gerekcesi gozden gecirilmeli");
});
