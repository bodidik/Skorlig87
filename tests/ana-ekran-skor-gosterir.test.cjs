"use strict";

/**
 * ANA EKRAN BİTMİŞ/CANLI MAÇLARIN SKORUNU GÖSTERİR.
 *
 * ⚠️ KUSUR (uçtan uca denetim, 2026-08-03): `/live2/schedule` maçların
 * DURUMUNU doğru veriyordu ama SKORUNU hiç göndermiyordu.
 *
 * ÖLÇÜLDÜ (üretim ana ekran yanıtı):
 *     FT   : 250 maçın 0'ında skor
 *     LIVE :   3 maçın 0'ında skor
 * Mobil `scoreText` `fx.score?.home ?? fx.homeGoals` okuyor; ikisi de yok,
 * ekranda " - " çıkıyor. Yani kullanıcı "Kasımpaşa - Hull City   -   "
 * görüyordu — oysa durum dosyasında skor **1-1** olarak duruyordu.
 *
 * ⚠️ SEBEP İLGİNÇ: `effectiveStatusForFixture` durum dosyasını ZATEN okuyor
 * ve skor tam yanında duruyor; fonksiyon yalnızca durum dizesini döndürüp
 * skoru atıyordu. Yani veri elde, bir satır ötede kayboluyordu. Düzeltmenin
 * ek I/O maliyeti YOK — dosya zaten okunuyordu.
 *
 * ⚠️ BU KUSURU BULMA YÖNTEMİ, ayrıca not: bugüne dek hep "istemcinin
 * çağırdığı ama sunucuda olmayan UÇ" tarandı. Bu sefer TERSİ tarandı —
 * istemci tipinin okuduğu ama sunucunun hiç göndermediği ALAN. `Fx` tipinin
 * 17 alanından 5'i hiç gelmiyordu; `score`/`homeGoals` bunlardandı.
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

const src = yalin("routes/live2.cjs");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("durum okuyucu skoru da döndürüyor", () => {
    assert.ok(/async function effectiveStateForFixture/.test(src),
      "durum+skor okuyucusu yok");
    const i = src.indexOf("async function effectiveStateForFixture");
    const govde = src.slice(i, src.indexOf("\n}", i));
    assert.ok(/score: st\.score \|\| null/.test(govde), "skor donmuyor");
    assert.ok(/htScore: st\.htScore \|\| null/.test(govde), "ilk yari skoru donmuyor");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("çıktıya skor ekleniyor", () => {
  test("schedule döngüsü skoru yanıta koyuyor", () => {
    const i = src.indexOf("const capped = [];");
    const govde = src.slice(i, src.indexOf("res.json", i));
    assert.ok(/effectiveStateForFixture\(it\)/.test(govde),
      "dongu hala yalnizca durumu aliyor — skor atilir");
    assert.ok(/score: it\.score \|\| skor/.test(govde), "score alani eklenmiyor");
    assert.ok(/homeGoals/.test(govde) && /awayGoals/.test(govde),
      "eski istemcinin okudugu homeGoals/awayGoals eklenmiyor");
  });

  test("MEVCUT skor EZİLMİYOR", () => {
    /**
     * ⚠️ Elle girilmiş fikstürde skor `it` üzerinde olabilir; durum
     * dosyasındaki değerle ezmek admin düzeltmesini geri alırdı.
     */
    const i = src.indexOf("const capped = [];");
    const govde = src.slice(i, src.indexOf("res.json", i));
    assert.ok(/it\.score \|\| skor/.test(govde), "mevcut skor korunmuyor");
    assert.ok(/Number\.isFinite\(Number\(it\.homeGoals\)\) \? it\.homeGoals/.test(govde),
      "mevcut homeGoals korunmuyor");
  });

  test("skor YOKSA alan eklenmiyor (uydurma 0-0 yok)", () => {
    /**
     * ⚠️ Başlamamış maça 0-0 yazmak, kullanıcıya oynanmış izlenimi verirdi.
     * Koşullu yayma (`...(skor ? {...} : {})`) tam bunun için.
     */
    const i = src.indexOf("const capped = [];");
    const govde = src.slice(i, src.indexOf("res.json", i));
    assert.ok(/\.\.\.\(skor \? \{/.test(govde), "skor kosulsuz ekleniyor — NS maclara 0-0 yazilir");
    assert.ok(/eff\.score && Number\.isFinite/.test(govde), "skor gecerliligi denetlenmiyor");
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: eski sarmalayıcı korundu (başka çağıranlar kırılmasın)", () => {
  assert.ok(/async function effectiveStatusForFixture/.test(src),
    "geriye uyum sarmalayicisi silinmis");
});

test("NÖBETÇİ: durum dosyası TEK KEZ okunuyor", () => {
  /**
   * Skoru ayrı bir okumayla almak, 582 maçlık listede ikinci bir dosya
   * turu demekti. Düzeltmenin bedelsiz olmasının sebebi tek okuma.
   */
  const i = src.indexOf("async function effectiveStateForFixture");
  const govde = src.slice(i, src.indexOf("\n}", i));
  const okuma = (govde.match(/readJson\(stateFile/g) || []).length;
  assert.equal(okuma, 1, `durum dosyasi ${okuma} kez okunuyor — tek okuma yeterli`);
});
