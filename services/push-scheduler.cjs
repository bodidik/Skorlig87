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

const DATA_DIR     = path.join(__dirname, "..", "data");
const FIXTURES     = path.join(DATA_DIR, "fixtures.json");
const PREDS        = path.join(DATA_DIR, "preds.json");
const RESULTS      = path.join(DATA_DIR, "match-results.json");
const MatchResults = require("../lib/match-results.cjs");
const WALLET       = path.join(DATA_DIR, "lc-wallet.json");
const SENT_FILE    = path.join(DATA_DIR, "push-sent.json");

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
async function claimKeys(keys) {
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
  const fixtures = asArray(await readJson(FIXTURES, null), "fixtures", "items");
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
    const score  = s.finalScore ? `${s.finalScore.home}-${s.finalScore.away}` : "";
    const name   = s.meta ? fmtMatch(s.meta) : String(s.fixtureId);

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

async function runDailyReminder(now = new Date()) {
  // Sadece belirlenen saat diliminde çalış
  if (now.getHours() !== DAILY_HOUR) return { sent: 0, skipped: "saat-dışı" };

  const today = todayKey(now);
  const claimed = await claimKeys([`daily:${today}`]);
  if (!claimed.length) return { sent: 0, skipped: "bugün-gönderildi" };

  const wallet = await readJson(WALLET, null);
  const users = Array.isArray(wallet?.users) ? wallet.users : [];
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
