"use strict";

const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const DATA_DIR = path.join(__dirname, "..", "data");
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
  const data = await readJson(RUNTIME_FILE, null);
  if (data) {
    return { ...DEFAULT_MODE, ...data };
  }

  const bootstrap = envBootstrapPatch();
  const next = {
    ...DEFAULT_MODE,
    ...bootstrap,
    updatedAt: new Date().toISOString(),
    updatedBy: "env-bootstrap",
  };

  await writeJson(RUNTIME_FILE, next);
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

  await writeJson(RUNTIME_FILE, next);
  return next;
}

module.exports = {
  getRuntimeMode,
  setRuntimeMode,
  DEFAULT_MODE,
  RUNTIME_FILE,
};
