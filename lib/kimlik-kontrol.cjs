"use strict";

/**
 * KENDİ KAYDI MI? — `?userId=` ile gelen okuma uçları için sahiplik denetimi.
 *
 * ⚠️ NEDEN VAR: cüzdan uçlarında YAZMALARIN hepsinde `verifyToken` vardı,
 * OKUMALARIN hiçbirinde yoktu. Yani kimliği bilinen herkesin bakiyesi, kazanç
 * /harcama toplamı ve TÜM işlem geçmişi kimlik doğrulaması olmadan
 * okunabiliyordu — kullanıcı kimlikleri sıralama tablolarında zaten görünür.
 *
 * Yazmalar bir kez güvenceye alınmış, okumalara dönülmemiş. Aynı yarım-düzeltme
 * izi yol birleştirmede de vardı (bkz. lib/guvenli-dosya.cjs). O yüzden bu
 * denetim üç yere KOPYALANMIYOR, tek yerden çağrılıyor.
 *
 * ⚠️ İSTEMCİ ZATEN BÖYLE DAVRANIYORDU: profil ekranı cüzdan özetini yalnızca
 * `isOwn` iken çağırıyor. Yani niyet en baştan "sadece kendisi"ydi; eksik olan
 * sunucunun bunu ZORLAMASIYDI. Bu yüzden kilitlemek hiçbir ekranı bozmuyor.
 */

/** Yönetici jetonu geçerli mi (destek/hata ayıklama için başkasını okuyabilir). */
function adminMi(req) {
  const beklenen = String(
    process.env.SKORLIG_ADMIN_TOKEN ||
      process.env.ADMIN_TOKEN ||
      process.env.EXPO_PUBLIC_ADMIN_TOKEN ||
      ""
  ).trim();
  // Token yapılandırılmamışsa admin YOK — fail-closed.
  if (!beklenen) return false;
  const gelen = String(req.headers?.["x-admin-token"] || "").trim();
  return !!gelen && gelen === beklenen;
}

/**
 * İstenen userId, isteği yapanın kendisi mi?
 *
 * @param {import("express").Request} req  `verifyToken`'dan geçmiş olmalı (req.uid)
 * @param {*} istenenUserId  sorgudan gelen userId (boş olabilir → kendi kaydı)
 * @returns {{ok:true, uid:string} | {ok:false, kod:number, hata:string}}
 */
function kendiKaydiMi(req, istenenUserId) {
  const kendi = String(req?.uid || "").trim();
  if (!kendi) return { ok: false, kod: 401, hata: "AUTH_REQUIRED" };

  const istenen = String(istenenUserId == null ? "" : istenenUserId).trim();
  // userId gönderilmediyse kendi kaydı kastediliyor.
  if (!istenen) return { ok: true, uid: kendi };

  if (istenen.toLowerCase() !== kendi.toLowerCase() && !adminMi(req)) {
    return { ok: false, kod: 403, hata: "FORBIDDEN_OTHER_USER" };
  }
  // Admin başkasını okuyorsa İSTENEN kimlik döner; normal kullanıcıda ikisi aynı.
  return { ok: true, uid: istenen };
}

/**
 * Rota içinde tek satırda kullanım:
 *   const k = kimlikVeyaHata(req, res, req.query.userId);
 *   if (!k) return;                  // yanıt zaten yazıldı
 *   const userId = k.uid;
 */
function kimlikVeyaHata(req, res, istenenUserId) {
  const s = kendiKaydiMi(req, istenenUserId);
  if (!s.ok) {
    res.status(s.kod).json({ ok: false, error: s.hata });
    return null;
  }
  return s;
}

module.exports = { adminMi, kendiKaydiMi, kimlikVeyaHata };
