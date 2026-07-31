"use strict";

/**
 * HATA AYRINTISI TEMİZLEYİCİ — iç bilgiyi yanıttan çıkarır.
 *
 * ⚠️ NEDEN VAR: kod tabanında 22 dosyada 100 uç, hatayı olduğu gibi
 * döndürüyor (`detail: String(e?.message || e)`). Ölçüldü:
 *
 *   dosya hatası  → "ENOENT: ... open 'D:\\APPden\\SkorLig\\api\\data\\x.json'"
 *   Mongo hatası  → "querySrv ENOTFOUND _mongodb._tcp.<kume>.mongodb.net"
 *
 * Yani mutlak sunucu yolu ve ATLAS KÜME ADRESİ dışarı sızıyor. Parola
 * sızmıyor (sürücü onu maskeliyor) ama küme adresi, IP listesi denemesi için
 * gerçek bir hedef. Bu bilgi kullanıcıya hiçbir şey ifade etmiyor.
 *
 * ⚠️ 100 ÇAĞRI YERİNİ TEK TEK DEĞİŞTİRMEK YERİNE TEK ÇIKIŞ NOKTASI. Bu
 * oturumda tekrar tekrar görüldü: aynı savunmanın çok sayıda kopyası varsa
 * birinde unutulur. Burada kopya YOK — yanıt yazılırken bir kez temizleniyor,
 * yeni eklenen uçlar da kendiliğinden kapsanıyor.
 *
 * ⚠️ SUNUCU GÜNLÜĞÜ DEĞİŞMİYOR. `console.error` çağrıları olduğu gibi kalıyor;
 * hata ayıklama için tam metin sunucuda duruyor. Kısılan yalnızca İSTEMCİYE
 * giden kopya.
 */

/** Değiştirilecek desenler — her biri gerekçeli. */
const DESENLER = [
  // Windows ve POSIX mutlak yolları (Render'da /opt/render/project/src/...)
  [/[A-Za-z]:\\[^\s"']+/g, "<yol>"],
  [/\/(?:opt|home|usr|var|srv|app)\/[^\s"')]+/g, "<yol>"],
  // Atlas / Mongo ana makine adları
  [/[A-Za-z0-9_.-]+\.mongodb\.net(?::\d+)?/g, "<db-host>"],
  [/_mongodb\._tcp\.[A-Za-z0-9_.-]+/g, "<db-srv>"],
  // Bağlantı dizesi kalıntısı (sürücü genelde maskeler; yine de)
  [/mongodb(?:\+srv)?:\/\/[^\s"']+/g, "<db-uri>"],
];

/** Bir metni temizler. */
function temizle(metin) {
  let s = String(metin);
  for (const [re, yerine] of DESENLER) s = s.replace(re, yerine);
  return s;
}

/**
 * Yanıt gövdesindeki hata alanlarını temizler.
 *
 * ⚠️ YALNIZCA HATA ALANLARI. Tüm gövdeyi taramak, oyuncu adı gibi meşru
 * verileri de bozabilirdi; `detail`/`error`/`message` dışındaki alanlara
 * dokunulmuyor.
 */
const ALANLAR = ["detail", "error", "message", "reason"];

function govdeyiTemizle(govde) {
  if (!govde || typeof govde !== "object") return govde;
  let degisti = false;
  const kopya = { ...govde };
  for (const alan of ALANLAR) {
    if (typeof kopya[alan] !== "string") continue;
    const yeni = temizle(kopya[alan]);
    if (yeni !== kopya[alan]) { kopya[alan] = yeni; degisti = true; }
  }
  return degisti ? kopya : govde;
}

/**
 * Express ara katmanı: `res.json` çıktısını temizler.
 *
 * Sarmalama bilinçli — 100 çağrı yerine dokunmadan hepsini kapsıyor ve
 * gelecekte eklenecek uçlar da otomatik korunuyor.
 */
function hataTemizleyici(req, res, next) {
  const asil = res.json.bind(res);
  res.json = (govde) => asil(govdeyiTemizle(govde));
  next();
}

module.exports = { hataTemizleyici, temizle, govdeyiTemizle, _DESENLER: DESENLER };
