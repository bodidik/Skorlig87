"use strict";

/**
 * ROTA GÖLGELEMESİ — iki router aynı tam yolu tanımlarsa Express İLKİNİ kullanır.
 *
 * ⚠️ NEDEN ÖNEMLİ: gölgede kalan kopya ÖLÜ kod olur ama canlı görünür. Orada
 * yapılan bir düzeltme hiçbir işe yaramaz — ve bu tam olarak yaşandı:
 *
 *   `groups.cjs` ile `users.cjs` aynı grup uçlarını tanımlıyordu. Yarış
 *   düzeltmesi (atomik `$addToSet`, benzersiz indeksle kod çakışması)
 *   `SocialStore`a yazılmış ve BELGELENMİŞTİ — ama istemcinin gittiği yolu
 *   `users.cjs` karşılıyordu ve o kopya eski "tüm depoyu oku → değiştir →
 *   yaz" desenini koruyordu. Yani belgelenen düzeltme gerçek kullanıcılar
 *   için yürürlükte değildi; iki eşzamanlı grup kurulumu birbirini siliyordu.
 *
 * Bu test iki şey yapar:
 *   1) YENİ gölgeleme eklenmesini engeller (bilinen liste dondurulmuş).
 *   2) Gölgelenen bir çiftte KORUMA FARKI varsa hemen kırılır — korumasız bir
 *      kopyanın korumalı olanı gölgelemesi doğrudan güvenlik açığıdır.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const ROTA_DIZIN = path.join(KOK, "routes");

/**
 * server.cjs'deki montajlar, DOSYADAKİ SIRAYLA (Express eşleşme sırası budur).
 *
 * ⚠️ İKİ MONTAJ BİÇİMİ VAR ve ilk sürüm yalnızca birini görüyordu:
 *
 *     app.use("/api/x", require("./routes/x.cjs"))   ← satır içi
 *     const team = require("./routes/team.cjs");     ← değişkenle
 *     app.use("/api/team", team);
 *
 * Değişkenli biçim gözden kaçınca o router'ın rotaları haritada HİÇ görünmez,
 * yani onu ilgilendiren bir gölgeleme sessizce kaçar. Bunu negatif kontrol
 * yakaladı: team.cjs'e bilerek çakışan bir rota ekledim ve test ATEŞLEMEDİ.
 * Nöbetçinin kendi kör noktası, koruduğu hata kadar tehlikeli.
 */
function montajlar() {
  const src = fs.readFileSync(path.join(KOK, "server.cjs"), "utf8");
  const out = [];

  // 1) satır içi: app.use("<onek>", require("./routes/<dosya>"))
  const satirIci = /app\.use\(\s*"([^"]+)"\s*,\s*require\(\s*"\.\/routes\/([^"]+)"\s*\)/g;
  let m;
  while ((m = satirIci.exec(src))) out.push({ konum: m.index, onek: m[1], dosya: m[2] });

  // 2) değişkenle: const <ad> = require("./routes/<dosya>") ... app.use("<onek>", <ad>)
  const degiskenler = new Map();
  const bildirim = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(\s*"\.\/routes\/([^"]+)"\s*\)/g;
  while ((m = bildirim.exec(src))) degiskenler.set(m[1], m[2]);

  const degiskenMontaj = /app\.use\(\s*"([^"]+)"\s*,\s*([A-Za-z0-9_$]+)\s*\)/g;
  while ((m = degiskenMontaj.exec(src))) {
    const dosya = degiskenler.get(m[2]);
    if (dosya) out.push({ konum: m.index, onek: m[1], dosya });
  }

  return out.sort((a, b) => a.konum - b.konum);
}

function rotalar(dosya) {
  const tam = path.join(ROTA_DIZIN, dosya);
  if (!fs.existsSync(tam)) return [];
  const out = [];
  fs.readFileSync(tam, "utf8").split("\n").forEach((satir, i) => {
    const m = /^router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/.exec(satir);
    if (!m) return;
    out.push({
      yontem: m[1].toUpperCase(),
      yol: m[2],
      korumali: satir.includes("verifyToken") || satir.includes("requireAdmin"),
      satir: i + 1,
    });
  });
  return out;
}

/** yöntem+tam yol -> [{dosya, korumali, sira}] */
function yolHaritasi() {
  const harita = new Map();
  montajlar().forEach(({ onek, dosya }, sira) => {
    for (const r of rotalar(dosya)) {
      const tamYol = (onek.replace(/\/+$/, "") + "/" + r.yol.replace(/^\/+/, "")).replace(/\/{2,}/g, "/");
      const anahtar = `${r.yontem} ${tamYol}`;
      if (!harita.has(anahtar)) harita.set(anahtar, []);
      harita.get(anahtar).push({ dosya, korumali: r.korumali, sira, satir: r.satir });
    }
  });
  return harita;
}

/**
 * BİLİNEN gölgelenmeler — hepsi incelendi, hiçbiri CANLI hata değil.
 * Her satır "kazanan / gölgede" biçiminde ve neden zararsız olduğunu söyler.
 *
 * Liste DONDURULMUŞTUR: yeni bir gölgeleme eklenirse test kırılır ve bilinçli
 * bir karar vermeye zorlar. Buraya ekleme yapmadan önce iki kopyanın
 * AYRIŞMADIĞINI doğrula — gruplar örneğinde ayrışma canlı bir yarış hatasıydı.
 */
const BILINEN = new Set([
  // live-fav kazanıyor (?userId=), fixtures.cjs kopyası ?team= alıyor ve
  // yorumu /api/live2/fav diyor — istemci hiçbirini çağırmıyor, ölü kod.
  "GET /api/live/fav",
  // realtime kazanıyor; rt-extra kopyası aynı işi yapıyor, ikisi de korumalı.
  "GET /api/rt/my",
  "GET /api/rt/score",
  // totals-read kazanıyor (Mongo, `items` dizisi). totals.cjs kopyası dosya
  // tabanlı ve BAŞKA şekil dönüyor; istemci `items` okuyor, yani kazanana
  // uyumlu. Gölgedeki ölü.
  "GET /api/rt/totals",
  // users.cjs kazanıyor. groups.cjs /api/users/groups'a da monte olduğu için
  // çakışıyor; create/join/opt SocialStore'a devredildi, board'da ayrışma yok.
  "GET /api/users/groups/:code/board",
  "GET /api/users/groups/diag",
  "POST /api/users/groups/:code/opt",
  "POST /api/users/groups/create",
  "POST /api/users/groups/join",
]);

test("gölgelenen çiftlerde koruma farkı olamaz", () => {
  // Bu kural muafiyetsizdir: korumasız bir kopya korumalı olanı gölgelerse
  // yetki denetimi fiilen kalkar.
  const kusurlu = [];
  for (const [anahtar, liste] of yolHaritasi()) {
    if (liste.length < 2) continue;
    const korumalar = new Set(liste.map((x) => x.korumali));
    if (korumalar.size > 1) {
      const kazanan = liste[0];
      kusurlu.push(
        `${anahtar} — kazanan ${kazanan.dosya}:${kazanan.satir} ` +
        `(${kazanan.korumali ? "korumali" : "KORUMASIZ"}), ` +
        liste.slice(1).map((x) => `${x.dosya}:${x.satir}(${x.korumali ? "korumali" : "KORUMASIZ"})`).join(", ")
      );
    }
  }
  assert.deepStrictEqual(kusurlu, [], "Golgelenen ciftte koruma farki:\n" + kusurlu.join("\n"));
});

test("YENİ rota gölgelemesi eklenemez", () => {
  const harita = yolHaritasi();
  assert.ok(harita.size > 100, `cok az yol bulundu (${harita.size}) — tarama bozulmus olabilir`);

  const yeni = [];
  for (const [anahtar, liste] of harita) {
    if (liste.length < 2) continue;
    if (BILINEN.has(anahtar)) continue;
    yeni.push(`${anahtar} → ` + liste.map((x) => `${x.dosya}:${x.satir}`).join(" ve "));
  }

  assert.deepStrictEqual(
    yeni,
    [],
    "Yeni rota golgelemesi: ikinci tanim OLU kod olur ve orada yapilan duzeltme\n" +
      "hicbir ise yaramaz (gruplarda tam olarak bu yasandi).\n" +
      yeni.join("\n")
  );
});

test("bilinen gölgeleme listesi güncel — çözülenler listede kalmasın", () => {
  // Liste bayatlarsa gerçek gölgelemeleri gizlemeye başlar.
  const harita = yolHaritasi();
  const artikYok = [...BILINEN].filter((a) => (harita.get(a) || []).length < 2);
  assert.deepStrictEqual(
    artikYok,
    [],
    "Bu yollar artik golgelenmiyor, BILINEN listesinden cikarilmali:\n" + artikYok.join("\n")
  );
});
