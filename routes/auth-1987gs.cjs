"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA_DIR    = path.join(__dirname, "..", "data");
const CODES_FILE  = path.join(DATA_DIR, "gs1987-codes.json");

function requireAdminToken(req, res, next) {
  const token = String(process.env.SKORLIG_ADMIN_TOKEN || "").trim();
  if (!token) return res.status(503).json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });
  const got = String(req.headers["x-admin-token"] || "").trim() || String(req.query.token || "").trim();
  if (got && got === token) return next();
  return res.status(401).json({ ok: false, error: "ADMIN_TOKEN_REQUIRED" });
}
const USERS_FILE  = path.join(DATA_DIR, "users.json");  // 1987 üyeleri burada tutulacak

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
 * Bir kullanıcıyı 1987 üyesi olarak işaretle.
 * users.json modeli:
 * {
 *   "users": [
 *      {
 *        "id": "demo1",
 *        "is1987": true,
 *        "since1987": "2025-11-22T...",
 *        "lastCode": "ABC1987",
 *        "lastVerifiedAt": "2025-11-22T...",
 *        "active": true
 *      }
 *   ],
 *   "updatedAt": "..."
 * }
 */
async function markUser1987(userId, code) {
  if (!userId) return;

  const data =
    (await readJson(USERS_FILE, { users: [], updatedAt: null })) || {};
  const users = Array.isArray(data.users) ? data.users : [];

  const idNorm = String(userId).trim().toLowerCase();
  const nowISO = new Date().toISOString();

  let idx = users.findIndex(
    (u) =>
      String(u.id || u.userId || "")
        .trim()
        .toLowerCase() === idNorm
  );

  if (idx === -1) {
    // yeni kullanıcı
    users.push({
      id: userId,
      is1987: true,
      since1987: nowISO,
      lastCode: code || null,
      lastVerifiedAt: nowISO,
      active: true
    });
  } else {
    // mevcut kullanıcıyı güncelle
    const u = users[idx];
    users[idx] = {
      ...u,
      id: u.id || u.userId || userId,
      is1987: true,
      since1987: u.since1987 || nowISO,
      lastCode: code || u.lastCode || null,
      lastVerifiedAt: nowISO,
      active: u.active !== false,  // default true
    };
  }

  data.users = users;
  data.updatedAt = nowISO;
  await writeJson(USERS_FILE, data);
}

/**
 * POST /api/auth1987gs/verify
 *
 * Body:
 *   { "code": "ABCD1987", "userId": "demo1" }
 *
 * - Kod geçerliyse:
 *   - gs1987-codes.json içinde used++ yapar
 *   - userId varsa users.json içinde is1987:true ve ek alanları günceller
 */
router.post("/verify", express.json(), async (req, res) => {
  const rawCode = String(req.body?.code || "").trim();
  const userId  = String(req.body?.userId || "").trim() || null;

  if (!rawCode) {
    return res.status(400).json({ ok: false, error: "CODE_REQUIRED" });
  }

  const codeNorm = rawCode.toUpperCase();

  const data  = (await readJson(CODES_FILE, { codes: [], updatedAt: null })) || {};
  const codes = Array.isArray(data.codes) ? data.codes : [];

  const idx = codes.findIndex(
    (c) => String(c.code || "").toUpperCase() === codeNorm
  );
  if (idx === -1) {
    return res.status(400).json({ ok: false, error: "INVALID_CODE" });
  }

  const item    = codes[idx];
  const maxUses = Number(item.maxUses || 0) || 0;
  const used    = Number(item.used || 0) || 0;

  if (maxUses > 0 && used >= maxUses) {
    return res.status(400).json({ ok: false, error: "CODE_EXHAUSTED" });
  }

  item.used       = used + 1;
  item.lastUsedAt = new Date().toISOString();

  codes[idx]     = item;
  data.codes     = codes;
  data.updatedAt = new Date().toISOString();

  await writeJson(CODES_FILE, data);

  // ✅ Kullanıcıyı 1987 üyesi olarak işaretle (userId verilmişse)
  if (userId) {
    await markUser1987(userId, codeNorm);
  }

  return res.json({
    ok: true,
    role: "1987GS",
    code: {
      label: item.label || null,
      remaining: maxUses > 0 ? maxUses - item.used : null,
    },
    userId: userId || null,
    is1987: !!userId,
  });
});

/**
 * GET /api/auth1987gs/diag
 *  - Kodların kullanım durumunu gösterir (eski diag aynen dursun)
 */
router.get("/diag", requireAdminToken, async (req, res) => {
  const data  = (await readJson(CODES_FILE, { codes: [], updatedAt: null })) || {};
  const codes = Array.isArray(data.codes) ? data.codes : [];

  const items = codes.map((c) => {
    const used    = Number(c.used || 0);
    const maxUses = Number(c.maxUses || 0);
    let ratio  = null;
    let status = "unknown";

    if (maxUses > 0) {
      ratio = used / maxUses;
      if (used >= maxUses)      status = "full";
      else if (ratio >= 0.75)   status = "low";
      else                      status = "ok";
    } else {
      status = "unlimited";
    }

    return {
      code: c.code,
      label: c.label || null,
      used,
      maxUses,
      ratio,
      status,
      lastUsedAt: c.lastUsedAt || null,
    };
  });

  res.json({
    ok: true,
    updatedAt: data.updatedAt || null,
    totalCodes: items.length,
    codes: items,
  });
});

/**
 * GET /api/auth1987gs/members
 *
 * 1987 üyesi kullanıcıların listesini döner.
 * Senin mobile tarafındaki Member tipiyle birebir uyumlu:
 *
 *   {
 *     ok: true,
 *     updatedAt: "...",
 *     total: N,
 *     items: [
 *       {
 *         userId,
 *         label,
 *         lastCode,
 *         sinceAt,
 *         lastVerifiedAt,
 *         active
 *       }
 *     ]
 *   }
 */
router.get("/members", requireAdminToken, async (req, res) => {
  const data =
    (await readJson(USERS_FILE, { users: [], updatedAt: null })) || {};
  const users = Array.isArray(data.users) ? data.users : [];

  const members = users
    .filter((u) => u.is1987)
    .map((u) => ({
      userId: u.id || u.userId,
      label: u.label || null,
      lastCode: u.lastCode || null,
      sinceAt: u.since1987 || u.sinceAt || null,
      lastVerifiedAt: u.lastVerifiedAt || null,
      active: u.active !== false,
    }));

  res.json({
    ok: true,
    updatedAt: data.updatedAt || null,
    total: members.length,
    items: members,
  });
});

module.exports = router;
