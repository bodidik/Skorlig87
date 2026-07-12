"use strict";

/**
 * Mini Turnuva: kullanıcı 2-10 maç seçip turnuva kurar, arkadaşları
 * 6 haneli kodla katılır. Sıralama, seçilen maçların settle edilmiş
 * sonuçlarından (data/match-results.json içindeki kullanıcı-başına puan
 * satırlarından) hesaplanır. Tamamen dosya tabanlı, Mongo gerektirmez.
 *
 * Endpoint'ler (/api/mini):
 *   POST /create { userId, name, fixtures:[{fixtureId,home,away,kickoffISO,league}] }
 *   POST /join   { userId, code }
 *   GET  /mine?userId=
 *   GET  /board?id=   (veya ?code=)
 */

const express = require("express");
const router = express.Router();

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const MINI_FILE = path.join(DATA_DIR, "mini-tournaments.json");
const RESULTS_FILE = path.join(DATA_DIR, "match-results.json");
const LIVE_DIR = path.join(DATA_DIR, "live");

const MIN_FIXTURES = 2;
const MAX_FIXTURES = 10;
const MAX_MEMBERS = 50;

// Turnuva birincisine LC (LigCoin) ödülü — settle2'nin match_reward
// mekanizmasıyla aynı dosyalara yazar (users.json + lc-wallet.json ledger).
const MINI_WIN_LC = Math.max(0, Number(process.env.SKORLIG_MINI_WIN_LC || 20));
const USERS_FILE = path.join(DATA_DIR, "users.json");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");

async function readJson(file, fb) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fb;
  }
}
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

async function loadAll() {
  const raw = await readJson(MINI_FILE, { items: [] });
  return Array.isArray(raw.items) ? raw.items : [];
}
async function saveAll(items) {
  await writeJson(MINI_FILE, { items, updatedAt: new Date().toISOString() });
}

function newCode(existing) {
  // karışması kolay karakterler yok (0/O, 1/I)
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let tries = 0; tries < 50; tries++) {
    let c = "";
    for (let i = 0; i < 6; i++) c += alpha[crypto.randomInt(alpha.length)];
    if (!existing.has(c)) return c;
  }
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function publicView(t) {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    ownerId: t.ownerId,
    fixtures: t.fixtures || [],
    members: t.members || [],
    memberCount: (t.members || []).length,
    createdAt: t.createdAt,
    finishedAt: t.finishedAt || null,
    winners: t.winners || null,
    rewardLc: t.rewardLc ?? null,
  };
}

// ---- LC ödülü (settle2 awardLcForRows ile aynı dosya deseninde) ----
function isBotUser(uid) {
  return String(uid || "").toLowerCase().startsWith("bot_");
}

async function awardMiniWinLc(userIds, tournament) {
  const winners = (userIds || []).filter((u) => u && !isBotUser(u));
  if (!winners.length || MINI_WIN_LC <= 0) return 0;

  const nowISO = new Date().toISOString();

  // users.json ({items:[]} formatı)
  const usersRaw = await readJson(USERS_FILE, { items: [] });
  const usersItems = Array.isArray(usersRaw) ? usersRaw : usersRaw.items || usersRaw.users || [];

  // lc-wallet.json ({users:[], ledger:[]})
  const wallet = (await readJson(WALLET_FILE, { users: [], ledger: [], updatedAt: null })) || {};
  if (!Array.isArray(wallet.users)) wallet.users = [];
  if (!Array.isArray(wallet.ledger)) wallet.ledger = [];

  for (const uid of winners) {
    let u = usersItems.find((x) => String(x.userId) === uid);
    if (!u) {
      u = { userId: uid, mainTeam: null, createdAt: nowISO, lc: MINI_WIN_LC, lcLastDaily: null };
      usersItems.push(u);
    } else {
      u.lc = Number(u.lc || 0) + MINI_WIN_LC;
    }
    u.lcUpdatedAt = nowISO;
    u.lcLastReason = "mini_tournament_win";
    u.lcLastAmount = MINI_WIN_LC;

    let wu = wallet.users.find(
      (x) => String(x.userId || "").toLowerCase() === uid.toLowerCase()
    );
    if (!wu) {
      wu = {
        userId: uid,
        balance: 0,
        createdAt: nowISO,
        updatedAt: nowISO,
        lastDailyAt: null,
        totalEarned: 0,
        totalSpent: 0,
      };
      wallet.users.push(wu);
    }
    wu.balance = Number(wu.balance || 0) + MINI_WIN_LC;
    wu.totalEarned = Number(wu.totalEarned || 0) + MINI_WIN_LC;
    wu.updatedAt = nowISO;

    wallet.ledger.push({
      id: "tx_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex"),
      userId: uid,
      kind: "reward",
      amount: MINI_WIN_LC,
      reason: "mini_tournament_win",
      fixtureId: null,
      meta: { tournamentId: tournament.id, tournamentName: tournament.name },
      createdAt: nowISO,
    });
  }

  const usersOut = Array.isArray(usersRaw) ? usersItems : { ...usersRaw, items: usersItems };
  await writeJson(USERS_FILE, usersOut);
  wallet.updatedAt = nowISO;
  await writeJson(WALLET_FILE, wallet);

  return winners.length;
}

// Aynı turnuvanın eşzamanlı iki board isteğinde çifte ödülü engelle
const _finalizing = new Set();

/** Tüm maçlar settle olduysa turnuvayı bitir: kazananları yaz, LC ödülünü ver. */
async function finalizeIfDone(t, board, settledCount, fixtureCount) {
  if (t.finishedAt) return t;
  if (!fixtureCount || settledCount < fixtureCount) return t;
  if (_finalizing.has(t.id)) return t;
  _finalizing.add(t.id);

  try {
    // Dosyadan taze oku (yarış koşullarına karşı) ve tekrar kontrol et
    const items = await loadAll();
    const cur = items.find((x) => x.id === t.id);
    if (!cur || cur.finishedAt) return cur || t;

    const top = board.length ? board[0].points : 0;
    // Kimse puan alamadıysa kazanan yok (hükümsüz biter, ödül dağıtılmaz)
    const winners = top > 0 ? board.filter((r) => r.points === top).map((r) => r.userId) : [];

    cur.finishedAt = new Date().toISOString();
    cur.winners = winners;
    cur.rewardLc = winners.length ? MINI_WIN_LC : 0;
    await saveAll(items);

    if (winners.length) {
      const awarded = await awardMiniWinLc(winners, cur);
      console.log(
        `[mini] turnuva bitti: "${cur.name}" (${cur.id}) | kazanan: ${winners.join(", ")} | LC ödülü: ${MINI_WIN_LC} x ${awarded}`
      );
    } else {
      console.log(`[mini] turnuva hükümsüz bitti (puan yok): "${cur.name}" (${cur.id})`);
    }
    return cur;
  } finally {
    _finalizing.delete(t.id);
  }
}

// ---- POST /api/mini/create ----
router.post("/create", express.json(), async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const name = String(req.body?.name || "").trim().slice(0, 60);
    const fixtures = Array.isArray(req.body?.fixtures) ? req.body.fixtures : [];

    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });
    if (!name) return res.status(400).json({ ok: false, error: "NAME_REQUIRED" });
    if (fixtures.length < MIN_FIXTURES || fixtures.length > MAX_FIXTURES) {
      return res.status(400).json({
        ok: false,
        error: "FIXTURE_COUNT_INVALID",
        detail: `${MIN_FIXTURES}-${MAX_FIXTURES} maç seçilmeli`,
      });
    }

    const clean = [];
    const seen = new Set();
    for (const f of fixtures) {
      const fid = String(f?.fixtureId || "").trim();
      if (!fid || seen.has(fid)) continue;
      seen.add(fid);
      clean.push({
        fixtureId: fid,
        home: String(f?.home || "").slice(0, 60) || null,
        away: String(f?.away || "").slice(0, 60) || null,
        kickoffISO: f?.kickoffISO || null,
        league: String(f?.league || "").slice(0, 60) || null,
      });
    }
    if (clean.length < MIN_FIXTURES) {
      return res.status(400).json({ ok: false, error: "FIXTURE_COUNT_INVALID" });
    }

    const items = await loadAll();
    const codes = new Set(items.map((t) => t.code));
    const t = {
      id: "MINI-" + crypto.randomBytes(6).toString("hex"),
      code: newCode(codes),
      name,
      ownerId: userId,
      fixtures: clean,
      members: [userId],
      createdAt: new Date().toISOString(),
    };
    items.push(t);
    await saveAll(items);

    return res.json({ ok: true, tournament: publicView(t) });
  } catch (e) {
    console.error("[mini] create error:", e);
    return res.status(500).json({ ok: false, error: "MINI_CREATE_FAILED", detail: String(e?.message || e) });
  }
});

// ---- POST /api/mini/join ----
router.post("/join", express.json(), async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!userId || !code) return res.status(400).json({ ok: false, error: "USER_OR_CODE_MISSING" });

    const items = await loadAll();
    const t = items.find((x) => String(x.code).toUpperCase() === code);
    if (!t) return res.status(404).json({ ok: false, error: "TOURNAMENT_NOT_FOUND" });

    t.members = Array.isArray(t.members) ? t.members : [];
    if (t.members.includes(userId)) {
      return res.json({ ok: true, tournament: publicView(t), already: true });
    }
    if (t.members.length >= MAX_MEMBERS) {
      return res.status(400).json({ ok: false, error: "TOURNAMENT_FULL" });
    }
    t.members.push(userId);
    await saveAll(items);

    return res.json({ ok: true, tournament: publicView(t) });
  } catch (e) {
    console.error("[mini] join error:", e);
    return res.status(500).json({ ok: false, error: "MINI_JOIN_FAILED", detail: String(e?.message || e) });
  }
});

// ---- POST /api/mini/invite ----
// Üye olan bir kullanıcı, ARKADAŞI olan birini turnuvaya doğrudan ekler.
// Arkadaşlık zaten karşılıklı onayla kurulduğu için ayrıca kabul adımı yok;
// davet edilen, turnuvayı "Turnuvalarım" listesinde görür.
const FRIENDS_FILE = path.join(DATA_DIR, "friends.json");

async function areFriends(u1, u2) {
  const m = await readJson(FRIENDS_FILE, { links: [], blocks: [] });
  const a = String(u1).toLowerCase();
  const b = String(u2).toLowerCase();

  const blocked = (m.blocks || []).some((x) => {
    const by = String(x.by || "").toLowerCase();
    const tg = String(x.target || "").toLowerCase();
    return (by === a && tg === b) || (by === b && tg === a);
  });
  if (blocked) return false;

  return (m.links || []).some((l) => {
    const la = String(l.a || "").toLowerCase();
    const lb = String(l.b || "").toLowerCase();
    return (la === a && lb === b) || (la === b && lb === a);
  });
}

router.post("/invite", express.json(), async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const id = String(req.body?.id || "").trim();
    const friendUserId = String(req.body?.friendUserId || "").trim();
    if (!userId || !id || !friendUserId) {
      return res.status(400).json({ ok: false, error: "USER_ID_OR_FRIEND_MISSING" });
    }
    if (userId.toLowerCase() === friendUserId.toLowerCase()) {
      return res.status(400).json({ ok: false, error: "CANNOT_INVITE_SELF" });
    }

    const items = await loadAll();
    const t = items.find((x) => x.id === id);
    if (!t) return res.status(404).json({ ok: false, error: "TOURNAMENT_NOT_FOUND" });

    t.members = Array.isArray(t.members) ? t.members : [];
    if (!t.members.includes(userId)) {
      return res.status(403).json({ ok: false, error: "NOT_A_MEMBER" });
    }
    if (t.members.includes(friendUserId)) {
      return res.json({ ok: true, tournament: publicView(t), already: true });
    }
    if (!(await areFriends(userId, friendUserId))) {
      return res.status(403).json({ ok: false, error: "NOT_FRIENDS" });
    }
    if (t.members.length >= MAX_MEMBERS) {
      return res.status(400).json({ ok: false, error: "TOURNAMENT_FULL" });
    }

    t.members.push(friendUserId);
    await saveAll(items);
    return res.json({ ok: true, tournament: publicView(t), invited: friendUserId });
  } catch (e) {
    console.error("[mini] invite error:", e);
    return res.status(500).json({ ok: false, error: "MINI_INVITE_FAILED", detail: String(e?.message || e) });
  }
});

// ---- GET /api/mini/mine?userId= ----
router.get("/mine", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const items = await loadAll();
    const mine = items
      .filter((t) => (t.members || []).includes(userId))
      .map(publicView)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return res.json({ ok: true, items: mine });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "MINI_LIST_FAILED", detail: String(e?.message || e) });
  }
});

// ---- GET /api/mini/wins?userId= : kazanılan turnuvalar (profil vitrini) ----
router.get("/wins", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const items = await loadAll();
    const wins = items
      .filter(
        (t) =>
          t.finishedAt &&
          Array.isArray(t.winners) &&
          t.winners.some((w) => String(w).toLowerCase() === userId.toLowerCase())
      )
      .map((t) => ({
        id: t.id,
        name: t.name,
        finishedAt: t.finishedAt,
        rewardLc: t.rewardLc ?? 0,
        memberCount: (t.members || []).length,
        fixtureCount: (t.fixtures || []).length,
        shared: (t.winners || []).length > 1, // beraberlikte ortak şampiyonluk
      }))
      .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));

    return res.json({ ok: true, count: wins.length, items: wins });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "MINI_WINS_FAILED", detail: String(e?.message || e) });
  }
});

// ---- GET /api/mini/board?id= (veya ?code=) ----
router.get("/board", async (req, res) => {
  try {
    const id = String(req.query.id || "").trim();
    const code = String(req.query.code || "").trim().toUpperCase();
    if (!id && !code) return res.status(400).json({ ok: false, error: "ID_OR_CODE_REQUIRED" });

    const items = await loadAll();
    const t = items.find(
      (x) => (id && x.id === id) || (code && String(x.code).toUpperCase() === code)
    );
    if (!t) return res.status(404).json({ ok: false, error: "TOURNAMENT_NOT_FOUND" });

    const members = new Set(t.members || []);
    const fixtureIds = (t.fixtures || []).map((f) => String(f.fixtureId));

    // Settle edilmiş sonuç snapshot'ları (kullanıcı-başına puan satırları)
    const resultsRaw = await readJson(RESULTS_FILE, []);
    const resultsArr = Array.isArray(resultsRaw) ? resultsRaw : resultsRaw.items || [];
    const byFixture = new Map(resultsArr.map((r) => [String(r.fixtureId), r]));

    const totals = new Map(); // userId -> { points, settledMatches }
    for (const uid of members) totals.set(uid, { userId: uid, points: 0, settledMatches: 0 });

    const fixtureViews = [];
    let settledCount = 0;

    for (const f of t.fixtures || []) {
      const fid = String(f.fixtureId);
      const snap = byFixture.get(fid);

      // canlı/pending durum bilgisi için state dosyası
      const st = await readJson(path.join(LIVE_DIR, `${fid}.json`), null);

      const view = {
        ...f,
        status: st?.status || (snap ? "FT" : "NS"),
        score: st?.score || snap?.finalScore || null,
        settled: !!snap,
      };
      fixtureViews.push(view);

      if (!snap) continue;
      settledCount++;
      for (const row of snap.rows || []) {
        const uid = String(row.userId || "");
        if (!members.has(uid)) continue;
        const cur = totals.get(uid);
        cur.points += Number(row.points || 0);
        cur.settledMatches++;
      }
    }

    const board = Array.from(totals.values())
      .map((x) => ({ ...x, points: Math.round(x.points * 100) / 100 }))
      .sort((a, b) => b.points - a.points || a.userId.localeCompare(b.userId));

    // Tüm maçlar bittiyse turnuvayı sonlandır (kazanan + LC ödülü, bir kez)
    const finalT = await finalizeIfDone(t, board, settledCount, fixtureIds.length);

    return res.json({
      ok: true,
      tournament: publicView(finalT),
      fixtures: fixtureViews,
      board,
      settledCount,
      pendingCount: fixtureIds.length - settledCount,
    });
  } catch (e) {
    console.error("[mini] board error:", e);
    return res.status(500).json({ ok: false, error: "MINI_BOARD_FAILED", detail: String(e?.message || e) });
  }
});

module.exports = router;
