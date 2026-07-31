"use strict";

/**
 * HIZ SINIRI
 *
 * Önceki sürümün üç sorunu vardı:
 *   1) KAPSAM — yalnızca /api/pred/submit sınırlıydı; cüzdan satın alma,
 *      günlük LC, düello/turnuva oluşturma, settle dahil DİĞER HER ŞEY
 *      sınırsızdı (`windowFor` eşleşmeyen her rotaya 0 dönüyordu).
 *   2) BELLEK — sayaç Map'i hiç tahliye edilmiyordu, sınırsız büyüyordu.
 *   3) ÇOK SÜREÇ — süreç-içi sayaç, N instance'lı deploy'da limiti N katına
 *      çıkarıyordu.
 *
 * Sayaç artık lib/rate-store.cjs üzerinden: REDIS_URL varsa Redis (tüm
 * instance'larda ortak), yoksa tahliyeli bellek.
 *
 * Kapatmak için: SKORLIG_RATE_LIMIT=0
 */

const { hit, stats } = require("../lib/rate-store.cjs");

const ENABLED = String(process.env.SKORLIG_RATE_LIMIT ?? "1") !== "0";

/* ── Muaf yollar ─────────────────────────────────────────────────────────
 * Mobil istemcinin sık yokladığı okuma uçları. Bunlar yazma yapmaz ve
 * sınırlanırsa uygulama gözle görülür şekilde bozulur.
 */
const SKIP = [
  /\/health$/,
  /\/api\/rt\/state\b/,
  /\/api\/rt\/board\b/,
  /\/api\/rt\/disabled\b/,
  /\/api\/rt\/poll\b/,          // zaten MAX_POLL koruması var
  /\/api\/fixtures\/list\b/,
  /\/api\/leaderboard\b/,
];

/* ── Rota kuralları ──────────────────────────────────────────────────────
 * İlk eşleşen kural uygulanır. Eşleşme yoksa DEFAULT geçerli — eski sürümde
 * eşleşmeyen her rota tamamen muaftı, asıl açık buydu.
 */
const RULES = [
  // Tahmin gönderimi: eski davranışın aynısı (5 saniyede bir).
  { re: /\/api\/pred\/submit\b/, max: 1, windowMs: 5_000 },

  // Para/bakiye etkileyen uçlar — en dar sınır.
  { re: /\/lc-wallet\/purchase\b/,          max: 5,  windowMs: 60_000 },
  { re: /\/lc-wallet\/premium\/subscribe\b/, max: 5,  windowMs: 60_000 },
  { re: /\/lc-wallet\/daily-claim\b/,       max: 10, windowMs: 60_000 },

  // Kimlik/profil yazma
  { re: /\/api\/users\/set-/, max: 20, windowMs: 60_000 },

  // Oluşturma uçları (davet/düello/turnuva spam'i)
  { re: /\/duels?\//,            max: 30, windowMs: 60_000 },
  { re: /\/mini\/create\b/,      max: 10, windowMs: 60_000 },
  { re: /\/friends\/invite\b/,   max: 20, windowMs: 60_000 },
  /* /use-invite AYRI: yukaridaki `\/friends\/invite` kalibi "use-invite"i
   * TUTMUYOR (yol /friends/use-invite). Bu uc LC BASIYOR — kuralsiz kalinca
   * varsayilana (dk/120) dusuyordu. */
  { re: /\/friends\/use-invite\b/, max: 10, windowMs: 60_000 },

  /* ⚠️ KOD DENEME UÇLARI — en dar sınır.
   * İkisi de `is1987` veriyor: açılış bakiyesi 60 LC (normalde 30), ücretsiz
   * haftalık seçim, premium tabanı. Yani doğru tahmin PARA kazandırıyor.
   * DEFAULT_RULE (120/dk) bir kod deneme ucu için fazla cömert — dakikada 120
   * deneme, saatte 7200 eder. 5/dk meşru kullanımı (kullanıcı kodu bir kez
   * yazar, yanılırsa birkaç kez dener) hiç etkilemez.
   */
  { re: /\/weekly-picks\/verify-code\b/, max: 5, windowMs: 60_000 },
  { re: /\/auth1987gs\/verify\b/,        max: 5, windowMs: 60_000 },

  /* Para hareketi: havuz bahsi ve turnuva giriş/ödemesi. DEFAULT_RULE'a
   * bırakılmışlardı; meşru kullanımın çok üstünde ama flood'u durduran sınır.
   */
  { re: /\/pool\/[^/]+\/bet\b/,  max: 20, windowMs: 60_000 },

  /* Haftalik kupon: katilim GIRIS BEDELI dusuyor. Kural yokken varsayilana
   * (dk/120) dusuyordu; her deneme LC dusup iade ettigi icin dakikada 120
   * cuzdan yazmasi + defter kaydi demekti. Para kaybi yok, yuk gercek. */
  { re: /\/kupon\/katil\b/,   max: 10, windowMs: 60_000 },
  { re: /\/kupon\/tahmin\b/,  max: 30, windowMs: 60_000 },

  /* 1987GS haftalik secim: LC_COST_NORMAL dusuyor. */
  { re: /\/weekly-picks\/predict\b/, max: 20, windowMs: 60_000 },
  { re: /\/tournaments\/(create|join|settle)\b/, max: 10, windowMs: 60_000 },
  { re: /\/groups\/(create|join)\b/,             max: 10, windowMs: 60_000 },
];

// Kural eşleşmeyen her şey için üst sınır. Cömert (saniyede ~2) ama
// sınırsız değil — eskiden buradaki her rota tamamen korumasızdı.
const DEFAULT_RULE = {
  max: Number(process.env.SKORLIG_RATE_DEFAULT_MAX || 120),
  windowMs: 60_000,
};

function ruleFor(url) {
  for (const s of SKIP) if (s.test(url)) return null;
  for (const r of RULES) if (r.re.test(url)) return r;
  return DEFAULT_RULE;
}

/**
 * İstek sunucunun kendi içinden mi geliyor?
 *
 * services/bot-filler.cjs her turda kendi API'sine 25 istek atıyor
 * (http://127.0.0.1:PORT/api/pred/bots-generate); af-sync de settle2'yi
 * böyle çağırıyor. Bunları sınırlamak kendi zamanlayıcımızı boğardı.
 *
 * Ölçüt: proxy başlığı YOK **ve** soket loopback. Render/nginx arkasında
 * dış trafiğin daima x-forwarded-for'u olur, ayrıca dış bir istemcinin
 * soketi loopback olamaz — yani dışarıdan taklit edilemez.
 */
function isInternal(req) {
  if (req.headers["x-forwarded-for"]) return false;
  const ip = String(req.socket?.remoteAddress || "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/* ── İki katmanlı anahtarlama ────────────────────────────────────────────
 * Bu middleware router'lardan ÖNCE çalışır, yani verifyToken henüz req.uid'i
 * yazmamıştır. Elimizdeki tek kimlik ipucu istemcinin gönderdiği x-user-id
 * başlığı — ve o taklit edilebilir.
 *
 * Sadece IP'ye anahtarlamak da olmaz: mobil kullanıcılar operatör NAT'ı
 * arkasında aynı IP'yi paylaşır, tek limit binlerce kullanıcıyı birbirine
 * bağlar ve masum kullanıcılar 429 yer.
 *
 * Çözüm iki katman:
 *   1) (IP + kimlik ipucu + rota) → rota kuralı. NAT'taki farklı kullanıcılar
 *      ayrı kovalara düşer.
 *   2) (IP) → yüksek tavan. Kimliği değiştirerek 1. katmanı atlayan saldırgan
 *      buraya takılır; normal kullanıcı asla göremez.
 */
/**
 * ⚠️ ESKİDEN `xff.split(",")[0]` OKUYORDU — o giriş TAMAMEN İSTEMCİ
 * DENETİMİNDE. Proxy başlığı silmez, SONUNA ekler; istemci uydurma bir değer
 * yollayınca soldan okuma o uydurmayı verir ve saldırgan her istekte kendine
 * YENİ KOVA açar. Aşağıdaki IP tavanı da aynı `ipOf`u kullandığı için yedek,
 * yedeklediği şeyle aynı delikteydi. bkz. lib/istemci-ip.cjs
 */
const { istemciIp: ipOf } = require("../lib/istemci-ip.cjs");

function keyFor(req, url) {
  // req.uid varsa (ileride limiter auth sonrasına taşınırsa) o tercih edilir.
  const uid = req.uid || req.headers["x-user-id"] || "-";
  return `${ipOf(req)}|${uid}|${url}`;
}

// IP tavanı: tüm rotalar toplamı. Tek kullanıcının meşru trafiğinin çok
// üstünde, ama kimlik döndürerek yapılan flood'u durduracak kadar dar.
const IP_CEILING = {
  max: Number(process.env.SKORLIG_RATE_IP_MAX || 600),
  windowMs: 60_000,
};

// Kural eşleşmesi rotaya göre olmalı; sorgu dizesi anahtarı şişirir
// (?t=... gibi cache-buster'lar her istekte yeni anahtar üretirdi).
function pathOf(req) {
  const raw = String(req.originalUrl || req.url || req.path || "/");
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

function tooMany(res, resetMs, rule) {
  res.setHeader("Retry-After", Math.max(1, Math.ceil(resetMs / 1000)));
  return res.status(429).json({
    ok: false,
    error: "RATE_LIMIT",
    waitMs: resetMs,
    limit: rule.max,
    windowMs: rule.windowMs,
  });
}

async function rateLimit(req, res, next) {
  if (!ENABLED) return next();

  try {
    if (isInternal(req)) return next();

    const url = pathOf(req);
    const rule = ruleFor(url);
    if (!rule) return next();

    // 1. katman: rota kuralı (IP + kimlik ipucu + rota)
    const r1 = await hit(keyFor(req, url), rule.windowMs);
    // count === 0 → store erişilemedi (fail-open), sınırlama uygulanmaz.
    if (r1.count > 0 && r1.count > rule.max) {
      return tooMany(res, r1.resetMs, rule);
    }

    // 2. katman: IP tavanı — kimlik değiştirerek 1. katmanı atlayanı yakalar
    const r2 = await hit(`ip|${ipOf(req)}`, IP_CEILING.windowMs);
    if (r2.count > 0 && r2.count > IP_CEILING.max) {
      return tooMany(res, r2.resetMs, IP_CEILING);
    }

    return next();
  } catch (e) {
    // Limiter kendi hatası yüzünden trafiği kesmemeli.
    console.error("[rateLimit] hata, istek geciriliyor:", e.message || e);
    return next();
  }
}

module.exports = rateLimit;
module.exports.stats = stats;
// Test icin: bir URL hangi kurala dusuyor (nobetci testi bunu kullaniyor).
module.exports._ruleFor = ruleFor;
module.exports._DEFAULT_RULE = DEFAULT_RULE;
