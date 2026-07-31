"use strict";

// Firebase Admin SDK token doğrulama (modüler API — firebase-admin v12+)
// Yerel: firebase-service-account.json  |  Prod: FIREBASE_SERVICE_ACCOUNT_JSON env

const path = require("path");
const fs   = require("fs");

// ─── Ban cache (60 sn TTL, her restart'ta sıfırlanır) ────────────────────────
const Moderation = require("../lib/moderation-store.cjs");
let _bannedCache  = new Set();
let _bannedAt     = 0;

async function isBanned(uid) {
  if (Date.now() - _bannedAt > 60_000) {
    try {
      // ⚠️ Yasak listesi Mongo birincil — bkz. lib/moderation-store.cjs.
      // Eskiden doğrudan banned-users.json okunuyordu ve dosya yoksa
      // `catch { new Set() }` çalışıyordu: "kimse yasaklı değil". Render'da
      // disk kalıcı olmadığı için o dosya HER DEPLOY'DA siliniyordu, yani
      // tüm yasaklar sessizce kalkıyordu. Fail-open bir güvenlik kontrolü,
      // hiç olmamasından daha kötü: koruyor sanılıyor.
      _bannedCache = await Moderation.bannedSet(null);
    } catch (e) {
      // Okunamadıysa ESKİ ÖNBELLEĞİ KORU — boş kümeye düşmek yasakları kaldırır.
      console.error("[verifyToken] yasak listesi okunamadi, onceki liste korunuyor:", e?.message || e);
    }
    _bannedAt = Date.now();
  }
  return _bannedCache.has(String(uid || "").toLowerCase());
}

const { uretimMi } = require("../lib/ortam.cjs");

let _auth = null;
let _sonDeneme = 0;

/**
 * ⚠️ ESKİDEN TEK DENEME VARDI (`_initTried`) ve başarısızlık KALICIYDI.
 * İlk deneme geçici bir nedenle (ağ, yavaş disk, env henüz yüklenmemiş)
 * patlarsa süreç yeniden başlatılana kadar kimlik doğrulama bir daha hiç
 * kurulamıyordu. Fail-closed davranışla birlikte bu, tek bir anlık arızanın
 * sunucuyu kalıcı olarak 503'e kilitlemesi demek olurdu. Artık 60 saniyede
 * bir yeniden deneniyor: geçici arıza kendiliğinden toparlanır.
 */
const YENIDEN_DENE_MS = 60_000;

function getFirebaseAuth() {
  if (_auth) return _auth;
  if (Date.now() - _sonDeneme < YENIDEN_DENE_MS) return null;
  _sonDeneme = Date.now();

  try {
    const { initializeApp, cert, applicationDefault, getApps } = require("firebase-admin/app");
    const { getAuth } = require("firebase-admin/auth");

    if (!getApps().length) {
      const filePath = path.join(__dirname, "..", "firebase-service-account.json");
      const envJson  = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      const envB64   = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

      if (fs.existsSync(filePath)) {
        initializeApp({ credential: cert(require(filePath)) });
      } else if (envB64) {
        // Base64-encoded JSON (Render env variable için stabil)
        const decoded = Buffer.from(envB64, 'base64').toString('utf-8');
        initializeApp({ credential: cert(JSON.parse(decoded)) });
      } else if (envJson) {
        initializeApp({ credential: cert(JSON.parse(envJson)) });
      } else {
        initializeApp({ credential: applicationDefault() });
      }
    }
    _auth = getAuth();
    console.log("[verifyToken] firebase-admin initialized");
  } catch (e) {
    console.warn("[verifyToken] firebase-admin init failed:", e.message);
    _auth = null;
  }
  return _auth;
}

/**
 * FIREBASE KURULAMADIĞINDA NE OLUR?
 *
 * ⚠️ BULUNAN AÇIK — bu, kod tabanındaki en kritik kapının fail-OPEN olmasıydı.
 * Eski kod şunu yapıyordu:
 *
 *     if (!fbAuth) { req.uid = req.headers["x-user-id"] || "dev"; return next(); }
 *
 * Yani `firebase-admin` KURULAMAZSA — tek bir bozuk/eksik
 * `FIREBASE_SERVICE_ACCOUNT_B64`, bir JSON ayrıştırma hatası, geçici bir
 * arıza — sunucu her isteği KABUL EDİYOR ve kimliği İSTEMCİNİN GÖNDERDİĞİ
 * başlıktan alıyordu. `x-user-id: kurban` yazan herkes kurbanın cüzdanını
 * harcayabilir, hesabını silebilirdi.
 *
 * ⚠️ VE FARK EDİLMEZDİ: `mobile/lib/apiFetch.ts` zaten HER istekte
 * `x-user-id` gönderiyor. Yani uygulama sorunsuz çalışmaya devam ederdi;
 * tek belirti açılışta akıp giden bir `console.warn` satırı olurdu.
 *
 * Aynı ilke bu kod tabanında İKİ KEZ yazılı:
 *   • middleware/requireAdmin.cjs — "token tanımlı değilse 503 döner, GEÇİRMEZ"
 *   • bu dosyanın kendi yasak listesi notu — "fail-open bir güvenlik kontrolü,
 *     hiç olmamasından daha kötü: koruyor sanılıyor"
 * En önemli kapı ikisini de çiğniyordu.
 *
 * Artık: ÜRETİMDE 503 (geçirmez). Yerelde geri düşüş korunuyor — orada
 * servis hesabı dosyası olmadan çalışmak olağan — ama gürültülü.
 */
function kimlikYokKapali(req, res, next) {
  if (uretimMi()) {
    console.error(
      "[verifyToken] ⛔ firebase-admin KURULAMADI — uretimde istek GECIRILMIYOR. " +
      "FIREBASE_SERVICE_ACCOUNT_B64 / _JSON degerini kontrol et."
    );
    return res.status(503).json({ ok: false, error: "AUTH_NOT_CONFIGURED" });
  }
  console.warn(
    "[verifyToken] ⚠️ firebase-admin yok — YEREL GERI DUSUS: kimlik x-user-id " +
    "basligindan aliniyor. Bu davranis uretimde KAPALI."
  );
  req.uid = req.headers["x-user-id"] || "dev";
  return next();
}

/**
 * Sağlık ucu bunu bildiriyor: yanlış yapılandırılmış dağıtım görünür olsun.
 *
 * ⚠️ KURULUMU TETİKLER. `_auth` tembel kuruluyor (ilk istekte). Yalnızca
 * `_auth`a bakan bir sürüm, HENÜZ İSTEK GELMEMİŞ taze bir sunucuda "kapalı"
 * derdi — sağlık ucu var olmayan bir arıza bildirirdi. Burada kurulum
 * denenip sonucu okunuyor.
 */
function kimlikModu() {
  if (getFirebaseAuth()) return "firebase";
  return uretimMi() ? "kapali" : "yerel-gecis";
}

/**
 * Zorunlu kimlik: x-auth-token doğrulanır, req.uid set edilir.
 * Token yok/geçersizse 401.
 */
async function verifyToken(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (!token) {
    return res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
  }

  const fbAuth = getFirebaseAuth();
  if (!fbAuth) return kimlikYokKapali(req, res, next);

  try {
    const decoded    = await fbAuth.verifyIdToken(token);
    req.uid          = decoded.uid;
    req.firebaseUser = decoded;
    if (await isBanned(req.uid)) {
      return res.status(403).json({ ok: false, error: "USER_BANNED" });
    }
    next();
  } catch (e) {
    console.warn("[verifyToken] invalid token:", e.message);
    return res.status(401).json({ ok: false, error: "INVALID_TOKEN" });
  }
}

/**
 * Opsiyonel kimlik: token varsa doğrula, yoksa anonim geç.
 */
async function optionalToken(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (!token) { req.uid = null; return next(); }

  /* ⚠️ BURADA DA İSTEMCİ BAŞLIĞINA GÜVENİLİYORDU. `optionalToken` kimliği
   * zorunlu kılmıyor ama set ettiği `req.uid` aşağı akıyor — örneğin
   * `/api/daily-picks/streak` onu doğrudan kullanıyor. Üretimde anonim
   * (`null`) geçmek doğru davranış: kimlik doğrulanamıyorsa kimlik YOKTUR. */
  const fbAuth = getFirebaseAuth();
  if (!fbAuth) {
    req.uid = uretimMi() ? null : (req.headers["x-user-id"] || null);
    return next();
  }

  try {
    const decoded    = await fbAuth.verifyIdToken(token);
    req.uid          = decoded.uid;
    req.firebaseUser = decoded;
  } catch {
    req.uid = null;
  }
  next();
}

module.exports = { verifyToken, optionalToken, getFirebaseAuth, kimlikModu };
