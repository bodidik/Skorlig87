"use strict";

/**
 * HIZ SINIRI KOVASI YOLA DEĞİL KURALA GÖRE.
 *
 * ⚠️ BULUNAN: iki router BİLEREK iki yere mount edilmiş (eski istemci
 * uyumluluğu için):
 *
 *     server.cjs:388  app.use("/api/friends",       friends.cjs)
 *     server.cjs:389  app.use("/api/users/friends", friends.cjs)   // compat
 *                     app.use("/api/groups") + app.use("/api/users/groups")
 *
 * Sayaç anahtarı ise ham yoldu (`${ip}|${uid}|${url}`), yani
 * `/api/friends/invite` ile `/api/users/friends/invite` AYRI kovalara
 * düşüyordu — ikisi de AYNI kurala eşleşmesine rağmen.
 *
 * ÖLÇÜLDÜ (düzeltme öncesi): kural 20/dk iken iki yoldan toplam 40 istek
 * geçti (~2.0x). Etkilenen kurallar:
 *     /friends/invite        20/dk → fiilen 40
 *     /friends/use-invite    10/dk → fiilen 20
 *     /groups/(create|join)  10/dk → fiilen 20
 *
 * Saldırganın ekstra bir şey yapmasına gerek yoktu: iki URL de belgeli ve
 * canlı, istekleri dönüşümlü atmak yetiyordu.
 *
 * ⚠️ NEDEN YAKALANMADI: mevcut hız sınırı testleri kuralın TEK yoldan
 * çalıştığını doğruluyor (20 geçer, 21. 429). İki mount'un aynı kurala
 * düştüğünü kimse sınamamış — kural doğru, muhasebe yanlıştı.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

process.env.SKORLIG_RATE_LIMIT = "1";
/* IP tavanı (2. katman) ölçümü kirletmesin — burada 1. katmanı sınıyoruz. */
process.env.SKORLIG_RATE_IP_MAX = "1000000";
/**
 * ⚠️ BU SATIR OLMADAN TESTLER BİRBİRİNİ KİRLETİYOR — İLK HÂLİNDE YOKTU.
 *
 * `lib/istemci-ip.cjs` yerelde `proxyHop()` = 0 döndürüyor ve x-forwarded-for'u
 * HİÇ OKUMUYOR (yerelde proxy yok; başlığa bakmak kendi makinesinden istek
 * atanın kendini istediği IP gibi göstermesi olurdu — bilinçli karar).
 *
 * Sonuç: testlerde farklı IP göndermek hiçbir şey yapmıyordu, hepsi soket
 * adresine (127.0.0.1) düşüp AYNI kovayı paylaşıyordu. "kurulum" testi
 * friends kovasını doldurunca asıl iddia kalan kotayla ölçüm yapıp
 * SABOTAJLI KODDA BİLE GEÇTİ. Negatif kontrol olmasa fark etmezdim.
 */
process.env.SKORLIG_PROXY_HOPS = "1";

const rateLimit = require("../middleware/rateLimit.cjs");

let server = null, taban = "";

before(async () => {
  const express = require("express");
  const app = express();
  app.set("trust proxy", true);
  app.use(rateLimit);
  app.use((req, res) => res.json({ ok: true }));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

/**
 * ⚠️ x-forwarded-for ŞART. Limiter loopback + XFF yok olan isteği İÇ ÇAĞRI
 * sayıp muaf tutuyor (bot-filler kendi API'sini çağırıyor). XFF koymazsam
 * her istek 200 döner ve testim hiçbir şey ölçmez.
 */
async function at(yol, ip, uid = "u1") {
  const r = await fetch(`${taban}${yol}`, {
    method: "POST",
    headers: { "x-forwarded-for": ip, "x-user-id": uid },
  });
  return r.status;
}

async function say(yol, ip, n, uid) {
  let gecen = 0, red = 0;
  for (let i = 0; i < n; i++) {
    const s = await at(yol, ip, uid);
    if (s === 429) red++; else gecen++;
  }
  return { gecen, red };
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("limiter GERÇEKTEN uygulanıyor", async () => {
    /* ⚠️ Sıfır sonuç kanıt değil: limiter hiç çalışmasaydı aşağıdaki
     * "toplam kurala uyuyor" iddiası da kendiliğinden geçerdi — çünkü
     * o durumda hiç 429 olmaz ve ben yanlış şeyi ölçtüğümü fark etmezdim.
     * Önce sınırın var olduğunu kanıtlıyoruz. */
    const r = await say("/api/friends/invite", "198.51.100.1", 25);
    assert.ok(
      r.red > 0,
      `hic 429 yok: ${JSON.stringify(r)} — limiter devre disi ya da istek ` +
      `ic cagri sayiliyor (x-forwarded-for eksik mi?), test bir sey olcmuyor`
    );
  });

  test("IP izolasyonu GERÇEKTEN çalışıyor", async () => {
    /**
     * ⚠️ BU İDDİA BİR HATADAN DOĞDU. İlk hâlde testler farklı IP'ler
     * gönderiyordu ama `proxyHop()` yerelde 0 olduğu için hepsi soket
     * adresine düşüp TEK kovayı paylaşıyordu; bir testin tükettiği kota
     * diğerinin ölçümünü bozuyor ve sabotajlı kod bile geçiyordu.
     *
     * Artık izolasyonun kendisi sınanıyor: aynı ucu iki FARKLI IP'den
     * doldurup ikincisinin birinciden etkilenmediğini gösteriyoruz.
     */
    const a = await say("/api/friends/invite", "198.51.100.90", 21);
    const b = await say("/api/friends/invite", "198.51.100.91", 21);
    assert.ok(a.red > 0, `birinci IP 429 yemedi: ${JSON.stringify(a)}`);
    assert.ok(
      b.gecen >= 20,
      `ikinci IP yalnizca ${b.gecen} istek gecirebildi — IP kovalari ayrisMIYOR. ` +
      `SKORLIG_PROXY_HOPS ayarlanmamis olabilir; bu durumda butun testler ayni ` +
      `kovada olcum yapar ve sonuclar anlamsizdir.`
    );
  });

  test("iki mount da server.cjs'te GERÇEKTEN var", () => {
    /* Kaynaktan doğrula: compat mount kaldırılırsa bu testin konusu da
     * kalmaz, o zaman testin sessizce boşa dönmesindense kırmızı olması iyi. */
    const srv = fs.readFileSync(nodePath.join(__dirname, "..", "server.cjs"), "utf8");
    assert.ok(
      /app\.use\(\s*"\/api\/friends"/.test(srv),
      "kanonik /api/friends mount'u yok"
    );
    assert.ok(
      /app\.use\(\s*"\/api\/users\/friends"/.test(srv),
      "compat /api/users/friends mount'u yok — kaldirildiysa bu testi guncelle"
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("çift mount tek kova paylaşıyor", () => {
  test("kanonik + compat TOPLAMI kuralı aşmıyor", async () => {
    const IP = "198.51.100.2";
    const KURAL = 20; // /friends/invite

    const a = await say("/api/friends/invite", IP, 25);
    const b = await say("/api/users/friends/invite", IP, 25);
    const toplam = a.gecen + b.gecen;

    assert.ok(
      toplam <= KURAL + 1,
      `iki yoldan toplam ${toplam} istek gecti, kural ${KURAL}/dk ` +
      `(kanonik ${a.gecen}, compat ${b.gecen}). Kova ham yola gore ` +
      `adlandiriliyor; ayni uc iki sayac kullaniyor ve sinir ~2x oluyor.`
    );
  });

  test("groups compat mount'u da aynı kovada", async () => {
    /* İkinci çift mount: /api/groups + /api/users/groups, kural 10/dk. */
    const IP = "198.51.100.3";
    const KURAL = 10;

    const a = await say("/api/groups/create", IP, 12);
    const b = await say("/api/users/groups/create", IP, 12);
    const toplam = a.gecen + b.gecen;

    assert.ok(
      toplam <= KURAL + 1,
      `groups: iki yoldan toplam ${toplam} gecti, kural ${KURAL}/dk ` +
      `(kanonik ${a.gecen}, compat ${b.gecen})`
    );
  });
});

describe("düzeltme fazla sıkmıyor", () => {
  test("DEFAULT'a düşen İLGİSİZ yollar AYRI kovada kalıyor", async () => {
    /**
     * ⚠️ Düzeltmenin kolay yanlışı: kovayı kurala bağlarken DEFAULT_RULE'u da
     * kurala bağlamak. DEFAULT tek bir kural nesnesi ve eşleşmeyen HER yol
     * ona düşüyor — kova ortak olsaydı birbiriyle ilgisiz yüzlerce uç tek
     * sayaçta birikir, bir ekranın yoğun kullanımı diğerlerini 429'a
     * sokardı. DEFAULT'ta yol bazlı ayrım KORUNMALI.
     */
    const IP = "198.51.100.4";

    /* İkisi de kural listesinde YOK → DEFAULT (120/dk). */
    const a = await say("/api/push/register", IP, 60);
    const b = await say("/api/provider/mark", IP, 60);

    assert.equal(
      a.red, 0,
      `ilk yol 429 yedi: ${JSON.stringify(a)} — DEFAULT siniri 120/dk, 60 istek gecmeliydi`
    );
    assert.equal(
      b.red, 0,
      `ikinci yol 429 yedi: ${JSON.stringify(b)} — ilgisiz iki uc ayni kovaya ` +
      `sokulmus; DEFAULT'ta kova yol bazli kalmali`
    );
  });

  test("farklı kullanıcılar hâlâ ayrı kovada (NAT korunuyor)", async () => {
    /* Mobil operatör NAT'ında binlerce kullanıcı aynı IP'yi paylaşıyor;
     * kimlik ipucu kovayı ayırmaya devam etmeli. */
    const IP = "198.51.100.5";
    const a = await say("/api/friends/invite", IP, 21, "ali");
    const b = await say("/api/friends/invite", IP, 21, "veli");

    assert.ok(a.red > 0, `ali 429 yemedi: ${JSON.stringify(a)}`);
    assert.ok(
      b.gecen >= 20,
      `veli ${b.gecen} istek gecirebildi — ali'nin kotasindan etkilendi, ` +
      `NAT'taki masum kullanicilar birbirini 429'a sokuyor`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kova anahtarı kuralı hesaba katıyor", () => {
  /**
   * Kaynak taraması, davranış testinin tamamlayıcısı. `keyFor` ham `url`e
   * geri dönerse çift mount açığı sessizce geri gelir — davranış testi
   * yakalar ama bu nöbetçi NEDENİ de söyler.
   */
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "middleware", "rateLimit.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const bas = kod.indexOf("function keyFor");
  assert.ok(bas >= 0, "keyFor bulunamadi — tarama bozuk");
  const kalan = kod.slice(bas + 8);
  const bit = kalan.search(/\n(async )?function /);
  const govde = bit >= 0 ? kalan.slice(0, bit) : kalan;

  /* ⚠️ `/rule/.test(govde)` YETMİYOR: imzada `rule` parametresi durduğu
   * sürece eşleşiyor, gövde onu kullanmasa bile. Negatif kontrolde tam bu
   * oldu — kova `url`e geri döndürüldü, davranış testleri düştü ama nöbetçi
   * yeşil kaldı. Kovanın KENDİSİ rule'dan türemeli. */
  const kovaAtamasi = govde.match(/const\s+kova\s*=([^;]*);/);
  assert.ok(kovaAtamasi, "kova atamasi bulunamadi — tarama bozuk");
  assert.ok(
    /rule/.test(kovaAtamasi[1]),
    `kova atamasi kurali kullanmiyor: "${kovaAtamasi[1].trim()}" — ` +
    "friends.cjs ve groups.cjs ikiser yere mount edildigi icin ayni uc " +
    "iki sayaca duser ve kural fiilen iki katina cikar (olculdu: 20/dk -> 40)."
  );

  /* Çağrı yerinde de rule geçiliyor mu — imza değişip çağrı unutulursa
   * `rule` undefined gelir, kova sessizce yine url olur. */
  assert.ok(
    /keyFor\(\s*req\s*,\s*url\s*,\s*rule\s*\)/.test(kod),
    "keyFor cagrisina rule GECIRILMIYOR — imza kurali aliyor ama cagri " +
    "gondermiyorsa kova sessizce ham yola geri doner"
  );
});
