"use strict";

/**
 * YAZMA UÇLARI — YETKİ SEVİYESİ DENETİMİ.
 *
 * ⚠️ NEDEN BU, ÖNCEKİNDEN FARKLI: `tests/uc-yetki.test.cjs` yalnızca "bir
 * muhafız var mı" diye bakıyordu. Turnuva açığı tam da o boşluktan geçti:
 *
 *     // POST /api/tournaments/settle/:code  (admin)
 *     router.post("/settle/:code", verifyToken, ...)   ← muhafız VAR ama YANLIŞ
 *
 * Yorumu "admin" diyordu, muhafızı `verifyToken`dı; giriş yapmış herkes
 * turnuvayı sonuçlandırıp maç sonuçlarını kendi gövdesinde gönderebiliyordu.
 * Bu test her ucun BEKLENEN SEVİYESİNİ pinliyor: `admin` beklenen bir uçta
 * `verifyToken` görürse DÜŞER.
 *
 * ⚠️ ÜÇ KÖR NOKTA — hepsi gerçek açık gizledi, üçü de burada kapalı:
 *   1) `express.json()` gibi ÇAĞRI biçimli ara katman: eski kalıp `[^)]*?`
 *      kullanıyordu, ilk parantezde duruyordu. 10 uç gizli kaldı.
 *   2) ADLANDIRILMIŞ handler (`router.post(yol, handleOpt)`): satır içi ok
 *      fonksiyonu arayan kalıp hiç eşleşmiyordu. `groups.cjs` opt uçları
 *      kimliksizdi ve kimliği gövdeden alıyordu.
 *   3) Gövde içi muhafız araması: sabit pencere komşu ucun metnini yakalayıp
 *      YANLIŞ POZİTİF üretiyordu. Artık gövde taraması yok; gövdesinde
 *      muhafız olan uçlar manifestoda `admin-govde` diye işaretli.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROTA_DIZIN = path.join(__dirname, "..", "routes");

const ADMIN_ARA = ["requireAdmin", "requireAdminToken", "_adminAuth", "isInternalCaller"];
const KIMLIK_ARA = ["verifyToken"];

/**
 * BEKLENEN SEVİYELER.
 *
 *   admin        → ara katman yönetici token'ı istemeli
 *   admin-govde  → muhafız handler gövdesinde (eski desen); adı burada pinli
 *   acik         → BİLEREK açık, gerekçesiyle
 *   (listede yok) → varsayılan `kimlik` (verifyToken şart)
 */
const ADMIN = new Set([
  "POST /api/admin/fixtures/add",
  "POST /api/admin/fixtures/delete",
  "POST /api/admin/match-note",
  "POST /api/admin/match/bootstrap",
  "POST /api/admin/match/final",
  "POST /api/admin/match/goal",
  "POST /api/admin/match/halfscore",
  "POST /api/admin/match/penalty",
  "POST /api/admin/match/red",
  "POST /api/admin/match/status",
  "POST /api/admin/results/set",
  "POST /api/admin/run-migration",
  "POST /api/admin/runtime-mode",
  "POST /api/admin/scraper-probe",
  "POST /api/config/update",
  "POST /api/livescore/refresh",
  "POST /api/livescore/refresh-bilyoner",
  "POST /api/livescore/sync",
  "POST /api/pred/bots-generate",
  "POST /api/provider/auto-primary",
  "POST /api/provider/mark",
  "POST /api/provider/reset",
  "POST /api/provider/team-primary",
  "POST /api/provider/warn",
  "POST /api/rt/admin-live-gs",
  "POST /api/rt/competitions/upsert",
  "POST /api/rt/fixture-competitions/assign",
  "POST /api/rt/poll",
  "POST /api/rt/settle",
  "POST /api/stats/recalc",
  // ⚠️ Bu ucun muhafızı `verifyToken`dı ve yorumu "(admin)" diyordu.
  "POST /api/tournaments/settle/:code",
]);

/** Muhafızı handler gövdesinde olanlar — ara katman listesinde görünmez. */
const ADMIN_GOVDE = {
  "POST /api/admin/admin-users/add": "requireAdminToken",
  "POST /api/admin/admin-users/remove": "requireAdminToken",
  "POST /api/admin/ban": "requireAdminToken",
  "POST /api/admin/unban": "requireAdminToken",
  "POST /api/config/admin/runtime-mode": "ADMIN_TOKEN",
  // Gövdede `if (!requireAdminToken(req, res)) return;` deseni.
  "POST /api/push/test": "requireAdminToken",
  "POST /api/rt/settle2": "isInternalCaller",
};

/** Bilerek açık — her biri gerekçeli. */
const ACIK = {
  "POST /api/auth1987gs/verify":
    "davet kodu kullanimi kullaniciya acik olmali; hiz siniri 5/dk ve kod kotasi atomik",
};

function mountTabani() {
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.cjs"), "utf8");
  const t = {};
  const re = /app\.use\(\s*"([^"]+)"\s*,\s*require\("\.\/routes\/([a-z0-9.\-]+)\.cjs"\)/g;
  for (const m of srv.matchAll(re)) if (!t[m[2]]) t[m[2]] = m[1];
  return t;
}

/**
 * Rotaları çıkarır. ⚠️ Handler biçimine BAKMAZ — ara katman listesi rota
 * satırının sonuna kadar okunur, böylece hem satır içi ok fonksiyonu hem
 * adlandırılmış handler yakalanır (kör nokta 2).
 */
function rotalar() {
  const taban = mountTabani();
  const out = [];
  for (const ad of fs.readdirSync(ROTA_DIZIN)) {
    if (!ad.endsWith(".cjs")) continue;
    const dosya = ad.slice(0, -4);
    const src = fs.readFileSync(path.join(ROTA_DIZIN, ad), "utf8");

    const routerUse = /router\.use\(\s*(requireAdmin|requireAdminToken|_adminAuth)\b/.test(src)
      ? "admin"
      : /router\.use\(\s*verifyToken\b/.test(src) ? "kimlik" : null;

    const re = /router\.(post|put|patch|delete)\(\s*"([^"]*)"\s*,([\s\S]*?)\)\s*;/g;
    for (const m of src.matchAll(re)) {
      const [, yontem, yol, ara] = m;
      // Ara katman kısmı çok uzunsa muhtemelen satır içi handler gövdesidir;
      // yalnızca ilk 400 karakteri muhafız araması için yeterli ve güvenli.
      const bas = ara.slice(0, 400);
      let seviye;
      if (routerUse === "admin") seviye = "admin";
      else if (ADMIN_ARA.some((k) => bas.includes(k))) seviye = "admin";
      else if (KIMLIK_ARA.some((k) => bas.includes(k)) || routerUse === "kimlik") seviye = "kimlik";
      else seviye = "acik";

      const tam = ((taban[dosya] || "?").replace(/\/$/, "") + "/" + yol.replace(/^\//, "")).replace(/\/\//g, "/");
      out.push({ dosya: ad, anahtar: `${yontem.toUpperCase()} ${tam}`, seviye, src });
    }
  }
  return out;
}

describe("yazma uçları — beklenen yetki SEVİYESİ", () => {
  test("admin beklenen uçlarda verifyToken YETMEZ", () => {
    const hatali = [];
    for (const r of rotalar()) {
      if (!ADMIN.has(r.anahtar)) continue;
      if (r.seviye !== "admin") hatali.push(`${r.anahtar} -> ${r.seviye}`);
    }
    assert.deepEqual(hatali, [],
      "Bu uclar YONETICI olmali ama degil:\n  " + hatali.join("\n  ") +
      "\n(verifyToken yeterli sanmak, turnuva acigini dogurdu.)");
  });

  test("gövdesinde muhafız olan uçlarda o muhafız hâlâ duruyor", () => {
    const eksik = [];
    for (const [anahtar, muhafiz] of Object.entries(ADMIN_GOVDE)) {
      // ⚠️ ROTA KAYDINDAN İLERİ tara. İlk sürüm "yolun son parçası" arayıp
      // rastgele bir yerden okuyordu ve iki ucu YANLIŞ ŞEKİLDE kayıp sandı —
      // aynı gevşek arama, denetimin ilk sürümünde yanlış pozitif üretmişti.
      const yol = anahtar.split(" ")[1];
      const yontem = anahtar.split(" ")[0].toLowerCase();
      const bulundu = fs.readdirSync(ROTA_DIZIN).some((ad) => {
        if (!ad.endsWith(".cjs")) return false;
        const src = fs.readFileSync(path.join(ROTA_DIZIN, ad), "utf8");
        // Rota yolunun dosya içindeki yazımı mount tabanını içermez.
        const re = new RegExp(`router\\.${yontem}\\(\\s*"([^"]*)"`, "g");
        for (const m of src.matchAll(re)) {
          const kayitliYol = m[1];
          if (!yol.endsWith(kayitliYol.replace(/^\//, "/"))) continue;
          if (src.slice(m.index, m.index + 1200).includes(muhafiz)) return true;
        }
        return false;
      });
      if (!bulundu) eksik.push(`${anahtar} (${muhafiz})`);
    }
    assert.deepEqual(eksik, [], "Govde ici muhafiz kaybolmus: " + eksik.join(", "));
  });

  test("listede olmayan her yazma ucu EN AZ kimlik ister", () => {
    const acik = [];
    for (const r of rotalar()) {
      if (ADMIN.has(r.anahtar) || ADMIN_GOVDE[r.anahtar] || ACIK[r.anahtar]) continue;
      if (r.seviye === "acik") acik.push(`${r.dosya}: ${r.anahtar}`);
    }
    assert.deepEqual(acik, [],
      "Korumasiz yazma ucu:\n  " + acik.join("\n  ") +
      "\nverifyToken/requireAdmin ekle ya da ACIK listesine GEREKCEYLE yaz.");
  });

  test("açık bırakılanların hepsinin gerekçesi var", () => {
    for (const [anahtar, gerekce] of Object.entries(ACIK)) {
      assert.ok(gerekce && gerekce.length > 20, `${anahtar} icin gerekce yetersiz`);
    }
  });

  test("kimlik isteyen uçlar kullanıcıyı GÖVDEDEN almamalı (örnek: grup opt)", () => {
    // Üç kez aynı hata: userId gövdeden okunuyordu ve herkes başkası adına
    // işlem yapabiliyordu (mini, presets, groups).
    const src = fs.readFileSync(path.join(ROTA_DIZIN, "groups.cjs"), "utf8");
    const i = src.indexOf("async function handleOpt");
    const govde = src.slice(i, i + 600);
    assert.ok(/req\.uid/.test(govde), "handleOpt kimligi req.uid'den almiyor");
    assert.ok(!/const\s*\{\s*userId/.test(govde), "handleOpt hala userId'yi govdeden aliyor");
  });
});

describe("okuma uçları — başkasının özel verisi", () => {
  /**
   * ⚠️ Yazma uçlarını seviyeye göre denetlerken okumalar açıkta kalmıştı.
   * Ölçüldü: `GET /api/pred/my?userId=<baskasi>` kimliksiz olarak o kişinin
   * OYNANMAMIŞ maçlardaki tahminlerini TAM İÇERİKLE döndürüyordu (sonuç,
   * kesin skor, ilk gol, ilk yarı).
   *
   * Sonuç: liderlik tablosundan en iyi oyuncuyu bul, seçimlerini maç
   * başlamadan kopyala. Bedava, çünkü bakmak LC istemiyor. Oyunun rekabet
   * önermesi tam olarak budur.
   *
   * Aynı sızıntının iki hafif hâli daha vardı: `/pred/list?userId=` (maç
   * bazlı) ve `/pred/flags?userId=` (hangi maçlarda oynuyor).
   */
  const fs = require("fs");
  const path = require("path");
  const src = () => fs.readFileSync(path.join(ROTA_DIZIN, "pred.cjs"), "utf8");

  test("kendi tahminlerini dönen uçlar kimlik doğrular", () => {
    const s = src();
    assert.ok(/router\.get\("\/pred\/my",\s*verifyToken/.test(s),
      "/pred/my kimliksiz — baskasinin acik tahminleri okunabilir");
    assert.ok(/router\.get\("\/pred\/flags",\s*verifyToken/.test(s),
      "/pred/flags kimliksiz");
  });

  test("kimlik SORGUDAN değil token'dan alınır", () => {
    const s = src();
    for (const uc of ["/pred/my", "/pred/flags"]) {
      const i = s.indexOf(`router.get("${uc}"`);
      const govde = s.slice(i, i + 700);
      assert.ok(/req\.uid/.test(govde), `${uc} req.uid kullanmiyor`);
      assert.ok(!/const uid = String\(req\.query\.userId/.test(govde),
        `${uc} kimligi hala sorgudan aliyor`);
    }
  });

  test("/pred/list başkasının kimliğini reddeder", () => {
    const s = src();
    assert.ok(/FORBIDDEN_OTHER_USER/.test(s),
      "/pred/list baskasinin kaydini vermeye devam ediyor");
  });
});
