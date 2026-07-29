"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA_DIR    = path.join(__dirname, "..", "data");
const CODES_FILE  = path.join(DATA_DIR, "gs1987-codes.json");
const InviteStore = require("../lib/invite-store.cjs");

function requireAdminToken(req, res, next) {
  const token = String(process.env.SKORLIG_ADMIN_TOKEN || "").trim();
  if (!token) return res.status(503).json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });
  const got = String(req.headers["x-admin-token"] || "").trim() || String(req.query.token || "").trim();
  if (got && got === token) return next();
  return res.status(401).json({ ok: false, error: "ADMIN_TOKEN_REQUIRED" });
}
const UsersStore = require("../lib/users-store.cjs");

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
/**
 * 1987 üyeliğini işaretler.
 *
 * ⚠️ DEPOYA yazılır. Eskiden doğrudan users.json'a yazılıyordu; premium.cjs ve
 * listSegment1987 depodan okuduğu için o yazım hiçbir yere ulaşmıyordu —
 * kullanıcı kodu doğruluyor ama üyeliğini (ve premium ayrıcalığını) hiç
 * alamıyordu.
 */
async function markUser1987(userId, code, db) {
  if (!userId) return;

  const nowISO = new Date().toISOString();
  const mevcut = await UsersStore.getUser(userId, db);

  await UsersStore.updateUser(
    userId,
    {
      is1987: true,
      // İlk doğrulama tarihi korunur; her doğrulamada sıfırlanmamalı.
      since1987: mevcut?.since1987 || nowISO,
      lastCode: code || mevcut?.lastCode || null,
      lastVerifiedAt: nowISO,
      active: mevcut?.active !== false,
    },
    { mainTeam: null, lc: 0, lcLastDaily: null },
    db
  );
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

  // ⚠️ ATOMİK KULLANIM. Eski akış "dosyayı oku → kotayı kontrol et → used+1
  // yaz" idi; kontrol ile yazma ayrı olduğu için son kontenjan için gelen iki
  // eşzamanlı istek İKİSİ de geçip kotayı aşıyordu. Ayrıca sayaçlar yalnızca
  // dosyada tutulduğu için her deploy'da sıfırlanıyor, dolmuş kodlar yeniden
  // kullanılabilir hâle geliyordu — 1987 üyeliği bedava değil (açılış bakiyesi
  // 60 LC, haftalık seçimler ücretsiz), yani sınırsız kod = sınırsız LC.
  // bkz. lib/invite-store.cjs
  const sonuc = await InviteStore.redeem(codeNorm, req.app?.locals?.db || null);
  if (!sonuc.ok) {
    return res.status(400).json({ ok: false, error: sonuc.reason });
  }
  const item = sonuc.code;
  // `maxUses` kaldırılan blokta tanımlıydı; artık güncel kayıttan türetiliyor.
  const maxUses = Number(item.maxUses || 0) || 0;

  // ✅ Kullanıcıyı 1987 üyesi olarak işaretle (userId verilmişse)
  if (userId) {
    await markUser1987(userId, codeNorm, req.app?.locals?.db || null);
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
  const codes = await InviteStore.listCodes(req.app?.locals?.db || null);

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
    // `data` sarmalı kaldırıldı (depo düz kod listesi döndürüyor); en yeni
    // kullanım zamanı kodlardan türetiliyor.
    updatedAt: codes.reduce((en, c) => (c.lastUsedAt && c.lastUsedAt > en ? c.lastUsedAt : en), "") || null,
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
  // İndeksli segment sorgusu — eskiden tüm kullanıcı dosyası okunuyordu.
  const users = await UsersStore.listSegment1987(req.app?.locals?.db || null);

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
    // Depo tek bir "son güncelleme" tutmuyor; en yeni doğrulama tarihi
    // aynı bilgiyi veriyor. (Eskiden users.json'un updatedAt alanıydı.)
    updatedAt:
      members.map((m) => m.lastVerifiedAt).filter(Boolean).sort().pop() || null,
    total: members.length,
    items: members,
  });
});

module.exports = router;
