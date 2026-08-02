"use strict";

/**
 * BOT DOLULUK ZAMANLAYICI
 *
 * Botlar kalıcı nüfus değil, DOLULUK YEDEĞİ: gerçek tahminci azken kullanıcı
 * maçta/sıralamada/canlı yarışta yalnız kalmasın diye varlar. Bu servis o
 * doldurmayı otomatik yapar — daha önce her maç için elle admin isteği
 * gerekiyordu ve maç sayısı arttıkça sürdürülemezdi.
 *
 * ÇALIŞMA BİÇİMİ
 * Periyodik olarak yaklaşan maçları tarar ve her biri için /pred/bots-generate
 * çağırır. Endpoint'in kendi mantığı bot sayısını belirler:
 *     bot = max(0, HEDEF − gerçek_tahminci)
 * Bu yüzden tekrar tekrar çalışmak güvenli ve İSTENEN bir şey: gerçek
 * kullanıcılar geldikçe her turda bot sayısı azalır, hedef dolunca sıfırlanır.
 *
 * Bot seçimi fixtureId ile tohumlandığından kadro turdan tura sabittir; sayı
 * 40'tan 30'a düştüğünde aynı sıralamanın ilk 30'u seçilir, yani botlar
 * kuyruktan sessizce çekilir — tabloda rastgele karışma olmaz.
 *
 * PENCERE
 * Sadece yakında başlayacak maçlar doldurulur. Haftalar sonrasını doldurmak
 * hem gereksiz hem yanıltıcı olurdu (kimse tahmin etmemişken tablo dolu
 * görünür). Kickoff'a PRED_LOCK'tan az kalanlar da atlanır: o maçlarda
 * endpoint zaten 409 döner.
 *
 * Kapatmak için: SKORLIG_BOT_FILL=0
 */

const { readJson } = require("./store.cjs");

const FixturesStore = require("../lib/fixtures-store.cjs");

// Kickoff'a bu kadar veya daha az kalan maçlar doldurulur.
const FILL_WINDOW_MS = Number(process.env.SKORLIG_BOT_FILL_WINDOW_H || 24) * 3600 * 1000;

// pred.cjs PRED_LOCK_BEFORE_MIN = 10. Kilide çok yaklaşmış maça istek atmak
// boşuna 409 üretir; küçük bir emniyet payı bırakılır.
const LOCK_GUARD_MS = 12 * 60 * 1000;

// Bir turda en fazla bu kadar maç doldurulur — yoğun günlerde tek turda
// yüzlerce isteğe boğulmamak için.
const MAX_PER_TICK = Number(process.env.SKORLIG_BOT_FILL_MAX || 25);

let _timer = null;
let _port = null;
let _running = false;


/** Doldurulacak maçlar: kickoff penceresi içinde ve kilide girmemiş. */
async function pickFixtures() {
  // Fikstürler Mongo birincil — bkz. lib/fixtures-store.cjs
  const list = await FixturesStore.loadAll();
  const now = Date.now();

  const out = [];
  for (const fx of list) {
    const fid = String(fx?.fixtureId || "").trim();
    const ko = fx?.kickoffISO ? new Date(fx.kickoffISO).getTime() : NaN;
    if (!fid || !Number.isFinite(ko)) continue;

    const untilKickoff = ko - now;
    if (untilKickoff > FILL_WINDOW_MS) continue;   // henüz çok erken
    if (untilKickoff <= LOCK_GUARD_MS) continue;   // kilide girdi/giriyor

    out.push({ fixtureId: fid, kickoff: ko });
  }

  // En yakın maç önce: tur limiti dolarsa en acil olanlar dolmuş olur.
  out.sort((a, b) => a.kickoff - b.kickoff);
  return out.slice(0, MAX_PER_TICK);
}

/**
 * ⚠️ ADMIN JETONU ZORUNLU — VE BU BİR KEZ UNUTULDUĞU İÇİN SERVİS TAMAMEN
 * ÖLMÜŞTÜ.
 *
 * ÖLÇÜLDÜ (çalışan sunucu logu, 2026-08-02):
 *     [bot-filler] 25 mac tarandi · doldurulan 0 · eklenen bot 0 · hata 25
 *     [bot-filler] MK-SOUTHM-2026-08-02-STALBA: ADMIN_TOKEN_REQUIRED
 * Yani her turda taranan 25 maçın 25'i başarısız; bot doldurma %100 ölü.
 *
 * SEBEP: `/pred/bots-generate` ucuna yetki koruması eklendi (haklı — yorumu
 * "herkes herhangi bir maça bot üretebiliyordu... ucuz bir DoS" diyor). Ama
 * o değişikliğin yanındaki not "bot-filler loopback'ten çağırdığı için
 * etkilenmez" diyordu ve BU YANLIŞTI: uçta İKİ muhafız var ve dıştaki
 * `requireAdminToken` ara katmanı ÖNCE çalışıp jetonsuz loopback çağrısını
 * reddediyor — içerideki `isInternalCaller` gevşemesine hiç sıra gelmiyor.
 * Güvenlik düzeltmesi iç çağıranı sessizce kırmış.
 *
 * ⚠️ ÇÖZÜM LOOPBACK'E GÜVENMEK DEĞİL, JETONU GÖNDERMEK. Muhafızı gevşetmek
 * de mümkündü ama o, korumayı ağ şekline bağlı bir tahmine indirir; jeton
 * göndermek hem daha açık hem hangi muhafız kullanılırsa kullanılsın çalışır.
 *
 * ⚠️ JETON ADI TEK YERDEN ÇÖZÜLÜYOR (`beklenenToken`). Bu dosyada
 * `process.env.SKORLIG_ADMIN_TOKEN` yazsaydım dördüncü kopya olurdu:
 * `middleware/requireAdmin.cjs` ÜÇ ad kabul ediyor (eski kurulumlar için
 * `ADMIN_TOKEN`, `EXPO_PUBLIC_ADMIN_TOKEN` da), `routes/pred.cjs`in yerel
 * kopyası yalnızca birini. Ayrışan listeler, jetonun bir uçta çalışıp
 * ötekinde 401 vermesi demek.
 */
const { beklenenToken } = require("../middleware/requireAdmin.cjs");

let _jetonUyarisiVerildi = false;

async function fillOne(fixtureId) {
  const jeton = beklenenToken();
  if (!jeton && !_jetonUyarisiVerildi) {
    /* Yalnızca bir kez: aksi hâlde her turda 25 satır tekrarlanır ve asıl
     * sebep gürültüde kaybolur — kırık hâlin belirtisi tam olarak buydu. */
    _jetonUyarisiVerildi = true;
    console.error(
      "[bot-filler] SKORLIG_ADMIN_TOKEN tanimsiz — bot doldurma CALISMAYACAK. " +
      "Uc jeton olmadan 503/401 doner; .env dosyasina ekleyin."
    );
  }

  const res = await fetch(`http://127.0.0.1:${_port}/api/pred/bots-generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(jeton ? { "x-admin-token": jeton } : {}),
    },
    body: JSON.stringify({ fixtureId }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    // 409 = maç kilitli; pencere hesabına rağmen olabilir (kickoff güncellendi).
    // Sessiz geçilir, hata değil.
    if (res.status === 409) return null;
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

async function tick() {
  // Önceki tur bitmediyse üst üste binme (yavaş disk / çok maç).
  if (_running) return;
  _running = true;

  try {
    const fixtures = await pickFixtures();
    if (!fixtures.length) return;

    let filled = 0;
    let added = 0;
    let skipped = 0;
    let failed = 0;

    for (const fx of fixtures) {
      try {
        const r = await fillOne(fx.fixtureId);
        if (!r) { skipped++; continue; }
        filled++;
        added += Number(r.botCount || 0);
        // Hedef gerçek kullanıcılarla dolduysa bot eklenmemiştir.
        if (r.botCount === 0) skipped++;
      } catch (e) {
        failed++;
        console.error(`[bot-filler] ${fx.fixtureId}:`, e.message || e);
      }
    }

    console.log(
      `[bot-filler] ${fixtures.length} mac tarandi · doldurulan ${filled} · ` +
      `eklenen bot ${added} · atlanan ${skipped} · hata ${failed}`
    );
  } catch (e) {
    console.error("[bot-filler] tur hatasi:", e.message || e);
  } finally {
    _running = false;
  }
}

/**
 * @param {number} intervalMs tarama aralığı
 * @param {number} port       kendi API portu (self-call)
 */
function start(intervalMs = 10 * 60 * 1000, port) {
  if (_timer) return;
  _port = Number(port) || Number(process.env.PORT) || 4102;

  // İlk tur hemen değil: sunucu yeni ayağa kalkmışken kendi kendine istek
  // atmasın, router'lar ve varsa Mongo bağlantısı otursun.
  setTimeout(tick, 30 * 1000).unref?.();

  _timer = setInterval(tick, intervalMs);
  _timer.unref?.();

  console.log(
    `[bot-filler] basladi · her ${Math.round(intervalMs / 60000)}dk · ` +
    `pencere ${Math.round(FILL_WINDOW_MS / 3600000)}sa · tur basi max ${MAX_PER_TICK} mac`
  );
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, tick, pickFixtures };
