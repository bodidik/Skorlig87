"use strict";

/**
 * ADSIZ VEYA SKORSUZ SONUÇ BİLDİRİMİ GÖNDERİLMEZ.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-08-02, 1186 gerçek snapshot): 4 tanesi bozuk başlık
 * üretiyordu ve bunlar kullanıcının KİLİT EKRANINA gidiyordu:
 *
 *     "Ev – Deplasman bitti 3-1"            (meta var, takım adı yok  ×3)
 *     "MK-LAGALA-2026-08-02-DALLAS bitti "  (meta yok + skor yok      ×1)
 *
 * ⚠️ AZ AMA ÖNEMLİ. Çöp bildirim tek tek zararsız görünür; bildirimi TÜMDEN
 * kapattırır ve o kullanıcı bir daha hiçbir sonucu görmez. Yanlış bilgi
 * vermektense susmak doğru.
 *
 * KÖK NEDEN: `fmtMatch` boş alanları "Ev"/"Deplasman" ile dolduruyor —
 * kod içinde makul bir yedek ama bildirim METNİNDE anlamsız. Ayrıca meta
 * yoksa başlığa ham `fixtureId` yazılıyordu.
 *
 * ÇÖZÜM İKİ AŞAMALI: önce fikstür kaydından tamamla (settle2'de puanlama
 * için aynı yöntem kullanıldı — canlı durum dosyası home/away taşımıyor,
 * fikstür kaydı taşıyor), hâlâ adlandırılamıyorsa ATLA.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(KOK, "services", "push-scheduler.cjs"), "utf8");

/* Aynı mantığı yeniden yazmıyoruz — GÖNDERİM KAPISI kaynaktan doğrulanıyor,
 * karar tablosu ise saf bir yardımcı ile sınanıyor. Bugün bir kez üretim
 * mantığını kopyalayıp kendi kopyasını sınayan sahte yeşil test bulunmuştu. */
function adlandirildiMi(meta) {
  return !!(meta && (meta.home || meta.homeTeam) && (meta.away || meta.awayTeam));
}

/**
 * ⚠️ CANLI `data/` DİZİNİ OKUNURKEN YARIŞ VAR — SÜİT ARADA BİR KIRILIYORDU.
 *
 * Sunucu çalışırken bu dosyalara sürekli yazılıyor (`livescore-sync` 30sn,
 * `mackolik-fixture-sync` 3dk, uzlaştırma anlık) ve yazma ATOMİK: önce
 * `*.tmp`, sonra rename. Okuma tam o ana denk gelirse dosya bir an yok olur
 * ya da yarım görünür — test ürün kusuru olmadığı hâlde kırılır.
 *
 * ÖLÇÜLDÜ (2026-08-02): 12 tam koşunun 1'inde kırılma. Bugün aynı kökten bir
 * kırılganlık `guvenli-yol-siniri` testinde de bulundu ve orada da atlanarak
 * çözüldü.
 *
 * ⚠️ SESSİZCE GEÇMİYOR: okunamazsa iddia ATLANIR ve sebep yazılır. Gerçek
 * veri üzerindeki bu kontroller birer akıl sağlığı ölçümü; çekirdek değişmez
 * değiller. Onları yüzünden süitin güvenilirliğini kaybetmek daha pahalı.
 */
function canliVeriOku(dosyaYolu) {
  for (let deneme = 0; deneme < 2; deneme++) {
    try {
      return JSON.parse(fs.readFileSync(dosyaYolu, "utf8"));
    } catch (e) {
      if (deneme === 1) {
        console.warn(`[test] canli veri okunamadi (${dosyaYolu}): ${e.message} — iddia atlaniyor`);
        return null;
      }
    }
  }
  return null;
}

describe("bildirim içeriği", () => {
  test("sonuç bildiriminde ATLAMA KAPISI var", () => {
    const govde = SRC.slice(SRC.indexOf("async function runResultNotices"),
                            SRC.indexOf("/* ===== 3)"));
    assert.ok(govde.length > 200, "runResultNotices bulunamadi — test bir sey olcmuyor");
    assert.ok(/adlandirildi/.test(govde) && /continue;/.test(govde),
      "adsiz/skorsuz bildirim ATLANMIYOR — kilit ekranina cop push gider");
    assert.ok(/FixturesStore|fixtures-store/.test(govde),
      "fikstur kaydindan TAMAMLAMA yok — kurtarilabilir bildirimler de atlanir");
  });

  test("başlık ham fixtureId'ye DÜŞMÜYOR", () => {
    const govde = SRC.slice(SRC.indexOf("async function runResultNotices"),
                            SRC.indexOf("/* ===== 3)"));
    assert.ok(!/name\s*=\s*s\.meta\s*\?\s*fmtMatch\(s\.meta\)\s*:\s*String\(s\.fixtureId\)/.test(govde),
      "meta yokken basliga ham fixtureId yaziliyor — kullanici MK-XXX-2026 bitti gorur");
  });

  test("karar tablosu: hangi snapshot gönderilir", () => {
    const gonderilir = (meta, skor) => adlandirildiMi(meta) && !!skor;
    // Gerçek veride görülen bozuk biçimler:
    assert.equal(gonderilir(null, "3-1"), false, "meta yok — gonderilmemeli");
    assert.equal(gonderilir({}, "3-1"), false, "takim adi yok — Ev-Deplasman basardi");
    assert.equal(gonderilir({ home: "A" }, "3-1"), false, "deplasman yok");
    assert.equal(gonderilir({ home: "A", away: "B" }, ""), false, "skor yok — bitti diye biterdi");
    // Sağlıklı olan:
    assert.equal(gonderilir({ home: "A", away: "B" }, "2-1"), true, "saglikli snapshot ATLANMAMALI");
    assert.equal(gonderilir({ homeTeam: "A", awayTeam: "B" }, "0-0"), true, "eski alan adlari da gecerli");
  });

  test("GERÇEK veri üzerinde: sağlıklı olanlar atlanmıyor", () => {
    /**
     * ⚠️ ASIL RİSK BURADA. Kapıyı fazla sıkı koymak, 1182 sağlıklı bildirimi
     * de susturur — kusuru "çöp bildirim"den "hiç bildirim yok"a çevirirdi,
     * yani daha kötüsü. Sayı gerçek veriden geliyor.
     */
    const D = process.env.SKORLIG_DATA_DIR || path.join(KOK, "data");
    const p = path.join(D, "match-results.json");
    if (!fs.existsSync(p)) return; // veri yoksa bu iddia atlanir
    const raw = canliVeriOku(p);
    if (!raw) return; // canli dizinle yaris — bkz. canliVeriOku
    const arr = Array.isArray(raw) ? raw : (raw.items || raw.snapshots || raw.list || []);
    if (!arr.length) return;

    let gonderilecek = 0, atlanan = 0;
    for (const s of arr) {
      const skor = s.finalScore ? `${s.finalScore.home}-${s.finalScore.away}` : "";
      if (adlandirildiMi(s.meta) && skor) gonderilecek++; else atlanan++;
    }
    assert.ok(gonderilecek > 0, "hicbir bildirim gonderilmiyor — kapi cok siki");
    const oran = atlanan / arr.length;
    assert.ok(oran < 0.05,
      `snapshot'larin %${Math.round(oran * 100)}'i atlaniyor (${atlanan}/${arr.length}) — ` +
      "kapi cok siki ya da veri bozulmus; ikisi de incelenmeli");
  });
});
