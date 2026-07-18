"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const TOURNAMENTS_FILE = path.join(DATA_DIR, "tournaments.json");

const PAYOUT_TABLE = {
  2: [0.70, 0.30],
  3: [0.70, 0.30],
  4: [0.60, 0.25, 0.15],
  5: [0.60, 0.25, 0.15],
  6: [0.60, 0.25, 0.15],
  7: [0.60, 0.25, 0.15],
};
const PAYOUT_8PLUS = [0.50, 0.25, 0.15, 0.10];

const MIN_ENTRY = 5;
const MAX_ENTRY = 100;
const MAX_MATCHES = 6;
const MIN_MATCHES = 2;

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function loadAll() {
  try {
    const txt = await fsp.readFile(TOURNAMENTS_FILE, "utf8");
    return JSON.parse(txt);
  } catch {
    return { tournaments: [] };
  }
}

async function saveAll(data) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(TOURNAMENTS_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function create({ creatorId, name, entryLC, fixtureIds, fixtures }) {
  const entry = Math.max(MIN_ENTRY, Math.min(MAX_ENTRY, Number(entryLC) || 10));
  const matchIds = (fixtureIds || []).slice(0, MAX_MATCHES);
  if (matchIds.length < MIN_MATCHES) throw new Error("MIN_2_MATCHES");

  const data = await loadAll();
  const code = genCode();
  const now = new Date().toISOString();

  const t = {
    id: "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    code,
    name: String(name || "Turnuva").slice(0, 40),
    creatorId,
    entryLC: entry,
    fixtureIds: matchIds,
    fixtures: (fixtures || []).slice(0, MAX_MATCHES),
    participants: [{
      userId: creatorId,
      joinedAt: now,
      predictions: {},
      totalScore: 0,
    }],
    pool: entry,
    status: "open",
    createdAt: now,
    settledAt: null,
    payouts: [],
  };

  data.tournaments.push(t);
  await saveAll(data);
  return t;
}

async function join(code, userId) {
  const data = await loadAll();
  const t = data.tournaments.find(x => x.code === code.toUpperCase());
  if (!t) throw new Error("NOT_FOUND");
  if (t.status !== "open") throw new Error("CLOSED");
  if (t.participants.some(p => p.userId.toLowerCase() === userId.toLowerCase())) {
    throw new Error("ALREADY_JOINED");
  }

  t.participants.push({
    userId,
    joinedAt: new Date().toISOString(),
    predictions: {},
    totalScore: 0,
  });
  t.pool += t.entryLC;

  await saveAll(data);
  return t;
}

async function predict(code, userId, fixtureId, outcome) {
  const data = await loadAll();
  const t = data.tournaments.find(x => x.code === code.toUpperCase());
  if (!t) throw new Error("NOT_FOUND");
  if (t.status === "settled") throw new Error("SETTLED");

  const p = t.participants.find(x => x.userId.toLowerCase() === userId.toLowerCase());
  if (!p) throw new Error("NOT_JOINED");
  if (!t.fixtureIds.includes(fixtureId)) throw new Error("INVALID_FIXTURE");

  p.predictions[fixtureId] = { outcome, at: new Date().toISOString() };
  await saveAll(data);
  return { ok: true };
}

async function settle(code, results) {
  const { calcOdds } = require("./odds-engine.cjs");
  const data = await loadAll();
  const t = data.tournaments.find(x => x.code === code.toUpperCase());
  if (!t) throw new Error("NOT_FOUND");
  if (t.status === "settled") throw new Error("ALREADY_SETTLED");

  for (const p of t.participants) {
    let score = 0;
    for (const fid of t.fixtureIds) {
      const pred = p.predictions[fid];
      const result = results[fid];
      if (!pred || !result) continue;

      const fx = t.fixtures.find(f => f.fixtureId === fid);
      const odds = fx ? calcOdds(fx.home, fx.away) : { home: 2, draw: 3, away: 2 };
      const outcomeOdd = pred.outcome === "H" ? odds.home : pred.outcome === "D" ? odds.draw : odds.away;

      if (pred.outcome === result.outcome) {
        score += Math.round(10 * outcomeOdd);
      }
    }
    p.totalScore = score;
  }

  const sorted = [...t.participants].sort((a, b) => b.totalScore - a.totalScore);
  const n = sorted.length;
  const table = n >= 8 ? PAYOUT_8PLUS : (PAYOUT_TABLE[n] || PAYOUT_TABLE[2]);

  t.payouts = table.map((pct, i) => {
    const user = sorted[i];
    if (!user) return null;
    return {
      rank: i + 1,
      userId: user.userId,
      score: user.totalScore,
      lcWon: Math.round(t.pool * pct),
      pct: Math.round(pct * 100),
    };
  }).filter(Boolean);

  t.status = "settled";
  t.settledAt = new Date().toISOString();
  await saveAll(data);
  return t;
}

async function getByCode(code) {
  const data = await loadAll();
  return data.tournaments.find(x => x.code === code.toUpperCase()) || null;
}

async function listByUser(userId) {
  const data = await loadAll();
  const uid = userId.toLowerCase();
  return data.tournaments.filter(t =>
    t.creatorId.toLowerCase() === uid ||
    t.participants.some(p => p.userId.toLowerCase() === uid)
  );
}

module.exports = { create, join, predict, settle, getByCode, listByUser, MIN_ENTRY, MAX_ENTRY, MAX_MATCHES };
