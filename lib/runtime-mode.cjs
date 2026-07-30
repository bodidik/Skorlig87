"use strict";

const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

// ⚠️ SKORLIG_DATA_DIR OKUNUYOR. Sabit yol yüzünden bir test GERÇEK
// data/runtime-mode.json dosyasını yazdı (git'ten geri alındı). Diğer
// depolar bu değişkeni zaten okuyordu; bu modül atlanmıştı.
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const RUNTIME_FILE = path.join(DATA_DIR, "runtime-mode.json");

/**
 * Basit JSON helper
 */
async function readJson(file, fb = null) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fb;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Varsayılan runtime modu:
 * - 4 takımlı geliştirme modu
 */
/* ⚠️ MONGO BİRİNCİL — dosya yalnızca ayna.
 *
 * NEDEN: `data/runtime-mode.json` GIT'TE TAKİPLİ. Yani Render'da deploy
 * dosyayı silmiyor, COMMIT'TEKİ ESKİ DEĞERE GERİ DÖNDÜRÜYOR. Yönetim
 * panelinden yapılan her değişiklik bir sonraki deploy'da sessizce geri
 * alınıyordu — hata da üretmeden, çünkü dosya "var" ve okunabiliyor.
 *
 * Bu ayar kaç takım/lig için fikstür çekileceğini belirliyor (profile,
 * maxTeams, maxLeagues), yani verinin kapsamını. `settings.json` aynı
 * sebeple taşınmıştı; bu dosya atlanmıştı.
 *
 * Tekil belge deseni lib/settings-store.cjs ile aynı.
 */
const COLL = "app_runtime";
const DOC_ID = "singleton";

/** ⚠️ MONGODB_URI yoksa YOK SAYILIR (dosya tek kaynaktır). */
const FILE_MIRROR = String(process.env.SKORLIG_RUNTIME_FILE_MIRROR ?? "1") !== "0";
const mirrorOn = () => FILE_MIRROR || !process.env.MONGODB_URI;

async function getDbSafe() {
  try {
    const { getDb } = require("./mongo.cjs");
    return await getDb();
  } catch {
    return null;
  }
}

async function mongoOku() {
  const db = await getDbSafe();
  if (!db) return null;
  try {
    const doc = await db.collection(COLL).findOne({ _id: DOC_ID });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest;
  } catch (e) {
    console.error("[runtime-mode] mongo okunamadi:", e?.message || e);
    return null;
  }
}

async function mongoYaz(veri) {
  const db = await getDbSafe();
  if (!db) return false;
  try {
    await db.collection(COLL).updateOne({ _id: DOC_ID }, { $set: veri }, { upsert: true });
    return true;
  } catch (e) {
    console.error("[runtime-mode] mongo yazilamadi:", e?.message || e);
    return false;
  }
}

const DEFAULT_MODE = {
  profile: "DEV_4_TEAMS", // DEV_4_TEAMS | TR_30_TEAMS | GLOBAL_100_TEAMS | GLOBAL_456_TEAMS ...
  maxTeams: 4,
  maxLeagues: 1,
  notes: "Varsayılan: 4 takımlı geliştirme modu",
  updatedAt: null,
  updatedBy: null,
};

function envBootstrapPatch() {
  // Sadece “ilk kurulum” için: runtime-mode.json yoksa .env’den bootstrap
  const profile = String(process.env.SKORLIG_RUNTIME_PROFILE || "").trim();
  const maxTeamsRaw = process.env.SKORLIG_MAX_TEAMS;
  const maxLeaguesRaw = process.env.SKORLIG_MAX_LEAGUES;

  const patch = {};

  if (profile) patch.profile = profile;
  const mt = Number(maxTeamsRaw);
  if (Number.isFinite(mt) && mt > 0) patch.maxTeams = mt;

  const ml = Number(maxLeaguesRaw);
  if (Number.isFinite(ml) && ml > 0) patch.maxLeagues = ml;

  return patch;
}

/**
 * Geçerli runtime modunu getirir.
 * - data/runtime-mode.json varsa onu okur
 * - yoksa DEFAULT_MODE + (.env bootstrap) ile dosyayı oluşturur ve döner
 */
async function getRuntimeMode() {
  // Mongo yetkili kaynak; dosya deploy'da commit'teki değere geri döner.
  const mongo = await mongoOku();
  if (mongo) return { ...DEFAULT_MODE, ...mongo };

  const data = await readJson(RUNTIME_FILE, null);
  if (data) {
    // Mongo boş ve dosyada değer var → bir kez taşı (ilk çalıştırma).
    await mongoYaz({ ...DEFAULT_MODE, ...data });
    return { ...DEFAULT_MODE, ...data };
  }

  const bootstrap = envBootstrapPatch();
  const next = {
    ...DEFAULT_MODE,
    ...bootstrap,
    updatedAt: new Date().toISOString(),
    updatedBy: "env-bootstrap",
  };

  await mongoYaz(next);
  if (mirrorOn()) await writeJson(RUNTIME_FILE, next);
  return next;
}

/**
 * Runtime modunu patch ederek günceller.
 * - Şema tamamen esnek: profile, maxTeams, maxLeagues, notes, updatedBy vs.
 */
async function setRuntimeMode(patch = {}) {
  const current = await getRuntimeMode();
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  const yazildi = await mongoYaz(next);
  if (mirrorOn() || !yazildi) await writeJson(RUNTIME_FILE, next);
  return next;
}

module.exports = {
  COLL,
  getRuntimeMode,
  setRuntimeMode,
  DEFAULT_MODE,
  RUNTIME_FILE,
};
