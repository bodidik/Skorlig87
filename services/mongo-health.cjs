"use strict";

/**
 * MONGO SAĞLIK İZLEME + OTOMATİK TOPARLANMA
 *
 * NEDEN (gerçek olay, 2026-07-28): Atlas M0 kümesi uzun süre kullanılmadığı
 * için otomatik duraklatıldı. Duraklatılmış kümenin SRV kaydı çözülmez, bu
 * yüzden açılışta bağlantı kurulamadı ve uygulama SESSİZCE dosya moduna
 * düştü. Kalıcı disk de olmadığından her deploy verileri sildi. Hiçbir alarm
 * üretilmedi; durum ancak elle log okunarak fark edildi.
 *
 * Bu servis üç iş yapar:
 *
 *  1) İZLER — bağlantı yoksa/koptuysa yönetim alarmı üretir. Artık sessizce
 *     dosya moduna düşülmez.
 *
 *  2) ONARIR — `server.cjs` `app.locals.db`'yi yalnızca AÇILIŞTA atar. O an
 *     Mongo düşükse alan tanımsız kalır ve rotalar, bağlantı sonradan
 *     düzelse bile, yeniden başlatılana kadar dosya modunda kalır. Bu servis
 *     bağlantı geri geldiğinde `app.locals.db`'yi CANLI günceller —
 *     yeniden başlatmaya gerek kalmaz.
 *
 *  3) UYANIK TUTAR — düzenli ping, M0 kümesinin "prolonged inactivity"
 *     nedeniyle tekrar duraklatılmasını önler.
 *
 * Kapatmak için: SKORLIG_MONGO_HEALTH=0
 */

const { getDb, close } = require("../lib/mongo.cjs");
const { appendAlert } = require("../lib/admin-alerts.cjs");

const ENABLED = () => process.env.SKORLIG_MONGO_HEALTH !== "0";
const INTERVAL_MS = Number(process.env.SKORLIG_MONGO_HEALTH_MIN || 10) * 60000;

// Bu kadar üst üste başarısızlıktan sonra alarm üretilir. Tek bir geçici
// ağ hatası alarm üretmesin diye 1'den büyük.
const FAIL_THRESHOLD = Number(process.env.SKORLIG_MONGO_FAIL_THRESHOLD || 2);

let _timer = null;
let _app = null;

const state = {
  configured: false,
  connected: false,
  consecutiveFailures: 0,
  lastOkAt: null,
  lastError: null,
  lastCheckedAt: null,
  recoveries: 0,
};

/**
 * Tek kontrol turu.
 *
 * `getDb()` önbellekli bir bağlantı döndürür — sunucu ölmüş olsa bile aynı
 * nesneyi verir. Bu yüzden GERÇEK bir ping atılır; başarısızsa bağlantı
 * kapatılır ki bir sonraki tur sıfırdan kursun.
 */
async function tick() {
  state.lastCheckedAt = new Date().toISOString();
  state.configured = !!process.env.MONGODB_URI;

  // URI hiç tanımlı değilse bu bir ARIZA değil, bilinçli yapılandırma
  // (yerel geliştirme). Alarm üretme.
  if (!state.configured) {
    state.connected = false;
    state.lastError = "MONGODB_URI tanimsiz";
    return state;
  }

  let db = null;
  try {
    db = await getDb();
    if (db) {
      // Asıl canlılık sınavı — önbellekli nesne yanıltıcı olabilir.
      await db.command({ ping: 1 });
    }
  } catch (e) {
    state.lastError = String(e?.message || e).slice(0, 200);
    db = null;
  }

  if (!db) {
    state.connected = false;
    state.consecutiveFailures++;

    if (state.consecutiveFailures === FAIL_THRESHOLD) {
      await appendAlert(
        "mongo_down",
        "database",
        `MongoDB baglantisi yok — uygulama DOSYA moduna dustu. Son hata: ${state.lastError || "bilinmiyor"}`,
        { consecutiveFailures: state.consecutiveFailures, lastOkAt: state.lastOkAt }
      );
      console.error(
        `[mongo-health] BAGLANTI YOK (${state.consecutiveFailures}. kez) — ${state.lastError}`
      );
    }

    // Ölü bağlantıyı bırak ki sonraki tur temiz kursun.
    try { await close(); } catch {}
    return state;
  }

  // ── Bağlantı sağlıklı ──────────────────────────────────────────────────
  const wasDown = !state.connected;
  state.connected = true;
  state.lastError = null;
  state.lastOkAt = state.lastCheckedAt;

  // ONARIM: açılışta atanamamış ya da bayatlamış referansı canlı düzelt.
  if (_app && _app.locals.db !== db) {
    const ilkKez = !_app.locals.db;
    _app.locals.db = db;
    _app.locals.getDb = getDb;
    if (ilkKez) {
      state.recoveries++;
      console.log("[mongo-health] app.locals.db canli olarak baglandi — yeniden baslatma gerekmedi");
      await appendAlert(
        "mongo_recovered",
        "database",
        "MongoDB baglantisi geri geldi ve uygulamaya canli baglandi (Mongo modu aktif).",
        { recoveries: state.recoveries }
      );
    }
  }

  if (wasDown && state.consecutiveFailures >= FAIL_THRESHOLD) {
    console.log("[mongo-health] baglanti toparlandi");
  }
  state.consecutiveFailures = 0;

  return state;
}

/** Yan etkisiz durum raporu (HTTP ucu için). */
function report() {
  return {
    ...state,
    enabled: ENABLED(),
    intervalMinutes: Math.round(INTERVAL_MS / 60000),
    // Mongo yapılandırılmışsa ama bağlı değilse: veri dosyaya yazılıyor ve
    // kalıcı disk yoksa deploy'da kaybolur.
    risk:
      state.configured && !state.connected
        ? "DOSYA MODUNDA — kalici disk yoksa veri deploy'da kaybolur"
        : null,
  };
}

function start(app, intervalMs = INTERVAL_MS) {
  if (_timer || !ENABLED()) return;
  _app = app || null;

  // İlk kontrol kısa gecikmeyle: açılıştaki initMongo'nun bitmesini bekle.
  setTimeout(() => { tick().catch(() => {}); }, 20_000).unref?.();

  _timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  _timer.unref?.();

  console.log(
    `[mongo-health] basladi · her ${Math.round(intervalMs / 60000)}dk · ` +
      `alarm esigi ${FAIL_THRESHOLD} basarisizlik`
  );
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, tick, report };
