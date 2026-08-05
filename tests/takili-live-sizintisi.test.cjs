"use strict";

/**
 * TAKILI LIVE SIZINTISI — beslemeden düşen maç sonsuza dek "CANLI" kalmasın.
 *
 * ⚠️ KUSUR: `services/livescore-sync.cjs` ana döngüsü
 *     const liveMatch = findLiveMatch(fixture, allLive);
 *     if (!liveMatch) continue;
 * diyordu — yani bir maç kaynağın canlı beslemesinden çıktığı anda BİR DAHA
 * ASLA ele alınmıyordu. Maç bitip kaynağın "bugün" sayfasından düşerse durum
 * dosyası sonsuza dek `status: "LIVE"` kalıyor. Güncelleme yok, hata yok, iz
 * yok — sessiz sınıf.
 *
 * ÖLÇÜLDÜ (üretim, 2026-08-02): 6 saatten eski **160** takılı LIVE durum
 * dosyası. Yaş dağılımı 6-24sa: 87 · 1-3gün: 21 · 3-7gün: 51 · 7gün+: 1.
 * Yani tarihî artık değil, AKTİF sızıntı — 1 Ağustos'ta 456 kayıt elle
 * kapatılmıştı ve sebep kapatılmadığı için geri geldi. En yaşlısı 360 saat
 * (15 gün) boyunca uygulamada "CANLI" görünüyordu.
 *
 * ⚠️ 16'SINDA ÖDÜL ZATEN DAĞITILMIŞTI: `match_results` kaydı `awardedAt`
 * damgalı ve `meta.status: "FT"`. Yani maç uzlaşmış, para ödenmiş, kullanıcı
 * ekranında hâlâ canlı görünüyordu.
 *
 * ⚠️ ÖLÇÜMÜ İKİ KEZ YANLIŞ ALAN ADIYLA YAPTIM, ikisi de bu dosyaya not:
 * önce `homeGoals`/`score` diye aradım ve "hiç kanıt yok" sonucuna vardım —
 * doğru alan `finalScore`. Bir örnek belgenin anahtarlarına bakmadan alan
 * adı varsayılmaz (aynı hatayı `favTeam`/`mainTeam` ile de yapmıştım).
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/* ⚠️ DATA_DIR modül YÜKLENİRKEN okunuyor — require'dan ÖNCE kurulmalı,
 * yoksa test gerçek data/live dizinine yazar. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-takili-"));
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";
fs.mkdirSync(path.join(TMP, "live"), { recursive: true });

/* Kanıt kaynağını denetim altına al: gerçek Mongo'ya gitmesin. */
const mrYol = require.resolve(path.join(KOK, "lib", "match-results.cjs"));
const _snapshots = new Map();
require.cache[mrYol] = { id: mrYol, filename: mrYol, loaded: true, exports: {
  getSnapshot: async (fid) => _snapshots.get(String(fid)) || null,
  settledFixtureIds: async () => new Set(),
  listSnapshots: async () => [],
  upsertSnapshot: async () => ({}),
  claimAward: async () => true,
  FILE: "", COLL: "match_results", FILE_MIRROR: false,
}};

const mongoYol = require.resolve(path.join(KOK, "lib", "mongo.cjs"));
require.cache[mongoYol] = { id: mongoYol, filename: mongoYol, loaded: true, exports: {
  getDb: async () => ({}),   // truthy: kanıt yolu denensin
}};

const Sync = require("../services/livescore-sync.cjs");
const { takiliLiveUzlastir, MAX_LIVE_SAAT } = Sync;

const SAAT = 3600 * 1000;
const simdiISO = () => new Date().toISOString();
const durumYolu = (fid) => path.join(TMP, "live", `${fid}.json`);
const durumYaz = (fid, st) => fs.writeFileSync(durumYolu(fid), JSON.stringify(st));
const durumOku = (fid) => JSON.parse(fs.readFileSync(durumYolu(fid), "utf8"));

const mac = (fid, saatOnce) => ({
  fixtureId: fid,
  home: "A", away: "B",
  kickoffISO: new Date(Date.now() - saatOnce * SAAT).toISOString(),
});

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("fonksiyon dışa açık ve eşik makul", () => {
    assert.equal(typeof takiliLiveUzlastir, "function", "sizinti kapisi disa acilmamis");
    assert.ok(MAX_LIVE_SAAT >= 3, `esik ${MAX_LIVE_SAAT} saat — hala oynayan mac bitti sayilabilir`);
    assert.ok(MAX_LIVE_SAAT <= 12, `esik ${MAX_LIVE_SAAT} saat — sizinti cok gec kapaniyor`);
  });

  test("test gerçek data/ dizinine yazmıyor", () => {
    assert.ok(TMP.includes("skorlig-takili"), "gecici dizin kurulmamis");
    assert.notEqual(path.resolve(TMP), path.resolve(KOK, "data"));
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("beslemeden düşen maç kapanıyor", () => {
  test("KANIT VAR → FT ve gerçek skor yazılıyor", async () => {
    _snapshots.set("K1", { finalScore: { home: 2, away: 3 } });
    durumYaz("K1", { fixtureId: "K1", status: "LIVE", isLive: true, score: { home: 1, away: 0 }, updatedAt: simdiISO() });

    const r = await takiliLiveUzlastir([mac("K1", 8)], new Set(), simdiISO(), []);
    assert.equal(r.kanitli, 1, "kanitli kapanma sayilmadi");

    const st = durumOku("K1");
    assert.equal(st.status, "FT");
    assert.equal(st.isLive, false);
    assert.deepEqual(st.score, { home: 2, away: 3 }, "gercek sonuc yazilmadi");
    assert.ok(st.ilkFtAt, "FT damgasi yok");
  });

  test("KANIT YOK → OVERDUE_NO_RESULT, SKOR UYDURULMUYOR", async () => {
    /**
     * ⚠️ EN ÖNEMLİ DEĞİŞMEZ. Bu dosyanın kendi kuralı: güvenilmez skorla FT
     * yazmak `claimAward` mührü yüzünden KALICI yanlış ödeme demek. Kanıtsız
     * kapanışta skora dokunulmamalı ve uzlaşma tetiklenmemeli.
     */
    durumYaz("K2", { fixtureId: "K2", status: "LIVE", isLive: true, score: { home: 1, away: 0 }, updatedAt: simdiISO() });

    const kuyruk = [];
    const r = await takiliLiveUzlastir([mac("K2", 8)], new Set(), simdiISO(), kuyruk);
    assert.equal(r.kanitsiz, 1);

    const st = durumOku("K2");
    assert.equal(st.status, "OVERDUE_NO_RESULT", "yanlis CANLI iddiasi kalkmadi");
    assert.equal(st.isLive, false);
    assert.deepEqual(st.score, { home: 1, away: 0 }, "skor DEGISTIRILDI — uydurma sonuc riski");
    assert.equal(kuyruk.length, 0, "kanitsiz mac uzlasmaya gonderildi — yanlis odeme riski");
  });
});

/* ── Yanlış pozitif olmasın ──────────────────────────────────────────────── */

describe("dokunulmaması gerekenlere dokunmuyor", () => {
  test("BESLEMEDE görülen maça dokunulmuyor", async () => {
    durumYaz("D1", { fixtureId: "D1", status: "LIVE", isLive: true, score: { home: 0, away: 0 }, updatedAt: simdiISO() });
    const r = await takiliLiveUzlastir([mac("D1", 8)], new Set(["D1"]), simdiISO(), []);
    assert.equal(r.kapanan, 0);
    assert.equal(durumOku("D1").status, "LIVE", "hala oynayan mac kapatildi");
  });

  test("kickoff YENİ ise dokunulmuyor (maç gerçekten oynuyor olabilir)", async () => {
    /* Beslemede geçici bir kesinti olabilir; 1 saatlik maçı bitti saymak
     * kullanıcıya yanlış bilgi verir. Bu yönde yanılmak daha pahalı. */
    durumYaz("D2", { fixtureId: "D2", status: "LIVE", isLive: true, score: { home: 1, away: 1 }, updatedAt: simdiISO() });
    const r = await takiliLiveUzlastir([mac("D2", 1)], new Set(), simdiISO(), []);
    assert.equal(r.kapanan, 0, `${MAX_LIVE_SAAT} saat esigi uygulanmiyor`);
    assert.equal(durumOku("D2").status, "LIVE");
  });

  test("zaten FT olan kayda dokunulmuyor", async () => {
    durumYaz("D3", { fixtureId: "D3", status: "FT", isLive: false, score: { home: 2, away: 2 }, updatedAt: simdiISO(), ilkFtAt: simdiISO() });
    const r = await takiliLiveUzlastir([mac("D3", 30)], new Set(), simdiISO(), []);
    assert.equal(r.kapanan, 0);
    assert.equal(durumOku("D3").status, "FT");
  });

  test("durum dosyası HİÇ yoksa dosya YARATILMIYOR", async () => {
    /* Hiç canlı görülmemiş maç için durum dosyası uydurmak, veri
     * yaratmaktır — `effectiveStatusForFixture` zaten OVERDUE_NO_STATE
     * dönüyor. */
    const r = await takiliLiveUzlastir([mac("YOK-1", 40)], new Set(), simdiISO(), []);
    assert.equal(r.kapanan, 0);
    assert.equal(fs.existsSync(durumYolu("YOK-1")), false, "olmayan mac icin durum dosyasi yaratildi");
  });

  test("kickoff okunamıyorsa dokunulmuyor (fail-closed)", async () => {
    durumYaz("D4", { fixtureId: "D4", status: "LIVE", isLive: true, score: { home: 0, away: 0 }, updatedAt: simdiISO() });
    const r = await takiliLiveUzlastir([{ fixtureId: "D4", kickoffISO: "bozuk" }], new Set(), simdiISO(), []);
    assert.equal(r.kapanan, 0, "saati bilinmeyen mac kapatildi — yas dogrulanamaz");
    assert.equal(durumOku("D4").status, "LIVE");
  });
});

/* ── Yapışkan değil ──────────────────────────────────────────────────────── */

describe("kendini onarıyor", () => {
  test("maç beslemede yeniden görünürse kapanış YAPIŞKAN değil", async () => {
    /**
     * Kaynak kesintisi geçiciyse maç yeniden beslemeye girer ve ana döngü
     * durumu normal şekilde üzerine yazar. Bu testin işi, kapanışın ayrı
     * bir "kilit" alanı bırakıp normal akışı engellemediğini doğrulamak.
     */
    durumYaz("Y1", { fixtureId: "Y1", status: "LIVE", isLive: true, score: { home: 0, away: 0 }, updatedAt: simdiISO() });
    await takiliLiveUzlastir([mac("Y1", 8)], new Set(), simdiISO(), []);
    const kapali = durumOku("Y1");
    assert.equal(kapali.status, "OVERDUE_NO_RESULT");

    const kilitAlani = Object.keys(kapali).find((k) => /kilit|locked|final|donmus/i.test(k));
    assert.equal(kilitAlani, undefined, `kapanis kilit alani birakiyor (${kilitAlani}) — besleme donerse duzelemez`);
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

const kaynak = fs.readFileSync(path.join(KOK, "services", "livescore-sync.cjs"), "utf8")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

test("NÖBETÇİ: sync() uzlaştırmayı GERÇEKTEN çağırıyor", () => {
  /**
   * ⚠️ Davranış testleri saf fonksiyonu çağırıyor — mantığı kilitler,
   * KULLANILDIĞINI değil. Bu oturumda aynı boşluk iki kez "yeşil ama ölü"
   * test üretti.
   */
  assert.ok(/await takiliLiveUzlastir\(fixtureList, gorulen, nowISO, settleQueue\)/.test(kaynak),
    "sizinti kapisi sync() icinden cagrilmiyor");
  assert.ok(/gorulen\.add\(String\(fid\)\)/.test(kaynak),
    "beslemede gorulenler izlenmiyor — kapi hangi macin dustugunu bilemez");
});

test("NÖBETÇİ: uzlaştırma hatası ana senkronu düşürmüyor", () => {
  /* ⚠️ `indexOf("takiliLiveUzlastir(fixtureList")` TANIMI buluyor, çağrıyı
   * değil — ikisi aynı parametre adlarını taşıyor. İlk yazımımda bunu
   * kaçırdım ve nöbetçi kod doğruyken kırıldı. (Aynı tuzağa
   * `saglayiciEksikleriniBildir` sayımında da düşmüştüm.) */
  const i = kaynak.indexOf("await takiliLiveUzlastir(");
  assert.ok(i > 0, "cagri bulunamadi");
  const cevre = kaynak.slice(Math.max(0, i - 200), i + 200);
  assert.ok(/try \{/.test(cevre) && /catch/.test(cevre),
    "uzlastirma hatasi tum senkron turunu dusurebilir");
});

test("NÖBETÇİ: mobilde etiket var — ham durum metni gösterilmiyor", () => {
  /**
   * `statusLabel` bilinmeyen durumu OLDUĞU GİBİ döndürüyor; etiket
   * eklenmezse kullanıcı "OVERDUE_NO_RESULT" ham metnini görürdü.
   */
  const mob = require("./_mobil-dizin.cjs").mobilYol("app", "(tabs)", "live.tsx");
  if (!fs.existsSync(mob)) return; // mobil depo yoksa atla
  const src = fs.readFileSync(mob, "utf8");
  assert.ok(/OVERDUE_NO_RESULT/.test(src), "mobilde yeni durum icin etiket yok");
  const i18n = require("./_mobil-dizin.cjs").mobilYol("lib", "i18n.ts");
  if (fs.existsSync(i18n)) {
    const t = fs.readFileSync(i18n, "utf8");
    const dil = (t.match(/notStarted:/g) || []).length;
    const yeni = (t.match(/noResult:/g) || []).length;
    assert.equal(yeni, dil, `${dil} dil blogundan ${yeni}'sinde ceviri var — eksik dilde ham metin gorunur`);
  }
});
