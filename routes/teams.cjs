"use strict";

const express = require("express");
const router  = express.Router();
const path    = require("path");
const fsp     = require("fs").promises;

const DATA_FILE = path.join(__dirname, "..", "data", "countries-teams.json");

let _cache = null;
async function getCountries() {
  if (_cache) return _cache;
  const raw = JSON.parse(await fsp.readFile(DATA_FILE, "utf8"));
  _cache = raw.countries || [];
  return _cache;
}

/** GET /api/teams/countries  — tüm ülkeler (takım listesi yok) */
router.get("/countries", async (req, res) => {
  try {
    const countries = await getCountries();
    res.json({ ok: true, count: countries.length, items: countries.map(c => ({
      code:      c.code,
      name:      c.name,
      localName: c.localName || c.name,
      flag:      c.flag,
      lang:      c.lang,
      topLeague: c.topLeague,
    }))});
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/teams/by-country?country=GR  — bir ülkenin takımları */
router.get("/by-country", async (req, res) => {
  try {
    const code = String(req.query.country || req.query.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ ok: false, error: "country required" });

    const countries = await getCountries();
    const found = countries.find(c => c.code === code ||
      c.name.toLowerCase() === code.toLowerCase() ||
      (c.localName || "").toLowerCase() === code.toLowerCase()
    );

    if (!found) return res.status(404).json({ ok: false, error: "COUNTRY_NOT_FOUND" });

    res.json({ ok: true, code: found.code, name: found.name, localName: found.localName || found.name,
      flag: found.flag, lang: found.lang, topLeague: found.topLeague, teams: found.teams });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/teams/search?q=ajax  — isim arama */
router.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    if (q.length < 2) return res.json({ ok: true, items: [] });

    const countries = await getCountries();
    const results = [];
    for (const c of countries) {
      for (const team of c.teams || []) {
        if (team.toLowerCase().includes(q)) {
          results.push({ team, countryCode: c.code, countryName: c.localName || c.name,
            flag: c.flag, topLeague: c.topLeague });
        }
      }
    }
    res.json({ ok: true, count: results.length, items: results.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
