"use strict";

/**
 * GİRİŞ ÜCRETLİ TURNUVALAR.
 *
 * ⚠️ 2026-07-30'da bulunan PARA YARATMA açığı: `create` ve `join` havuzu
 * büyütüyordu ama giriş ücretini KİMSEDEN TAHSİL ETMİYORDU. Dosyada tek bir
 * `spendLc` çağrısı yoktu; `entryLC` yalnızca okunuyor, sınırlanıyor ve
 * `t.pool`'a ekleniyordu.
 *
 * Havuz karşılıksız değildi — settle2 onu GERÇEK LC olarak dağıtıyor
 * (routes/settle2.cjs, `lc_wallet_users` üzerinde `$inc: {balance}`).
 *
 * Ölçüldü: entryLC=100 ile 1 kurucu + 7 katılımcı → havuz 800 LC, hiçbir
 * bakiye değişmeden. 8+ katılımcı ödeme tablosu (50/25/15/10) havuzun
 * %100'ünü dağıtır, yani 800 LC yoktan yaratılırdı. Günlük LC hakkı 3-7 LC;
 * yani tek turnuva 100+ günlük gelire denk ve tekrarlanabilirdi.
 *
 * Artık ücret turnuvaya YAZILMADAN ÖNCE tahsil ediliyor; yazma başarısız
 * olursa iade ediliyor (aşağıdaki notlara bak).
 */

const SocialStore = require("../lib/social-store.cjs");
const path = require("path");
const { guvenliYol } = require("../lib/guvenli-dosya.cjs");
const fsp = require("fs").promises;
// Maç kilidi için: durum dosyası Render'da kalıcı değil, depo yetkili kaynak.
const FixturesStore = require("../lib/fixtures-store.cjs");
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const LIVE_DIR = path.join(DATA_DIR, "live");
const { spendLc, creditLc } = require("../lib/wallet-credit.cjs");

/** Rotalar db'yi geçmiyorsa depoların yaptığı gibi kendimiz çözelim. */
async function dbAl(db) {
  if (db) return db;
  try {
    const { getDb } = require("../lib/mongo.cjs");
    return await getDb();
  } catch {
    return null;
  }
}

/**
 * Giriş ücretini tahsil eder. Bakiye yetmezse THROW eder — çağıran turnuvaya
 * hiçbir şey yazmamalı.
 *
 * ⚠️ `spendLc` koşulu sorgunun içinde tutuyor (`balance: {$gte: tutar}`),
 * yani okunan bir değere dayanmıyor ve bakiyeyi eksiye düşüremez.
 */
async function ucretTahsilEt(db, userId, tutar) {
  const conn = await dbAl(db);
  if (!conn) {
    // Cüzdan yoksa ücret alınamaz. Bedava katılım = para yaratmak, o yüzden
    // sessizce geçmiyoruz.
    const e = new Error("WALLET_UNAVAILABLE");
    throw e;
  }
  const r = await spendLc(conn, userId, tutar, "tournament_entry");
  if (!r?.ok) {
    const e = new Error(r?.reason === "INSUFFICIENT" ? "INSUFFICIENT_LC" : "ENTRY_CHARGE_FAILED");
    e.balance = r?.lc ?? null;
    throw e;
  }
  return conn;
}

/**
 * Turnuvaya yazma başarısız olursa ücreti geri ver.
 *
 * ⚠️ BURADAKİ SAVUNMA ETKİSİZDİ — YANLIŞ BAŞARISIZLIK MODUNU BEKLİYORDU.
 *
 * Eski hâli `creditLc`'yi try/catch'e sarıp FIRLATMA durumunda logluyordu.
 * Ama `creditLc` hiç fırlatmaz: hatayı kendi içinde yutar ve `false` döner
 * (lib/wallet-credit.cjs:206). Ampirik olarak ölçüldü (2026-08-02):
 *     db yok       → false, fırlatmadı
 *     mongo çöktü  → false, fırlatmadı
 * Yani `catch` bloğu ÖLÜ KODDU ve iade sessizce düşüyordu.
 *
 * ⚠️ ETKİSİ GERÇEK PARA: oyuncu giriş ücretini ÖDEMİŞ (`ucretTahsilEt`
 * başarılı), turnuvaya yazma patlamış, iade de patlamış. Bu dal zaten Mongo
 * tökezlediği için çalışıyor — yani iadenin de patlaması EN OLASI senaryo,
 * kenar durum değil.
 *
 * ⚠️ AYNI DOSYA DOĞRUSUNU ZATEN YAPIYOR: ödül ödemesi başarısız olunca
 * `kayipOdulKaydet` ile kalıcı ize yazılıyor (aşağıda) ve `GET /api/health`
 * onu sayıyor. Kupon, havuz, mini turnuva ve bayat temizleyici de öyle.
 * Eksik olan tek yol buydu. Log yeterli değil: Render'da disk geçici,
 * dosyanın kendi niyeti "elle telafi edilebilsin" ve bu ancak kalıcı izle
 * mümkün.
 */
async function ucretIadeEt(conn, userId, tutar, neden) {
  const ok = await creditLc(conn, userId, tutar, "tournament_entry_refund", { neden });
  if (ok) return;

  console.error(`[tournament] ⛔ IADE EDILEMEDI ${userId} ${tutar} LC (${neden})`);
  try {
    const { kayipOdulKaydet } = require("../lib/wallet-credit.cjs");
    await kayipOdulKaydet(conn, {
      kaynak: "tournament_entry_refund",
      neden,
      odemeler: [{ userIdLower: String(userId || "").toLowerCase(), tutar }],
      beklenen: 1,
      eksik: 1,
    });
  } catch (e) {
    // İz bırakma da başarısızsa yapacak bir şey kalmadı; en azından logla.
    console.error("[tournament] kayip iade izi yazilamadi:", e?.message || e);
  }
}

const PAYOUT_TABLE = {
  2: [0.70, 0.30],
  3: [0.70, 0.30],
  4: [0.60, 0.25, 0.15],
  5: [0.60, 0.25, 0.15],
  6: [0.60, 0.25, 0.15],
  7: [0.60, 0.25, 0.15],
};
const PAYOUT_8PLUS = [0.50, 0.25, 0.15, 0.10];

/** Doğru bilinen maç başına puan = bu sabit × maçın odds'ı. */
const PUAN_CARPANI = 10;

/**
 * KATILIMCI PUANLARI — TEK KAYNAK.
 *
 * Kural: doğru bildiğin her maç için `10 × o seçimin odds'ı` (yuvarlanmış).
 * Yanlış tahmin 0 getirir, ceza yok — turnuva kısa ve giriş bedeli zaten
 * ödenmiş durumda.
 *
 * ⚠️ NEDEN ÇIKARILDI (2026-08-03): ödeme hesabının ikinci kopyası ayrışıp
 * canlı yolda fazla/eksik ödeme bırakınca (bkz. `odemePaylari`) bu döngünün de
 * İKİ kopyası olduğu görüldü — `settle()` ve `routes/settle2.cjs`
 * tryAutoSettleTournaments. O gün birebir aynıydılar, AMA bir fark vardı:
 *
 *     servis kopyası : t.fixtures.find(...)          → alan yoksa TypeError
 *     settle2 kopyası: (t.fixtures || []).find(...)  → tolere eder
 *
 * Yani aynı turnuva, hangi yoldan sonuçlandığına göre ya puanlanıyor ya
 * patlıyordu. Üretimde turnuva sayısı 0 olduğu için canlı bir yanlış puanlama
 * ÇIKMADI — abartmıyorum; bu, ayrışmanın ikinci kez yakalanması.
 *
 * ⚠️ EKSİK ALANLAR ARTIK PUANI SIFIRLAR, PATLATMAZ: `predictions` taşımayan
 * bir katılımcı İKİ kopyada da TypeError üretiyordu ve bu, sonuçlandırmanın
 * tamamını (ödeme dahil) düşürürdü. Turnuvanın kapanmaması, tek oyuncunun
 * 0 puan alması demek olurdu — kapalı-başarısızlık burada yanlış taraf.
 *
 * ⚠️ odds MAÇ BAŞINA bir kez hesaplanır: iki kopya da her katılımcı × her maç
 * için yeniden `calcOdds` çağırıyordu (aynı maç için aynı sonuç).
 *
 * @param {object} t turnuva
 * @param {Record<string, {outcome:string}>} sonuclar fixtureId → sonuç
 * @returns {Array} `totalScore` yazılmış katılımcılar, puana göre AZALAN sıralı
 */
function puanlariHesapla(t, sonuclar) {
  const { calcOdds } = require("./odds-engine.cjs");
  const fidler = Array.isArray(t?.fixtureIds) ? t.fixtureIds : [];
  const fixturelar = Array.isArray(t?.fixtures) ? t.fixtures : [];
  const katilimcilar = Array.isArray(t?.participants) ? t.participants : [];
  const sonuc = sonuclar || {};

  // Maç başına odds — katılımcı sayısından bağımsız, bir kez.
  const oddsHarita = new Map();
  for (const fid of fidler) {
    const fx = fixturelar.find((f) => f && f.fixtureId === fid);
    oddsHarita.set(fid, fx ? calcOdds(fx.home, fx.away) : { home: 2, draw: 3, away: 2 });
  }

  for (const p of katilimcilar) {
    let puan = 0;
    const tahminler = (p && p.predictions) || {};
    for (const fid of fidler) {
      const pred = tahminler[fid];
      const r = sonuc[fid];
      if (!pred || !r) continue;
      if (pred.outcome !== r.outcome) continue;
      const odds = oddsHarita.get(fid) || { home: 2, draw: 3, away: 2 };
      const oran = pred.outcome === "H" ? odds.home : pred.outcome === "D" ? odds.draw : odds.away;
      puan += Math.round(PUAN_CARPANI * oran);
    }
    p.totalScore = puan;
  }

  return [...katilimcilar].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
}

/**
 * Havuzu yüzdelere göre TAM SAYI olarak dağıtır (en büyük kalan yöntemi).
 *
 * Önce her pay aşağı yuvarlanır, artan LC kesirli kısmı en büyük olandan
 * başlayarak birer birer dağıtılır. Toplam havuza tam eşitlenir, hiçbir zaman
 * aşmaz. Eşit kesirde üst sıra önce gelir — dağıtım deterministik.
 *
 * ⚠️ AYRI FONKSİYON, ÇÜNKÜ SINANMASI GEREKİYOR. `settle` Mongo, mühür ve
 * gerçek ödeme istiyor; saf matematiği 1440 senaryoda sınamanın yolu yoktu.
 * İlk denemede testime mantığın KOPYASINI yazdım ve negatif kontrol yakaladı:
 * kaynaktaki dağıtımı bozmak testi kırmıyordu — test kendi kopyasını
 * ölçüyordu. Kopya silindi, test bu fonksiyonu çağırıyor.
 */
/* ⚠️ GÖVDE lib/pay-dagitim.cjs DOSYASINA TAŞINDI.
 *
 * Aynı yuvarlama kusuru MAÇ HAVUZUNDA da çıktı (210 senaryonun %49'unda
 * havuzdan fazla dağıtım, en kötü +10 LC). Kural burada kalsaydı ikinci kez
 * yazılacaktı — bu depoda kopyalanan kural defalarca ayrıştı.
 *
 * Ad korunuyor: mevcut testler bu adı çağırıyor. */
const { odemeDagit } = require("../lib/pay-dagitim.cjs");

/**
 * Havuz + katılımcı sayısından ödeme paylarını hesaplar — TEK KAYNAK.
 *
 * ⚠️ NEDEN ÇIKARILDI (2026-08-03): bu hesabın İKİNCİ BİR KOPYASI
 * `routes/settle2.cjs` tryAutoSettleTournaments içinde yaşıyordu ve iki yol
 * AYRIŞMIŞTI: buradaki `Math.round` fazla-ödeme kusuru ve n=1 normalleştirme
 * kusuru yalnızca BURADA düzeltilmiş, kopya eski hâliyle kalmıştı.
 *
 * Üstelik canlı yol KOPYAYDI: settle2 her maç sonuçlandığında otomatik
 * tetikleniyor ve mührü (claimTournamentSettle) neredeyse hep o alıyor;
 * elle çağrılan uç (POST /tournaments/:code/settle) nadir. Yani düzeltme
 * nadir yolda, kusur canlı yolda duruyordu.
 *
 * ÖLÇÜLDÜ (1536 senaryo, n=1..16 × giriş=5..100, kopyanın kuralıyla):
 *     %23.4 havuzdan FAZLA ödeme   ← yoktan LC
 *     %6.6  havuzdan EKSİK ödeme   ← yakılan LC (n=1'de 30 LC'ye kadar)
 *     %70.0 tam eşit
 * Bu yol 1536/1536 senaryoda havuza TAM eşit dağıtıyor.
 *
 * @returns {{paylar:number[], tablo:number[]}} paylar[i] = i+1. sıranın LC'si
 */
function odemePaylari(havuz, katilimciSayisi) {
  const n = Math.max(0, Math.floor(Number(katilimciSayisi) || 0));
  if (!n) return { paylar: [], tablo: [] };
  const table = n >= 8 ? PAYOUT_8PLUS : (PAYOUT_TABLE[n] || PAYOUT_TABLE[2]);
  // Kesilen yüzdeler normalleştirilir — yoksa n=1'de havuzun %30'u buharlaşır
  // (bkz. settle içindeki ölçüm notu).
  const kesikTablo = table.slice(0, n);
  const yuzdeToplam = kesikTablo.reduce((a, b) => a + Number(b || 0), 0);
  const normalTablo =
    yuzdeToplam > 0 && Math.abs(yuzdeToplam - 1) > 1e-9
      ? kesikTablo.map((x) => Number(x || 0) / yuzdeToplam)
      : kesikTablo;
  const tamHavuz = Math.max(0, Math.floor(Number(havuz) || 0));
  return {
    paylar: odemeDagit(tamHavuz, normalTablo),
    tablo: kesikTablo,
  };
}

const MIN_ENTRY = 5;
const MAX_ENTRY = 100;
const MAX_MATCHES = 6;
const MIN_MATCHES = 2;

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Turnuvalar Mongo birincil — bkz. lib/social-store.cjs. Dosyada tutulurken
// Render'da her deploy siliyordu: giriş ücreti ödenmiş, havuzu birikmiş
// turnuvalar yok oluyordu ve LC hiçbir yere iade edilmiyordu.
// Sarmal ({tournaments:[...]}) çağıranlar için korunuyor.
async function loadAll() {
  return { tournaments: await SocialStore.loadTournaments() };
}

async function saveAll(data) {
  await SocialStore.saveTournaments(data?.tournaments || [], null);
}

async function create({ creatorId, name, entryLC, fixtureIds, fixtures, db = null }) {
  const entry = Math.max(MIN_ENTRY, Math.min(MAX_ENTRY, Number(entryLC) || 10));
  const matchIds = (fixtureIds || []).slice(0, MAX_MATCHES);
  if (matchIds.length < MIN_MATCHES) throw new Error("MIN_2_MATCHES");

  // ⚠️ Kurucu da KATILIMCI olarak ekleniyor ve havuz `entry` ile başlıyor —
  // yani onun da ücreti alınmalı. Doğrulamalar bittikten SONRA tahsil et ki
  // "MIN_2_MATCHES" hatasında boşuna para gitmesin.
  const conn = await ucretTahsilEt(db, creatorId, entry);

  const data = await loadAll();
  const code = genCode();
  const now = new Date().toISOString();

  const t = {
    id: "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    code,
    name: String(name || "Turnuva").slice(0, 40),
    creatorId,
    entryLC: entry,
    fixtureIds: matchIds,
    fixtures: (fixtures || []).slice(0, MAX_MATCHES),
    participants: [{
      userId: creatorId,
      joinedAt: now,
      predictions: {},
      totalScore: 0,
    }],
    pool: entry,
    status: "open",
    createdAt: now,
    settledAt: null,
    payouts: [],
  };

  data.tournaments.push(t);
  try {
    await saveAll(data);
  } catch (e) {
    // Ücret alındı ama turnuva yazılamadı — parayı kullanıcıda bırakma.
    await ucretIadeEt(conn, creatorId, entry, "create_save_failed");
    throw e;
  }
  return t;
}

async function join(code, userId, db = null) {
  const data = await loadAll();
  const t = data.tournaments.find(x => x.code === code.toUpperCase());
  if (!t) throw new Error("NOT_FOUND");
  if (t.status !== "open") throw new Error("CLOSED");
  if (t.participants.some(p => p.userId.toLowerCase() === userId.toLowerCase())) {
    throw new Error("ALREADY_JOINED");
  }

  // ⚠️ Ucuz kontroller (bulundu mu / açık mı / zaten katıldı mı) BİTTİKTEN
  // sonra tahsil et — reddedilecek bir katılım için para alınmasın.
  const conn = await ucretTahsilEt(db, userId, t.entryLC);

  t.participants.push({
    userId,
    joinedAt: new Date().toISOString(),
    predictions: {},
    totalScore: 0,
  });
  t.pool += t.entryLC;

  try {
    await saveAll(data);
  } catch (e) {
    await ucretIadeEt(conn, userId, t.entryLC, "join_save_failed");
    throw e;
  }
  return t;
}

/**
 * ⚠️ MAÇ KİLİDİ EKLENDİ. Önceki hâli YALNIZCA `status === "settled"` bakıyordu:
 * maçın başlayıp başlamadığına HİÇ bakmıyordu. Yani oynanmış, sonucu bilinen
 * bir maça turnuva içinde tahmin girilebiliyordu — turnuva kapanana kadar.
 *
 * Ana oyunda bu kilit iki kez sertleştirildi (routes/pred.cjs computePredLock,
 * routes/duels.cjs isFixtureLocked) ama turnuva o işten habersizdi.
 *
 * Aynı kapalı-başarısızlık ilkesi: durum dosyası yoksa FİKSTÜR DEPOSUNA
 * bakılır; maç orada da yoksa KİLİTLİ sayılır.
 */
async function macKilitliMi(fixtureId, db) {
  const fid = String(fixtureId || "").trim();
  if (!fid) return { kilitli: true, sebep: "FIXTURE_ID_REQUIRED" };

  let st = null;
  try {
    st = JSON.parse(await fsp.readFile(guvenliYol(LIVE_DIR, fid, ".json"), "utf8"));
  } catch { st = null; }

  if (!st || typeof st !== "object") {
    try {
      const hepsi = await FixturesStore.loadAll(db);
      const fx = (hepsi || []).find((f) => String(f?.fixtureId || "") === fid);
      if (!fx) return { kilitli: true, sebep: "FIXTURE_NOT_FOUND" };
      st = { status: fx.status || "NS", kickoffISO: fx.kickoffISO || fx.kickoff || null };
    } catch (e) {
      console.error("[tournament] fikstur dogrulanamadi, kilitli sayiliyor:", e?.message || e);
      return { kilitli: true, sebep: "FIXTURE_CHECK_FAILED" };
    }
  }

  const durum = String(st.status || "").toUpperCase();
  if (durum && durum !== "NS") return { kilitli: true, sebep: "MATCH_ALREADY_STARTED" };

  const ko = st.kickoffISO || st.kickoff || null;
  if (!ko) return { kilitli: true, sebep: "NO_KICKOFF" };
  const koMs = new Date(String(ko)).getTime();
  if (!Number.isFinite(koMs)) return { kilitli: true, sebep: "BAD_KICKOFF" };
  if (Date.now() >= koMs) return { kilitli: true, sebep: "MATCH_ALREADY_STARTED" };

  return { kilitli: false, sebep: null };
}

async function predict(code, userId, fixtureId, outcome, db = null) {
  const data = await loadAll();
  const t = data.tournaments.find(x => x.code === code.toUpperCase());
  if (!t) throw new Error("NOT_FOUND");
  if (t.status === "settled") throw new Error("SETTLED");

  const p = t.participants.find(x => x.userId.toLowerCase() === userId.toLowerCase());
  if (!p) throw new Error("NOT_JOINED");
  if (!t.fixtureIds.includes(fixtureId)) throw new Error("INVALID_FIXTURE");

  // ⚠️ Maç başladıysa tahmin alınmaz — bkz. macKilitliMi notu.
  const kilit = await macKilitliMi(fixtureId, db);
  if (kilit.kilitli) throw new Error(kilit.sebep);

  p.predictions[fixtureId] = { outcome, at: new Date().toISOString() };
  await saveAll(data);
  return { ok: true };
}

/**
 * ⚠️ ÖDEME YOLU BAĞLANDI. Önceki hâli `payouts` dizisini HESAPLAYIP YAZIYOR
 * ama cüzdana TEK SATIR yazmıyordu. Gerçek ödemeyi settle2 yapıyor, o da
 * yalnızca `status === "open"` turnuvaları tarıyor — yani bu fonksiyon
 * çağrıldığı anda turnuva "settled" oluyor, settle2 bir daha bakmıyordu ve
 * TOPLANAN GİRİŞ ÜCRETLERİ KİMSEYE ÖDENMİYORDU. Giriş ücreti gerçekten
 * tahsil edildiği için bu doğrudan para yakıyordu.
 *
 * ⚠️ MÜHÜR settle2 İLE AYNI (`claimTournamentSettle`): iki ödeme yolu var ve
 * hangisi önce mührü alırsa diğeri atlar. Ayrı mühür kullanmak çift ödeme
 * demek olurdu.
 */
async function settle(code, results, db = null) {
  const data = await loadAll();
  const t = data.tournaments.find(x => x.code === code.toUpperCase());
  if (!t) throw new Error("NOT_FOUND");
  if (t.status === "settled") throw new Error("ALREADY_SETTLED");

  // Puanlama TEK KAYNAKTAN (bkz. puanlariHesapla): kopyası settle2'de yaşıyor
  // ve `t.fixtures` yokken bu yol patlarken öteki tolere ediyordu.
  const sorted = puanlariHesapla(t, results);

  /* ⚠️ ÖDEMELER HAVUZLA UZLAŞTIRILIR — `Math.round` HAVUZDAN FAZLA ÖDÜYORDU.
   *
   * Her ödeme bağımsız yuvarlanıyor ve toplam havuzla hiç karşılaştırılmıyordu.
   * ÖLÇÜLDÜ (oyuncu 2-16 × giriş 5-100 LC = 1440 senaryo):
   *     %74.7 tam eşleşme
   *     %25.0 FAZLA ödeme (+1 LC)   ← yoktan LC, dörtte bir turnuvada
   *     %0.3  eksik ödeme (-1 LC)
   * Örnek: 3 oyuncu × 5 LC = 15 havuz → round(10.5)=11 + round(4.5)=5 = 16.
   *
   * Aynı hatanın doğru karşılığı kod tabanında ZATEN vardı — `routes/mini.cjs`
   * içindeki `kazananPayi` aşağı yuvarlıyor: "Yukarı yuvarlamak toplamı
   * taşırırdı ... Enflasyon yönünde hata yapmamak, kuruş kuruşuna dağıtmaktan
   * önemli." Turnuva o kuralı almamıştı.
   *
   * ⚠️ AMA YALNIZCA AŞAĞI YUVARLAMAK DA YETMEZ. Ölçtüm: her ödemeyi floor'a
   * çekmek fazla ödemeyi bitiriyor ama 1440 senaryonun 1199'unda 3 LC'ye kadar
   * YAKIYOR — mini'de tek bir pay hesaplandığı için kayıp önemsizdi, burada
   * üç-dört kalem var. Bunun yerine EN BÜYÜK KALAN yöntemi: önce hepsi aşağı
   * yuvarlanır, artan LC kesirli kısmı en büyük olandan başlayarak birer birer
   * dağıtılır. Toplam havuza TAM eşitlenir, hiçbir zaman aşmaz.
   *
   * (Yüzdeler her zaman 1.00'e toplanıyor ve ödeme sayısı tablo uzunluğuna
   * eşit — n < tablo durumu yok, çünkü tablo katılımcı sayısına göre seçiliyor.) */
  /**
   * ⚠️ HESAP TEK KAYNAKTA: `odemePaylari` (normalleştirme + en büyük kalan).
   * n=1 buharlaşması ve `Math.round` fazla-ödemesi orada anlatılıyor; iki
   * ödeme yolunun (burası + settle2 auto-settle) aynı sayıları üretmesi
   * için hesap oraya toplandı — kopya bir kez ayrıştı ve canlı yolda kusur
   * bıraktı.
   */
  const { paylar, tablo } = odemePaylari(t.pool, sorted.length);

  t.payouts = paylar.map((lcWon, i) => ({
    rank: i + 1,
    userId: sorted[i].userId,
    score: sorted[i].totalScore,
    lcWon,
    pct: Math.round(tablo[i] * 100),
  }));

  /* Değişmez ödemeden ÖNCE doğrulanır: toplam havuzu AŞAMAZ. Aşağı yuvarlama
   * bunu zaten sağlıyor; bu kontrol tablo ya da yuvarlama bir gün değişirse
   * sessiz enflasyon yerine gürültü çıkarsın diye duruyor. */
  const odenecek = t.payouts.reduce((a, p) => a + Number(p.lcWon || 0), 0);
  if (odenecek > Number(t.pool || 0)) {
    console.error(
      `[tournament] ⛔ ODEME HAVUZU ASIYOR: ${t.code} havuz=${t.pool} odenecek=${odenecek} — ` +
      "odeme yapilmadi"
    );
    throw new Error("PAYOUT_EXCEEDS_POOL");
  }

  const nowISO = new Date().toISOString();

  // ⚠️ MÜHÜR ÖDEMEDEN ÖNCE, ATOMİK. Koşul (`status:"open"`) yazmanın içinde;
  // yalnızca tek çağrı true alır. settle2 de aynı mührü kullanıyor.
  const conn = await dbAl(db);
  const bizimki = await SocialStore.claimTournamentSettle(t.id, nowISO, conn);
  if (!bizimki) throw new Error("ALREADY_SETTLED");

  t.status = "settled";
  t.settledAt = nowISO;
  await saveAll(data);

  // Mühür alındı → ödemeyi BİZ yapmalıyız; settle2 artık bu turnuvayı görmez.
  const odenemeyen = [];
  for (const odeme of t.payouts) {
    const tutar = Number(odeme?.lcWon || 0);
    if (!odeme?.userId || tutar <= 0) continue;
    const ok = await creditLc(conn, odeme.userId, tutar, "tournament_payout", {
      tournamentId: t.id, tournamentCode: t.code, rank: odeme.rank,
    });
    if (!ok) odenemeyen.push({ userIdLower: String(odeme.userId).toLowerCase(), tutar });
  }
  if (odenemeyen.length) {
    // Mühür atıldı, tekrar denenmez → kalıcı iz bırak (bkz. lib/wallet-credit).
    console.error(`[tournament] ⛔ ODEME YAPILAMADI: ${t.code} — ${odenemeyen.length} kisi`);
    const { kayipOdulKaydet } = require("../lib/wallet-credit.cjs");
    await kayipOdulKaydet(conn, {
      kaynak: "tournament_payout", tournamentCode: t.code,
      odemeler: odenemeyen, beklenen: t.payouts.length, eksik: odenemeyen.length,
    });
  }

  return t;
}

async function getByCode(code) {
  const data = await loadAll();
  return data.tournaments.find(x => x.code === code.toUpperCase()) || null;
}

async function listByUser(userId) {
  const data = await loadAll();
  const uid = userId.toLowerCase();
  return data.tournaments.filter(t =>
    t.creatorId.toLowerCase() === uid ||
    t.participants.some(p => p.userId.toLowerCase() === uid)
  );
}

module.exports = {
  create, join, predict, settle, getByCode, listByUser,
  MIN_ENTRY, MAX_ENTRY, MAX_MATCHES,
  // Sınama için: saf dağıtım matematiği (bkz. odemeDagit notu).
  /* ⚠️ İADE YOLU DA SINANMALI: buradaki savunma bir kez ETKİSİZ yazılmıştı
   * (yanlış başarısızlık modunu bekliyordu) ve hiçbir test görmedi. */
  _ucretIadeEt: ucretIadeEt,
  _odemeDagit: odemeDagit, _PAYOUT_TABLE: PAYOUT_TABLE, _PAYOUT_8PLUS: PAYOUT_8PLUS,
  // İki ödeme yolunun (settle + settle2 auto-settle) ORTAK hesapları — her
  // ikisinin de kopyası ayrıştı: ödemede fazla/eksik LC, puanlamada bir yolun
  // patlayıp ötekinin tolere etmesi (bkz. tanımları).
  odemePaylari, puanlariHesapla, PUAN_CARPANI,
};
