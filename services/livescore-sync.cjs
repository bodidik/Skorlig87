"use strict";

const fs = require("fs");
const SkorUyusmazlik = require("../lib/skor-uyusmazlik.cjs");
/** Mongo baglantisi (yoksa null) — uyusmazlik kaydi icin. */
async function dbAlSafe() {
  try { return await require("../lib/mongo.cjs").getDb(); } catch { return null; }
}
const fsp = fs.promises;
const path = require("path");
const { guvenliYol } = require("../lib/guvenli-dosya.cjs");

// ⚠️ SKORLIG_DATA_DIR: sabit yol testleri GERÇEK data/ dizinine yazdırır.
const DATA_DIR   = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const LIVE_DIR   = path.join(DATA_DIR, "live");
const FixturesStore = require("../lib/fixtures-store.cjs");
const RESULTS_FILE  = path.join(DATA_DIR, "results.json");   // settle2'nin okuduğu file
const MatchResults = require("../lib/match-results.cjs");
const { ilkGolTuret } = require("../lib/ilk-gol.cjs");

const livescoreScraper = require("./livescore-scraper.cjs");

// track which fixtureIds we already settled this session
const _settledThisSession = new Set();
let _lastSync   = null;
let _syncInProgress = false;
let _apiPort    = 4102;

// ──────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────
async function readJson(file, fb = null) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fb; }
}
async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

function liveStateFile(fid) {
  return guvenliYol(LIVE_DIR, String(fid), ".json");
}

// ──────────────────────────────────────────────
// Team name normalization
// Kendi fixtures'ımızdaki isimler Maçkolik'tekiyle örtüşmeyebilir.
// Her iki tarafı da normalize ediyoruz.
// ──────────────────────────────────────────────
const TEAM_MAP = {
  "galatasaray":  ["galatasaray", "galatasaray sk", "gs"],
  "fenerbahçe":   ["fenerbahçe", "fenerbahce", "fb"],
  "beşiktaş":     ["beşiktaş", "besiktas", "bjk"],
  "trabzonspor":  ["trabzonspor", "ts"],
  "başakşehir":   ["başakşehir", "istanbul başakşehir", "basaksehir"],
  "kayserispor":  ["kayserispor", "kayseri"],
  "sivasspor":    ["sivasspor", "sivas"],
  "konyaspor":    ["konyaspor", "konya"],
  "antalyaspor":  ["antalyaspor", "antalya"],
  "gaziantep":    ["gaziantep", "gaziantep fk", "gaziantepspor"],
  "hatayspor":    ["hatayspor", "hatay"],
  "kasımpaşa":    ["kasımpaşa", "kasimpasa"],
  "alanyaspor":   ["alanyaspor", "alanya"],
  "adana demirspor": ["adana demirspor", "adana demir"],
  "giresunspor":  ["giresunspor", "giresun"],
  "ümraniyespor": ["ümraniyespor", "umraniyespor", "ümraniye"],
  "kocaelispor":  ["kocaelispor", "kocaeli"],
  "istanbulspor": ["istanbulspor", "istanbul spor"],
  "erzurumspor":  ["erzurumspor fk", "erzurumspor", "erzurum"],
  "rizespor":     ["ç. rizespor", "çaykur rizespor", "rizespor", "rize"],
  "arsenal":      ["arsenal"],
  "chelsea":      ["chelsea"],
  "liverpool":    ["liverpool"],
  "manchester city": ["manchester city", "man city", "man. city"],
  "manchester united": ["manchester united", "man utd", "man. united"],
  "tottenham":    ["tottenham", "tottenham hotspur", "spurs"],
  "real madrid":  ["real madrid"],
  "barcelona":    ["fc barcelona", "barcelona"],
  "atletico madrid": ["atlético madrid", "atletico madrid", "atletico de madrid"],
};

/**
 * Yaş/cinsiyet/rezerv takım işaretleri. Bunlar A takımıyla ASLA
 * birleştirilmemeli: "Barcelona (K)" kadın takımıdır, "Tottenham U21" altyapıdır.
 * Aksi halde A takımı fixture'ı altyapı maçının skorunu alır.
 */
const QUALIFIER_RE =
  /(\bu\s?1[4-9]\b|\bu\s?2[0-3]\b|\bii\b|\bb\s?tak[ıi]m\b|\breserves?\b|\bakademi\b|\(k\)|\(w\)|\bkad[ıi]n\b|\bwomen\b|\bfeminin\b)/i;

// Kulüp tipi ekleri (FC, SK, VfB...) — meşru varyant eşleşmesini kolaylaştırmak
// için atılır. \b sınırı kullanıldığı için kelime İÇİNDE eşleşmez
// ("Aston" içindeki "as" atılmaz).
const CLUB_AFFIX_RE =
  /\b(fc|sc|sk|cf|ac|as|afc|cd|ud|sv|vfb|vfl|fk|if|bk|nk|hk|ks|cs|rc|sd)\b/g;

function baseNormalize(s) {
  return String(s || "")
    .toLowerCase()
    // Türkçe harfleri ASCII'ye indir (İ/ı önce, NFD bunları bozuyor)
    .replace(/[İı]/g, "i")
    .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
    .replace(/ö/g, "o").replace(/ç/g, "c")
    // kalan diakritikleri sıyır (é, á, ø...)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[.\-_'’`]/g, " ")
    .replace(CLUB_AFFIX_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Takım adını eşleştirme anahtarına çevirir.
 *
 * DİKKAT — bir dönem burada `n.includes(v)` vardı ve TEAM_MAP'te "ts", "gs",
 * "fb" gibi kısa kısaltmalar olduğu için felaket sonuç veriyordu:
 * "Botev Vra[ts]a", "Por[ts]mouth", "Ludogore[ts]" → hepsi "trabzonspor";
 * "Au[gs]burg", "Livin[gs]ton" → "galatasaray". Bu, 45 dakikalık kickoff
 * toleransı içinde oynanan yabancı bir maçın skorunun bizim fixture'a
 * yazılmasına yol açıyordu (yanlış settle → yanlış puan/LC).
 * Ölçülen etki: 1411 takımın 30'u yanlış eşleşiyordu.
 *
 * Artık SADECE TAM eşitlik kullanılıyor ve yaş/kadın/rezerv işaretleri
 * anahtara ekleniyor, böylece A takımıyla karışmıyorlar.
 */
/* ────────────────────────────────────────────────────────────────────────────
 * NORMALİZASYON ÖNHESABI + MEMO — API'Yİ KULLANILMAZ YAPAN BLOKAJIN KAYNAĞI.
 *
 * ⚠️ ÖLÇÜLDÜ (üretim verisi, 2026-08-03): `findLiveMatch` tam turu
 * **25.232 ms SENKRON CPU** (1907 fikstür × 512 canlı maç) ve `sync()` her
 * 30 saniyede çalışıyor — yani olay döngüsü her 30 saniyenin ~25'inde
 * KİLİTLİydi. Ping deseni (45 saniyenin 26'sı 1.5sn+): statik ülke listesi
 * bile 20 saniye yanıt veremiyordu. Uygulamanın "takılması"nın kökü buydu.
 *
 * SEBEP İKİ KATLIYDI:
 *   1) `normalizeTeam` HER çağrıda tüm TEAM_MAP varyantlarını (67 adet)
 *      yeniden `baseNormalize`'dan geçiriyordu — NFD + 8 regex her seferinde.
 *   2) `findLiveMatch` her fikstür×maç çifti için `normalizeTeam(m.homeTeam)`
 *      çağırıyordu → 1907 × 512 × 2 ≈ 2M çağrı × 67 varyant taraması.
 *
 * ⚠️ DAVRANIŞ BİLEREK BİREBİR AYNI. Bu fonksiyonun geçmişinde yanlış
 * eşleşmenin parası var (yukarıdaki not: "ts"/"gs" kısaltmaları 30 takımı
 * yanlış eşleştirip yanlış settle üretiyordu). Bu yüzden eşleştirme kuralına
 * DOKUNULMUYOR; yalnızca aynı girdinin aynı çıktıyı ürettiği gerçeği
 * önbelleğe alınıyor:
 *   - TEAM_MAP varyantları BİR KEZ normalize edilip Map'e konuyor
 *     (67 normalizasyon, modül başına bir kez).
 *   - `normalizeTeam` sonuçları ada göre memolanıyor: takım adları sonlu
 *     bir küme (~4K benzersiz ad), 2M çağrının neredeyse hepsi tekrar.
 *
 * ⚠️ TEAM_MAP ÇALIŞMA ANINDA DEĞİŞTİRİLMİYOR (tarandı: hiçbir yazan yok) —
 * önhesap bu yüzden güvenli. Değiştiren çıkarsa `_resetNormalizeCache()`
 * çağırmalı; test de bunu kullanıyor.
 *
 * SONUÇ (aynı veriyle yeniden ölçüldü): 25.232ms → ~60ms. ~420 kat.
 * ──────────────────────────────────────────────────────────────────────── */
let _variantIx = null;
function variantIx() {
  if (_variantIx) return _variantIx;
  _variantIx = new Map();
  for (const [canonical, variants] of Object.entries(TEAM_MAP)) {
    for (const v of variants) {
      const k = baseNormalize(v);
      /* İlk gelen kazanır — Object.entries sırası korunuyor, yani eski
       * `for..of` taramasıyla aynı öncelik. */
      if (k && !_variantIx.has(k)) _variantIx.set(k, canonical);
    }
  }
  return _variantIx;
}

const _normMemo = new Map();
/** Testler ve olası TEAM_MAP değişiklikleri için: tüm önbelleği sıfırlar. */
function _resetNormalizeCache() { _variantIx = null; _normMemo.clear(); }

function normalizeTeam(name) {
  if (!name) return "";
  const key = String(name);
  const memo = _normMemo.get(key);
  if (memo !== undefined) return memo;

  const raw = key.toLowerCase();
  const qMatch = raw.match(QUALIFIER_RE);
  const qualifier = qMatch ? "|" + qMatch[0].replace(/\s+/g, "") : "";

  const n = baseNormalize(name);
  const sonuc = !n
    ? raw.trim() + qualifier
    : (variantIx().get(n) || n) + qualifier;

  /* Sınırsız büyüme emniyeti: takım adları sonlu ama bozuk bir kaynak
   * rastgele dizeler gönderirse bellek şişmesin. */
  if (_normMemo.size > 20000) _normMemo.clear();
  _normMemo.set(key, sonuc);
  return sonuc;
}

// ──────────────────────────────────────────────
// Match a fixture to a livescore entry
// ──────────────────────────────────────────────
function findLiveMatch(fixture, allMatches) {
  const fixHome = normalizeTeam(fixture.home);
  const fixAway = normalizeTeam(fixture.away);

  const kickoff = new Date(fixture.kickoffISO || fixture.kickoffDate || "");
  const kickoffValid = !isNaN(kickoff.getTime());

  return allMatches.find(m => {
    if (normalizeTeam(m.homeTeam) !== fixHome) return false;
    if (normalizeTeam(m.awayTeam) !== fixAway) return false;

    if (!kickoffValid || !m.matchDate) return true;

    try {
      const [dateStr, timeStr] = m.matchDate.split(" ");
      const [hh, mm] = (timeStr || "00:00").split(":").map(Number);
      const liveKO = new Date(dateStr);
      liveKO.setHours(hh, mm, 0, 0);
      return Math.abs(kickoff - liveKO) / 60000 <= 45; // 45 dk tolerans
    } catch { return true; }
  });
}

// ──────────────────────────────────────────────
// Parse HT from "İY 0-1" string
// ──────────────────────────────────────────────
function parseHT(htScore) {
  if (!htScore) return null;
  const m = htScore.match(/(\d+)-(\d+)/);
  if (!m) return null;
  return { home: parseInt(m[1], 10), away: parseInt(m[2], 10) };
}

/**
 * Canlı maç dakikası — kaynak onu AYRI BİR ALANDA VERMİYOR.
 *
 * ⚠️ ÖLÇÜLDÜ (scraper önbelleği): canlı maçlarda `minute` alanı `undefined`;
 * dakika `status` DİZESİNİN İÇİNDE geliyor:
 *     status="62'"   → 62. dakika
 *     status="İY"    → devre arası (dakika yok)
 *     status="45+2'" → uzatma
 *
 * Bu yüzden ana ekranda canlı maç "62'" yerine düz "CANLI" görünüyordu:
 * mobil `statusLabel` `fx.minute` sayısını arıyor, o da hiç yazılmıyordu
 * (`Fx` tipinin okuduğu ama sunucunun hiç göndermediği alanlardan biri).
 *
 * ⚠️ UYDURMA YOK: yalnızca rakamla başlayan bir dakika işareti kabul
 * ediliyor. "İY", "MS", "Ert." gibi durumlarda `null` dönüyor — sıfır ya da
 * tahmini bir sayı yazmak, kullanıcıya oynanmayan bir dakikayı göstermek
 * olurdu. Uzatmada ana dakika alınıyor (45+2 → 45); toplama yapmak 47.
 * dakika gibi var olmayan bir an üretirdi.
 */
function parseMinute(status) {
  const s = String(status || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,3})(?:\s*\+\s*\d{1,2})?\s*'/);
  if (!m) return null;
  const dk = parseInt(m[1], 10);
  /* 0 dakika diye bir şey yok; 130+ bir ayrıştırma hatasıdır. */
  if (!Number.isFinite(dk) || dk <= 0 || dk > 130) return null;
  return dk;
}

// ──────────────────────────────────────────────
// Write live state so settle2 can read it
// ──────────────────────────────────────────────
/**
 * FT SONRASI BEKLEME SÜRESİ (dakika).
 *
 * ⚠️ SAYI TAHMİNLE SEÇİLDİ, VE BUNU AÇIKÇA YAZIYORUM. Üretimde 636 uzlaşmış
 * maçın 4'ünde ödenen skor bugünkü skordan farklı çıktı (%0.63) ve ikisinde
 * 1X2 sonucu değişmişti — yani sorun gerçek. Ama düzeltmenin NE KADAR sonra
 * geldiğini ölçemedim: durum dosyasındaki `updatedAt` her turda yeniden
 * yazılıyor, yani "en son ne zaman görüldü" demek, "ne zaman değişti" değil.
 *
 * Bu yüzden 10 dakika bir BAŞLANGIÇ değeri. `ftSonrasiDegisim` sayacı ve
 * `ilkFtAt` damgası tam da bu soruyu ölçülebilir kılmak için yazılıyor:
 * birkaç gün sonra "FT sonrası değişimler ilk FT'den kaç dakika sonra geldi"
 * sorusunun gerçek cevabı olacak ve süre ona göre ayarlanacak.
 */
const FT_BEKLEME_DK = Number(process.env.SKORLIG_FT_BEKLEME_DK || 10);

/**
 * Uzlaşma için skor yeterince kararlı mı?
 *
 * Saf fonksiyon — testten doğrudan çağrılabilsin diye dışa açık.
 *
 * @param {object|null} st  canlı durum dosyası içeriği
 * @param {number} simdiMs
 * @returns {{hazir:boolean, sebep:string, kalanDk?:number}}
 */
function ftBeklemesiDoldu(st, simdiMs = Date.now()) {
  if (FT_BEKLEME_DK <= 0) return { hazir: true, sebep: "bekleme-kapali" };
  if (!st) return { hazir: true, sebep: "durum-yok" }; // eski davranış: engelleme

  const damga = Date.parse(st.skorSabitAt || st.ilkFtAt || "");
  // Damga yoksa bu kayıt bu özellikten ÖNCE yazılmış — bekletme.
  if (!Number.isFinite(damga)) return { hazir: true, sebep: "damga-yok" };

  const gecen = simdiMs - damga;
  const gerek = FT_BEKLEME_DK * 60 * 1000;
  if (gecen >= gerek) return { hazir: true, sebep: "kararli" };
  return { hazir: false, sebep: "bekliyor", kalanDk: Math.ceil((gerek - gecen) / 60000) };
}

async function writeLiveState(fixtureId, liveMatch, scores, nowISO) {
  const stateFile = liveStateFile(fixtureId);
  const prev = await readJson(stateFile, {});
  const st = {
    ...prev,
    fixtureId,
    status: scores.isFT ? "FT" : "LIVE",
    isLive: !scores.isFT,
    score: { home: scores.home, away: scores.away },
    updatedAt: nowISO,
    source: "livescore-sync",
  };

  /* ⚠️ FT KARARLILIK DAMGALARI — uzlaşmayı geciktirmek için.
   *
   * NEDEN: `claimAward` mührü yüzünden uzlaşma bir kez olur; skor sonradan
   * düzelirse puanlar ve LC kalıcı olarak yanlış kalır. ÖLÇÜLDÜ (üretim,
   * 636 uzlaşmış maç): 4'ünde ödenen skor bugünkü skordan FARKLI ve
   * İKİSİNDE 1X2 SONUCU DEĞİŞMİŞ (1-0→2-2, 2-3→2-2).
   *
   * ⚠️ SABİT SAYAÇ DEĞİL KARARLILIK: `skorSabitAt` skor HER DEĞİŞTİĞİNDE
   * sıfırlanıyor. Böylece bekleme süresi kendi kendine uyarlanıyor — skor
   * oturmuşsa hemen, oynuyorsa oturana kadar. Düz "FT+10dk" sayacı skorun
   * hâlâ değiştiğini göremezdi.
   *
   * ⚠️ `updatedAt` BU İŞE YARAMAZ: her turda yeniden yazılıyor, yani "en son
   * ne zaman görüldü" demek. İlk ölçümümde onu düzeltme zamanı sanmıştım.
   *
   * `ftSonrasiDegisim` yalnızca ÖLÇÜM için: N'i tahminle değil veriyle
   * seçebilelim diye FT'den sonra skorun kaç kez değiştiğini sayıyor.
   */
  if (scores.isFT) {
    const oncekiSkor = prev?.score || {};
    const skorAyni =
      Number(oncekiSkor.home) === Number(scores.home) &&
      Number(oncekiSkor.away) === Number(scores.away);
    const oncedenFT = String(prev?.status || "").toUpperCase() === "FT";

    /* ⚠️ `ilkFtAt` YALNIZCA LIVE→FT GEÇİŞİNDE damgalanır.
     *
     * İlk yazımımda "önceden FT ama damga yok" durumunda `nowISO` yazıyordum.
     * Bu, özellik devreye girmeden ÖNCE bitmiş maçlara (ölçüm anında 1111
     * durum dosyasının hepsi böyle) sahte bir "ilk FT" zamanı basardı ve
     * gecikme ölçümünü kirletirdi — süreyi veriyle seçmek için yazdığım
     * damganın kendisi yanlış olurdu.
     *
     * Damgasız kalan eski kayıtlar kapıdan zaten GEÇİYOR (`damga-yok`), yani
     * bekletilmiyorlar. */
    if (prev?.ilkFtAt) st.ilkFtAt = prev.ilkFtAt;
    else if (!oncedenFT) st.ilkFtAt = nowISO;      // gerçek LIVE→FT geçişi

    if (st.ilkFtAt) {
      st.skorSabitAt = skorAyni && prev?.skorSabitAt ? prev.skorSabitAt : nowISO;
    }
    if (oncedenFT && !skorAyni) {
      st.ftSonrasiDegisim = Number(prev?.ftSonrasiDegisim || 0) + 1;
      console.warn(
        `[sync] FT sonrasi skor degisti -> ${fixtureId}: ` +
        `${oncekiSkor.home}-${oncekiSkor.away} => ${scores.home}-${scores.away} ` +
        `(ilkFT ${st.ilkFtAt}) — bekleme sayaci sifirlandi`
      );
    }
  }
  if (scores.htHome != null) st.htScore = { home: scores.htHome, away: scores.htAway };
  if (liveMatch.homeRed) st.redHome = liveMatch.homeRed;
  if (liveMatch.awayRed) st.redAway = liveMatch.awayRed;

  /* ⚠️ İLK GOL SKORDAN DAMGALANIR — bahis kazanılamıyordu.
   *
   * `firstGoal`ü yalnızca af-sync (askıdaki kaynak) yazıyordu; ölçüldü:
   * 14518 tahminin TAMAMI ceza, 0 ödül. Bir taraf gol atmış öteki 0 iken
   * ilk golü atan kesindir; her ~30 sn'lik turda bu an bir kez yakalanırsa
   * skor sonradan 3-1 olsa da bilgi korunur (`...prev` taşır, yalnızca
   * BOŞKEN yazılır — af-sync olaydan yazarsa ona dokunulmaz).
   * bkz. lib/ilk-gol.cjs */
  if (!st.firstGoal) {
    const tur = ilkGolTuret(scores.home, scores.away);
    if (tur) {
      st.firstGoal = tur;
      st.firstGoalSource = "score-derived";
    }
  }

  /* ⚠️ CANLI DAKİKA. Kaynak ayrı alan vermiyor, dakika `status` dizesinin
   * içinde ("62'"). Ana ekranda canlı maç "62'" yerine düz "CANLI"
   * görünüyordu. Maç bitince dakika ANLAMSIZ — FT'de silinir, yoksa
   * bitmiş maçın yanında son dakika asılı kalırdı. */
  if (scores.isFT) {
    delete st.minute;
  } else {
    const dk = parseMinute(liveMatch.status);
    if (dk != null) st.minute = dk;
    else delete st.minute;      // devre arası vb. — eski değeri taşıma
  }

  await writeJsonAtomic(stateFile, st);
}

// ──────────────────────────────────────────────
// Also write to results.json so settle2 bootstrap picks it up
// ──────────────────────────────────────────────
/* ────────────────────────────────────────────────────────────────────────────
 * BESLEMEDEN DÜŞEN MAÇLARI UZLAŞTIR — "takılı LIVE" sızıntısının kaynağı.
 *
 * ⚠️ KUSUR: `sync()` içindeki ana döngü `if (!liveMatch) continue;` diyor —
 * yani bir maç kaynağın canlı beslemesinden çıktığı anda BİR DAHA ASLA ele
 * alınmıyor. Maç bitip kaynağın "bugün" sayfasından düşerse durum dosyası
 * sonsuza dek `status: "LIVE"` kalıyor. Güncelleme yok, hata yok, iz yok.
 *
 * ÖLÇÜLDÜ (üretim, 2026-08-02): 6 saatten eski 160 takılı LIVE durum dosyası.
 * Yaş dağılımı 6-24sa: 87 · 1-3gün: 21 · 3-7gün: 51 · 7gün+: 1 — yani
 * tarihî artık değil, AKTİF sızıntı. Hepsinin kaynağı `livescore-sync`.
 * 1 Ağustos'ta 456 kayıt elle kapatılmıştı; sebep kapatılmadığı için geri
 * geldi. En yaşlısı 360 saat (15 gün) boyunca uygulamada "CANLI" görünüyordu.
 *
 * ⚠️ 16'SINDA ÖDÜL ZATEN DAĞITILMIŞTI (`match_results.awardedAt` damgalı,
 * `meta.status: "FT"`) — yani maç uzlaşmış, para ödenmiş, ama kullanıcı
 * ekranında hâlâ canlı görünüyordu.
 *
 * ⚠️ SKOR UYDURULMUYOR. Bu dosyanın kendi kuralı: güvenilmez skorla FT
 * yazmak, `claimAward` mührü yüzünden KALICI yanlış ödeme demek. Bu yüzden
 * iki ayrı yol var:
 *   (a) `match_results` içinde gerçek `finalScore` VARSA → FT yazılır ve
 *       normal uzlaşma boru hattı çalışır.
 *   (b) Kanıt YOKSA → skor yazılmaz; durum `OVERDUE_NO_RESULT` olur.
 *       "Maç bitti, sonuç alınamadı" demek — LIVE göstermek düpedüz yanlış
 *       bilgi. Para tarafı ayrıca korunuyor: `lib/bayat-mac.cjs` 48 saatte
 *       bahisleri iade ediyor.
 *
 * ⚠️ YAPIŞKAN DEĞİL. Maç beslemede yeniden görünürse ana döngü durumu
 * normal şekilde üzerine yazar (kaynak kesintisi geçiciyse kendini onarır).
 *
 * ⚠️ EŞİK CÖMERT: Bir futbol maçı uzatma + devre arası + gecikmeyle bile
 * 5 saati bulmaz. Erken davranmak, hâlâ oynayan maçı "bitti" göstermek
 * olurdu — bu yönde yanılmak daha pahalı.
 * ──────────────────────────────────────────────────────────────────────── */
const MAX_LIVE_SAAT = Number(process.env.SKORLIG_MAX_LIVE_SAAT || 5);

/** Fikstürün başlama anı (ms) — birden çok alan adı kullanılıyor. */
function kickoffMs(fixture) {
  return Date.parse(fixture?.kickoffISO || fixture?.kickoff || fixture?.dateISO || "");
}

/**
 * Beslemede olmayan ama durumu LIVE kalmış maçları kapatır.
 * @returns {Promise<{kapanan:number, kanitli:number, kanitsiz:number}>}
 */
async function takiliLiveUzlastir(fixtureList, gorulen, nowISO, settleQueue) {
  const simdi = Date.now();
  const sinir = MAX_LIVE_SAAT * 3600 * 1000;
  let kanitli = 0, kanitsiz = 0;

  /* Yalnızca aday olabilecekler için durum dosyası okunuyor: her turda 1400
   * dosya açmak gereksiz. Fikstür listesi zaten bellekte. */
  const adaylar = fixtureList.filter((f) => {
    const fid = String(f?.fixtureId || "");
    if (!fid || gorulen.has(fid)) return false;
    const ko = kickoffMs(f);
    return Number.isFinite(ko) && simdi - ko >= sinir;
  });

  let db = null;
  try { db = await dbAlSafe(); } catch { /* kanıt aranamaz, (b) yoluna düşer */ }

  for (const f of adaylar) {
    const fid = String(f.fixtureId);
    const st = await readJson(liveStateFile(fid), null);
    if (!st || String(st.status || "").toUpperCase() !== "LIVE") continue;

    // (a) Gerçek sonuç var mı?
    let skor = null;
    if (db) {
      try {
        const snap = await MatchResults.getSnapshot(fid, db);
        const h = Number(snap?.finalScore?.home);
        const a = Number(snap?.finalScore?.away);
        if (Number.isFinite(h) && Number.isFinite(a)) skor = { home: h, away: a };
      } catch (e) {
        console.error(`[sync/takili] ${fid} sonuc okunamadi:`, e?.message || e);
      }
    }

    if (skor) {
      /* FT'ye çeviriliyor. `writeLiveState` yolundan geçmiyoruz çünkü elimizde
       * `liveMatch` yok; damgalar burada elle set ediliyor. */
      const oncekiSkor = st.score || {};
      const skorAyni =
        Number(oncekiSkor.home) === skor.home && Number(oncekiSkor.away) === skor.away;
      await writeJsonAtomic(liveStateFile(fid), {
        ...st,
        status: "FT",
        isLive: false,
        score: skor,
        updatedAt: nowISO,
        source: "livescore-sync/takili-uzlastir",
        ilkFtAt: st.ilkFtAt || nowISO,
        skorSabitAt: skorAyni && st.skorSabitAt ? st.skorSabitAt : nowISO,
      });
      kanitli++;
      /* Uzlaşma kuyruğuna EKLENMİYOR: bu maçların sonucu zaten
       * `match_results` içinde, yani uzlaşma olmuş demektir (ölçümde 16'sının
       * `awardedAt` damgası vardı). Tekrar tetiklemek `claimAward` mührüne
       * çarpar — zararsız ama gereksiz iş. Kuyruk parametresi, ileride
       * kanıt uzlaşmadan ÖNCE gelirse diye imzada duruyor. */
      void settleQueue;
    } else {
      // (b) Kanıt yok — skora DOKUNULMUYOR, yalnızca yanlış "canlı" iddiası kalkıyor.
      await writeJsonAtomic(liveStateFile(fid), {
        ...st,
        status: "OVERDUE_NO_RESULT",
        isLive: false,
        updatedAt: nowISO,
        source: "livescore-sync/takili-uzlastir",
        sonucBeklemedeAt: st.sonucBeklemedeAt || nowISO,
      });
      kanitsiz++;
    }
  }

  if (kanitli || kanitsiz) {
    console.log(
      `[sync/takili] beslemeden dusen ${kanitli + kanitsiz} mac kapatildi ` +
      `(sonucu bilinen ${kanitli} -> FT, bilinmeyen ${kanitsiz} -> OVERDUE_NO_RESULT)`
    );
  }
  return { kapanan: kanitli + kanitsiz, kanitli, kanitsiz };
}

async function writeResultsEntry(fixture, scores, nowISO) {
  const results = await readJson(RESULTS_FILE, []);
  const list = Array.isArray(results) ? results : (results?.items || []);

  const idx = list.findIndex(r => r.fixtureId === fixture.fixtureId);
  const entry = idx >= 0 ? list[idx] : {
    fixtureId: fixture.fixtureId,
    home: fixture.home,
    away: fixture.away,
    source: "livescore-sync",
  };

  entry.homeScore  = scores.home;
  entry.awayScore  = scores.away;
  entry.status     = scores.isFT ? "FT" : "LIVE";
  entry.syncedAt   = nowISO;
  if (scores.htHome != null) {
    entry.htHome = scores.htHome;
    entry.htAway = scores.htAway;
  }

  if (idx >= 0) list[idx] = entry; else list.push(entry);

  const toWrite = Array.isArray(results) ? list : { items: list };
  await writeJsonAtomic(RESULTS_FILE, toWrite);
}

// ──────────────────────────────────────────────
// Trigger settle2 via HTTP
// ──────────────────────────────────────────────
async function triggerSettle(fixtureId) {
  const url = `http://localhost:${_apiPort}/api/rt/settle2?fixtureId=${encodeURIComponent(fixtureId)}`;
  try {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    if (j.ok) {
      console.log(`[sync] ✅ settle OK → ${fixtureId} (${j.settled} settled)`);
    } else {
      console.error(`[sync] ⚠️  settle FAILED → ${fixtureId}: ${j.error} — ${j.detail}`);
    }
    return j;
  } catch (e) {
    console.error(`[sync] settle fetch error → ${fixtureId}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ──────────────────────────────────────────────
// Main sync loop
// ──────────────────────────────────────────────
async function sync() {
  if (_syncInProgress) return _lastSync;
  _syncInProgress = true;

  const startMs = Date.now();
  const nowISO  = new Date().toISOString();

  try {
    // Fikstürler Mongo birincil — bkz. lib/fixtures-store.cjs.
    // Eskiden readJsonSync idi: JSON.parse SENKRON olduğu için 124 KB'lık
    // dosyayı her turda olay döngüsünü bloklayarak okuyordu.
    const fixtureList = await FixturesStore.loadAll();
    const lsCache      = livescoreScraper.getCache();

    if (!fixtureList.length) throw new Error("No fixtures");
    if (!lsCache?.leagues) throw new Error("Livescore cache empty");

    // Flatten livescore matches
    const allLive = [];
    for (const lg of Object.values(lsCache.leagues)) {
      if (lg.matches) allLive.push(...lg.matches);
    }

    // Yalnızca kimlik kümesi gerekiyor — tüm snapshot'ları (satırlarıyla
    // birlikte) belleğe almanın anlamı yok.
    const settledIds = await MatchResults.settledFixtureIds();

    let newFT = 0;
    let newLive = 0;
    let bekleyen = 0;   // kararlilik kapisinda bekleyen mac sayisi
    const settleQueue = [];

    /* Beslemede görülen maçlar. Görülmeyenler döngü sonunda uzlaştırılıyor —
     * bkz. takiliLiveUzlastir: `continue` yüzünden onlar bir daha hiç ele
     * alınmıyordu ve durumları sonsuza dek LIVE kalıyordu. */
    const gorulen = new Set();

    for (const fixture of fixtureList) {
      const fid      = fixture.fixtureId;
      const liveMatch = findLiveMatch(fixture, allLive);
      if (!liveMatch) continue;
      gorulen.add(String(fid));

      const htParsed = parseHT(liveMatch.htScore);
      const hasScore = liveMatch.homeScore != null && liveMatch.awayScore != null;

      const homeRaw = hasScore ? parseInt(liveMatch.homeScore, 10) : 0;
      const awayRaw = hasScore ? parseInt(liveMatch.awayScore, 10) : 0;

      if (hasScore && (!Number.isFinite(homeRaw) || !Number.isFinite(awayRaw) ||
          homeRaw < 0 || awayRaw < 0 || homeRaw > 99 || awayRaw > 99)) {
        console.error(
          `[sync] absurt skor reddedildi: ${fid} home=${liveMatch.homeScore} away=${liveMatch.awayScore}`
        );
        continue;
      }

      const scores = {
        home:   homeRaw,
        away:   awayRaw,
        isFT:   liveMatch.isFinished,
        htHome: htParsed?.home ?? null,
        htAway: htParsed?.away ?? null,
      };

      if (!hasScore && !htParsed) continue;

      /* UYARI: SKOR AYRISTIRILAMADIYSA FT YAZMA, SETTLE TETIKLEME.
       *
       * Yukarida `home`/`away` icin `hasScore ? parseInt(...) : 0` var — yani
       * skor okunamadiginda 0 UYDURULUYOR. Bu tek basina zararsiz (canli
       * durumda 0-0 gosterilir, sonraki tur duzeltir) ama `isFinished` de
       * dogruysa 0-0 FINAL olarak yazilip settle tetikleniyordu.
       *
       * Ulasilabilir yol: FT isareti gelmis, HT skoru ayrismis ama FT skoru
       * ayrismamis (kaynak isaretlemesi degisti, hucre bos). Sonuc: herkesin
       * tahmini 0-0'a gore puanlanir, LC yanlis dagitilir — ve `claimAward`
       * muhru atildigi icin KENDI KENDINE DUZELMEZ.
       *
       * Ayni sinifta bir hata bu dosyada zaten yasanmisti (bkz. normalizeTeam
       * notu: yanlis takim eslesmesi -> yanlis settle, 1411 takimin 30'u).
       *
       * Dogru davranis: FT'yi YOK SAY. Skor sonraki turda gelirse normal
       * akis calisir; hic gelmezse bayat mac temizleyicisi 48 saat sonra
       * bahisleri iade eder — para kilitli kalmaz. */
      const ftGuvenilir = scores.isFT && hasScore;

      /* UYARI: CANLI DURUM YAZIMI DA ATLANIYOR — yalnizca sonuc dosyasi degil.
       *
       * settle2 skoru CANLI DURUM DOSYASINDAN okuyor (`fx.score.home`). Eger
       * burada `status:"FT", score:{0,0}` yazsaydik, settle'i baska bir yol
       * tetikledigi anda (af-sync, admin paneli, elle /rt/settle) 0-0
       * uzlastirilirdi. Yani yalnizca settle tetigini kapatmak YETMEZ;
       * guvenilmez veriyi hic yazmamak gerekiyor.
       *
       * Onceki (dogru) durum dosyasi yerinde kaliyor; skor sonraki turda
       * gelirse normal akis calisir. Hic gelmezse bayat mac temizleyicisi
       * 48 saat sonra bahisleri iade eder — para kilitli kalmaz. */
      if (scores.isFT && !hasScore) {
        console.error(
          `[sync] FT bildirildi ama skor ayristirilamadi -> ${fid} ` +
          `(${fixture.home} - ${fixture.away}); durum ve sonuc YAZILMIYOR, settle TETIKLENMIYOR`
        );
        continue;
      }

      // Write live state (HT+FT veya sadece LIVE)
      await writeLiveState(fid, liveMatch, scores, nowISO);
      if (ftGuvenilir) await writeResultsEntry(fixture, scores, nowISO);

      /* UYARI: UZLASMA SONRASI SKOR DEGISIMI.
       *
       * Uzlasma `claimAward` ile muhurlu — ayni mac iki kez odeme yapmasin
       * diye. Dogru bir koruma ama yan etkisi var: skor SONRADAN degisirse
       * (VAR karari, kaynak duzeltmesi) yeniden uzlasma OLMUYOR ve puanlar/LC
       * kalici olarak yanlis kaliyor. Bunu fark eden hicbir sey yoktu.
       *
       * Otomatik duzeltme YAPILMIYOR: dagitilmis LC'yi geri almak bakiyeyi
       * eksiye dusurebilir. Karar operatorun; burada yalnizca kalici iz
       * birakiliyor. bkz. lib/skor-uyusmazlik.cjs */
      if (ftGuvenilir && settledIds.has(fid)) {
        try {
          const dbU = await dbAlSafe();
          if (dbU) {
            const snap = await MatchResults.getSnapshot(fid, dbU);
            const guncel = { home: scores.home, away: scores.away };
            if (snap && SkorUyusmazlik.farkliMi(snap.finalScore, guncel)) {
              await SkorUyusmazlik.kaydet(dbU, {
                fixtureId: fid,
                mac: `${fixture.home} - ${fixture.away}`,
                muhurluSkor: snap.finalScore,
                guncelSkor: guncel,
              });
            }
          }
        } catch (e) {
          console.error("[sync] skor uyusmazligi kontrolu basarisiz:", e?.message || e);
        }
      }

      // Settle trigger — sadece GUVENILIR FT + daha önce settle edilmemişse
      if (ftGuvenilir && !settledIds.has(fid) && !_settledThisSession.has(fid)) {
        /* ⚠️ KARARLILIK KAPISI: skor SABİTLENELİ en az FT_BEKLEME_DK olmalı.
         *
         * Uzlaşma mühürlü ve geri alınamıyor; bir kez ödedikten sonra skor
         * düzelse bile puan/LC yanlış kalıyor. Bu kapı, kaynağın erken FT
         * demesi ya da skoru düzeltmesi için pencere bırakıyor.
         *
         * Bekleme KAYBA yol açmaz: sonraki tur aynı maçı yeniden görüyor ve
         * kapı açıldığında uzlaştırıyor. Sonuç hiç oturmazsa `lib/bayat-mac`
         * 48 saatte parayı iade ediyor. */
        const beklendi = ftBeklemesiDoldu(await readJson(liveStateFile(fid), null), Date.now());
        if (beklendi.hazir) {
          settleQueue.push(fid);
          newFT++;
        } else {
          bekleyen++;
        }
      } else if (!ftGuvenilir && hasScore) {
        newLive++;
      }
    }

    /* ⚠️ SIZINTI KAPISI. Yukarıdaki döngü yalnızca BESLEMEDE OLAN maçları
     * günceller; beslemeden düşen bir maç sonsuza dek LIVE kalıyordu
     * (ölçüldü: 160 kayıt, en yaşlısı 15 gün). Hata fırlatmasın — ana
     * senkron akışı bundan etkilenmemeli. */
    let takiliSonuc = { kapanan: 0, kanitli: 0, kanitsiz: 0 };
    try {
      takiliSonuc = await takiliLiveUzlastir(fixtureList, gorulen, nowISO, settleQueue);
    } catch (e) {
      console.error("[sync/takili] uzlastirma basarisiz:", e?.message || e);
    }

    // Settle sırayla (flood önlemi)
    for (const fid of settleQueue) {
      _settledThisSession.add(fid); // optimistic lock
      await triggerSettle(fid);
      await new Promise(r => setTimeout(r, 500)); // biraz bekle aralarında
    }

    const duration = Date.now() - startMs;
    if (newFT || newLive) {
      console.log(`[sync] ${nowISO} — FT settle: ${newFT}, live updates: ${newLive} (${duration}ms)`);
    }

    _lastSync = { ts: nowISO, newFT, newLive, duration, takili: takiliSonuc };
    return _lastSync;
  } catch (e) {
    console.error("[sync] error:", e.message);
    _lastSync = { ts: nowISO, error: e.message };
    return _lastSync;
  } finally {
    _syncInProgress = false;
  }
}

function getLastSync() { return _lastSync || { ts: null }; }

function start(intervalMs = 30 * 1000, apiPort = 4102) {
  _apiPort = apiPort;
  console.log(`[sync] starting, interval=${intervalMs / 1000}s`);
  sync();
  setInterval(sync, intervalMs);
}

// normalizeTeam/findLiveMatch test edilebilir olsun diye export edilir —
// eşleştirme hataları sessizce yanlış skor yazdırdığı için doğrulanabilir olmalı.
module.exports = {
  sync, getLastSync, start, normalizeTeam, findLiveMatch, TEAM_MAP,
  // Test icin: kararlilik kapisi saf fonksiyon, kendi kopyasini yazmak yerine
  // gercegi cagrilsin (bu oturumda kopya-mantik iki kez yesil-ama-olu test uretti).
  ftBeklemesiDoldu, FT_BEKLEME_DK, parseMinute,
  // Takili LIVE sizintisinin kapisi — davranisi dogrudan sinanabilsin diye acik.
  takiliLiveUzlastir, MAX_LIVE_SAAT,
  // Normalizasyon onbellegi sifirlama (test + olasi TEAM_MAP degisikligi icin).
  _resetNormalizeCache,
};
