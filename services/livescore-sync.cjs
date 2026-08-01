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
function normalizeTeam(name) {
  if (!name) return "";
  const raw = String(name).toLowerCase();
  const qMatch = raw.match(QUALIFIER_RE);
  const qualifier = qMatch ? "|" + qMatch[0].replace(/\s+/g, "") : "";

  const n = baseNormalize(name);
  if (!n) return raw.trim() + qualifier;

  for (const [canonical, variants] of Object.entries(TEAM_MAP)) {
    if (variants.some(v => baseNormalize(v) === n)) return canonical + qualifier;
  }
  return n + qualifier;
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

    st.ilkFtAt = oncedenFT && prev?.ilkFtAt ? prev.ilkFtAt : nowISO;
    st.skorSabitAt = oncedenFT && skorAyni && prev?.skorSabitAt ? prev.skorSabitAt : nowISO;
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

  await writeJsonAtomic(stateFile, st);
}

// ──────────────────────────────────────────────
// Also write to results.json so settle2 bootstrap picks it up
// ──────────────────────────────────────────────
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

    for (const fixture of fixtureList) {
      const fid      = fixture.fixtureId;
      const liveMatch = findLiveMatch(fixture, allLive);
      if (!liveMatch) continue;

      const htParsed = parseHT(liveMatch.htScore);
      const hasScore = liveMatch.homeScore != null && liveMatch.awayScore != null;

      const scores = {
        home:   hasScore ? parseInt(liveMatch.homeScore, 10) : 0,
        away:   hasScore ? parseInt(liveMatch.awayScore, 10) : 0,
        isFT:   liveMatch.isFinished,
        htHome: htParsed?.home ?? null,
        htAway: htParsed?.away ?? null,
      };

      if (!hasScore && !htParsed) continue; // maç henüz başlamadı

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

    _lastSync = { ts: nowISO, newFT, newLive, duration };
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
  ftBeklemesiDoldu, FT_BEKLEME_DK,
};
