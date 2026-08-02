"use strict";

/**
 * KİMLİK PARAMETREDEN OKUNAN HER UÇ YA KORUNUR YA LİSTEDEDİR.
 *
 * ⚠️ BUGÜNÜN BASKIN KUSURU BUYDU — DOKUZ KEZ. Hepsi aynı biçimde: uç bir
 * kullanıcı kimliğini `?userId=`, `:userId` ya da gövdeden alıyor ve o kişinin
 * verisini, İSTEYENİN KİM OLDUĞUNU sormadan döndürüyor:
 *
 *     pool.myBet             rakibin bahsi (açık maçta)
 *     weekly-picks           başkasının haftalık seçimleri
 *     stats/user             başkasının cüzdanı
 *     users/profile          başkasının bakiyesi
 *     auth1987gs/verify      üyelik BAŞKASINA yazılabiliyordu
 *     friends/list           başkasının sosyal grafiği
 *     friends/board          aynısı
 *     rt/user-profile        başkasının LC bakiyesi
 *     rt/match-race          MAÇ BAŞLAMADAN herkesin tam skor tahmini
 *
 * `lib/kimlik-kontrol.cjs` bu dersi zaten yazmış; eksik olan her seferinde
 * onu ÇAĞIRMAKTI. Tek tek bulmak yerine sınıfı kapatıyoruz.
 *
 * ⚠️ TEST GREP DEĞİL, KAPI SAYIMI. Bir uç şu dördünden BİRİNE sahip olmalı:
 * rota satırında kimlik ara katmanı, gövdede sahiplik kontrolü, gövdede
 * yönetici kapısı, ya da aşağıdaki AÇIK listede bulunmak. Listeye satır
 * eklemek "bu uç herkese açık" demektir ve ekleyen kişi kullanıcıya ÖZEL veri
 * dönmediğini doğrulamak zorundadır.
 *
 * ⚠️ SONDAM İKİ KEZ YANILDI, ikisi de burada kapalı:
 *   1) `requireAdminToken` gövde İÇİNDE çağrılıyordu (`if (!requireAdminToken(...)) return;`)
 *      ve ilk kalıbım onu görmüyordu — dört yönetici ucu yanlışlıkla
 *      "korumasız" göründü. Kapı deseni artık onu da kapsıyor.
 *   2) Açık uç taramam SORGU parametrelerini doldurmuyordu; `?userId=` olmadan
 *      uç 400 döndüğü için `rt/user-profile` "kapalı" göründü. Bu test HTTP
 *      atmıyor, kaynağı okuyor — o kör noktası yok.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/** Kimlik parametresi okuma izi. */
const KIMLIK = /req\.(query|params|body)\??\.\??userId/;

/** Kabul edilen dört kapıdan herhangi biri. */
const KAPI = /verifyToken|optionalToken|requireAdmin|requireAdminToken|kimlikVeyaHata|kendiKaydiMi|req\.uid/;

/**
 * BİLEREK AÇIK UÇLAR — hepsi GET ve hepsi kamuya açık istatistik döndürür.
 * 2026-08-02'de tek tek incelendi:
 *   - sıralama/pano uçları: puan ve sıra zaten herkese açık
 *   - `/fav`: kullanıcının TAKIMINA göre fikstür süzüyor; takım da açık
 *   - `/streak`: seri sayısı, puan gibi kamuya açık bir istatistik
 *   - `pred/history*`: yalnızca UZLAŞMIŞ snapshot'lardan okuyor, açık maç yok
 */
const ACIK = new Set([
  "GET /competition-totals", "GET /duels/open", "GET /streak", "GET /fav",
  "GET /public", "GET /wins", "GET /pred/history", "GET /pred/history/detail",
  "GET /totals", "GET /current", "GET /week/:weekKey", "GET /leaderboard",
]);

function rotalariTara() {
  const dizin = path.join(KOK, "routes");
  const bulunan = [];
  for (const ad of fs.readdirSync(dizin)) {
    if (!ad.endsWith(".cjs")) continue;
    const satir = fs.readFileSync(path.join(dizin, ad), "utf8").split(/\r?\n/);
    let rota = null, rn = 0;
    for (let i = 0; i < satir.length; i++) {
      const m = satir[i].match(/^router\.(get|post|put|delete)\(\s*"([^"]+)"/);
      if (m) { rota = `${m[1].toUpperCase()} ${m[2]}`; rn = i; continue; }
      if (!rota || !KIMLIK.test(satir[i])) continue;
      const govde = satir.slice(rn, rn + 45).join("\n");
      bulunan.push({ dosya: ad, rota, korumali: KAPI.test(govde) });
      rota = null;
    }
  }
  return bulunan;
}

describe("kimlik sınıfı nöbeti", () => {
  test("tarama GERÇEKTEN rota buluyor", () => {
    /* ⚠️ Sıfır sonuç kanıt değildir: kalıp bozulursa test sessizce yeşil
     * kalır ve sınıfı hiç korumaz. Bugün sonda kurulumunda üç kez bu tuzağa
     * düşüldü. */
    const hepsi = rotalariTara();
    assert.ok(hepsi.length >= 30,
      `yalnizca ${hepsi.length} kimlik okuyan rota bulundu — tarama bozuk, test bir sey olcmuyor`);
    assert.ok(hepsi.some((x) => x.korumali), "hicbir rota korumali gorunmuyor — kapi deseni bozuk");
  });

  test("KORUMASIZ hiçbir uç listede olmadan kalamaz", () => {
    const acikta = rotalariTara()
      .filter((x) => !x.korumali)
      .filter((x) => !ACIK.has(x.rota))
      .map((x) => `${x.dosya}  ${x.rota}`);
    assert.deepEqual(acikta, [],
      "kimlik parametresini DENETIMSIZ okuyan uc(lar): " + acikta.join(" | ") +
      "  — kullaniciya ozel veri donduruyorsa jetondan kimlik iste, donmuyorsa ACIK listesine ekle");
  });

  test("AÇIK listesi şişmiyor (her satır bir karar)", () => {
    /* ⚠️ Listeye eklemek kolay, sonucu görünmez. Sayı büyürse birileri
     * uçları kilitlemek yerine listeye ekliyor demektir. */
    assert.ok(ACIK.size <= 16,
      `ACIK listesinde ${ACIK.size} uc var — kilitlemek yerine listeye eklenmis olabilir, gozden gecir`);
  });

  test("listedeki uçlar GERÇEKTEN var (liste bayatlamasın)", () => {
    /**
     * ⚠️ Ölü satır tehlikeli: uç silinip aynı ad başka bir yerde
     * KULLANICIYA ÖZEL olarak geri gelirse, liste onu sessizce muaf tutar.
     */
    const mevcut = new Set(rotalariTara().map((x) => x.rota));
    const olu = [...ACIK].filter((r) => !mevcut.has(r));
    assert.deepEqual(olu, [],
      "ACIK listesinde artik var olmayan rota(lar): " + olu.join(" | ") + "  — sil, yoksa ileride yanlis muafiyet verir");
  });
});
