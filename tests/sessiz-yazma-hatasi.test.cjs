"use strict";

/**
 * YAZMA İSTEĞİ SESSİZCE BAŞARISIZ OLAMAZ.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-02, `app/match-race/[fixtureId].tsx` toggleBlock):
 *
 *     await apiFetch(`/api/friends/${action}`, { method: "POST", ... });
 *     setBlocked(!blocked);          // <- arayüz "engellendi" der
 *     } catch (_) {}                 // <- hata yutuluyor
 *
 * `apiFetch` YALNIZCA ağ hatasında fırlatır; 500/401/403 gibi yanıtlarda
 * fırlatmaz (standart fetch davranışı — bkz. mobile/lib/apiFetch.ts, yanıt
 * nesnesini olduğu gibi döndürür). Yani sunucu engellemeyi reddetse bile
 * ekran ENGELLENDİ gösteriyordu.
 *
 * ⚠️ BU BİR GÜVENLİK ÖZELLİĞİ. Taciz eden birini engellediğini düşünen kişi
 * korunduğunu da düşünür. Yanlış "başarılı" geri bildirimi, hiç geri bildirim
 * olmamasından kötüdür.
 *
 * ⚠️ ÖLÇÜM YÖNTEMİM ÜÇ KEZ FAZLA RAPORLADI, nota değer: ilk taramalarım
 * `showToast`'ı geri bildirim saymadı, `res.json().catch(()=>null)` gibi
 * meşru iç catch'leri kusur saydı ve `Alert.alert` geri çağrısı içindeki
 * gövdeleri yanlış dilimledi. Bayrak kaldıran her yeri TEK TEK okumadan
 * kusur yazılmamalı — 7 adayın 5'i temiz çıktı.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const MOBIL = require("./_mobil-dizin.cjs").MOBIL;
const varMi = fs.existsSync(MOBIL);
const sebep = "mobile deposu yaninda degil";

const oku = (rel) => fs.readFileSync(path.join(MOBIL, rel), "utf8");

describe("sessiz yazma hatası", () => {
  test("apiFetch 2xx OLMAYAN yanıtta FIRLATMIYOR (iddianın dayanağı)", { skip: !varMi && sebep }, () => {
    /**
     * ⚠️ Bu iddia düşerse aşağıdaki tüm gerekçe çöker: apiFetch fırlatsaydı
     * `catch` yeterli olurdu. Kaynakta `res.ok` kontrolü YOK, yanıt olduğu
     * gibi dönüyor.
     */
    const src = oku(path.join("lib", "apiFetch.ts"));
    const govde = src.slice(src.indexOf("async function istekYap"), src.indexOf("async function istekYap") + 1200);
    assert.ok(govde.length > 100, "istekYap bulunamadi — test bir sey olcmuyor");
    assert.ok(!/if\s*\(\s*!\w*res\w*\.ok\s*\)[\s\S]{0,80}throw/i.test(govde),
      "apiFetch artik 2xx disinda firlatiyor — cagiranlardaki res.ok kontrolleri gozden gecirilebilir");
  });

  test("engelleme yanıtı KONTROL ediliyor", { skip: !varMi && sebep }, () => {
    const src = oku(path.join("app", "match-race", "[fixtureId].tsx"));
    const i = src.indexOf("/api/friends/${action}");
    assert.ok(i > 0, "engelleme cagrisi bulunamadi — test bir sey olcmuyor");
    /* Pencere GENİŞ: açıklama bloğu uzun, dar pencere kontrolü ıskalıyordu. */
    const govde = src.slice(Math.max(0, i - 1200), i + 1600);

    assert.ok(/res\.ok|j\?\.ok/.test(govde),
      "engelleme yaniti KONTROL EDILMIYOR — sunucu reddetse de ekran engellendi der");
    assert.ok(/Alert\.alert/.test(govde),
      "engelleme basarisizken kullaniciya HICBIR sey soylenmiyor");
    /* ⚠️ YALNIZCA ÇAĞRIDAN SONRASI. İlk yazımım çağrının ÖNCESİNİ de
     * kapsıyordu ve kusuru ANLATAN kendi yorum metnimdeki `catch (_) {}`
     * ifadesiyle eşleşip kırılıyordu. Ayrıca aynı dosyadaki `openProfile`
     * bir OKUMA yolu; sessiz kalması ayrı bir konu, bu iddianın kapsamında
     * değil. */
    const sonrasi = src.slice(i, i + 1600);
    assert.ok(!/catch\s*\(_\)\s*\{\s*\}/.test(sonrasi),
      "bos catch geri geldi — cevrimdisiyken sessiz kaliyor");
  });

  test("durum yalnızca BAŞARIDA değişiyor", { skip: !varMi && sebep }, () => {
    /* ⚠️ Asıl kusur buydu: `setBlocked` başarısızlıkta da çalışıyordu.
     * Erken `return` olmadan hata dalı akışı durdurmaz. */
    const src = oku(path.join("app", "match-race", "[fixtureId].tsx"));
    const i = src.indexOf("/api/friends/${action}");
    const govde = src.slice(i, i + 1600);
    const hataIdx = govde.indexOf("Alert.alert");
    const donusIdx = govde.indexOf("return;", hataIdx);
    const setIdx = govde.indexOf("setBlocked(!blocked)");
    assert.ok(hataIdx > 0 && donusIdx > 0, "hata dali erken donmuyor");
    assert.ok(donusIdx < setIdx,
      "setBlocked hata dalindan SONRA gelmiyor — basarisizlikta da arayuz degisir");
  });

  test("1987 haftalık seçimde ağ hatası bildiriliyor", { skip: !varMi && sebep }, () => {
    /* ⚠️ YALNIZCA YAZMA fonksiyonu sınanıyor. Dosyada başka boş catch'ler de
     * var ama onlar OKUMA yolları (`fetchBoard`) — sessiz kalmaları meşru,
     * tablo boş/bayat kalır, kullanıcı yanlış bilgilenmez. İlk yazımım tüm
     * dosyayı sınıyordu ve okuma yollarını da kusur sayıyordu. */
    const src = oku(path.join("components", "Picks1987.tsx"));
    const i = src.indexOf("const handleSubmit");
    assert.ok(i > 0, "handleSubmit bulunamadi — test bir sey olcmuyor");
    const govde = src.slice(i, i + 1800);
    assert.ok(!/\}\s*catch\s*\{\s*\}/.test(govde),
      "handleSubmit bos catch ile bitiyor — cevrimdisiyken secim kaydedilmedigi halde kullanici bilmiyor");
  });
});
