"use strict";

/**
 * YÖNETİCİ TOKEN'I — tek yer.
 *
 * NEDEN VAR (2026-07-30'da bulunan açık): aynı kontrol dört ayrı dosyada
 * elle yazılmıştı (admin-users, admin-runtime, auth-1987gs, pred). Beşincisi
 * — `routes/admin-live.cjs` — hiç yazılmadı. Dosyanın kendi başlığı bunu
 * itiraf ediyordu: "Token kontrolünü bu router'a koymadım."
 *
 * Sonuç kozmetik değildi. O router `/api/admin` altına mount ediliyor ve
 * KİMLİK DOĞRULAMASIZ yedi POST ucu açıyor:
 *
 *   POST /api/admin/match/final?fixtureId=X&home=3&away=0
 *     → data/live/X.json dosyasına skoru yazar ve status'u "FT" yapar.
 *
 * settle2 ödemeyi hesaplarken TAM O DOSYAYI okuyor (`stateFile(fid)` →
 * `st.score`, `st.status === "FT"` şartı). Otomatik settle servisi de FT olan
 * maçları tarıyor. Yani kimliksiz tek istek bir maçın nihai skorunu belirleyip
 * gerçek LC dağıtımını tetikleyebiliyordu — saldırgan kendi tahminine uyan
 * skoru yazıp ödeme alabilirdi.
 *
 * Kopyalamak yerine buraya çıkarıldı: altıncı bir yönetici router'ı
 * eklendiğinde kontrolü yeniden yazmak gerekmesin, unutulacak bir şey olmasın.
 *
 * ⚠️ KAPALI BAŞARISIZLIK: token tanımlı değilse 503 döner, GEÇİRMEZ. Yasak
 * listesi bir kez "dosya okunamayınca boş küme" mantığıyla fail-open olmuştu;
 * aynı hatayı burada yapmıyoruz.
 */

/**
 * Beklenen token. `SKORLIG_ADMIN_TOKEN` kanoniktir (.env.example'da o var);
 * diğer ikisi eski kurulumlar için geriye uyumluluk — admin-users.cjs zaten
 * üçünü de kabul ediyordu, daraltmak çalışan panelleri kırardı.
 */
function beklenenToken() {
  return String(
    process.env.SKORLIG_ADMIN_TOKEN ||
    process.env.ADMIN_TOKEN ||
    process.env.EXPO_PUBLIC_ADMIN_TOKEN ||
    ""
  ).trim();
}

/**
 * Express ara katmanı. Hem tek uçta (`router.post(yol, requireAdmin, ...)`)
 * hem router genelinde (`router.use(requireAdmin)`) kullanılabilir.
 */
function requireAdmin(req, res, next) {
  const beklenen = beklenenToken();
  if (!beklenen) {
    return res.status(503).json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });
  }
  // Başlık tercih edilir; sorgu parametresi tarayıcıdan panel açmak için
  // kabul ediliyor (mevcut panellerin kullandığı biçim).
  const gelen =
    String(req.headers["x-admin-token"] || "").trim() ||
    String(req.query?.token || "").trim();

  if (gelen && gelen === beklenen) return next();
  return res.status(401).json({ ok: false, error: "ADMIN_TOKEN_REQUIRED" });
}

/** Ara katman olarak kullanılamayan yerler için boolean sürüm. */
function isAdminRequest(req) {
  const beklenen = beklenenToken();
  if (!beklenen) return false;
  const gelen =
    String(req.headers["x-admin-token"] || "").trim() ||
    String(req.query?.token || "").trim();
  return !!gelen && gelen === beklenen;
}

module.exports = { requireAdmin, isAdminRequest, beklenenToken };
