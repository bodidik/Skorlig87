"use strict";

/**
 * AYNI TAKIMI TUTANLARIN SIRALAMASI — kanonik ad + /team-ranks ucu.
 *
 * ⚠️ NEREDEN ÇIKTI: kullanıcının telefon günlüğünde
 * `404 /api/stats/team-ranks?team=Galatasaray — böyle bir uç YOK`.
 * Mobil (`app/(tabs)/stats.tsx:353`) bu ucu çağırıyordu ama sunucuda hiç
 * yazılmamıştı. İstemci 404'ü yutuyordu (`setTeamRanks([])`), o yüzden
 * çökme değil SESSİZ BOŞ EKRAN olarak görünüyordu.
 *
 * ⚠️ İLK TEŞHİSİM YANLIŞTI, ONU DA YAZIYORUM: "hiçbir kullanıcıda takım
 * alanı yok, önce profile eklenmeli" demiştim. Yanlış alan adıyla ölçmüştüm
 * (`favTeam`). Depodaki alan `mainTeam`; hem alan hem indeks hem
 * `listByTeam` hem `set-main-team` ucu ZATEN vardı. Ders: alan adını
 * varsaymadan önce bir örnek belgenin anahtarlarına bak.
 *
 * ÖLÇÜLDÜ (negatif kontrol, bu testin kurduğu veri): beş kullanıcı aynı
 * takımı tutuyor ama yazımları farklı — "Galatasaray", "galatasaray",
 * "Galatasaray SK", "FC Galatasaray", "galatasaray sk". Kanonikleştirme
 * kapatılınca `/team-ranks?team=Galatasaray` yalnızca ["ayse","burak"]
 * döndürdü: 5 taraftarın 3'ü sıralamadan DÜŞTÜ. Hata mesajı yok — eksik
 * liste. `listByTeam` tam eşleşme (harf duyarsız) yapıyor, "Galatasaray SK"
 * yazan kullanıcı "Galatasaray" listesinde hiç görünmüyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const Katalog = require("../lib/takim-katalog.cjs");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("katalog gerçekten dolu", () => {
    const hepsi = Katalog.takimlar();
    assert.ok(hepsi.length > 300, `katalog ${hepsi.length} takim — dosya okunamamis olabilir`);
    const tr = Katalog.takimlar("Türkiye");
    assert.ok(tr.length >= 10, `Turkiye ${tr.length} takim`);
    assert.ok(tr.every((t) => t.team && t.country), "kayitlarda takim/ulke eksik");
  });
});

/* ── Kanonikleştirme ─────────────────────────────────────────────────────── */

describe("kanonik takım adı", () => {
  test("yazım varyantları tek ada iniyor", () => {
    for (const v of ["Galatasaray", "galatasaray", "GALATASARAY", "Galatasaray SK", "FC Galatasaray", "  galatasaray  "]) {
      assert.equal(Katalog.kanonikTakim(v), "Galatasaray", `varyant coztulemedi: ${v}`);
    }
  });

  test("aksan farkı kanonik yazıma çevriliyor", () => {
    /* Kaynaklar aksansız gönderiyor; katalog aksanlı tutuyor. İkisi
     * eşleşmezse taraftarlar iki gruba bölünür. */
    assert.equal(Katalog.kanonikTakim("Fenerbahce"), "Fenerbahçe");
    assert.equal(Katalog.kanonikTakim("Besiktas"), "Beşiktaş");
  });

  test("BİLİNMEYEN AD TAHMİN EDİLMİYOR", () => {
    /**
     * ⚠️ Bu testin asıl işi. `team-country.cjs` içinde ölçülmüştü: "içeriyor"
     * aramasıyla eşleştirmek `Inter`/`Atlético`/`Union` gibi adlarda birden
     * çok aday üretip yazı turası atıyordu. Orada bedeli maçın yanlış ülkeye
     * düşmesiydi; BURADA iki farklı kulübün taraftarı tek sıralamada
     * birleşirdi. Bu yüzden bulanık eşleşme YOK.
     */
    assert.equal(Katalog.kanonikTakim("Uydurma Takim FC"), null);
    assert.equal(Katalog.kanonikTakim(""), null);
    assert.equal(Katalog.kanonikTakim(null), null);
    assert.equal(Katalog.kanonikTakim("FC"), null, "cok kisa ad eslesti — yanlis kulup riski");
  });
});

/* ── Gerçek uçlar, gerçek Mongo ──────────────────────────────────────────── */

describe("/api/stats/team-ranks", () => {
  /**
   * ⚠️ GERÇEK MONGO KULLANILIYOR, dosya modu değil. Depo notu bunu açıkça
   * söylüyor: `$set`/`$setOnInsert` çakışması sınıfı yalnızca Mongo'da
   * ortaya çıkıyor ve `set-main-team` daha önce tam buna takılıp uçta
   * komple patlamıştı. Dosya modu testi onu yakalayamazdı.
   */
  let mongod, client, db, app, srv, port, TMP;

  test("kur", async () => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-takim-"));
    process.env.SKORLIG_DATA_DIR = TMP;
    process.env.SKORLIG_BG = "0";
    /* Katalog dosyası SKORLIG_DATA_DIR altında yok; modül kaynak ağacındaki
     * kopyaya düşüyor (bkz. lib/takim-katalog.cjs ADAY_YOLLAR). */

    const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
    require.cache[vt] = { id: vt, filename: vt, loaded: true, exports: {
      verifyToken: (q, _r, n) => { q.uid = q.headers["x-user-id"]; n(); },
      optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
      getFirebaseAuth: () => null, kimlikModu: () => "test",
    }};

    const { MongoMemoryServer } = require(path.join(KOK, "node_modules", "mongodb-memory-server"));
    const { MongoClient } = require(path.join(KOK, "node_modules", "mongodb"));
    mongod = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongod.getUri());
    db = client.db("t");

    const express = require(path.join(KOK, "node_modules", "express"));
    app = express();
    app.use((q, _r, n) => { q.app.locals.db = db; n(); });
    app.use("/api/stats", require(path.join(KOK, "routes", "stats.cjs")));
    app.use("/api/users", require(path.join(KOK, "routes", "users.cjs")));
    srv = app.listen(0);
    port = srv.address().port;
  });

  const cagir = (yol, opt = {}) =>
    fetch(`http://127.0.0.1:${port}${yol}`, {
      ...opt,
      headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
    }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  test("set-main-team varyantı kanonikleştiriyor", async () => {
    const r = await cagir("/api/users/set-main-team", {
      method: "POST",
      headers: { "x-user-id": "ali" },
      body: JSON.stringify({ team: "galatasaray sk" }),
    });
    assert.equal(r.s, 200, JSON.stringify(r.j));
    assert.equal(r.j.mainTeam, "Galatasaray", "ham ad kaydedildi — siralama bolunur");
    assert.equal(r.j.canonical, true);
  });

  test("tanınmayan ad REDDEDİLMİYOR, ham kaydediliyor", async () => {
    /* Katalog 461 takım; dünyadaki her kulüp yok. Reddetmek bu ucu kullanan
     * öbür ekranları kırardı. */
    const r = await cagir("/api/users/set-main-team", {
      method: "POST",
      headers: { "x-user-id": "zeynep" },
      body: JSON.stringify({ team: "Mahalle Spor" }),
    });
    assert.equal(r.s, 200, JSON.stringify(r.j));
    assert.equal(r.j.mainTeam, "Mahalle Spor");
    assert.equal(r.j.canonical, false, "istemci kanonik olmadigini anlayamaz");
  });

  test("dört farklı yazım TEK sıralamada toplanıyor", async () => {
    /**
     * ⚠️ ASIL DEĞİŞMEZ. Kanonikleştirme olmasa `listByTeam("Galatasaray")`
     * yalnızca tam eşleşenleri döndürür ve diğerleri listede HİÇ olmaz.
     */
    for (const [uid, yazim] of [
      ["ayse", "Galatasaray"],
      ["burak", "galatasaray"],
      ["can", "Galatasaray SK"],
      ["deniz", "FC Galatasaray"],
    ]) {
      const r = await cagir("/api/users/set-main-team", {
        method: "POST", headers: { "x-user-id": uid },
        body: JSON.stringify({ team: yazim }),
      });
      assert.equal(r.s, 200, `${uid}: ${JSON.stringify(r.j)}`);
    }

    const r = await cagir("/api/stats/team-ranks?team=Galatasaray");
    assert.equal(r.s, 200, JSON.stringify(r.j));
    const idler = r.j.items.map((x) => x.userId).sort();
    assert.deepEqual(idler, ["ali", "ayse", "burak", "can", "deniz"],
      `varyantlar birlesmedi — eksik: ${JSON.stringify(idler)}`);
  });

  test("sorgudaki varyant da kanonikleşiyor", async () => {
    /* Yalnızca yazma tarafını kanonikleştirmek yetmez: "Galatasaray SK"
     * arayan kullanıcı boş liste görürdü. */
    const r = await cagir("/api/stats/team-ranks?team=galatasaray%20sk");
    assert.equal(r.j.team, "Galatasaray");
    assert.equal(r.j.items.length, 5);
  });

  test("puana göre azalan sıralı, puansız üye 0 ile listede", async () => {
    await db.collection("season_totals").insertMany([
      { userId: "ayse",  userIdLower: "ayse",  season: require(path.join(KOK, "lib", "season.cjs")).seasonKey(), totalPoints: 30.5, matches: 4, updatedAt: "2026-08-01T10:00:00.000Z" },
      { userId: "burak", userIdLower: "burak", season: require(path.join(KOK, "lib", "season.cjs")).seasonKey(), totalPoints: 12,   matches: 2, updatedAt: "2026-08-01T09:00:00.000Z" },
    ]);
    const r = await cagir("/api/stats/team-ranks?team=Galatasaray");
    assert.equal(r.j.items[0].userId, "ayse");
    assert.equal(r.j.items[0].total, 31, "kesirli puan yuvarlanmadi");
    assert.equal(r.j.items[1].userId, "burak");

    const puansiz = r.j.items.find((x) => x.userId === "can");
    assert.ok(puansiz, "puani olmayan uye listeden dusuruldu — kullanici kendini bulamaz");
    assert.equal(puansiz.total, 0);
  });

  test("SEZONSUZ ESKİ BELGE aynı kullanıcıyı İKİYE BÖLMÜYOR", async () => {
    /**
     * ⚠️ leaderboard.cjs'ten devralınan tuzak. Yazma tarafı
     * `filter: {season, userIdLower}` kullanıyor; sezon alanı eklenmeden
     * önceki belgede `season` olmadığı için eşleşmiyor ve İKİNCİ belge
     * yaratılıyor. Birleştirmezsek kullanıcı sıralamada iki kez görünür ve
     * puanı bölünür. bkz. lib/season-totals.cjs belgeleriBirlestir
     */
    await db.collection("season_totals").insertOne({
      userId: "ayse", userIdLower: "ayse", totalPoints: 9, matches: 1,   // season YOK
      updatedAt: "2026-07-01T10:00:00.000Z",
    });
    const r = await cagir("/api/stats/team-ranks?team=Galatasaray");
    const ayseler = r.j.items.filter((x) => x.userId === "ayse");
    assert.equal(ayseler.length, 1, "ayni kullanici sirlamada iki kez gorunuyor");
    assert.equal(ayseler[0].total, 40, "eski + yeni belge birlestirilmedi (31+9)");
  });

  test("takımı olmayan sorgu boş liste, hata değil", async () => {
    const r = await cagir("/api/stats/team-ranks?team=Fenerbah%C3%A7e");
    assert.equal(r.s, 200);
    assert.deepEqual(r.j.items, []);
  });

  test("team parametresi yoksa 400", async () => {
    assert.equal((await cagir("/api/stats/team-ranks")).s, 400);
  });

  test("/api/stats/teams onboarding listesi veriyor", async () => {
    const r = await cagir("/api/stats/teams?country=T%C3%BCrkiye");
    assert.equal(r.s, 200);
    assert.ok(r.j.teams.length >= 10, `Turkiye ${r.j.teams.length} takim`);
    assert.ok(r.j.teams.some((t) => t.team === "Galatasaray"));
    assert.ok(r.j.teams.every((t) => typeof t.flag === "string"));
  });

  test("/api/stats/me gerçek mainTeam dönüyor", async () => {
    /* Eskiden burası `favTeam: null` sabitiydi ve mobil herkese
     * "Galatasaray" gösteriyordu. */
    const r = await cagir("/api/stats/me", { headers: { "x-user-id": "zeynep" } });
    assert.equal(r.s, 200, JSON.stringify(r.j));
    assert.equal(r.j.favTeam, "Mahalle Spor");
  });

  test("/api/stats/me team alanı NESNE, mobil tipiyle uyumlu", async () => {
    /**
     * ⚠️ BU TESTİ İLK YAZIŞIMDA KAÇIRMIŞTIM. `/me` içine `team: mainTeam`
     * (düz metin) koymuştum; mobil `MeStats` tipi ise
     * `{team, rank, count, myTeamTotal}` nesnesi bekliyor ve
     * `meStats.team.team` okuyor. Metin dönseydi orası sessizce `undefined`
     * olurdu — çökme yok, yalnızca boş alan. İstemci tipini okumadan
     * sunucu sözleşmesi yazılmaz.
     */
    const r = await cagir("/api/stats/me", { headers: { "x-user-id": "ayse" } });
    assert.equal(r.s, 200, JSON.stringify(r.j));
    assert.equal(typeof r.j.team, "object", "team duz metin donuyor — mobil .team.team okuyor");
    assert.equal(r.j.team.team, "Galatasaray");
    assert.equal(r.j.team.rank, 1, "ayse en yuksek puanli, 1. sirada olmali");
    assert.equal(r.j.team.count, 5);
    assert.equal(r.j.team.myTeamTotal, 40);
  });

  test("takımı olmayan kullanıcıda team null", async () => {
    const r = await cagir("/api/stats/me", { headers: { "x-user-id": "takimsiz" } });
    assert.equal(r.s, 200, JSON.stringify(r.j));
    assert.equal(r.j.favTeam, null);
    assert.equal(r.j.team, null);
  });

  test("kapat", async () => {
    srv?.close(); await client?.close(); await mongod?.stop();
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

const yalin = (p) => fs.readFileSync(path.join(KOK, p), "utf8")
  /* ⚠️ SATIR SONLARI ÖNCE NORMALLEŞTIRİLİR — CRLF İKİ NÖBETÇİYİ SESSİZCE
   * KÖRELTMİŞTİ. Depoda .gitattributes yok ve core.autocrlf=true, yani Windows
   * checkout unda her satır CR+LF ile bitiyor. İçinde LF geçen bir kalıp — bir
   * fonksiyon gövdesini yeni satır + kapanış parantezi ile kesmek, ya da iki
   * satırlık bir dizgeyi indexOf ile aramak — o checkout ta HİÇBİR ZAMAN
   * eşleşmiyordu: kod doğru olduğu hâlde iddia düşüyor, ya da daha kötüsü gövde
   * çıkarımı -1 dönüp ölçüm YANLIŞ BÖLGEYE kayıyordu. */
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

test("NÖBETÇİ: team-ranks sezon belgelerini BİRLEŞTİRİYOR", () => {
  /* Davranış testi bunu zaten sınıyor ama yalnızca kurduğum veriyle.
   * Çağrı kalkarsa sessizce bölünmüş puanlara döneriz. */
  assert.ok(/belgeleriBirlestir/.test(yalin("routes/stats.cjs")),
    "season_totals belgeleri birlestirilmiyor — kullanici iki kez gorunur");
});

test("NÖBETÇİ: yazma ve okuma AYNI kanonikleştirmeden geçiyor", () => {
  const s = yalin("routes/stats.cjs");
  const u = yalin("routes/users.cjs");
  assert.ok(/TakimKatalog\.kanonikTakim/.test(u), "set-main-team kanoniklestirmiyor");
  assert.ok(/TakimKatalog\.kanonikTakim/.test(s), "team-ranks sorgusu kanoniklestirmiyor");
});

test("NÖBETÇİ: katalog bulanık eşleşme yapmıyor", () => {
  /**
   * `team-country.cjs`'te ölçülmüştü: içerme aramasi belirsiz adlarda yazı
   * turası atıyor. Buraya sızarsa iki farklı kulübün taraftarı birleşir.
   */
  const k = yalin("lib/takim-katalog.cjs");
  assert.ok(!/icerir\s*\(/.test(k), "katalogda icerme eslesmesi belirmis");
  assert.ok(/cakisan\.delete|for \(const c of cakisan\) cekirdekIx\.delete/.test(k),
    "belirsiz cekirdekler silinmiyor — yanlis kulup eslesmesi mumkun");
});
