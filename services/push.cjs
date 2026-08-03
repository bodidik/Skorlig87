"use strict";

/**
 * PUSH BİLDİRİM SERVİSİ (Expo Push API)
 *
 * Token deposu: data/push-tokens.json
 *   { items: { "<userId>": { tokens: [...], prefs: {...}, updatedAt } } }
 *
 * Aynı kullanıcı birden fazla cihazdan girebildiği için token bir DİZİ.
 * Expo "DeviceNotRegistered" döndürdüğünde token otomatik silinir —
 * aksi halde uygulamayı silen kullanıcılara sonsuza kadar gönderim denenir.
 *
 * Kapatmak için: SKORLIG_PUSH=0
 */

const path = require("path");
// Jeton/tercih deposu Mongo birincil — dosya Render'da her deploy siliniyordu.
const PushStore = require("../lib/push-store.cjs");

// ⚠️ SKORLIG_DATA_DIR: sabit yol testleri GERÇEK data/ dizinine yazdırır.
const DATA_DIR   = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const TOKEN_FILE = path.join(DATA_DIR, "push-tokens.json");

const EXPO_URL   = "https://exp.host/--/api/v2/push/send";
const CHUNK_SIZE = 100; // Expo tek istekte en fazla 100 mesaj kabul eder

const ENABLED = () => process.env.SKORLIG_PUSH !== "0";

/** Bildirim türleri — kullanıcı her birini ayrı kapatabilir. */
const PREF_KEYS = ["matchStart", "result", "duel", "daily"];

const DEFAULT_PREFS = {
  matchStart: true, // maç başlamadan önce hatırlatma
  result:     true, // maç bitti, puanın hesaplandı
  duel:       true, // düello daveti / sonucu
  daily:      true, // günlük LC hakkın hazır
};

/* ============ Token deposu ============ */

/**
 * ⚠️ ARTIK MONGO BİRİNCİL. Eskiden yalnızca `data/push-tokens.json` okunuyordu
 * ve o dosya Render'da HER DEPLOY'DA siliniyordu:
 *
 *   - Jetonlar gidiyordu. İstemci her açılışta yeniden kaydoluyor, yani
 *     uygulamayı AÇAN kullanıcı geri kazanıyordu — ama bildirimin amacı tam da
 *     AÇMAYANI geri getirmek; onlar bir daha hiç bildirim almıyordu.
 *   - TERCİHLER de gidiyordu: bildirimi KAPATAN kullanıcı varsayılana dönüyor
 *     ve kapattığı bildirimi yeniden almaya başlıyordu.
 *
 * bkz. lib/push-store.cjs — diğer depolarla aynı desen.
 */
async function loadStore() {
  return PushStore.loadStore(null);
}

function isExpoToken(t) {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(String(t || "").trim());
}

/** Cihaz token'ını kullanıcıya bağla (idempotent). */
async function registerToken(userId, token, prefs) {
  const uid = String(userId || "").trim();
  const tok = String(token || "").trim();
  if (!uid || !isExpoToken(tok)) return { ok: false, error: "INVALID_TOKEN" };

  // Aynı token başka bir hesapta kayıtlıysa oradan sök — cihaz el değiştirmiş
  // olabilir; yoksa eski kullanıcının bildirimleri yeni kullanıcıya düşer.
  await PushStore.revokeTokenFrom(tok, uid);

  const rec = await PushStore.getUser(uid) ||
    { userId: uid, tokens: [], prefs: { ...DEFAULT_PREFS } };
  if (!Array.isArray(rec.tokens)) rec.tokens = [];
  if (!rec.tokens.includes(tok)) rec.tokens.push(tok);
  if (prefs && typeof prefs === "object") {
    rec.prefs = sanitizePrefs(prefs, rec.prefs);
  } else if (!rec.prefs) {
    rec.prefs = { ...DEFAULT_PREFS };
  }
  rec.updatedAt = new Date().toISOString();

  await PushStore.saveUser(uid, rec);
  return { ok: true, tokens: rec.tokens.length, prefs: rec.prefs };
}

async function unregisterToken(userId, token) {
  const uid = String(userId || "").trim();
  const tok = String(token || "").trim();
  if (!uid) return { ok: false, error: "NO_USER" };

  const rec = await PushStore.getUser(uid);
  if (!rec) return { ok: true, tokens: 0 };
  rec.tokens = tok
    ? (rec.tokens || []).filter((t) => t !== tok)
    : [];
  rec.updatedAt = new Date().toISOString();
  await PushStore.saveUser(uid, rec);
  return { ok: true, tokens: rec.tokens.length };
}

/**
 * Yalnızca bilinen anahtarları ve yalnızca boolean değerleri kabul eder.
 * Geçersiz/eksik değerde `base`'e düşer — DEFAULT'a DEĞİL. Aksi halde bozuk
 * bir istek, kullanıcının kapattığı bildirimi sessizce geri açardı.
 */
function sanitizePrefs(p, base = DEFAULT_PREFS) {
  const out = { ...DEFAULT_PREFS, ...base };
  for (const k of PREF_KEYS) if (typeof p?.[k] === "boolean") out[k] = p[k];
  return out;
}

async function getPrefs(userId) {
  const store = await loadStore();
  const rec = store.items[String(userId || "").trim()];
  return {
    prefs: sanitizePrefs(rec?.prefs),
    deviceCount: rec?.tokens?.length || 0,
  };
}

async function setPrefs(userId, prefs) {
  const uid = String(userId || "").trim();
  if (!uid) return { ok: false, error: "NO_USER" };

  const rec = await PushStore.getUser(uid) ||
    { userId: uid, tokens: [], prefs: { ...DEFAULT_PREFS } };
  rec.prefs = sanitizePrefs(prefs, rec.prefs);
  rec.updatedAt = new Date().toISOString();
  await PushStore.saveUser(uid, rec);
  return { ok: true, prefs: rec.prefs };
}

/** Geçersiz token'ları topluca sil (Expo "DeviceNotRegistered" dönünce). */
async function pruneTokens(badTokens) {
  return PushStore.pullBadTokens(badTokens);
}

/* ============ Gönderim ============ */

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Ham Expo mesaj dizisini gönderir. Çağıran tarafın token'ları hazırlaması gerekir.
 * @returns {{sent:number, failed:number, pruned:number}}
 */
async function sendRaw(messages) {
  if (!ENABLED()) return { sent: 0, failed: 0, pruned: 0, skipped: "SKORLIG_PUSH=0" };
  if (!messages.length) return { sent: 0, failed: 0, pruned: 0 };

  let sent = 0;
  let failed = 0;
  const badTokens = [];

  for (const batch of chunk(messages, CHUNK_SIZE)) {
    try {
      const res = await fetch(EXPO_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Accept-Encoding": "gzip, deflate",
        },
        body: JSON.stringify(batch),
      });

      const j = await res.json().catch(() => null);
      const tickets = Array.isArray(j?.data) ? j.data : [];

      tickets.forEach((t, i) => {
        if (t?.status === "ok") { sent++; return; }
        failed++;
        if (t?.details?.error === "DeviceNotRegistered") {
          badTokens.push(batch[i]?.to);
        }
      });

      // Ticket sayısı mesaj sayısını tutmuyorsa (Expo hata döndürmüş olabilir)
      if (!tickets.length) {
        failed += batch.length;
        console.warn("[push] Expo yanıtı boş:", JSON.stringify(j).slice(0, 200));
      }
    } catch (e) {
      failed += batch.length;
      console.warn("[push] gönderim hatası:", e.message);
    }
  }

  const pruned = await pruneTokens(badTokens);
  return { sent, failed, pruned };
}

/**
 * Belirli kullanıcılara bildirim gönder. Tercih kapalıysa o kullanıcı atlanır.
 * @param {string[]} userIds
 * @param {{title:string, body:string, data?:object, type?:string}} payload
 *   type: PREF_KEYS'ten biri — kullanıcının o türü kapattıysa gönderilmez.
 */
async function sendToUsers(userIds, payload) {
  if (!ENABLED()) return { sent: 0, failed: 0, pruned: 0, skipped: "SKORLIG_PUSH=0" };

  const store = await loadStore();
  const type = payload.type;
  const messages = [];

  for (const uid of new Set(userIds.map((u) => String(u || "").trim()).filter(Boolean))) {
    const rec = store.items[uid];
    if (!rec?.tokens?.length) continue;

    const prefs = sanitizePrefs(rec.prefs);
    if (type && PREF_KEYS.includes(type) && prefs[type] === false) continue;

    for (const to of rec.tokens) {
      messages.push({
        to,
        sound: "default",
        title: payload.title,
        body: payload.body,
        data: { ...(payload.data || {}), type: type || "generic" },
        channelId: "default",
        priority: "high",
      });
    }
  }

  return sendRaw(messages);
}

/** Tüm kayıtlı kullanıcılara (duyuru). Tercih türü genelde "daily". */
async function broadcast(payload) {
  const store = await loadStore();
  return sendToUsers(Object.keys(store.items), payload);
}

module.exports = {
  registerToken,
  unregisterToken,
  getPrefs,
  setPrefs,
  sendToUsers,
  broadcast,
  sendRaw,
  loadStore,
  isExpoToken,
  PREF_KEYS,
  DEFAULT_PREFS,
  TOKEN_FILE,
};
