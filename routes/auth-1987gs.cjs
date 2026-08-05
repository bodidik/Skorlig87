"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;

const InviteStore = require("../lib/invite-store.cjs");
/* Üyelik yazması yalnızca doğrulanmış kimliğe — bkz. POST /verify notu. */
const { verifyToken, optionalToken } = require("../middleware/verifyToken.cjs");

function requireAdminToken(req, res, next) {
  const token = String(process.env.SKORLIG_ADMIN_TOKEN || "").trim();
  if (!token) return res.status(503).json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });
  const got = String(req.headers["x-admin-token"] || "").trim() || String(req.query.token || "").trim();
  if (got && got === token) return next();
  return res.status(401).json({ ok: false, error: "ADMIN_TOKEN_REQUIRED" });
}
const UsersStore = require("../lib/users-store.cjs");



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
/**
 * ⚠️ ÜYELİĞİ İSTENEN HERKESE VEREBİLİYORDU — kimlik GÖVDEDEN geliyordu.
 *
 * `userId` doğrulanmadan `markUser1987` çağrılıyordu; yani geçerli bir kod
 * bilen kişi üyeliği KENDİ HESABI YERİNE başkasına yazdırabiliyordu. 1987
 * üyeliği bedava değil — dosyanın kendi notu sayıyor: açılış bakiyesi 60 LC
 * (normalde 30) ve haftalık seçimler ücretsiz. Kod kotası da o hesap için
 * harcanıyordu.
 *
 * ⚠️ KOD DOĞRULAMA KISMI KİMLİKSİZ KALIYOR. `optionalToken` seçildi çünkü
 * kodun geçerliliğini sormak (kotayı görmek) oturum gerektirmemeli; üyelik
 * YAZMASI ise yalnızca doğrulanmış kimliğe yapılıyor. `verifyToken` koymak
 * kod girme ekranını oturumdan önce kullanılamaz hâle getirirdi.
 *
 * ⚠️ İSTEMCİ ZATEN JETON GÖNDERİYOR: `gs1987-verify.tsx` ve `mystatus.tsx`
 * ikisi de `apiFetch` kullanıyor ve giriş yapmış kullanıcıdan çağrılıyor —
 * yani kilitlemek hiçbir ekranı bozmuyor.
 *
 * Kaba kuvvet ayrı bir katmanda: `server.cjs` global `rateLimit` uyguluyor
 * ve kodlar 11 karakter.
 */
router.post("/verify", optionalToken, express.json(), async (req, res) => {
  const rawCode = String(req.body?.code || "").trim();
  /* Kimlik JETONDAN. Gövdedeki `userId` yalnızca kendi kimliğiyle
   * eşleşiyorsa dikkate alınır; eşleşmezse üyelik YAZILMAZ. */
  const istenen = String(req.body?.userId || "").trim();
  const kimlik  = String(req.uid || "").trim();
  const userId  = (kimlik && (!istenen || istenen.toLowerCase() === kimlik.toLowerCase()))
    ? kimlik
    : null;

  if (!rawCode) {
    return res.status(400).json({ ok: false, error: "CODE_REQUIRED" });
  }

  /* ⚠️ KİMLİK YOKSA KOD TÜKETİLMEZ — SIRA ÖNEMLİ.
   *
   * `redeem` kotayı ATOMİK olarak harcıyor. Kimlik denetimini ondan SONRA
   * yapsaydım (ilk yazımım öyleydi), eşleşmeyen istek üyelik almadan
   * kullanım hakkını YAKARDI: saldırgan başkasının kodunu boşa harcayabilir,
   * jetonu düşmüş meşru kullanıcı ise hakkını kaybederdi.
   * Kod bedava değil — kota 1987 üyeliğinin (60 LC açılış + ücretsiz
   * haftalık seçim) fiyatı. */
  if (!userId) {
    return res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
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
 *         sinceAt,
 *         lastVerifiedAt,
 *         active
 *       }
 *     ]
 *   }
 */
router.get("/members", verifyToken, async (req, res) => {
  const uid = String(req.uid || "").trim().toLowerCase();
  if (!uid) return res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });

  const map = await UsersStore.getUsersByIdsLower([uid], req.app?.locals?.db || null);
  const caller = map[uid];
  if (!caller?.is1987) {
    return res.status(403).json({ ok: false, error: "NOT_1987_MEMBER" });
  }

  // İndeksli segment sorgusu — eskiden tüm kullanıcı dosyası okunuyordu.
  const users = await UsersStore.listSegment1987(req.app?.locals?.db || null);

  const members = users
    .filter((u) => u.is1987)
    .map((u) => ({
      userId: u.id || u.userId,
      label: u.label || null,
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
