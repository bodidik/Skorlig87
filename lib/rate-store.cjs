"use strict";

/**
 * HIZ SINIRI SAYACI — Redis varsa Redis, yoksa bellek.
 *
 * NEDEN İKİ MOD: Rate limit'in doğru çalışması için sayaç TÜM süreçlerde ortak
 * olmalı. Süreç-içi Map ile 3 instance'lı bir deploy'da limit fiilen 3 katına
 * çıkar. Ama Redis henüz sağlanmadıysa uygulama çalışmaya devam etmeli —
 * bu yüzden REDIS_URL yoksa bellek moduna düşer.
 *
 * Bellek modunda TAHLİYE ŞART: eski sürümde sayaçlar hiç silinmiyordu, her
 * yeni (ip, kullanıcı, rota) üçlüsü kalıcı olarak Map'te kalıyordu — 500k
 * kullanıcıda sınırsız büyüyen bir bellek sızıntısı.
 *
 * Algoritma: sabit pencere sayacı. `hit()` sayacı artırır ve pencerenin
 * kalan süresini döner. Redis'te INCR + PEXPIRE atomiktir (pipeline).
 *
 * ARIZA DURUŞU: Redis düşerse istek ENGELLENMEZ (fail-open). Rate limit bir
 * koruma katmanıdır; Redis kesintisinin tüm API'yi kapatması çok daha kötü
 * olurdu.
 */

const REDIS_URL = process.env.REDIS_URL || process.env.SKORLIG_REDIS_URL || "";
const PREFIX = process.env.SKORLIG_RATE_PREFIX || "rl:";

let _redis = null;
let _redisDown = false;
// Son bağlantı hatası. error olayı yalnızca İLK seferde loglanıyor (gürültü
// olmasın diye) — sonrakiler kayboluyordu ve "reconnecting" durumunda SEBEP
// hiçbir yerden okunamıyordu. Tanı ucu bunu gösterir.
let _lastError = null;

function initRedis() {
  if (!REDIS_URL || _redis) return _redis;

  try {
    const Redis = require("ioredis");
    _redis = new Redis(REDIS_URL, {
      // Rate limit isteğin önünde durur: Redis yavaşsa isteği bekletmek
      // yerine hızlıca vazgeçip fail-open davranmak gerekir.
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      enableOfflineQueue: false,
      lazyConnect: false,
    });

    _redis.on("error", (e) => {
      _lastError = { message: String(e?.message || e).slice(0, 300), at: new Date().toISOString() };
      if (!_redisDown) {
        _redisDown = true;
        console.error("[rate-store] Redis hatasi, bellek moduna dusuluyor:", e.message);
      }
    });
    _redis.on("ready", () => {
      if (_redisDown) console.log("[rate-store] Redis tekrar hazir");
      _redisDown = false;
      _lastError = null;
    });

    console.log("[rate-store] Redis modu");
  } catch (e) {
    console.error("[rate-store] ioredis yuklenemedi, bellek modu:", e.message);
    _redis = null;
  }
  return _redis;
}

/* ── Bellek modu ────────────────────────────────────────────────────────── */

const _mem = new Map(); // key -> { count, resetAt }

// Süresi dolmuş anahtarları periyodik temizle. Tahliye olmadan Map sonsuza
// kadar büyür (eski sürümdeki sızıntı).
const SWEEP_MS = 60 * 1000;
const _sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _mem) {
    if (v.resetAt <= now) _mem.delete(k);
  }
}, SWEEP_MS);
_sweeper.unref?.();

function memHit(key, windowMs) {
  const now = Date.now();
  const cur = _mem.get(key);

  if (!cur || cur.resetAt <= now) {
    const rec = { count: 1, resetAt: now + windowMs };
    _mem.set(key, rec);
    return { count: 1, resetMs: windowMs };
  }

  cur.count++;
  return { count: cur.count, resetMs: Math.max(0, cur.resetAt - now) };
}

/* ── Ortak API ──────────────────────────────────────────────────────────── */

// Redis erişilemediğinde dönen değer. count=0, çağıran tarafta "sınırlama
// uygulama" anlamına gelir (fail-open) — Redis kesintisi API'yi kapatmamalı.
const FAIL_OPEN = Object.freeze({ count: 0, resetMs: 0 });

/**
 * Sayacı bir artır.
 * @returns {Promise<{count:number, resetMs:number}>} pencere içindeki toplam
 *   istek ve pencerenin bitmesine kalan süre. Redis erişilemezse
 *   `{count: 0}` döner — çağıran bunu "sınırlama" saymamalı (fail-open).
 */
async function hit(key, windowMs) {
  const r = initRedis();

  if (r && !_redisDown) {
    try {
      const k = PREFIX + key;
      const res = await r.pipeline().incr(k).pttl(k).exec();

      // ⚠️ ioredis'te pipeline().exec() komut hatalarında FIRLATMAZ: bağlantı
      // kopukken sonuç null olur ya da her girdi [hata, değer] biçiminde hata
      // taşır. Bunu kontrol etmezsek count `undefined` döner — sayaç sessizce
      // çalışmaz ve resetMs (Retry-After) bozulur.
      const cmdErr = !Array.isArray(res) || res.some((e) => !e || e[0]);
      if (cmdErr) return FAIL_OPEN;

      const count = Number(res[0][1]);
      const pttl = Number(res[1][1]);
      if (!Number.isFinite(count)) return FAIL_OPEN;

      // İlk istek (veya TTL yoksa) pencereyi başlat.
      if (count === 1 || !Number.isFinite(pttl) || pttl < 0) {
        await r.pexpire(k, windowMs);
        return { count, resetMs: windowMs };
      }
      return { count, resetMs: pttl };
    } catch (e) {
      return FAIL_OPEN;
    }
  }

  return memHit(key, windowMs);
}

/**
 * HAM TANI — `hit()` fail-open olduğu için komut hatalarını YUTAR; sayaç
 * sessizce çalışmaz ve dışarıdan yalnızca "count: 0" görünür. Sebebi görmek
 * için pipeline burada bire bir tekrarlanır ve her komutun kendi hatası
 * olduğu gibi döndürülür.
 *
 * Yalnızca yönetim ucundan çağrılır; sıcak yolda kullanılmaz.
 */
async function diagnose() {
  const r = initRedis();
  if (!r) {
    return { configured: !!REDIS_URL, clientReady: false, reason: "istemci kurulamadi" };
  }

  const k = PREFIX + "diagnose:" + Date.now();
  const out = {
    configured: true,
    clientReady: true,
    down: _redisDown,
    status: r.status,
    // "reconnecting" tek başına sebep söylemez — asıl bilgi burada.
    lastError: _lastError,
  };

  try {
    const t0 = Date.now();
    out.ping = await r.ping();
    out.pingMs = Date.now() - t0;
  } catch (e) {
    out.pingError = String(e?.message || e).slice(0, 300);
  }

  try {
    const res = await r.pipeline().incr(k).pttl(k).exec();
    out.pipeline = Array.isArray(res)
      ? res.map(([err, val], i) => ({
          cmd: i === 0 ? "incr" : "pttl",
          error: err ? String(err?.message || err).slice(0, 300) : null,
          value: val,
        }))
      : { notArray: String(res) };
  } catch (e) {
    out.pipelineError = String(e?.message || e).slice(0, 300);
  }

  try { await r.del(k); } catch {}
  return out;
}

/** Tanı/test için: aktif mod ve bellek modundaki anahtar sayısı. */
function stats() {
  return {
    mode: _redis && !_redisDown ? "redis" : "memory",
    redisConfigured: !!REDIS_URL,
    memKeys: _mem.size,
  };
}

/** Test yardımcısı — bellek sayaçlarını sıfırlar. */
function _resetMemory() {
  _mem.clear();
}

async function close() {
  clearInterval(_sweeper);
  if (_redis) {
    try { await _redis.quit(); } catch {}
    _redis = null;
  }
}

module.exports = { hit, stats, close, diagnose, _resetMemory };
