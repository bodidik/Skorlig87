"use strict";

/**
 * BİLİNMEYEN BAKİYE "0" DİYE GÖSTERİLMEZ.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-02, app/(tabs)/predict.tsx):
 *
 *     {walletLoading ? "…" : `${wallet?.user?.balance ?? 0} LC`}
 *
 * `loadWalletSummary` hata durumunda (ağ hatası, sunucu hatası, jeton sorunu)
 * `wallet`ı null yapıyor; yükleme bitince bu satır `?? 0` yüzünden "0 LC"
 * yazıyordu. 500 LC'si olan kullanıcı parasının bittiğini sanıyordu.
 *
 * ⚠️ BİLİNMEYEN İLE SIFIR AYNI ŞEY DEĞİL. Aynı sınıfın bugünkü diğer iki
 * örneği: premium tablosu `undefined LC` basıyordu, mini profil başkasının
 * bakiyesini `0` göndermek yerine alanı hiç göndermiyor (0 göndermek "parası
 * yok" diye okunurdu).
 *
 * ⚠️ ABARTMADIM, ÖLÇTÜM: eylem kapısı (`matchCost > 0`) de aynı null'dan
 * beslendiği için tahmin ENGELLENMİYORDU — kusur yalnızca gösterimde.
 * Yine de kullanıcıya yanlış bilgi veriyor.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const MOBIL = path.join(KOK, "..", "mobile");
const varMi = fs.existsSync(MOBIL);
const sebep = "mobile deposu yaninda degil";

/** Bakiye gösteren satırları toplar (para birimi etiketiyle basılanlar). */
function bakiyeSatirlari() {
  const kokler = [path.join(MOBIL, "app"), path.join(MOBIL, "components")];
  const bulunan = [];
  const gez = (d) => {
    if (!fs.existsSync(d)) return;
    for (const a of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, a.name);
      if (a.isDirectory()) gez(p);
      else if (a.name.endsWith(".tsx")) {
        const satir = fs.readFileSync(p, "utf8").split(/\r?\n/);
        satir.forEach((l, i) => {
          const t = l.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("{/*")) return;
          /**
           * ⚠️ YALNIZCA KORUMASIZ BİÇİM. `wallet?.user?.balance ?? 0` cüzdanın
           * KENDİSİ null olabilirken sıfır basar — asıl kusur bu.
           * `wallet.user?.balance ?? 0` ise zaten `wallet ? (...)` teyidinin
           * içinde; orada 0 gerçek bir bakiyedir.
           *
           * İlk yazımım ikisini ayırmıyordu ve üç satır işaretledi; üçü de
           * yanlış pozitifti (biri kendi düzelttiğim satırdı). Dedektörün
           * kendisi de sınanmalı — bugünün tekrar eden dersi.
           */
          /* Kesin biçim: `.balance`ın HEMEN ÖNCESİNDE isteğe bağlı zincir
           * (`?.balance`) — cüzdan yokken de bu satıra ulaşılır demektir.
           * Korumalı biçim (`wallet ? ... wallet.user.balance ?? 0`) eşleşmez;
           * ilk iki denememde o satırları da işaretliyordum. */
          /* ⚠️ KURAL "GÖSTERİM/İDDİA" ÜZERİNE, atama üzerine değil.
           * `const currentBalance = wallet?.user?.balance ?? 0` başlı başına
           * kusur değil — kullanımı bir "bilinmiyor" kapısına bağlıysa
           * sorun yok. Kusur, uydurma sıfırın KULLANICIYA basılması.
           * İlk iki denememde atamayı da işaretliyordum; dedektörün kendisi
           * de sınanmalı. */
          if (/wallet\?\.\w+\?\.balance\s*\?\?\s*0/.test(t) && /LC/.test(t)) {
            bulunan.push(`${path.relative(MOBIL, p)}:${i + 1}  ${t.slice(0, 90)}`);
          }
        });
      }
    }
  };
  kokler.forEach(gez);
  return bulunan;
}

describe("bilinmeyen bakiye", () => {
  test("tarama GERÇEKTEN ekran dosyası buluyor", { skip: !varMi && sebep }, () => {
    /* ⚠️ Sıfır sonuç kanıt değildir: kalıp bozulursa test sessizce yeşil
     * kalır. Bugün sonda kurulumunda bu tuzağa defalarca düşüldü. */
    const ekran = path.join(MOBIL, "app", "(tabs)", "predict.tsx");
    assert.ok(fs.existsSync(ekran), "predict ekrani bulunamadi — tarama bozuk");
    const src = fs.readFileSync(ekran, "utf8");
    assert.ok(/walletLoading/.test(src), "cuzdan yukleme durumu yok — dosya degismis");
  });

  test("hiçbir ekran bilinmeyen bakiyeyi 0 LC diye basmıyor", { skip: !varMi && sebep }, () => {
    const suclu = bakiyeSatirlari();
    assert.deepEqual(suclu, [],
      "bilinmeyen bakiye 0 LC olarak basiliyor — kullanici parasinin bittigini sanir:\n" + suclu.join("\n"));
  });

  test("predict ekranı BİLİNMEYENİ ayrı gösteriyor", { skip: !varMi && sebep }, () => {
    /**
     * ⚠️ Yalnızca "?? 0 yok" demek yetmez: satır tümden silinmiş de olabilir.
     * Bilinmeyen için AYRI bir gösterim olduğunu ayrıca doğruluyoruz.
     */
    const src = fs.readFileSync(path.join(MOBIL, "app", "(tabs)", "predict.tsx"), "utf8");
    const i = src.indexOf("walletLoading ?");
    assert.ok(i > 0, "bakiye gosterimi bulunamadi — test bir sey olcmuyor");
    const satir = src.slice(i, i + 200);
    assert.ok(/wallet\?\.user\s*\?/.test(satir),
      "bakiye gosterimi cuzdanin VARLIGINI kontrol etmiyor — bilinmeyen yine 0 gorunur");
    assert.ok(/—/.test(satir), "bilinmeyen icin ayri bir gosterim (—) yok");
  });
});
