"use strict";

/**
 * "İÇ ÇAĞRI" KONTROLÜ — tek yer, ve ters proxy'ye karşı sağlam.
 *
 * ⚠️ BULUNAN: `routes/settle2.cjs` kendi `isInternalCaller` kopyasını
 * kullanıyordu ve o kopyada `x-forwarded-for` kontrolü YOKTU:
 *
 *     const remote = String(req.socket?.remoteAddress || req.ip || "");
 *     if (remote === "127.0.0.1" ...) return true;    // jeton bile aranmıyor
 *
 * Sağlamlaştırılmış sürüm (`lib/internal-caller.cjs`) TAM BU BOŞLUK İÇİN
 * yazılmış ve farkı kendi başlığında anlatıyordu — ama yalnızca
 * `routes/pred.cjs` ona geçirilmişti. Yani hata biliniyor, yazılıyor, ve para
 * dağıtan uçta düzeltilmeden kalıyordu.
 *
 * Neyin tehlikede olduğunu ucun kendi yorumu söylüyor: "birisi ham HTTP ile
 * POST atarak totals'a defalarca puan yatırtabilir". Önündeki ters proxy
 * uygulamaya loopback üzerinden ulaşıyorsa `/api/rt/settle2` tüm internete
 * kimliksiz açık olurdu.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { isInternalCaller } = require("../lib/internal-caller.cjs");

/** Sahte istek. */
function istek({ remote = "1.2.3.4", basliklar = {} } = {}) {
  return { socket: { remoteAddress: remote }, headers: basliklar, ip: remote };
}

const JETON = "test-yonetici-jetonu";

function jetonlu(fn) {
  const eskiler = {
    SKORLIG_ADMIN_TOKEN: process.env.SKORLIG_ADMIN_TOKEN,
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    EXPO_PUBLIC_ADMIN_TOKEN: process.env.EXPO_PUBLIC_ADMIN_TOKEN,
  };
  for (const k of Object.keys(eskiler)) delete process.env[k];
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(eskiler)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

/* ── Davranış ────────────────────────────────────────────────────────────── */

test("loopback + proxy başlığı YOK → iç çağrı", () => {
  // services/af-sync.cjs ve services/bot-filler.cjs kendi API'lerini böyle çağırıyor.
  assert.equal(isInternalCaller(istek({ remote: "127.0.0.1" })), true);
  assert.equal(isInternalCaller(istek({ remote: "::1" })), true);
  assert.equal(isInternalCaller(istek({ remote: "::ffff:127.0.0.1" })), true);
});

test("loopback AMA proxy başlığı VAR → iç çağrı DEĞİL", () => {
  /**
   * ⚠️ ASIL DEĞİŞMEZ BU. Ters proxy uygulamaya loopback üzerinden bağlanıyorsa
   * soket adresi 127.0.0.1'dir — dış dünyadan gelen HER istek için. `x-forwarded-for`
   * varlığı isteğin dışarıdan geldiğinin kanıtıdır.
   */
  jetonlu(() => {
    for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      assert.equal(
        isInternalCaller(istek({ remote, basliklar: { "x-forwarded-for": "9.9.9.9" } })),
        false,
        `${remote} + x-forwarded-for ic cagri sayildi — dis trafik ic sayiliyor`
      );
    }
  });
});

test("uzak adres + jeton yok → reddedilir", () => {
  jetonlu(() => {
    assert.equal(isInternalCaller(istek()), false);
  });
});

test("jeton TANIMSIZSA doğru jeton bile geçmez (fail-closed)", () => {
  jetonlu(() => {
    // Boş beklenen değerle boş gelen değerin eşleşmesi kapıyı açardı.
    assert.equal(isInternalCaller(istek({ basliklar: { "x-admin-token": "" } })), false);
    assert.equal(isInternalCaller(istek({ basliklar: { "x-admin-token": "herhangi" } })), false);
  });
});

test("geçerli jeton her adresten geçer", () => {
  const eski = process.env.SKORLIG_ADMIN_TOKEN;
  process.env.SKORLIG_ADMIN_TOKEN = JETON;
  try {
    assert.equal(isInternalCaller(istek({ basliklar: { "x-admin-token": JETON } })), true);
    assert.equal(isInternalCaller(istek({ basliklar: { "x-admin-token": JETON + "x" } })), false);
  } finally {
    if (eski === undefined) delete process.env.SKORLIG_ADMIN_TOKEN;
    else process.env.SKORLIG_ADMIN_TOKEN = eski;
  }
});

test("ESKİ KURULUM ADI da kabul ediliyor (requireAdmin ile aynı küme)", () => {
  /**
   * ⚠️ Bu dosya iki jeton adı sayıyordu, `middleware/requireAdmin.cjs` ise üç.
   * Ayrı listeler, aynı jetonun bir uçta çalışıp ötekinde 503 vermesi demek.
   * Artık ad kümesi tek yerden geliyor.
   */
  const eskiler = {
    SKORLIG_ADMIN_TOKEN: process.env.SKORLIG_ADMIN_TOKEN,
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    EXPO_PUBLIC_ADMIN_TOKEN: process.env.EXPO_PUBLIC_ADMIN_TOKEN,
  };
  for (const k of Object.keys(eskiler)) delete process.env[k];
  process.env.EXPO_PUBLIC_ADMIN_TOKEN = JETON;
  try {
    assert.equal(isInternalCaller(istek({ basliklar: { "x-admin-token": JETON } })), true);
  } finally {
    for (const [k, v] of Object.entries(eskiler)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: ikinci bir isInternalCaller kopyası yok", () => {
  const kusurlu = [];
  for (const alt of ["routes", "lib", "services", "middleware"]) {
    const d = path.join(KOK, alt);
    if (!fs.existsSync(d)) continue;
    for (const dosya of fs.readdirSync(d)) {
      if (!dosya.endsWith(".cjs")) continue;
      if (`${alt}/${dosya}` === "lib/internal-caller.cjs") continue;   // tek kaynağın kendisi
      const src = fs.readFileSync(path.join(d, dosya), "utf8");
      if (/function\s+isInternalCaller\s*\(/.test(src)) kusurlu.push(`${alt}/${dosya}`);
    }
  }
  assert.deepStrictEqual(
    kusurlu,
    [],
    "`isInternalCaller` yeniden tanimlanmis. Kopya, `x-forwarded-for` korumasi\n" +
      "olmadan yazilirsa ters proxy arkasinda DIS TRAFIGI ic sayar —\n" +
      "settle2'de tam olarak bu oldu. `lib/internal-caller.cjs` kullan:\n" +
      kusurlu.join("\n")
  );
});

test("NÖBETÇİ: loopback'e güvenen her yer proxy başlığına da bakıyor", () => {
  /**
   * Yeni bir dosya kendi loopback denetimini yazarsa aynı tuzağa düşer.
   * `middleware/rateLimit.cjs` MUAF: orada loopback yalnızca hız sınırını
   * atlatıyor (yetki vermiyor), ve iç servislerin kendi API'sini dövmemesi
   * için bilinçli.
   */
  const MUAF = new Set(["middleware/rateLimit.cjs", "lib/internal-caller.cjs"]);
  const kusurlu = [];

  for (const alt of ["routes", "lib", "services", "middleware"]) {
    const d = path.join(KOK, alt);
    if (!fs.existsSync(d)) continue;
    for (const dosya of fs.readdirSync(d)) {
      if (!dosya.endsWith(".cjs")) continue;
      const ad = `${alt}/${dosya}`;
      if (MUAF.has(ad)) continue;
      const satirlar = fs.readFileSync(path.join(d, dosya), "utf8").split("\n");
      satirlar.forEach((satir, i) => {
        const t = satir.trim();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
        // Gelen isteğin adresini loopback ile KIYASLAYAN satır.
        if (!/===\s*"(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)"/.test(satir)) return;
        const src = satirlar.join("\n");
        if (!/x-forwarded-for/.test(src)) kusurlu.push(`${ad}:${i + 1}`);
      });
    }
  }

  assert.deepStrictEqual(
    [...new Set(kusurlu)],
    [],
    "Bu yerler soket adresinin loopback olmasina GUVENIYOR ama `x-forwarded-for`\n" +
      "kontrolu yok. Ters proxy loopback uzerinden baglaniyorsa dis trafik ic\n" +
      "sayilir ve uc kimliksiz acilir:\n" + [...new Set(kusurlu)].join("\n")
  );
});
