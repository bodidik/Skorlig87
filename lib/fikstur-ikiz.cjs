"use strict";

/**
 * AYNI MAÇIN İKİ KEZ KAYDEDİLMESİNİ ENGELLE.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-08-02, 1930 fikstür): aynı gerçek maç, iki farklı ad
 * yazımıyla İKİ AYRI fixtureId olarak duruyor. 115 çift, 230 fikstür:
 *
 *     MK-MARSEI-2026-07-30-NIMES   Marseille - Nimes
 *     MK-MARSIL-2026-07-30-NIMES   Marsilya - Nimes        (Türkçe ad)
 *     MK-SPORTI-...-NOTFOR         Sporting CP - Not. Forest
 *     MK-SPORTI-...-NOTTIN         Sporting CP - Nottingham Forest
 *
 * ⚠️ ZARARI ÖLÇÜLDÜ, VARSAYIM DEĞİL: 115 çiftin 23'ünde durum dosyası
 * YALNIZCA BİRİNDE var. Yani ikizin biri FT olup ödüyor, öbürü hiç
 * uzlaşmıyor — o kayda tahmin yapan kullanıcı giriş bedelini ödemiş, ödülü
 * hiçbir zaman gelmeyecek. Bugün ayrıca "uzlaşmamış maç" olarak görülen
 * sorunun kaynağı da bu.
 *
 *     MK-MARSEI-2026-07-30-NIMES  Marseille-Nimes  [durum yok]
 *     MK-MARSIL-2026-07-30-NIMES  Marsilya-Nimes   [FT]
 *
 * ⚠️ BULANIK EŞLEŞTİRME YAPILMIYOR — `lib/takim-katalog.cjs`'in dersi burada
 * da geçerli. İki kaydın ikiz sayılması için ÜÇ şart birden gerekir:
 *   1) dakikası dakikasına aynı başlama saati,
 *   2) aynı ülke,
 *   3) HEM ev HEM deplasman adı birbirinin varyantı.
 * Tek taraf yetmez: aynı saatte aynı ülkede oynanan iki farklı maç ortak bir
 * takım adı taşıyabilir (ölçümde görüldü: "Hradec Kralove - NK Varazdin" ve
 * "Jablonec - NK Varazdin" AYRI maçlar). Bunları birleştirmek gerçek bir maçı
 * yok ederdi — kopyayı bırakmaktan daha kötü.
 */

/** Ad normalleştirme: harf/rakam dışını at, boşlukları tekle. */
function ad(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * İki takım adı aynı kulübün yazım varyantı mı?
 *
 * Ölçülen gerçek varyant biçimleri:
 *   "R. Sociedad"  / "Real Sociedad"      → ortak kelime "sociedad"
 *   "Not. Forest"  / "Nottingham Forest"  → ortak kelime "forest"
 *   "Marseille"    / "Marsilya"           → ortak 4 harfli önek "mars"
 *   "Den Haag"     / "ADO Den Haag"       → ortak kelime "haag"
 */
function varyantMi(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = a.split(" "), tb = b.split(" ");
  /* Ortak "anlamlı" kelime: 4+ harf. Kısa kelimeler ("fc", "sk", "ii", "b")
   * kulüp ayırt etmez; onlarla eşleştirmek farklı takımları birleştirirdi. */
  for (const x of ta) if (x.length >= 4 && tb.includes(x)) return true;
  const A = a.replace(/ /g, ""), B = b.replace(/ /g, "");
  return A.length >= 4 && B.length >= 4 && A.slice(0, 4) === B.slice(0, 4);
}

/** Aynı maçın iki kaydı mı? Üç şart da sağlanmalı. */
function ikizMi(a, b) {
  if (!a || !b) return false;
  const ka = String(a.kickoffISO || "").slice(0, 16);
  const kb = String(b.kickoffISO || "").slice(0, 16);
  if (!ka || ka !== kb) return false;
  if (ad(a.country) !== ad(b.country)) return false;
  return varyantMi(ad(a.home), ad(b.home)) && varyantMi(ad(a.away), ad(b.away));
}

/**
 * Listedeki ikizleri ayıklar. Dönen: { list, dusenler }
 *
 * ⚠️ HANGİSİ KALIR — BU KARAR PARA ETKİLER.
 *
 * `bilinenIdler` DEPODA HÂLİHAZIRDA OLAN kimlikler. Bir ikiz zaten depodaysa
 * kullanıcılar ona tahmin yapmış, havuza girmiş, düello kurmuş olabilir. O
 * kaydı düşürmek tahminleri ÖKSÜZ bırakır — kopyadan daha kötü. Bu yüzden
 * kural: BİLİNEN kayıt her zaman kazanır.
 *
 * İkisi de yeniyse daha uzun (daha kanonik) adı olan kalır; eşitlikte
 * kimlik sırasına göre — karar DETERMİNİSTİK olmak zorunda, yoksa iki
 * senkron turu birbirinin kararını bozar ve kayıt sürekli değişir.
 */
function ikizleriAyikla(list, bilinenIdler) {
  const bilinen = bilinenIdler instanceof Set ? bilinenIdler : new Set(bilinenIdler || []);
  const items = (Array.isArray(list) ? list : []).filter((f) => f && f.fixtureId != null);

  const kova = new Map();
  for (const f of items) {
    const k = `${String(f.kickoffISO || "").slice(0, 16)}|${ad(f.country)}`;
    if (!kova.has(k)) kova.set(k, []);
    kova.get(k).push(f);
  }

  const dusen = new Set();
  const dusenler = [];
  for (const grup of kova.values()) {
    if (grup.length < 2) continue;
    for (let i = 0; i < grup.length; i++) {
      for (let j = i + 1; j < grup.length; j++) {
        const a = grup[i], b = grup[j];
        const ia = String(a.fixtureId), ib = String(b.fixtureId);
        if (ia === ib || dusen.has(ia) || dusen.has(ib)) continue;
        if (!ikizMi(a, b)) continue;

        const aBilinen = bilinen.has(ia), bBilinen = bilinen.has(ib);

        /* ⚠️ İKİSİ DE DEPODAYSA İKİSİ DE KALIR — GERİYE DÖNÜK SİLME YOK.
         *
         * İlk yazımım burada da bir tanesini düşürüyordu ve ölçüm yakaladı:
         * mevcut listede 116 kayıt siliniyordu. Onların her birine tahmin,
         * havuz bahsi ya da düello bağlanmış olabilir; silmek o kayıtları
         * ÖKSÜZ bırakırdı — kopyadan çok daha kötü. Bu fonksiyonun işi YENİ
         * kopyayı önlemek, geçmişi temizlemek değil. Geçmiş temizliği ayrı
         * bir karar (kim kazanacak, tahminler nereye taşınacak). */
        if (aBilinen && bBilinen) continue;

        let kalan, giden;
        if (aBilinen !== bBilinen) {
          kalan = aBilinen ? a : b;
          giden = aBilinen ? b : a;
        } else {
          const uzA = ad(a.home).length + ad(a.away).length;
          const uzB = ad(b.home).length + ad(b.away).length;
          if (uzA !== uzB) { kalan = uzA > uzB ? a : b; giden = uzA > uzB ? b : a; }
          else { kalan = ia < ib ? a : b; giden = ia < ib ? b : a; }
        }
        dusen.add(String(giden.fixtureId));
        dusenler.push({
          dusen: String(giden.fixtureId), kalan: String(kalan.fixtureId),
          mac: `${giden.home} - ${giden.away}`, yerine: `${kalan.home} - ${kalan.away}`,
        });
      }
    }
  }

  return { list: items.filter((f) => !dusen.has(String(f.fixtureId))), dusenler };
}

module.exports = { ikizMi, ikizleriAyikla, _ad: ad, _varyantMi: varyantMi };
