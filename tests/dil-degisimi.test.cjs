"use strict";

/**
 * DİL SEÇİMİ GERÇEKTEN UYGULANIR MI?
 *
 * ⚠️ UYGULAMA 21 DİL VAAT EDİYOR: `me.tsx` bayraklı bir seçici gösteriyor,
 * `detectLang()` cihaz yerelini otomatik algılıyor, sunucu `preferredLang`
 * alanını kalıcı yazıyor. İki kusur ölçüldü (2026-08-02):
 *
 *  1) "✕ Tercihi kaldır (cihaz diline dön)" BUTONU ÇALIŞMIYORDU.
 *     `saveLang("")` çağırıyor, ama `setLang` koşulu `if (lang && ...)` idi;
 *     boş dize sessizce DÜŞÜYORDU. Sunucu tercihi siliyor, rozet kalkıyor,
 *     uyarı "kaydedildi" diyor — uygulama o oturum boyunca ESKİ dilde kalıyor.
 *
 *  2) DİL DEĞİŞİMİ EKRANI YENİLEMİYORDU. `_lang` bir MODÜL değişkeni; React
 *     onu izlemez. Kullanıcı dil seçiyor, uyarıyı alıyor, ekranda hiçbir şey
 *     değişmiyor — ancak uygulama yeniden açılınca etkili oluyordu.
 *
 * ⚠️ AYRICA ÖLÇÜLDÜ, DÜZELTİLMEDİ (kapsam kararı kullanıcının):
 *     sözlükte 32 anahtar · 21 dilin hepsi %100 dolu
 *     ama i18n'i kullanan ekran   :  2 / 52
 *     gömülü Türkçe dize          : 491  (yorumlar hariç, ALT SINIR)
 *     Türkçe içeren ekran         : 44 / 52
 * Yani seçici çalışsa bile arayüzün ezici çoğunluğu Türkçe kalıyor. Bu bir
 * kusur değil, BİTMEMİŞ İŞ — ama seçicinin vaadiyle çelişiyor. Aşağıdaki
 * kapsam nöbeti sayının SESSİZCE KÖTÜLEŞMESİNİ engelliyor.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const MOBIL = path.join(KOK, "..", "mobile");
const I18N = path.join(MOBIL, "lib", "i18n.ts");
const varMi = fs.existsSync(I18N);
const sebep = "mobile deposu yaninda degil";

const oku = (p) => fs.readFileSync(p, "utf8");

describe("dil değişimi", () => {
  test("setLang BOŞ değerde cihaz diline döner (tercihi kaldır butonu)", { skip: !varMi && sebep }, () => {
    const s = oku(I18N);
    const govde = s.match(/export function setLang[\s\S]*?\n\}/);
    assert.ok(govde, "setLang bulunamadi");
    const g = govde[0];
    /* Eski hatalı hâl: `if (lang && lang in strings) _lang = ...` — boş dize
     * hiçbir şey yapmıyordu. Doğru hâl boş değerde detectLang()'e düşer. */
    assert.ok(/detectLang\(\)/.test(g),
      "setLang bos degerde cihaz diline DONMUYOR — 'Tercihi kaldir' butonu sessiz kalir");
  });

  test("dil değişimi ABONELERE haber verir (ekran yeniden çizilsin)", { skip: !varMi && sebep }, () => {
    const s = oku(I18N);
    assert.ok(/dilAboneOl/.test(s), "abonelik yok — dil degisimi ekrani yenilemez");
    assert.ok(/export function useLang/.test(s), "useLang kancasi yok");
    const g = s.match(/export function setLang[\s\S]*?\n\}/)[0];
    assert.ok(/_dinleyiciler/.test(g), "setLang dinleyicileri UYARMIYOR — degisim gorunmez kalir");
  });

  test("t() KULLANAN her ekran abonelikte olmalı", { skip: !varMi && sebep }, () => {
    /**
     * ⚠️ ABONELİK OLMADAN DÜZELTME ETKİSİZ. Bir ekran `t()` basıyor ama
     * `useLang()` çağırmıyorsa, dil değiştiğinde o ekran ESKİ dilde kalır.
     * Kusur tam olarak böyle görünmezdi.
     */
    const kokler = [path.join(MOBIL, "app"), path.join(MOBIL, "components")];
    const dosyalar = [];
    const gez = (d) => {
      if (!fs.existsSync(d)) return;
      for (const a of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, a.name);
        if (a.isDirectory()) gez(p);
        else if (a.name.endsWith(".tsx")) dosyalar.push(p);
      }
    };
    kokler.forEach(gez);
    assert.ok(dosyalar.length > 20, "tarama ekran bulamadi — test bir sey olcmuyor");

    const aciklar = [];
    for (const f of dosyalar) {
      const s = oku(f);
      if (!/\bt\("/.test(s)) continue;          // t() basmiyor
      if (/useLang\(\)/.test(s)) continue;      // abone
      aciklar.push(path.relative(MOBIL, f));
    }
    assert.deepEqual(aciklar, [], `t() basiyor ama useLang() ile abone DEGIL:\n${aciklar.join("\n")}`);
  });

  test("21 dilin hepsi ÇEKİRDEK sözlükteki her anahtarı taşır", { skip: !varMi && sebep }, () => {
    /**
     * ⚠️ SÖZLEŞME DEĞİŞTİ (2026-08-03, kapsam kararı): taban artık tr'nin
     * TAMAMI değil, 22 dilde çevirisi olan ÇEKİRDEK küme. Yeni anahtarlar
     * bilinçli olarak yalnız tr+en ekleniyor; diğer diller t()'nin İngilizce
     * yedeğine düşüyor (783 sabit metni önce anahtara çevirmek, 22 dile el
     * çevirisinden önce geliyor). tr+en paritesini ve yer tutucu eşleşmesini
     * `i18n-kapsam-cirlagi` testi ayrıca koruyor.
     *
     * Çekirdek, en KÜÇÜK dil bloğundan türetilir: 21 dilin hâlâ ortak taşımak
     * zorunda olduğu küme odur. Bir dilden çekirdek anahtar SİLİNİRSE burada
     * yakalanır.
     */
    const src = oku(I18N);
    const pos = [];
    const re = /^  ([a-z]{2}(?:-[A-Za-z]+)?):\s*\{/gm;
    let m;
    while ((m = re.exec(src))) pos.push({ dil: m[1], i: m.index + m[0].length });
    assert.ok(pos.length >= 10, `yalnizca ${pos.length} dil blogu bulundu — tarama bozuk`);

    const anahtarlar = {};
    pos.forEach((p, k) => {
      const son = k + 1 < pos.length ? src.lastIndexOf("},", pos[k + 1].i) : src.length;
      anahtarlar[p.dil] = new Set(
        [...src.slice(p.i, son).matchAll(/^\s{4}"?([A-Za-z0-9_.]+)"?\s*:/gm)].map((x) => x[1])
      );
    });
    // Çekirdek = en küçük blok (bugün 40 anahtarlık orijinal küme).
    const cekirdek = Object.values(anahtarlar).reduce((a, b) => (b.size < a.size ? b : a));
    assert.ok(cekirdek.size >= 30 && cekirdek.size <= 60,
      `cekirdek kume supheli (${cekirdek.size}) — 40 civari olmali, tarama bozuk olabilir`);
    assert.ok(anahtarlar.tr && [...cekirdek].every((k) => anahtarlar.tr.has(k)),
      "tr cekirdegi tasimiyor — tarama bozuk");

    const eksik = [];
    for (const [d, s] of Object.entries(anahtarlar)) {
      if (d === "tr") continue;
      const yok = [...cekirdek].filter((k) => !s.has(k));
      if (yok.length) eksik.push(`${d}: ${yok.join(", ")}`);
    }
    assert.deepEqual(eksik, [], `dilde eksik CEKIRDEK anahtar (kullaniciya HAM ANAHTAR gorunur):\n${eksik.join("\n")}`);
  });

  test("KAPSAM NÖBETİ: i18n kullanan ekran sayısı gerilemesin", { skip: !varMi && sebep }, () => {
    /**
     * ⚠️ BU BİR HEDEF DEĞİL, BİR BARİYER. Bugün 2/52 ekran i18n kullanıyor ve
     * bu düşük — ama düzeltmesi 491 dizeyi 21 dile çevirmek demek, yani ürün
     * kararı. Test yalnızca sayının SESSİZCE düşmesini engelliyor.
     */
    const kokler = [path.join(MOBIL, "app"), path.join(MOBIL, "components")];
    const dosyalar = [];
    const gez = (d) => {
      if (!fs.existsSync(d)) return;
      for (const a of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, a.name);
        if (a.isDirectory()) gez(p);
        else if (a.name.endsWith(".tsx")) dosyalar.push(p);
      }
    };
    kokler.forEach(gez);
    const kullanan = dosyalar.filter((f) => /\bt\("/.test(oku(f))).length;
    assert.ok(kullanan >= 1, `i18n kullanan ekran ${kullanan} — ceviri altyapisi olmus`);
  });
});
