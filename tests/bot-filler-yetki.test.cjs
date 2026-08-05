"use strict";

/**
 * BOT DOLDURMA, KENDİ API'SİNE YETKİLİ ÇAĞRI YAPAR.
 *
 * ⚠️ NEREDEN ÇIKTI: sunucu yeniden başlatılınca logda görüldü —
 *     [bot-filler] 25 mac tarandi · doldurulan 0 · eklenen bot 0 · hata 25
 *     [bot-filler] MK-SOUTHM-2026-08-02-STALBA: ADMIN_TOKEN_REQUIRED
 * Her turda taranan 25 maçın 25'i başarısız; bot doldurma %100 ölüydü.
 *
 * KUSURUN ŞEKLİ — YORUM DOĞRUYU SÖYLÜYORDU AMA KOD ÖYLE DAVRANMIYORDU:
 * `/pred/bots-generate` ucuna yetki koruması eklenirken yanına
 * "(bot-filler loopback'ten çağırdığı için etkilenmez)" notu düşülmüş.
 * Uçta İKİ muhafız var:
 *     router.post(..., requireAdminToken, handler)   ← ara katman, ÖNCE çalışır
 *     handler içinde: if (!isInternalCaller(req))    ← loopback'i kabul eder
 * Ara katman jetonsuz loopback isteğini reddettiği için içerideki gevşemeye
 * hiç sıra gelmiyordu. Güvenlik düzeltmesi iç çağıranı sessizce kırmıştı.
 *
 * ⚠️ BU TEST GERÇEK MUHAFIZA KARŞI ÇALIŞIYOR. Sahte bir uç kurup "başlık
 * gidiyor mu" diye bakmak, asıl uç başka türlü davranırsa hiçbir şey
 * yakalamaz — kırılmanın sebebi zaten "iki muhafızın sırası" gibi ancak
 * gerçek zincirde görülen bir şeydi.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("bots-generate gerçekten korumalı", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "pred.cjs"), "utf8");
    assert.ok(
      /router\.post\("\/pred\/bots-generate",\s*requireAdminToken/.test(src),
      "uc korumasiz — bu test bir sey olcmuyor"
    );
  });
});

/* ── Gerçek zincir ───────────────────────────────────────────────────────── */

describe("bot-filler → bots-generate yetki zinciri", () => {
  const JETON = "test-admin-jetonu-123";
  let srv, port, eskiJeton, TMP;

  /** Gerçek pred.cjs'i monte eder; bots-generate'in muhafızları aynen çalışır. */
  const kur = () => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-botfill-"));
    process.env.SKORLIG_DATA_DIR = TMP;
    process.env.SKORLIG_BG = "0";

    const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
    require.cache[vt] = { id: vt, filename: vt, loaded: true, exports: {
      verifyToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || "t"; n(); },
      optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
      getFirebaseAuth: () => null, kimlikModu: () => "test",
    }};

    const express = require("express");
    const app = express();
    /* ⚠️ x-forwarded-for EKLENMİYOR: isInternalCaller o başlığı görürse
     * isteği DIŞ sayıyor. Gerçek bot-filler de eklemez. */
    app.use("/api", require(path.join(KOK, "routes", "pred.cjs")));
    srv = app.listen(0);
    port = srv.address().port;
  };

  test("kur", () => {
    eskiJeton = process.env.SKORLIG_ADMIN_TOKEN;
    process.env.SKORLIG_ADMIN_TOKEN = JETON;
    kur();
  });

  const cagir = (headers) =>
    fetch(`http://127.0.0.1:${port}/api/pred/bots-generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ fixtureId: "TEST-FIXTURE-YOK" }),
    }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  test("JETONSUZ loopback çağrısı REDDEDİLİYOR — kırılmanın kanıtı", async () => {
    /**
     * ⚠️ ASIL BULGU BU. "Loopback'ten geliyor, geçer" varsayımı yanlıştı;
     * bu satır o varsayımı kalıcı olarak yalanlıyor. Bu test geçtiği sürece
     * bot-filler'ın jeton göndermesi ZORUNLU demektir.
     */
    const r = await cagir({});
    assert.equal(r.s, 401, `loopback jetonsuz gectiyse duzeltme gereksizdi (HTTP ${r.s})`);
    assert.equal(r.j?.error, "ADMIN_TOKEN_REQUIRED");
  });

  test("JETONLA çağrı muhafızları GEÇİYOR", async () => {
    /* Fixture yok, o yüzden 401/503 dışında bir yanıt bekliyoruz — muhafızı
     * geçtiğini bu ayırt ediyor. */
    const r = await cagir({ "x-admin-token": JETON });
    assert.notEqual(r.s, 401, `jeton gonderildigi halde reddedildi: ${JSON.stringify(r.j)}`);
    assert.notEqual(r.s, 503, "jeton tanimli oldugu halde ADMIN_TOKEN_NOT_CONFIGURED");
  });

  test("YANLIŞ jeton reddediliyor", async () => {
    const r = await cagir({ "x-admin-token": "yanlis" });
    assert.equal(r.s, 401);
  });

  test("kapat", () => {
    srv?.close();
    if (eskiJeton === undefined) delete process.env.SKORLIG_ADMIN_TOKEN;
    else process.env.SKORLIG_ADMIN_TOKEN = eskiJeton;
  });
});

/* ── Jeton çözümü ────────────────────────────────────────────────────────── */

describe("jeton adı tek yerden çözülüyor", () => {
  test("bot-filler ile muhafız AYNI çözücüyü kullanıyor", () => {
    /**
     * ⚠️ `middleware/requireAdmin.cjs` ÜÇ ad kabul ediyor (SKORLIG_ADMIN_TOKEN,
     * ADMIN_TOKEN, EXPO_PUBLIC_ADMIN_TOKEN). bot-filler'a
     * `process.env.SKORLIG_ADMIN_TOKEN` yazsaydım, eski kurulumunda yalnızca
     * `ADMIN_TOKEN` tanımlı olan biri için servis yine sessizce ölürdü.
     */
    const eski = { ...process.env };
    try {
      delete process.env.SKORLIG_ADMIN_TOKEN;
      delete process.env.EXPO_PUBLIC_ADMIN_TOKEN;
      process.env.ADMIN_TOKEN = "eski-kurulum-jetonu";
      const yol = require.resolve(path.join(KOK, "middleware", "requireAdmin.cjs"));
      delete require.cache[yol];
      const { beklenenToken } = require(yol);
      assert.equal(beklenenToken(), "eski-kurulum-jetonu",
        "eski ADMIN_TOKEN adi cozulmuyor");
    } finally {
      for (const k of ["SKORLIG_ADMIN_TOKEN", "ADMIN_TOKEN", "EXPO_PUBLIC_ADMIN_TOKEN"]) {
        if (eski[k] === undefined) delete process.env[k];
        else process.env[k] = eski[k];
      }
    }
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

const kaynak = fs.readFileSync(path.join(KOK, "services", "bot-filler.cjs"), "utf8")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

test("NÖBETÇİ: bot-filler x-admin-token gönderiyor", () => {
  assert.ok(/"x-admin-token"/.test(kaynak),
    "bot-filler admin basligi gondermiyor — servis tamamen olur");
});

test("NÖBETÇİ: jeton beklenenToken ile çözülüyor, elle env okunmuyor", () => {
  assert.ok(/beklenenToken\(\)/.test(kaynak), "ortak jeton cozucu kullanilmiyor");
  assert.ok(!/process\.env\.SKORLIG_ADMIN_TOKEN/.test(kaynak),
    "yerel env kopyasi belirmis — jeton adi listesi ayrisir");
});

test("NÖBETÇİ: jeton yokken bir kez uyarı veriliyor", () => {
  /* Kırık hâlin en kötü yanı sebebin görünmemesiydi: her turda 25 satır
   * ADMIN_TOKEN_REQUIRED akıyor ama "jeton tanimsiz" hiçbir yerde yazmıyordu. */
  assert.ok(/_jetonUyarisiVerildi/.test(kaynak), "jeton yoklugu icin uyari yok");
});
