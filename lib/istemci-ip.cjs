"use strict";

/**
 * İSTEMCİ IP'Sİ — hız sınırı ve kaba-kuvvet sayaçları için.
 *
 * ⚠️ BULUNAN AÇIK: iki yer `x-forwarded-for` başlığının SOLUNDAN okuyordu —
 *
 *     middleware/rateLimit.cjs:  xff.split(",")[0].trim()
 *     routes/presets.cjs:        (req.headers["x-forwarded-for"] || ...)
 *
 * O değer TAMAMEN İSTEMCİ DENETİMİNDE. Ters proxy başlığı silmez, SONUNA
 * EKLER: istemci `X-Forwarded-For: uydurma` gönderirse uygulamaya
 * `uydurma, <gerçek-ip>` ulaşır. Soldan okumak "uydurma"yı verir, yani
 * saldırgan her istekte başka bir değer yollayarak KENDİNE SONSUZ YENİ KOVA
 * açar.
 *
 * ⚠️ İKİNCİ KATMAN DA AYNI DELİKTEYDİ. `rateLimit` iki katmanlı: (1) IP+kimlik
 * +rota, (2) yalnızca IP tavanı. İkincisinin yorumu amacını yazıyor: "kimliği
 * değiştirerek 1. katmanı atlayan saldırgan buraya takılır". Ama o da aynı
 * `ipOf`u kullanıyordu — yedek, yedeklediği şeyle aynı delikteydi.
 *
 * Kırılan korumalar: 1987 davet kodu (5/dk — kalıcı premium + 60 LC veriyor),
 * kupon/düello/havuz akın koruması, ve `presets.cjs`'teki PIN denemesi
 * (10 dakikada 5).
 *
 * ⚠️ DOĞRU OKUMA SAĞDAN. Zincirdeki her proxy, isteği ALDIĞI adresi ekler.
 * Güvenilen proxy sayısı kadar sağdan sayılan giriş, o proxy'nin KENDİ
 * gördüğü adrestir ve istemci onu yazamaz:
 *
 *     istemci gönderir : "uydurma"
 *     Render kenarı    : "uydurma, 5.6.7.8"   ← 5.6.7.8 gerçek istemci
 *     sağdan 1. giriş  : 5.6.7.8              ✅
 *
 * Ne kadar çöp eklenirse eklensin sağdan sayım doğru kalır.
 */

const { uretimMi } = require("./ortam.cjs");

/**
 * Güvenilen proxy adedi.
 *
 * ⚠️ VARSAYILAN ÜRETİMDE 1, YERELDE 0. Yerelde proxy yoktur; orada başlığa
 * bakmak, kendi makinesinden istek atan birinin kendini istediği IP gibi
 * göstermesi demek olurdu. Üretimde Render kenarı tek hop ekler.
 *
 * Farklı bir kurulumda (ek CDN/yük dengeleyici) `SKORLIG_PROXY_HOPS` ile
 * ayarlanır. YANLIŞ AYARLAMAK GÜVENLİK ETKİLER: sayı gerçekte olandan
 * BÜYÜKSE istemcinin yazdığı bir girişi okumaya başlarsınız.
 */
function proxyHop() {
  const ham = process.env.SKORLIG_PROXY_HOPS;
  if (ham === undefined || ham === "") return uretimMi() ? 1 : 0;
  const n = Number(ham);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : (uretimMi() ? 1 : 0);
}

/**
 * Sayaç anahtarı olarak kullanılacak istemci adresi.
 *
 * Beklenen proxy zinciri yoksa (girişten az sayıda hop) SOKET ADRESİNE düşer:
 * o durumda tüm bu istekler tek kovayı paylaşır — dar, ama uydurulamaz.
 * Sayaçlarda kapalı tarafta hata yapmak doğrusu.
 */
function istemciIp(req) {
  const soket = String(req?.socket?.remoteAddress || "0.0.0.0");
  const hop = proxyHop();
  if (hop <= 0) return soket;

  const ham = req?.headers?.["x-forwarded-for"];
  if (!ham) return soket;

  const liste = String(ham)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const idx = liste.length - hop;
  return idx >= 0 && liste[idx] ? liste[idx] : soket;
}

module.exports = { istemciIp, proxyHop };
