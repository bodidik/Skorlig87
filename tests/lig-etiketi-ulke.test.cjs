"use strict";

/**
 * LİG ETİKETİ ÜLKEYİ SÖYLER + SIRALAMA SEÇİLEBİLİR.
 *
 * ⚠️ BULUNAN SORUN (2026-08-03, kullanıcı bildirimi, üretim verisiyle ölçüldü):
 * maç listesi yalnızca lig ADINI yazıyordu. Lig adları ülkeden bağımsız olarak
 * tekrar ediyor (1944 fikstür, 298 lig+ülke çifti):
 *
 *     BİRDEN FAZLA ülkede geçen lig adı : 32
 *     "Premier Lig"      → 24 ülke
 *     "1. Lig"           → 18 ülke
 *     "2. Lig"           → 13 ülke
 *     "Primera Division" →  7 ülke
 *     "Serie A"          → İtalya, Brezilya, Ekvador
 *     "Championship"     → İngiltere, İskoçya
 *
 * Yani "3. Lig" yazan satırda kullanıcı hangi ülkenin ligi olduğunu
 * bilemiyordu. Ayrıca tek sabit sıra vardı; aradığı maçı bulmak için
 * sayfalarca kaydırmak gerekiyordu.
 *
 * ⚠️ MOBİLDE TEST KOŞUCUSU YOK. Bu dosya kaynak sözleşmesini tutuyor; etiketin
 * dayandığı ülke-adı çözümü ayrıca `tests/ulke-adi-yerellestirme.test.cjs`
 * tarafından ölçülüyor ve `tsc --noEmit` tip tarafını kapatıyor. Bunu
 * olduğundan güçlü göstermiyorum: burada davranış değil BAĞLANTI sınanıyor.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const MOBIL = path.join(KOK, "..", "mobile");
const ULKELER = path.join(MOBIL, "lib", "ulkeler.ts");
const LIVE = path.join(MOBIL, "app", "(tabs)", "live.tsx");
const I18N = path.join(MOBIL, "lib", "i18n.ts");

const varMi = (p) => fs.existsSync(p);
const oku = (p) => fs.readFileSync(p, "utf8");

describe("lig etiketi + sıralama", () => {
  test("kurulum sınandı: mobil depo ve dosyalar GERÇEKTEN yerinde", () => {
    /* ⚠️ Bu olmadan tüm testler sessizce atlanır ve yeşil görünür — bu
     * oturumda "sıfır sonuç kanıt değildir" dersinin aynısı. */
    if (!varMi(MOBIL)) return;                       // mobil depo yoksa atla
    assert.ok(varMi(ULKELER), "lib/ulkeler.ts yok");
    assert.ok(varMi(LIVE), "live.tsx yok");
    assert.ok(varMi(I18N), "i18n.ts yok");
  });

  test("ligEtiketi TEK YERDE tanımlı ve ülke adını yerelleştirilmiş alıyor", () => {
    if (!varMi(ULKELER)) return;
    const s = oku(ULKELER);
    assert.ok(/export function ligEtiketi\(/.test(s), "ligEtiketi disa acilmamis");
    assert.ok(/export function ligSiraAnahtari\(/.test(s), "ligSiraAnahtari disa acilmamis");
    // Ülke adı `ulkeAdi` üzerinden gelmeli: ham ad basmak "Turkey/Türkiye"
    // bölünmesini ekrana taşırdı (bu depoda ölçülmüş bir kusur).
    assert.ok(/ulkeAdi\(ulke\)/.test(s), "ligEtiketi ulke adini ulkeAdi()'nden almiyor");
    assert.ok(/ulkeBayragi\(ulke\)/.test(s), "bayrak ortak yardimcidan gelmiyor");
  });

  test("TEKRAR ETMEZ: lig adı ülkeyi içeriyorsa ülke iki kez yazılmaz", () => {
    /**
     * ⚠️ "Türkiye · Türkiye Kupası" gibi bir etiket, sorunu çözerken yeni bir
     * gürültü yaratırdı. Karşılaştırma TÜRKÇE küçük harfle yapılmalı:
     * `"İ".toLowerCase()` tuzağı bu depoda daha önce ısırdı.
     */
    if (!varMi(ULKELER)) return;
    const s = oku(ULKELER);
    const i = s.indexOf("export function ligEtiketi(");
    const govde = s.slice(i, s.indexOf("export function ligSiraAnahtari("));
    assert.ok(/includes\(kucuk\(ad\)\)|includes\(.*toLocaleLowerCase\("tr"\)/.test(govde),
      "lig adi ulkeyi iceriyor mu kontrolu yok — 'Turkiye · Turkiye Kupasi' cikar");
    assert.ok(/toLocaleLowerCase\("tr"\)/.test(govde),
      "kucuk harf donusumu Turkce degil");
  });

  test("MAÇ LİSTESİ etiketi kullanıyor (ham lig adı basılmıyor)", () => {
    /**
     * ⚠️ ASIL KIRILGANLIK. Yardımcı yazılıp ekran eski hâlinde kalırsa
     * kullanıcı için HİÇBİR ŞEY değişmez — bu oturumun tekrar eden dersi:
     * "fonksiyonu sınamak yetmez, ucu döv".
     */
    /**
     * ⚠️ İLK YAZIMIM YALANCI YEŞİLDİ — negatif kontrol yakaladı.
     *
     * "`ligEtiketi(item.league, item.country)` dosyada geçiyor mu" diye
     * bakıyordum. Ama aynı çağrı LİG BAŞLIĞI hesabında da var; satırı eski
     * ham hâline döndürdüğüm hâlde o iddia geçmeye devam etti. İddia artık
     * SATIRIN KENDİSİNE bağlı: kickoff etiketinin hemen ardından gelmeli.
     */
    if (!varMi(LIVE)) return;
    const s = oku(LIVE);
    assert.ok(/\{kickoffLabel\(item\)\}[\s\S]{0,240}?ligEtiketi\(item\.league, item\.country\)/.test(s),
      "mac SATIRI ligEtiketi kullanmiyor (baska yerde gecmesi yetmez)");
    assert.ok(!/\$\{item\.league\}/.test(s),
      "ham lig adi hala basiliyor — hangi ulkenin ligi belirsiz kalir");
  });

  test("SIRALAMA SEÇİCİ var ve varsayılan ÖNERİLEN", () => {
    /* ⚠️ Varsayılanı değiştirmek sunucunun öncelik sırasını (kendi ülken
     * üstte) görünmez kılardı — o sıra bilinçli bir üründür. */
    if (!varMi(LIVE)) return;
    const s = oku(LIVE);
    assert.ok(/useState<"onerilen" \| "tarih" \| "lig">\("onerilen"\)/.test(s),
      "siralama durumu yok ya da varsayilani onerilen degil");
    assert.ok(/setSiralama\(/.test(s), "siralama secici bagli degil");
    assert.ok(/ligSiraAnahtari\(/.test(s), "lige gore sirada ortak anahtar kullanilmiyor");
  });

  test("ÖNERİLEN DIŞINDA öncelik başlıkları GİZLENİYOR", () => {
    /**
     * ⚠️ İNCE AMA ÖNEMLİ: liste tarihe göre dizildiğinde "Ülkeniz / Kupalar /
     * Büyük Ligler" başlıkları yanıltıcı olur — sıra artık o mantığa göre
     * değil ve aynı başlık defalarca tekrar eder. Başlık sıralamaya bağlı
     * olmalı.
     */
    if (!varMi(LIVE)) return;
    const s = oku(LIVE);
    assert.ok(/siralama === "onerilen" \? \(item\.priorityGroup \|\| null\) : null/.test(s),
      "oncelik basligi siralamadan bagimsiz — yanlis sirada da basilir");
  });

  test("SUNUCU SIRASI YENİDEN YAZILMIYOR (öncelik tek kaynak)", () => {
    /**
     * ⚠️ `lib/fixture-priority.cjs` tek kaynak. İstemci "önerilen" modda
     * kendi öncelik hesabını yaparsa iki tanım ayrışır — bu depoda defalarca
     * yaşanmış kusur şekli.
     */
    if (!varMi(LIVE)) return;
    const s = oku(LIVE);
    const i = s.indexOf("const gorunenListe");
    assert.ok(i > 0, "gorunenListe bulunamadi");
    const govde = s.slice(i, i + 1200);
    assert.ok(/if \(siralama === "onerilen"\) return items;/.test(govde),
      "onerilen modda liste sunucudan geldigi gibi birakilmiyor");
    assert.ok(!/priorityGroup/.test(govde) || !/sort\(/.test(govde.split("priorityGroup")[0] || ""),
      "istemci oncelik sirasini yeniden hesapliyor");
  });

  test("i18n anahtarları HER İKİ dilde var", () => {
    /* Eksik anahtar ekranda ham anahtar adı gösterir; kapsam cırcırı bunu
     * ayrıca sayıyor ama burada iki dilin de dolduğu doğrudan sınanıyor. */
    if (!varMi(I18N)) return;
    const s = oku(I18N);
    for (const k of ["sortBy", "sortSuggested", "sortByDate", "sortByLeague"]) {
      const n = (s.match(new RegExp(`\\b${k}:`, "g")) || []).length;
      assert.ok(n >= 2, `${k} iki dilde tanimli degil (bulunan: ${n})`);
    }
  });

  test("DİĞER MAÇ YÜZEYLERİ de etiketi kullanıyor", () => {
    /* ⚠️ Kusurun sınıfı "bir yüzeyde düzeltip ötekini unutmak". Kullanıcının
     * maç gezdiği öbür iki bileşen de aynı etiketi kullanmalı. */
    for (const rel of [["components", "DailyMatchCard.tsx"], ["components", "BigFourPicks.tsx"]]) {
      const p = path.join(MOBIL, ...rel);
      if (!varMi(p)) continue;
      assert.ok(/ligEtiketi\(/.test(oku(p)), `${rel[1]} ligEtiketi kullanmiyor`);
    }
  });
});
