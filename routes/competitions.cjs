"use strict";

const express = require("express");
const router  = express.Router();
const path    = require("path");
const fs      = require("fs");
const fsp     = fs.promises;

const DATA_DIR            = path.join(__dirname, "..", "data");
const COMPETITIONS_FILE   = path.join(DATA_DIR, "competitions.json");
const FIXTURE_COMP_FILE   = path.join(DATA_DIR, "fixture-competitions.json");
// Competition sezon/kupa toplamları için opsiyonel dosya fallback'i
const COMP_TOTALS_FILE    = path.join(DATA_DIR, "competition-totals.json");

// ----------------- Helper'lar -----------------
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

function getDb(req) {
  return req?.app?.locals?.db || null;
}

// ----------------- MODEL NOTLARI -----------------
/**
 * Competitions (Mongo koleksiyonu: "competitions", file: competitions.json)
 *
 *  {
 *    id: "COMP_GLOBAL_2025",     // primary
 *    name: "SkorLig Global Sezon 2025",
 *    shortName: "Global 25",
 *    kind: "league" | "cup" | "friendly",
 *    season: "2024-25",
 *    country: "TR" | "EU" | "GLOBAL" | ...
 *    isActive: true,
 *    meta: {...},                // serbest alan
 *    createdAt: ISO,
 *    updatedAt: ISO
 *  }
 *
 * Fixture_competitions (Mongo koleksiyonu: "fixture_competitions",
 * file: fixture-competitions.json ile aynı şema)
 *
 *  {
 *    fixtureId: "TEST-FX-1",
 *    competitions: [
 *      {
 *        competitionId: "COMP_GLOBAL_2025",
 *        countsForPoints: true,
 *        createdAt: ISO,
 *        updatedAt: ISO
 *      },
 *      ...
 *    ],
 *    updatedAt: ISO
 *  }
 *
 * settle2.cjs, competition_totals mirror'ını bu şemaya göre yapıyor.
 */

// ----------------- 1) Ping -----------------

/**
 * GET /api/rt/competitions/ping
 */
router.get("/competitions/ping", (req, res) => {
  res.json({ ok: true, where: "competitions-router-alive" });
});

// ----------------- 2) Competition listesi -----------------

/**
 * GET /api/rt/competitions
 *
 * Query:
 *   - onlyActive=1   → sadece isActive:true olanlar
 *
 * Kaynak önceliği:
 *   1) Mongo "competitions" koleksiyonu (varsa)
 *   2) data/competitions.json (yoksa)
 */
router.get("/competitions", async (req, res) => {
  try {
    const onlyActive = String(req.query.onlyActive || "0") === "1";
    const db = getDb(req);

    // 1) Mongo modu
    if (db) {
      const col = db.collection("competitions");
      const filter = {};
      if (onlyActive) filter.isActive = true;

      const docs = await col
        .find(filter)
        .sort({ isActive: -1, createdAt: 1 })
        .toArray();

      const items = docs.map((d) => ({
        id: d.id,
        name: d.name,
        shortName: d.shortName || null,
        kind: d.kind || null,
        season: d.season || null,
        country: d.country || null,
        isActive: !!d.isActive,
        meta: d.meta || null,
        createdAt: d.createdAt || null,
        updatedAt: d.updatedAt || null,
      }));

      return res.json({
        ok: true,
        source: "mongo",
        count: items.length,
        items,
      });
    }

    // 2) Dosya modu
    const data = (await readJson(COMPETITIONS_FILE, { items: [] })) || {
      items: [],
    };
    let items = Array.isArray(data.items) ? data.items : [];

    if (onlyActive) {
      items = items.filter((c) => c.isActive !== false);
    }

    return res.json({
      ok: true,
      source: "file",
      count: items.length,
      items,
    });
  } catch (e) {
    console.error("COMPETITIONS_LIST_FAILED", e);
    return res.status(500).json({
      ok: false,
      error: "COMPETITIONS_LIST_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

// ----------------- 3) Competition upsert -----------------

/**
 * POST /api/rt/competitions/upsert
 *
 * body:
 *  {
 *    id: "COMP_GLOBAL_2025",        // zorunlu
 *    name: "SkorLig Global Sezon 2025",
 *    shortName: "Global 25",
 *    kind: "league" | "cup" | "friendly",
 *    season: "2024-25",
 *    country: "GLOBAL",
 *    isActive: true,
 *    meta: {...}
 *  }
 *
 * Not:
 *  - Mongo varsa "competitions" koleksiyonuna upsert
 *  - Yoksa data/competitions.json içinde upsert
 */
router.post("/competitions/upsert", express.json(), async (req, res) => {
  try {
    const {
      id,
      name,
      shortName,
      kind,
      season,
      country,
      isActive,
      meta,
    } = req.body || {};

    const cid = String(id || "").trim();
    if (!cid) {
      return res
        .status(400)
        .json({ ok: false, error: "COMPETITION_ID_REQUIRED" });
    }

    const nowISO = new Date().toISOString();
    const db = getDb(req);

    // 1) Mongo modu
    if (db) {
      const col = db.collection("competitions");

      const doc = {
        id: cid,
        name: name || cid,
        shortName: shortName || null,
        kind: kind || null,
        season: season || null,
        country: country || null,
        isActive: isActive !== false, // default: true
        meta: meta || null,
        updatedAt: nowISO,
      };

      const result = await col.updateOne(
        { id: cid },
        {
          $set: doc,
          $setOnInsert: {
            createdAt: nowISO,
          },
        },
        { upsert: true }
      );

      const saved = await col.findOne({ id: cid });

      return res.json({
        ok: true,
        source: "mongo",
        upsertedId: result.upsertedId || null,
        competition: saved,
      });
    }

    // 2) Dosya modu
    const data =
      (await readJson(COMPETITIONS_FILE, { items: [], updatedAt: null })) || {
        items: [],
      };
    const items = Array.isArray(data.items) ? data.items : [];

    let found = items.find(
      (c) => String(c.id || "").trim().toLowerCase() === cid.toLowerCase()
    );

    if (!found) {
      found = {
        id: cid,
        name: name || cid,
        shortName: shortName || null,
        kind: kind || null,
        season: season || null,
        country: country || null,
        isActive: isActive !== false,
        meta: meta || null,
        createdAt: nowISO,
        updatedAt: nowISO,
      };
      items.push(found);
    } else {
      found.name = name || found.name || cid;
      found.shortName = shortName != null ? shortName : found.shortName;
      found.kind = kind != null ? kind : found.kind;
      found.season = season != null ? season : found.season;
      found.country = country != null ? country : found.country;
      if (typeof isActive === "boolean") found.isActive = isActive;
      found.meta = meta != null ? meta : found.meta;
      found.updatedAt = nowISO;
    }

    const out = {
      items,
      updatedAt: nowISO,
    };
    await writeJson(COMPETITIONS_FILE, out);

    return res.json({
      ok: true,
      source: "file",
      competition: found,
    });
  } catch (e) {
    console.error("COMPETITIONS_UPSERT_FAILED", e);
    return res.status(500).json({
      ok: false,
      error: "COMPETITIONS_UPSERT_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

// ----------------- 4) Fixture ↔ Competition ilişkisi -----------------

/**
 * GET /api/rt/fixture-competitions?fixtureId=...
 *
 * - Bir maçın hangi yarışmalara bağlı olduğunu döner.
 * - Mongo varsa "fixture_competitions", yoksa fixture-competitions.json
 */
router.get("/fixture-competitions", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "").trim();
    if (!fixtureId) {
      return res
        .status(400)
        .json({ ok: false, error: "FIXTURE_ID_REQUIRED" });
    }

    const db = getDb(req);

    // 1) Mongo modu
    if (db) {
      const col = db.collection("fixture_competitions");
      const doc = await col.findOne({ fixtureId });

      return res.json({
        ok: true,
        source: "mongo",
        fixtureId,
        competitions: Array.isArray(doc?.competitions)
          ? doc.competitions
          : [],
        updatedAt: doc?.updatedAt || null,
      });
    }

    // 2) Dosya modu
    const data =
      (await readJson(FIXTURE_COMP_FILE, { items: [], updatedAt: null })) || {
        items: [],
      };
    const items = Array.isArray(data.items) ? data.items : [];

    const rec = items.find(
      (x) => String(x.fixtureId || "") === fixtureId
    );

    return res.json({
      ok: true,
      source: "file",
      fixtureId,
      competitions: Array.isArray(rec?.competitions)
        ? rec.competitions
        : [],
      updatedAt: rec?.updatedAt || null,
    });
  } catch (e) {
    console.error("FIXTURE_COMPETITIONS_GET_FAILED", e);
    return res.status(500).json({
      ok: false,
      error: "FIXTURE_COMPETITIONS_GET_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

/**
 * POST /api/rt/fixture-competitions/assign
 *
 * body:
 *  {
 *    fixtureId: "TEST-FX-1",
 *    competitionId: "COMP_GLOBAL_2025",
 *    countsForPoints: true   // opsiyonel, default true
 *  }
 *
 * - Aynı fixtureId için competitions[] array'ini günceller.
 * - Aynı competitionId zaten varsa, countsForPoints alanını günceller.
 * - settle2.cjs, competition_totals mirror'ında bu dokümanı kullanıyor.
 */
router.post(
  "/fixture-competitions/assign",
  express.json(),
  async (req, res) => {
    try {
      const { fixtureId, competitionId, countsForPoints } = req.body || {};

      const fid = String(fixtureId || "").trim();
      const cid = String(competitionId || "").trim();

      if (!fid || !cid) {
        return res.status(400).json({
          ok: false,
          error: "FIXTURE_ID_AND_COMPETITION_ID_REQUIRED",
        });
      }

      const db = getDb(req);
      const nowISO = new Date().toISOString();
      const cfp =
        typeof countsForPoints === "boolean" ? countsForPoints : true;

      // 1) Mongo modu
      if (db) {
        const col = db.collection("fixture_competitions");

        const doc = await col.findOne({ fixtureId: fid });
        let competitions = Array.isArray(doc?.competitions)
          ? [...doc.competitions]
          : [];

        const idx = competitions.findIndex(
          (c) =>
            String(c.competitionId || "").trim().toLowerCase() ===
            cid.toLowerCase()
        );

        if (idx === -1) {
          competitions.push({
            competitionId: cid,
            countsForPoints: cfp,
            createdAt: nowISO,
            updatedAt: nowISO,
          });
        } else {
          competitions[idx] = {
            ...competitions[idx],
            competitionId: cid,
            countsForPoints: cfp,
            updatedAt: nowISO,
          };
        }

        await col.updateOne(
          { fixtureId: fid },
          {
            $set: {
              fixtureId: fid,
              competitions,
              updatedAt: nowISO,
            },
            $setOnInsert: {
              createdAt: nowISO,
            },
          },
          { upsert: true }
        );

        const saved = await col.findOne({ fixtureId: fid });

        return res.json({
          ok: true,
          source: "mongo",
          fixtureId: fid,
          competitions: saved?.competitions || [],
          updatedAt: saved?.updatedAt || nowISO,
        });
      }

      // 2) Dosya modu
      const data =
        (await readJson(FIXTURE_COMP_FILE, {
          items: [],
          updatedAt: null,
        })) || { items: [] };
      const items = Array.isArray(data.items) ? data.items : [];

      let rec = items.find(
        (x) => String(x.fixtureId || "") === fid
      );
      if (!rec) {
        rec = {
          fixtureId: fid,
          competitions: [],
          createdAt: nowISO,
          updatedAt: nowISO,
        };
        items.push(rec);
      }

      if (!Array.isArray(rec.competitions)) rec.competitions = [];

      const idx2 = rec.competitions.findIndex(
        (c) =>
          String(c.competitionId || "").trim().toLowerCase() ===
          cid.toLowerCase()
      );

      if (idx2 === -1) {
        rec.competitions.push({
          competitionId: cid,
          countsForPoints: cfp,
          createdAt: nowISO,
          updatedAt: nowISO,
        });
      } else {
        rec.competitions[idx2] = {
          ...rec.competitions[idx2],
          competitionId: cid,
          countsForPoints: cfp,
          updatedAt: nowISO,
        };
      }

      rec.updatedAt = nowISO;

      const out = {
        items,
        updatedAt: nowISO,
      };
      await writeJson(FIXTURE_COMP_FILE, out);

      return res.json({
        ok: true,
        source: "file",
        fixtureId: fid,
        competitions: rec.competitions,
        updatedAt: rec.updatedAt,
      });
    } catch (e) {
      console.error("FIXTURE_COMPETITIONS_ASSIGN_FAILED", e);
      return res.status(500).json({
        ok: false,
        error: "FIXTURE_COMPETITIONS_ASSIGN_FAILED",
        detail: String(e && (e.message || e)),
      });
    }
  }
);

// ----------------- 5) Competition sezon/toplam leaderboard -----------------

/**
 * GET /api/rt/competitions/totals?competitionId=...&limit=100
 *
 * Kaynak önceliği:
 *   1) Mongo "competition_totals" koleksiyonu (varsa)
 *   2) data/competition-totals.json (yoksa)
 *
 * Çıktı:
 *  {
 *    ok: true,
 *    competitionId,
 *    leaderboard: [
 *      { userId, total, played, penalties, avg }
 *    ],
 *    updatedAt,
 *    source: "mongo_competition_totals" | "file_competition_totals"
 *  }
 */
router.get("/competitions/totals", async (req, res) => {
  try {
    const competitionId = String(req.query.competitionId || "").trim();
    const limit = Number(req.query.limit || 100) || 100;

    if (!competitionId) {
      return res
        .status(400)
        .json({ ok: false, error: "COMPETITION_ID_REQUIRED" });
    }

    const db = getDb(req);

    // 1) Mongo modu
    if (db) {
      try {
        const col = db.collection("competition_totals");
        const docs = await col
          .find({ competitionId })
          .sort({ totalPoints: -1 })
          .limit(limit)
          .toArray();

        const rows = docs.map((d) => {
          const total = Number(d.totalPoints || 0);
          const played = Number(d.matches || 0);
          const penalties = Number(d.totalPenalty || 0);
          const avg = played ? Math.round(total / played) : 0;

          return {
            userId: d.userId || d.userIdLower || "anon",
            total,
            played,
            penalties,
            avg,
          };
        });

        const updatedAt =
          docs[0]?.updatedAt ||
          docs[0]?.lastAt ||
          new Date().toISOString();

        return res.json({
          ok: true,
          competitionId,
          leaderboard: rows,
          updatedAt,
          source: "mongo_competition_totals",
        });
      } catch (e) {
        console.error(
          "[competitions] Mongo competition_totals read failed, falling back to files:",
          e
        );
        // Sessizce dosya moduna düşeceğiz
      }
    }

    // 2) Dosya modu
    const data =
      (await readJson(COMP_TOTALS_FILE, {
        items: [],
        updatedAt: null,
      })) || { items: [], updatedAt: null };

    const items = Array.isArray(data.items) ? data.items : [];

    const filtered = items
      .filter(
        (t) =>
          String(t.competitionId || "").trim() === competitionId
      )
      .map((t) => {
        const total = Number(t.totalPoints || 0);
        const played = Number(t.matches || 0);
        const penalties = Number(t.totalPenalty || 0);
        const avg = played ? Math.round(total / played) : 0;

        return {
          userId: t.userId,
          total,
          played,
          penalties,
          avg,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);

    const updatedAt =
      data.updatedAt ||
      (filtered[0] && filtered[0].updatedAt) ||
      null;

    return res.json({
      ok: true,
      competitionId,
      leaderboard: filtered,
      updatedAt,
      source: "file_competition_totals",
    });
  } catch (e) {
    console.error("COMPETITION_TOTALS_FAILED", e);
    return res.status(500).json({
      ok: false,
      error: "COMPETITION_TOTALS_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

module.exports = router;
