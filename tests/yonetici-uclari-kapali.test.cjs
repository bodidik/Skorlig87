"use strict";

/**
 * HER YÖNETİCİ UCU KİMLİKSİZ İSTEĞİ REDDETMELİ — HEPSİ, TEK TEK.
 *
 * ⚠️ BU SINIF BİR KEZ GERÇEKTEN AÇIKTI. `middleware/requireAdmin.cjs` kendi
 * başlığında anlatıyor: aynı kontrol dört dosyada elle yazılmış, beşincisi
 * (`routes/admin-live.cjs`) hiç yazılmamıştı. O router `/api/admin` altında
 * KİMLİKSİZ yedi POST ucu açıyordu:
 *
 *     POST /api/admin/match/final?fixtureId=X&home=3&away=0
 *       → maçın nihai skorunu yazar, status'u FT yapar
 *
 * settle2 ödemeyi TAM O DOSYADAN hesaplıyor. Yani kimliksiz tek istek bir
 * maçın skorunu belirleyip gerçek LC dağıtımını tetikleyebiliyordu —
 * saldırgan kendi tahminine uyan skoru yazıp ödeme alabilirdi.
 *
 * ⚠️ TEST KOD OKUMUYOR, UÇLARI DÖVÜYOR. `router.use(requireAdmin)` var mı diye
 * bakmak yeterli değil: bir uç o satırdan ÖNCE tanımlanırsa korumasız kalır ve
 * grep bunu göremez. Yollar router yığınından çıkarılıyor, yani yeni eklenen
 * uç otomatik kapsama giriyor — listeyi güncellemek gerekmiyor.
 *
 * ⚠️ SONDAYI KURARKEN YANILDIM, nota değer: ilk yazımda mount öneki
 * (`/api/admin`) eklenmemişti; 38 ucun hepsi 404 döndü ve 404 izinli
 * listede olmadığı için HEPSİ "KORUMASIZ" göründü. Yanlış yeri döven sonda,
 * güvenlik kanıtı da alarm da üretemez — bu yüzden aşağıda 404 AYRI bir
 * hata olarak yakalanıyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
const TOKEN = "test-admin-token";
const ROUTERLAR = ["admin-runtime", "admin-live", "admin-users"];

/* Kimliksiz istek için KABUL EDİLEBİLİR yanıtlar:
 *   401/403 → reddedildi
 *   503     → yönetici jetonu yapılandırılmamış (fail-closed, geçirmez) */
const KAPALI = [401, 403, 503];

/**
 * BİLEREK AÇIK BIRAKILMIŞ TEK UÇ.
 *
 * ⚠️ İSTİSNA GEVŞETME DEĞİL, KOŞUL. `runtime-mode/ping` yalnızca "router
 * ayakta" der ve VERİ DÖNDÜRMEZ — kaynağındaki not (routes/admin-runtime.cjs)
 * ayrımın kasıtlı olduğunu yazıyor. İzin bu koşula bağlı: aşağıdaki test
 * yanıtın veri taşımadığını AYRICA doğruluyor, yani uç bir gün gerçek bilgi
 * döndürmeye başlarsa kimliksiz erişim hemen kusura dönüşür.
 *
 * ⚠️ Bu listeye yeni satır eklemek, bir ucu kimlik denetiminden ÇIKARMAK
 * demektir. Varsayılan her zaman `requireAdminToken`.
 */
const BILEREK_ACIK = new Set(["GET /runtime-mode/ping"]);

describe("yönetici uçları kimliksiz reddeder", () => {
  let srv, port, yollar = [], eskiToken;

  test("kur", async () => {
    eskiToken = process.env.SKORLIG_ADMIN_TOKEN;
    process.env.SKORLIG_ADMIN_TOKEN = TOKEN;
    process.env.SKORLIG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-adm-"));

    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use((q, _r, n) => { q.app.locals.db = null; n(); });
    for (const f of ROUTERLAR) app.use("/api/admin", require(path.join(KOK, "routes", `${f}.cjs`)));

    await new Promise((r) => { srv = app.listen(0, r); });
    port = srv.address().port;

    /* Yolları router yığınından çıkar — elle liste tutmak yeni ucu kaçırır. */
    const gez = (k) => {
      for (const l of (k.stack || [])) {
        if (l.route) for (const m of Object.keys(l.route.methods)) yollar.push([m.toUpperCase(), l.route.path]);
        else if (l.handle && l.handle.stack) gez(l.handle);
      }
    };
    gez(app._router);
    assert.ok(yollar.length >= 20, `yalnizca ${yollar.length} uc bulundu — tarama bozuk, test bir sey olcmuyor`);
  });

  test("SONDA KONTROLÜ: doğru jetonla geçiliyor mu", async () => {
    /* ⚠️ Bu olmadan "hepsi reddetti" sonucu hiçbir şey kanıtlamaz: sonda
     * yanlış yeri dövüyorsa da her şey reddedilmiş görünür. */
    const [m, y] = yollar[0];
    const r = await fetch(`http://127.0.0.1:${port}/api/admin${y.replace(/:[a-zA-Z]+/g, "x")}`, {
      method: m, headers: { "Content-Type": "application/json", "x-admin-token": TOKEN },
      body: m === "GET" ? undefined : "{}",
    });
    assert.ok(!KAPALI.includes(r.status), `dogru jetonla da reddedildi (${r.status}) — sonda yanlis yeri doviyor`);
    assert.notEqual(r.status, 404, "404 — mount oneki yanlis, sonda hicbir sey olcmuyor");
  });

  test("HİÇBİR uç kimliksiz geçmez", async () => {
    const acik = [];
    for (const [m, y] of yollar) {
      const url = `http://127.0.0.1:${port}/api/admin${y.replace(/:[a-zA-Z]+/g, "x")}`;
      let r;
      try {
        r = await fetch(url, { method: m, headers: { "Content-Type": "application/json" }, body: m === "GET" ? undefined : "{}" });
      } catch (e) {
        acik.push(`${m} ${y} -> ISTEK HATASI ${e.message}`);
        continue;
      }
      if (r.status === 404) acik.push(`${m} ${y} -> 404 (sonda yanlis yeri doviyor, kapsam DISI kaldi)`);
      else if (BILEREK_ACIK.has(`${m} ${y}`)) continue;
      else if (!KAPALI.includes(r.status)) acik.push(`${m} ${y} -> ${r.status} KIMLIKSIZ GECTI`);
    }
    assert.deepEqual(acik, [], `korumasiz yonetici ucu:\n${acik.join("\n")}`);
  });

  test("bilerek açık uç VERİ DÖNDÜRMEZ (izin bu koşula bağlı)", async () => {
    /**
     * ⚠️ İSTİSNANIN BEDELİ BU TEST. `ping` kimliksiz erişilebilir olmayı
     * yalnızca hiçbir şey söylemediği için hak ediyor. Fikstür, kullanıcı,
     * yapılandırma ya da durum bilgisi eklenirse bu kırılır ve uç yeniden
     * kimlik denetimine girmelidir.
     */
    for (const anahtar of BILEREK_ACIK) {
      const [m, y] = anahtar.split(" ");
      const r = await fetch(`http://127.0.0.1:${port}/api/admin${y}`, { method: m });
      assert.equal(r.status, 200, `${anahtar} artik 200 donmuyor — liste guncel degil`);
      const j = await r.json();
      const alanlar = Object.keys(j).filter((k) => !["ok", "where"].includes(k));
      assert.deepEqual(alanlar, [],
        `${anahtar} VERI donduruyor (${alanlar.join(", ")}) — kimliksiz acik kalamaz`);
    }
  });

  test("kapat", () => {
    if (eskiToken === undefined) delete process.env.SKORLIG_ADMIN_TOKEN;
    else process.env.SKORLIG_ADMIN_TOKEN = eskiToken;
    srv?.close();
  });
});
