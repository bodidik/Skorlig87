"use strict";

/**
 * PUSH ZAMANLAYICI — iki tetikleyici:
 *
 *   1) Maç başlıyor  : kickoff'a ~30dk kala, O MAÇA TAHMİN YAPMIŞ kullanıcılara.
 *   2) Sonuç hazır   : settle sonrası snapshot'ta awardedAt görülünce, puanıyla.
 *
 * Kasıtlı olarak yalnızca ilgili kullanıcıya gönderilir — herkese "Bolivya
 * ligi başlıyor" atmak spam olur ve uygulama sildirir.
 *
 * Çift gönderim koruması: data/push-sent.json içindeki anahtarlar.
 * settle koduna DOKUNULMAZ; snapshot dosyası dışarıdan gözlenir (decoupled).
 *
 * Kapatmak için: SKORLIG_PUSH_SCHED=0
 */

const path = require("path");
const { withFileLock, writeJsonAtomic } = require("../lib/fileLock.cjs");
const { readJson } = require("./store.cjs");
const push = require("./push.cjs");

// ⚠️ SKORLIG_DATA_DIR: sabit yol testleri GERÇEK data/ dizinine yazdırır.
const DATA_DIR     = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FixturesStore = require("../lib/fixtures-store.cjs");
const PREDS        = path.join(DATA_DIR, "preds.json");
const MatchResults = require("../lib/match-results.cjs");
const WALLET       = path.join(DATA_DIR, "lc-wallet.json");
const SENT_FILE    = path.join(DATA_DIR, "push-sent.json");
const PushSent = require("../lib/push-sent-store.cjs");

// Günlük LC hatırlatması bu saatte gider (sunucu saati, 0-23).
// Gece yarısı bildirim atmak uygulamayı sildirir — akşam kullanım saati seçildi.
const DAILY_HOUR = Math.min(23, Math.max(0, Number(process.env.SKORLIG_PUSH_DAILY_HOUR ?? 19)));

// Bu kadar gündür ortalıkta olmayan kullanıcıya günlük hatırlatma gitmez.
const DAILY_ACTIVE_DAYS = 14;

// Kickoff'a kalan süre bu aralıktaysa hatırlatma gönderilir.
// Alt sınır tarama aralığından geniş olmalı, yoksa maç pencereden kaçar.
const REMIND_MIN_MS = 15 * 60 * 1000;
const REMIND_MAX_MS = 45 * 60 * 1000;

const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün sonra anahtarları temizle

let _timer = null;

function asArray(raw, ...keys) {
  if (Array.isArray(raw)) return raw;
  for (const k of keys) if (Array.isArray(raw?.[k])) return raw[k];
  return [];
}

async function loadSent() {
  const raw = await readJson(SENT_FILE, null);
  return raw && typeof raw.keys === "object" ? raw : { keys: {} };
}

/** Anahtarı işaretle. Zaten varsa false döner — çağıran gönderimi atlar. */
/** Mongo bağlantısı (yoksa null) — dosya yedeğine düşmek için. */
async function dbAl() {
  try {
    const { getDb } = require("../lib/mongo.cjs");
    return await getDb();
  } catch {
    return null;
  }
}

/**
 * Gönderim mührü.
 *
 * ⚠️ ÖNCE MONGO. Dosya yolu iki biçimde çöküyordu: Render'da `data/` her
 * deploy'da silindiği için anahtarlar kaybolup bildirimler TEKRAR gidiyordu,
 * ve `withFileLock` çok instance'ta hiçbir şey yapmıyordu. Aynı ders tr-lig'de
 * de alınmıştı (süreç-içi Set → Mongo mührü).
 *
 * Dosya yedeği KORUNUYOR: Mongo erişilemezken bildirimleri tamamen durdurmak
 * daha kötü olurdu.
 */
async function claimKeys(keys) {
  const db = await dbAl();
  if (db) {
    const alinan = await PushSent.claimKeys(keys, db);
    if (alinan) return alinan;
  }
  return withFileLock(SENT_FILE, async () => {
    const store = await loadSent();
    const now = Date.now();

    // Bayat anahtarları at, yoksa dosya sonsuza kadar büyür.
    for (const [k, iso] of Object.entries(store.keys)) {
      if (now - new Date(iso).getTime() > SENT_TTL_MS) delete store.keys[k];
    }

    const fresh = keys.filter((k) => !store.keys[k]);
    if (!fresh.length) {
      await writeJsonAtomic(SENT_FILE, store);
      return [];
    }
    const iso = new Date(now).toISOString();
    for (const k of fresh) store.keys[k] = iso;
    await writeJsonAtomic(SENT_FILE, store);
    return fresh;
  });
}

function fmtMatch(f) {
  const h = f.home || f.homeTeam || "Ev";
  const a = f.away || f.awayTeam || "Deplasman";
  return `${h} – ${a}`;
}

/* ===== 1) Maç başlıyor hatırlatması ===== */

async function runKickoffReminders() {
  // Fikstürler Mongo birincil — bkz. lib/fixtures-store.cjs
  const fixtures = await FixturesStore.loadAll();
  const preds    = asArray(await readJson(PREDS, null), "items", "preds");
  if (!fixtures.length) return { checked: 0, sent: 0 };

  const now = Date.now();
  const due = fixtures.filter((f) => {
    const t = Date.parse(f.kickoffISO || f.kickoff || "");
    if (!Number.isFinite(t)) return false;
    const delta = t - now;
    return delta >= REMIND_MIN_MS && delta <= REMIND_MAX_MS;
  });
  if (!due.length) return { checked: fixtures.length, sent: 0 };

  const keys = due.map((f) => `start:${f.fixtureId}`);
  const claimed = new Set(await claimKeys(keys));
  if (!claimed.size) return { checked: fixtures.length, sent: 0 };

  let sent = 0;
  for (const f of due) {
    if (!claimed.has(`start:${f.fixtureId}`)) continue;

    const userIds = preds
      .filter((p) => String(p.fixtureId) === String(f.fixtureId))
      .map((p) => p.userId);
    if (!userIds.length) continue;

    const mins = Math.round((Date.parse(f.kickoffISO || f.kickoff) - now) / 60000);
    const r = await push.sendToUsers(userIds, {
      type:  "matchStart",
      title: `⏱ ${mins} dk sonra başlıyor`,
      body:  `${fmtMatch(f)} — tahminin kayıtlı, yarışı canlı izle.`,
      data:  { screen: "match-race", fixtureId: String(f.fixtureId) },
    });
    sent += r.sent;
  }
  return { checked: fixtures.length, sent };
}

/* ===== 2) Sonuç bildirimi ===== */

async function runResultNotices() {
  // Filtre depoda: yalnızca ödülü dağıtılmış snapshot'lar gelir.
  const snaps = await MatchResults.listSnapshots({ settledOnly: true });
  const settled = snaps.filter((s) => Array.isArray(s.rows) && s.rows.length);
  if (!settled.length) return { sent: 0 };

  const keys = settled.map((s) => `result:${s.fixtureId}`);
  const claimed = new Set(await claimKeys(keys));
  if (!claimed.size) return { sent: 0 };

  let sent = 0;
  for (const s of settled) {
    if (!claimed.has(`result:${s.fixtureId}`)) continue;

    // En yüksek puandan sıralayıp herkese kendi sırasını bildir
    const ranked = [...s.rows].sort((a, b) => Number(b.points || 0) - Number(a.points || 0));
    const total  = ranked.length;
    /**
     * ⚠️ ADSIZ BİLDİRİM GÖNDERME — ÇÖP PUSH, PUSH'U TÜMDEN KAPATTIRIR.
     *
     * ÖLÇÜLDÜ (2026-08-02, 1186 gerçek snapshot): 4 tanesi bozuk başlık
     * üretiyordu ve bunlar kullanıcının KİLİT EKRANINA gidiyordu:
     *
     *     "Ev – Deplasman bitti 3-1"          (meta var, takım adı yok  ×3)
     *     "MK-LAGALA-2026-08-02-DALLAS bitti " (meta yok + skor yok     ×1)
     *
     * `fmtMatch` boş alanları "Ev"/"Deplasman" ile dolduruyor; kod içinde
     * makul bir yedek ama BİLDİRİM METNİNDE anlamsız.
     *
     * Önce fikstür kaydından tamamlanıyor (settle2'de puanlama için aynı
     * yöntem kullanıldı: canlı durum dosyası home/away taşımıyor, fikstür
     * kaydı taşıyor). Hâlâ adlandırılamıyorsa bildirim ATLANIYOR —
     * yanlış bilgi vermektense susmak doğru.
     */
    const score  = s.finalScore ? `${s.finalScore.home}-${s.finalScore.away}` : "";
    let meta = s.meta;
    if (!meta || !(meta.home || meta.homeTeam) || !(meta.away || meta.awayTeam)) {
      try {
        const FixturesStore = require("../lib/fixtures-store.cjs");
        const fx = await FixturesStore.getOne(s.fixtureId, null);
        if (fx && fx.home && fx.away) meta = { ...(meta || {}), home: fx.home, away: fx.away };
      } catch { /* fikstur okunamadi — asagidaki kapi yakalar */ }
    }
    const adlandirildi = !!(meta && (meta.home || meta.homeTeam) && (meta.away || meta.awayTeam));
    if (!adlandirildi || !score) {
      console.warn(`[push-sched] sonuc bildirimi ATLANDI (adsiz/skorsuz) fixture=${s.fixtureId}`);
      continue;
    }
    const name = fmtMatch(meta);

    for (let i = 0; i < ranked.length; i++) {
      const row = ranked[i];
      const pts = Math.round(Number(row.points || 0) * 100) / 100;
      const rank = i + 1;
      const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "📊";

      const r = await push.sendToUsers([row.userId], {
        type:  "result",
        title: `${medal} ${name} bitti ${score}`,
        body:  `${pts} puan aldın — ${total} kişi arasında ${rank}. sıradasın.`,
        data:  { screen: "match-race", fixtureId: String(s.fixtureId) },
      });
      sent += r.sent;
    }
  }
  return { sent };
}

/* ===== 3) Günlük LC hatırlatması ===== */

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/**
 * Cüzdan kullanıcıları — MONGO BİRİNCİL.
 *
 * ⚠️ BULUNAN: günlük hatırlatma listeyi YALNIZCA `data/lc-wallet.json`dan
 * okuyordu. Bakiye Mongo'ya taşındı ve `SKORLIG_WALLET_FILE_MIRROR=0` iken o
 * dosya HİÇ YAZILMIYOR — üstelik Render'ın diski kalıcı da değil. Sonuç:
 * liste boş, hatırlatma kimseye gitmiyor ve hiçbir yerde hata görünmüyor.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo, ayna kapalı): günlük hakkını almamış 20 aktif
 * kullanıcı varken hedef sayısı 0.
 *
 * Aynı sınıf bu oturumda ikinci kez: ana ekranın hızlı-oyun bölümü de artık
 * beslenmeyen bir kaynaktan okuduğu için boş kalıyordu. Mühür tarafı (`dbAl`)
 * zaten Mongo kullanıyordu — okuma tarafı geçirilmeyi unutmuş.
 *
 * ⚠️ DOSYA YEDEĞİ KORUNUYOR: Mongo erişilemezken hatırlatmayı tamamen
 * durdurmak daha kötü olurdu (aynı gerekçe `claimKeys`te de yazılı).
 */
async function cuzdanKullanicilari() {
  const db = await dbAl();
  if (db) {
    try {
      const docs = await db
        .collection("lc_wallet_users")
        .find({}, { projection: { userId: 1, lastDailyAt: 1, updatedAt: 1, createdAt: 1, _id: 0 } })
        .toArray();
      if (docs.length) return docs;
    } catch (e) {
      console.error("[push-scheduler] cuzdan Mongo'dan okunamadi:", e?.message || e);
    }
  }
  const wallet = await readJson(WALLET, null);
  return Array.isArray(wallet?.users) ? wallet.users : [];
}

async function runDailyReminder(now = new Date()) {
  // Sadece belirlenen saat diliminde çalış
  if (now.getHours() !== DAILY_HOUR) return { sent: 0, skipped: "saat-dışı" };

  const today = todayKey(now);
  const claimed = await claimKeys([`daily:${today}`]);
  if (!claimed.length) return { sent: 0, skipped: "bugün-gönderildi" };

  const users = await cuzdanKullanicilari();
  if (!users.length) return { sent: 0 };

  const activeSince = now.getTime() - DAILY_ACTIVE_DAYS * 24 * 60 * 60 * 1000;

  const targets = users
    .filter((u) => {
      // Bugün zaten almışsa hatırlatma anlamsız
      const last = u.lastDailyAt ? String(u.lastDailyAt).slice(0, 10) : null;
      if (last === today) return false;

      // Uzun süredir uğramayanı dürtmek spam olur
      const seen = Date.parse(u.updatedAt || u.lastDailyAt || u.createdAt || "");
      return Number.isFinite(seen) && seen >= activeSince;
    })
    .map((u) => u.userId);

  if (!targets.length) return { sent: 0 };

  const r = await push.sendToUsers(targets, {
    type:  "daily",
    title: "🪙 Günlük LC hakkın hazır",
    body:  "Ücretsiz LigCoin'ini al, günün maçlarına tahmin yap.",
    data:  { screen: "predict" },
  });
  return { sent: r.sent, targets: targets.length };
}

/* ===== Döngü ===== */

async function tick() {
  try {
    const [k, r, d] = await Promise.all([
      runKickoffReminders(),
      runResultNotices(),
      runDailyReminder(),
    ]);
    if (k.sent || r.sent || d.sent) {
      console.log(`[push-sched] kickoff:${k.sent} sonuç:${r.sent} günlük:${d.sent} bildirim gönderildi`);
    }
  } catch (e) {
    console.warn("[push-sched] tick hatası:", e.message);
  }
}

function start(intervalMs = 5 * 60 * 1000) {
  if (process.env.SKORLIG_PUSH_SCHED === "0") {
    console.log("[push-sched] kapalı (SKORLIG_PUSH_SCHED=0)");
    return;
  }
  if (_timer) return;
  console.log(`[push-sched] başladı, ${Math.round(intervalMs / 1000)}sn aralık`);
  tick();
  _timer = setInterval(tick, intervalMs);
  _timer.unref?.();
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  start, stop, tick, runKickoffReminders, runResultNotices, runDailyReminder,
  claimKeys, // dışa açık: çift gönderim koruması testi için
};
