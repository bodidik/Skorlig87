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

/* ────────────────────────────────────────────────────────────────────────────
 * BAĞLANTI KESİNTİSİ 500 DEĞİL 503.
 *
 * ⚠️ NEDEN: kullanıcı telefonundan `500 /api/rt/lc-wallet/daily-claim`
 * bildirdi. ÜRETİLDİ: Mongo bağlantısı istek ortasında ölünce handler
 * `500 LC_WALLET_DAILY_ERR detail:"querySrv ETIMEOUT ..."` döndürüyor.
 * `data/admin-alerts.json` içindeki en yeni uyarı da aynı anı gösteriyor:
 * `mongo_down — Son hata: querySrv ETIMEOUT`.
 *
 * Yani KOD KUSURU DEĞİL, altyapı kesintisi. Ama 500 "sunucu bozuk" demek;
 * geçici ağ kesintisiyle gerçek çökmeyi aynı kovaya atıyor. Bu oturumun
 * tamamı kusur avıydı — yanlış etiketlenmiş bir 500 doğrudan o işi harcıyor.
 * 503 ise "geçici, tekrar dene" demek: hem istemci doğru mesajı gösterebilir
 * hem günlükte ikisi ayrışır.
 *
 * ⚠️ DOSYA MODUNA DÜŞÜLMÜYOR, VE BU BİLİNÇLİ. "Mongo yoksa dosyaya yaz"
 * burada YANLIŞ olurdu: günlük ödül bir PARA yazması ve mühür (`lastDailyAt`)
 * Mongo'da duruyor. Dosyaya düşersek Mongo döndüğünde iki depo ayrışır ve
 * oyuncu ödülü İKİ KEZ alır — bu oturumda tekrar tekrar kapattığım kusurun
 * ta kendisi. Para yolunda doğru yön fail-closed: yazma, dürüstçe hata ver.
 *
 * ⚠️ YALNIZCA 500'LER. 4xx (iş kuralı reddi) ve 2xx'e dokunulmuyor.
 * ──────────────────────────────────────────────────────────────────────── */

/** Bağlantı/ağ katmanı arızası — iş mantığı hatası değil. */
const BAGLANTI_DESENLERI = [
  /querySrv/i,
  /ETIMEDOUT|ETIMEOUT/i,
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i,
  /MongoNetworkError|MongoServerSelectionError|MongoNotConnectedError/i,
  /topology (?:was destroyed|is closed)/i,
  /server selection timed out/i,
  /connection .{0,20}closed/i,
];

function baglantiHatasiMi(metin) {
  const s = String(metin || "");
  if (!s) return false;
  return BAGLANTI_DESENLERI.some((re) => re.test(s));
}

/**
 * Express ara katmanı: `res.json` çıktısını temizler ve bağlantı
 * kesintilerini 503'e indirir.
 *
 * Sarmalama bilinçli — 100 çağrı yerine dokunmadan hepsini kapsıyor ve
 * gelecekte eklenecek uçlar da otomatik korunuyor.
 */
function hataTemizleyici(req, res, next) {
  const asil = res.json.bind(res);
  res.json = (govde) => {
    /* ⚠️ SIRA ÖNEMLİ: sınıflandırma HAM metinde yapılıyor. Önce temizlersek
     * "querySrv ETIMEOUT _mongodb._tcp.<kume>" → "<db-srv>" olur ve deseni
     * kaybederiz; kesinti sessizce 500 olarak kalırdı. */
    if (res.statusCode === 500 && govde && typeof govde === "object") {
      const ham = ALANLAR.map((a) => (typeof govde[a] === "string" ? govde[a] : "")).join(" ");
      if (baglantiHatasiMi(ham)) {
        res.status(503);
        return asil({ ...govdeyiTemizle(govde), gecici: true, retryAfterSec: 5 });
      }
    }
    return asil(govdeyiTemizle(govde));
  };
  next();
}

module.exports = {
  hataTemizleyici, temizle, govdeyiTemizle, baglantiHatasiMi,
  _DESENLER: DESENLER, _BAGLANTI_DESENLERI: BAGLANTI_DESENLERI,
};
