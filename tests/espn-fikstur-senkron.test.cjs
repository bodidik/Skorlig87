"use strict";

/**
 * ESPN FİKSTÜR SENKRONU.
 *
 * ⚠️ NEDEN VAR (2026-08-06): Türkiye'nin fikstürü hiçbir kaynaktan ileri
 * tarihli gelmiyordu ve haftalık kupon Türk kullanıcı için HİÇ kurulamıyordu.
 * Ölçüldü (gerçek `data/fixtures.json`, 2253 kayıt):
 *
 *     Süper Lig maçı                       : 0
 *     kupon kurulabilen hafta (8 maç şart) : W32-W35 hepsi 0/8
 *
 * ESPN kaynağı bağlandıktan sonra (gerçek API, ölçüldü):
 *
 *     W33 8/8 · W34 8/8 · W35 8/8   → kupon KURULUR
 *
 * ⚠️ AĞA ÇIKILMIYOR: testler sahte `fetchFn` ile çalışır. Gerçek API'ye
 * bağlanan test, ESPN kesintisinde ya da sezon arasında kırmızı yanar ve
 * kimse sebebini anlamaz — sınanan şey bizim dönüşümümüz, ESPN'in çalışması
 * değil.
 */

const test = require("node:test");
const { describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-espn-"));
process.env.SKORLIG_DATA_DIR = TMP;

const S = require("../services/espn-fixture-sync.cjs");
const { ikizMi, ikizleriAyikla } = require("../lib/fikstur-ikiz.cjs");

const TUR = S.LIGLER.find((l) => l.key === "tur.1");

/** ESPN olay nesnesi üretir (gerçek payload şekliyle). */
function olay({ home, away, date, state = "pre" }) {
  return {
    date,
    status: { type: { state, name: state === "pre" ? "STATUS_SCHEDULED" : "STATUS_FINAL" } },
    competitions: [{
      competitors: [
        { homeAway: "home", team: { displayName: home } },
        { homeAway: "away", team: { displayName: away } },
      ],
    }],
  };
}

const YARIN = () => new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 19) + "Z";

/* ── Dönüşüm ─────────────────────────────────────────────────────────── */

describe("ESPN kaydı → fikstür", () => {
  test("takım adları KANONİKLEŞİYOR (aksansız ESPN adı düzeliyor)", () => {
    /* ⚠️ ASIL DEĞİŞMEZ. Ham bırakmak iki zarar verir: ekranda "Besiktas"
     * görünür ve Maçkolik aynı maçı "Beşiktaş" yazınca İKİZ fikstür olur. */
    const { fixture } = S._normalizeWithReason(
      olay({ home: "Besiktas", away: "Genclerbirligi", date: YARIN() }), TUR
    );
    assert.ok(fixture, "kayit uretilmedi");
    assert.equal(fixture.home, "Beşiktaş");
    assert.equal(fixture.away, "Gençlerbirliği");
  });

  test("önekli varyantlar da kanonikleşiyor", () => {
    const { fixture } = S._normalizeWithReason(
      olay({ home: "Istanbul Basaksehir", away: "Caykur Rizespor", date: YARIN() }), TUR
    );
    assert.equal(fixture.home, "Başakşehir");
    assert.equal(fixture.away, "Rizespor");
  });

  test("country ve league KANONİK — aşağı akış süzgeçleri buna bakıyor", () => {
    /* `routes/tr-league.cjs` isSuperLigTR country="türkiye" + league="süper lig"
     * arıyor; `routes/kupon.cjs` sameCountry ile eşliyor. ESPN'in kendi adı
     * ("Turkish Super Lig") ikisini de tutturmazdı. */
    const { fixture } = S._normalizeWithReason(
      olay({ home: "Galatasaray", away: "Fenerbahce", date: YARIN() }), TUR
    );
    assert.equal(fixture.country, "Türkiye");
    assert.equal(fixture.league, "Süper Lig");
    assert.equal(fixture.source, "ESPN");
  });

  test("kanonikleşmeyen ad ELENMİYOR, ham hâliyle geçiyor", () => {
    /* Tek bir tanınmayan takım yüzünden maçı atmak, o haftanın kuponunu
     * kuramamak demek (kupon 8 maçın TAMAMINI ister). */
    const { fixture } = S._normalizeWithReason(
      olay({ home: "Bilinmeyen Kulup FK", away: "Galatasaray", date: YARIN() }), TUR
    );
    assert.ok(fixture, "taninmayan takim maci ELENDI — kupon kurulamaz hale gelir");
    assert.equal(fixture.home, "Bilinmeyen Kulup FK");
  });

  test("bitmiş ve geçmiş maç kayıt AÇMIYOR", () => {
    const bitmis = S._normalizeWithReason(
      olay({ home: "Galatasaray", away: "Fenerbahce", date: YARIN(), state: "post" }), TUR
    );
    assert.equal(bitmis.fixture, null);
    assert.equal(bitmis.reason, "bitmis");

    const gecmis = S._normalizeWithReason(
      olay({ home: "Galatasaray", away: "Fenerbahce",
             date: new Date(Date.now() - 5 * 864e5).toISOString() }), TUR
    );
    assert.equal(gecmis.fixture, null);
    assert.equal(gecmis.reason, "gecmis");
  });

  test("eksik takım reddediliyor", () => {
    const r = S._normalizeWithReason({ date: YARIN(), competitions: [{ competitors: [] }] }, TUR);
    assert.equal(r.fixture, null);
    assert.equal(r.reason, "takim_eksik");
  });

  test("durum çevirisi", () => {
    assert.equal(S._durumCevir({ status: { type: { state: "pre" } } }), "NS");
    assert.equal(S._durumCevir({ status: { type: { state: "in" } } }), "LIVE");
    assert.equal(S._durumCevir({ status: { type: { state: "post" } } }), "FT");
  });
});

/* ── Kimlik şeması ───────────────────────────────────────────────────── */

describe("fixtureId şeması", () => {
  test("MK/admin ile AYNI slug kuralı", () => {
    // Ayri sema yazmak ayni maca iki farkli kimlik uretir.
    assert.equal(S._slugPart("Beşiktaş"), "BESIKT");
    assert.equal(S._slugPart("Galatasaray"), "GALATA");
    // Aksansiz yazim AYNI slug'a inmeli — kanoniklestirme sonrasi zaten ayni.
    assert.equal(S._slugPart("Besiktas"), S._slugPart("Beşiktaş"));
  });

  test("aynı maç HER ZAMAN aynı kimliği üretiyor", () => {
    const tarih = YARIN();
    const a = S._normalizeWithReason(olay({ home: "Besiktas", away: "Eyupspor", date: tarih }), TUR);
    const b = S._normalizeWithReason(olay({ home: "Beşiktaş", away: "Eyüpspor", date: tarih }), TUR);
    assert.equal(a.fixture.fixtureId, b.fixture.fixtureId,
      "ayni mac iki farkli kimlik uretti — ikiz fikstur olusur");
  });
});

/* ── İkiz koruması ───────────────────────────────────────────────────── */

describe("Maçkolik ile ikiz üretmiyor", () => {
  test("ESPN (UTC) ve MK (+03:00) kayıtları İKİZ olarak tanınıyor", () => {
    /**
     * ⚠️ BU TESTİN SEBEBİ GERÇEK BİR KUSUR. `ikizMi` başlama anını HAM STRING
     * olarak kesiyordu (`kickoffISO.slice(0,16)`). ESPN "…T15:30Z", Maçkolik
     * "…T18:30:00+03:00" yazıyor — AYNI AN, farklı string:
     *
     *     "2026-08-16T15:30" !== "2026-08-16T18:30"  → ikiz KAÇIRILIYORDU
     *
     * Kanıtlandı: düzeltmeden önce `ikizMi` false dönüyordu. Canlıda henüz
     * çakışma çıkmamasının sebebi savunmanın çalışması değil, FDO ile MK'nın
     * farklı ülkeleri kapsaması — yani şans. ESPN Türkiye'yi yazınca MK ile
     * AYNI maçlar üst üste gelecekti.
     */
    const espn = {
      fixtureId: "ESPN-BESIKT-2026-08-16-EYUPSP",
      home: "Beşiktaş", away: "Eyüpspor", country: "Türkiye",
      kickoffISO: "2026-08-16T15:30Z",
    };
    const mk = {
      fixtureId: "MK-BESIKT-2026-08-16-EYUPSP",
      home: "Beşiktaş", away: "Eyüpspor", country: "Türkiye",
      kickoffISO: "2026-08-16T18:30:00+03:00",
    };
    assert.equal(Date.parse(espn.kickoffISO), Date.parse(mk.kickoffISO), "test kurulumu bozuk");
    assert.equal(ikizMi(espn, mk), true,
      "capraz-bicim ikiz KACIRILDI — ayni mac iki kayit olarak kalir");
  });

  test("farklı saatteki maçlar ikiz SAYILMIYOR", () => {
    const a = { home: "Beşiktaş", away: "Eyüpspor", country: "Türkiye", kickoffISO: "2026-08-16T15:30Z" };
    const b = { home: "Beşiktaş", away: "Eyüpspor", country: "Türkiye", kickoffISO: "2026-08-16T19:30:00+03:00" };
    assert.equal(ikizMi(a, b), false);
  });

  test("UÇ: boru hattı da ikizi ayıklıyor (yalnız ikizMi yetmez)", () => {
    /**
     * ⚠️ BU TESTİN SEBEBİ: `ikizMi` düzeltildikten SONRA kusur AYNEN sürdü.
     * `ikizleriAyikla` önce kova anahtarı üretiyor ve o anahtar HAM STRING
     * kesiyordu (`kickoffISO.slice(0,16)`) — farklı yazımdaki iki kayıt AYRI
     * KOVAYA düşüyor ve `ikizMi` onlar için HİÇ ÇAĞRILMIYOR.
     *
     * ÖLÇÜLDÜ (düzeltmeden önce):
     *     ikizMi(espn, mk)              → true
     *     ikizleriAyikla([espn, mk])    → 2 kayıt, 0 düşen   ← KAÇIRIYOR
     *
     * Ders: karşılaştırma fonksiyonunu sınamak yetmez, ÖN ELEME de aynı
     * eşitlik tanımını kullanmalı. Bu test boru hattının ucunu dövüyor.
     */
    const espn = {
      fixtureId: "ESPN-BESIKT-2026-08-16-EYUPSP",
      home: "Beşiktaş", away: "Eyüpspor", country: "Türkiye",
      kickoffISO: "2026-08-16T15:30Z",
    };
    const mk = {
      fixtureId: "MK-BESIKT-2026-08-16-EYUPSP",
      home: "Beşiktaş", away: "Eyüpspor", country: "Türkiye",
      kickoffISO: "2026-08-16T18:30:00+03:00",
    };

    const r = ikizleriAyikla([espn, mk], []);
    assert.equal(r.list.length, 1,
      `boru hatti capraz-bicim ikizi KACIRDI: ${r.list.length} kayit kaldi`);
    assert.equal(r.dusenler.length, 1);
  });

  test("UÇ: depodaki kayıt kazanıyor (tahminler öksüz kalmasın)", () => {
    const espn = {
      fixtureId: "ESPN-BESIKT-2026-08-16-EYUPSP",
      home: "Beşiktaş", away: "Eyüpspor", country: "Türkiye",
      kickoffISO: "2026-08-16T15:30Z",
    };
    const mk = {
      fixtureId: "MK-BESIKT-2026-08-16-EYUPSP",
      home: "Beşiktaş", away: "Eyüpspor", country: "Türkiye",
      kickoffISO: "2026-08-16T18:30:00+03:00",
    };
    // MK zaten depoda: kullanicilar ona tahmin yapmis olabilir, O kalmali.
    const r = ikizleriAyikla([espn, mk], [mk.fixtureId]);
    assert.deepStrictEqual(r.list.map((x) => x.fixtureId), [mk.fixtureId],
      "depodaki kayit dusuruldu — mevcut tahminler oksuz kalir");
  });

  test("UÇ: aynı anda oynanan FARKLI maçlar birleştirilmiyor", () => {
    /* Ikizi bulmak ugruna gercek bir maci yok etmek, kopyadan daha kotu. */
    const a = {
      fixtureId: "ESPN-BESIKT-2026-08-16-EYUPSP",
      home: "Beşiktaş", away: "Eyüpspor", country: "Türkiye",
      kickoffISO: "2026-08-16T15:30Z",
    };
    const b = {
      fixtureId: "ESPN-GALATA-2026-08-16-FENERB",
      home: "Galatasaray", away: "Fenerbahçe", country: "Türkiye",
      kickoffISO: "2026-08-16T18:30:00+03:00",
    };
    const r = ikizleriAyikla([a, b], []);
    assert.equal(r.list.length, 2, "farkli iki mac birlestirildi — gercek mac yok edildi");
  });
});

/* ── Tur akışı ───────────────────────────────────────────────────────── */

describe("syncOnce", () => {
  test("boş sonuç YAZMIYOR — mevcut kayıtları silmez", async () => {
    /* ⚠️ `merge` kendi kaynağının GELECEK kayıtlarını silme yetkisine sahip.
     * Geçici ağ hatasından sonra gelen boş tur, toplanmış tüm ESPN
     * fikstürlerini silen "başarılı" bir yazma gibi görünürdü. */
    const sahte = async () => ({ ok: true, json: async () => ({ events: [] }) });
    const r = await S.syncOnce({ dryRun: true, fetchFn: sahte });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "MAC_YOK");
  });

  test("HTTP hatası tur'u düşürmüyor, raporluyor", async () => {
    const sahte = async () => ({ ok: false, status: 503 });
    const r = await S.syncOnce({ dryRun: true, fetchFn: sahte });
    assert.equal(r.ok, false);
    assert.ok(r.ligHata["tur.1"], "lig hatasi raporlanmadi");
  });

  test("geçerli maçlar toplanıyor ve tekilleşiyor", async () => {
    const t = YARIN();
    const sahte = async () => ({
      ok: true,
      json: async () => ({ events: [
        olay({ home: "Galatasaray", away: "Fenerbahce", date: t }),
        olay({ home: "Besiktas", away: "Trabzonspor", date: t }),
        // Ayni mac ikinci kez — tekillesmeli
        olay({ home: "Galatasaray", away: "Fenerbahce", date: t }),
      ] }),
    });
    const r = await S.syncOnce({ dryRun: true, fetchFn: sahte });
    assert.equal(r.ok, true);
    assert.equal(r.fetched, 2, "mukerrer kayit tekillesmedi");
  });
});

/* ── Nöbetçiler ──────────────────────────────────────────────────────── */

describe("nöbetçi", () => {
  test("server.cjs ESPN senkronunu bağlıyor", () => {
    const src = fs.readFileSync(path.join(KOK, "server.cjs"), "utf8");
    assert.ok(/espn-fixture-sync/.test(src),
      "ESPN senkronu server.cjs'e bagli DEGIL — servis hic calismaz");
    assert.ok(/SKORLIG_ESPN_SYNC/.test(src), "kapatma bayragi yok");
  });

  test("merge KENDİ kaynak etiketiyle çağrılıyor", () => {
    /* ⚠️ `merge` ucuncu argumani almazsa "FDO"ya duser (bkz. fixture-sync
     * syncOnce) ve bu tur, FDO'nun gelecek kayitlarini SILERDI. */
    const src = fs.readFileSync(path.join(KOK, "services", "espn-fixture-sync.cjs"), "utf8");
    assert.ok(/merge\(existing,\s*items,\s*SOURCE\)/.test(src),
      "merge ownedSource olmadan cagriliyor — baska kaynagin kayitlari silinir");
  });

  test("varsayılan yalnızca Türkiye açık (kademeli açılış)", () => {
    const acik = S.LIGLER.filter((l) => l.aktif).map((l) => l.key);
    assert.deepStrictEqual(acik, ["tur.1"],
      `varsayilan acik ligler beklenenden farkli: ${acik.join(", ")}`);
  });
});
