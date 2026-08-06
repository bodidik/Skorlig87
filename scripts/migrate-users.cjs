"use strict";

require("dotenv").config();

/**
 * users.json → MongoDB `users` koleksiyonu aktarımı.
 *
 * NEDEN: Profil verisi (ülke, favori takım, takma ad, ligler, dil) yalnızca
 * dosyada tutuluyordu. Render ücretsiz katmanda kalıcı disk olmadığı için her
 * deploy'da siliniyordu — sessizce: `ensureUser` kullanıcıyı bulamayınca
 * sıfırdan yaratıyor, hata vermiyor.
 *
 * İDEMPOTENT: upsert kullanır, tekrar çalıştırılabilir. Yarıda kalırsa
 * kaldığı yerden değil baştan çalışır ama mevcut kayıtları bozmaz.
 *
 * Kullanım:
 *   node scripts/migrate-users.cjs            # aktar + doğrula
 *   node scripts/migrate-users.cjs --verify   # yalnızca doğrula (yazmaz)
 *   node scripts/migrate-users.cjs --dry-run  # ne yapacağını göster, yazma
 */

const path = require("path");
const fsp = require("fs").promises;

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "users.json");
const COLL = "users";
const BATCH = 500;

const argv = process.argv.slice(2);
const YALNIZ_DOGRULA = argv.includes("--verify");
const KURU = argv.includes("--dry-run");

/** Takma ad normalizasyonu — routes/users.cjs normNick ile AYNI olmalı. */
function normNick(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ı/g, "i").replace(/İ/g, "i")
    .replace(/ş/g, "s").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
    .trim();
}

const normId = (x) => String(x || "").trim();

/** Dosyayı her formattan ({items}, {users}, düz map) tek listeye indirger. */
async function dosyadanOku() {
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(FILE, "utf8"));
  } catch (e) {
    return { items: [], hata: e.code === "ENOENT" ? "DOSYA_YOK" : String(e.message || e) };
  }

  const out = [];
  const ekle = (u, zorunluId) => {
    if (!u || typeof u !== "object") return;
    const id = normId(zorunluId || u.userId || u.id);
    if (!id) return;
    out.push({ ...u, userId: id });
  };

  if (Array.isArray(raw)) raw.forEach((u) => ekle(u));
  else if (Array.isArray(raw.items)) raw.items.forEach((u) => ekle(u));
  else if (Array.isArray(raw.users)) raw.users.forEach((u) => ekle(u));
  else for (const [id, u] of Object.entries(raw || {})) ekle(u, id);

  // Aynı kimlik birden çok kez geçebilir (users + items birlikte) — ilki kazanır,
  // loadUsersMap'in mevcut davranışı da buydu.
  const gorulen = new Set();
  const tekil = [];
  for (const u of out) {
    if (gorulen.has(u.userId)) continue;
    gorulen.add(u.userId);
    tekil.push(u);
  }
  return { items: tekil };
}

/** Mongo'ya yazılacak biçim: sorgu alanları normalize edilir. */
function hazirla(u) {
  const doc = { ...u, userId: normId(u.userId) };
  // Bu alanlar indekslidir ve sorgular bunlara bakar. YAZILMAZLARSA sorgular
  // HATA VERMEDEN boş döner — en sinsi arıza biçimi.
  //   userIdLower : sıralamada ülke çözümü (kimlikler karışık harfli)
  //   userIdNorm  : takma ad çakışma kontrolü (kimlikle taklit engeli)
  //   nicknameNorm: takma ad çakışma kontrolü
  doc.userIdLower = doc.userId.toLowerCase();
  doc.userIdNorm = normNick(doc.userId);
  if (doc.nickname) doc.nicknameNorm = normNick(doc.nickname);
  delete doc._id;
  delete doc.id;
  return doc;
}

async function aktar(db, items) {
  let yazilan = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const dilim = items.slice(i, i + BATCH);
    const ops = dilim.map((u) => {
      const doc = hazirla(u);
      return {
        updateOne: {
          filter: { userId: doc.userId },
          update: { $set: doc },
          upsert: true,
        },
      };
    });
    if (!KURU) await db.collection(COLL).bulkWrite(ops, { ordered: false });
    yazilan += dilim.length;
    process.stdout.write(`\r[migrate] ${yazilan}/${items.length}`);
  }
  if (items.length) process.stdout.write("\n");
  return yazilan;
}

async function indeksler(db) {
  const col = db.collection(COLL);
  await col.createIndex({ userId: 1 }, { unique: true, background: true });
  await col.createIndex({ country: 1 }, { background: true });
  await col.createIndex({ nicknameNorm: 1 }, { background: true, sparse: true });
  await col.createIndex({ userIdNorm: 1 }, { background: true, sparse: true });
  await col.createIndex({ userIdLower: 1 }, { background: true });
  // Aşağıdakiler lib/users-store.cjs ensureIndexes ile AYNI olmalı. Eskiden
  // burada eksiklerdi ve yalnızca ilk trafikte oluşuyorlardı — taze bir
  // deploy'un ilk istekleri indekssiz çalışıyordu.
  await col.createIndex({ mainTeam: 1 }, { background: true, sparse: true });
  await col.createIndex({ is1987: 1 }, { background: true, sparse: true });
  await col.createIndex({ segment: 1 }, { background: true, sparse: true });
  await col.createIndex({ inviteCode: 1 }, { background: true, sparse: true });
}

/**
 * GO/NO-GO kapısı. Bayrak ancak GO dediğinde çevrilir.
 * Her kontrol, sessizce yanlış çalışabilecek bir şeyi hedefler.
 */
async function dogrula(db, dosyaItems) {
  const col = db.collection(COLL);
  const sorunlar = [];
  const not = (s) => console.log("   " + s);

  console.log("\n[dogrula] kontroller:");

  // 1) Sayı
  const mongoSayi = await col.countDocuments();
  not(`kayit: dosya ${dosyaItems.length} · mongo ${mongoSayi}`);
  if (mongoSayi < dosyaItems.length) {
    sorunlar.push(`Mongo'da eksik kayit var (${mongoSayi} < ${dosyaItems.length})`);
  }

  // 2) İndeksler
  const idx = (await col.indexes()).map((i) => JSON.stringify(i.key));
  for (const gerekli of [
    '{"userId":1}', '{"country":1}', '{"nicknameNorm":1}', '{"userIdNorm":1}',
    '{"userIdLower":1}', '{"mainTeam":1}', '{"is1987":1}', '{"segment":1}',
    '{"inviteCode":1}',
  ]) {
    if (!idx.includes(gerekli)) sorunlar.push(`indeks eksik: ${gerekli}`);
  }
  not(`indeks: ${idx.length} tane`);

  // 3) Örneklem — alan alan karşılaştırma
  const ornek = dosyaItems.slice(0, 50);
  let uyusmaz = 0;
  for (const u of ornek) {
    const doc = await col.findOne({ userId: normId(u.userId) });
    if (!doc) { uyusmaz++; continue; }
    for (const alan of ["country", "mainTeam", "nickname", "preferredLang"]) {
      const a = u[alan] ?? null, b = doc[alan] ?? null;
      if (JSON.stringify(a) !== JSON.stringify(b)) { uyusmaz++; break; }
    }
  }
  not(`orneklem: ${ornek.length} kayit, ${uyusmaz} uyusmazlik`);
  if (uyusmaz) sorunlar.push(`${uyusmaz} kayitta alan uyusmazligi`);

  // 4) Takma ad benzersizlik alanı — asıl sorgu yolu
  // nicknameNorm yazılmamışsa çakışma kontrolü HATA VERMEDEN boş döner.
  const takmaAdli = dosyaItems.filter((u) => u.nickname).length;
  const normluMongo = await col.countDocuments({ nicknameNorm: { $exists: true, $ne: null } });
  not(`takma ad: dosyada ${takmaAdli} · mongo'da normalize ${normluMongo}`);
  if (takmaAdli > 0 && normluMongo < takmaAdli) {
    sorunlar.push(`nicknameNorm eksik (${normluMongo} < ${takmaAdli}) — cakisma kontrolu sessizce kacirir`);
  }

  // 5) Gerçek sorgu yolu: bir takma adı indeksten bulabiliyor muyuz
  const ornekNick = dosyaItems.find((u) => u.nickname);
  if (ornekNick) {
    const bulundu = await col.findOne({ nicknameNorm: normNick(ornekNick.nickname) });
    not(`sorgu sinavi: "${ornekNick.nickname}" -> ${bulundu ? "bulundu" : "BULUNAMADI"}`);
    if (!bulundu) sorunlar.push("nicknameNorm sorgusu calismiyor");
  }

  // 6) Ülke alanı — sıralamanın dayandığı veri
  const ulkeli = await col.countDocuments({ country: { $exists: true, $ne: null } });
  not(`ulkesi olan: ${ulkeli}/${mongoSayi}`);

  // 7) userIdLower — SIRALAMANIN ülke sorgusu bu alandan gidiyor.
  // Eksikse sorgu hata vermeden boş döner ve TÜM insanlar ülkesiz görünür.
  const lowerVar = await col.countDocuments({ userIdLower: { $exists: true, $ne: null } });
  not(`userIdLower olan: ${lowerVar}/${mongoSayi}`);
  if (mongoSayi > 0 && lowerVar < mongoSayi) {
    sorunlar.push(`userIdLower eksik (${lowerVar} < ${mongoSayi}) — ulke siralamasi bos doner`);
  }

  // 8) Asıl sorgu yolu: karışık harfli bir kimliği küçük harfle bulabiliyor muyuz
  const ornekKullanici = dosyaItems[0];
  if (ornekKullanici) {
    const bulundu = await col.findOne({ userIdLower: normId(ornekKullanici.userId).toLowerCase() });
    not(`ulke sorgu sinavi: ${bulundu ? "bulundu" : "BULUNAMADI"}`);
    if (!bulundu) sorunlar.push("userIdLower sorgusu calismiyor — siralama ulke gosteremez");
  }

  console.log("");
  if (sorunlar.length) {
    console.log("SONUC: NO-GO");
    sorunlar.forEach((s) => console.log("  ✗ " + s));
    return false;
  }
  console.log("SONUC: GO");
  return true;
}

(async () => {
  const { getDb } = require("../lib/mongo.cjs");
  const db = await getDb({ force: true });
  if (!db) {
    console.error("[migrate] MongoDB baglantisi yok — MONGODB_URI kontrol edin.");
    process.exit(1);
  }

  const { items, hata } = await dosyadanOku();
  if (hata === "DOSYA_YOK") {
    console.log(`[migrate] ${FILE} yok — aktarilacak veri yok.`);
    console.log("[migrate] Bu NORMAL olabilir: Render'da kalici disk yoksa dosya");
    console.log("          zaten her deploy'da siliniyordu. Mongo tarafi dogrulaniyor...");
  } else if (hata) {
    console.error("[migrate] dosya okunamadi:", hata);
    process.exit(1);
  }

  // --verify SALT DENETİM: indeks kurma. Aksi halde eksik indeksi sessizce
  // yaratıp "GO" derdi — doğrulamanın yakalaması gereken şeyi onarmış olurdu
  // (sabotaj testinde tam olarak bu yaşandı).
  if (!YALNIZ_DOGRULA) await indeksler(db);

  if (!YALNIZ_DOGRULA && items.length) {
    console.log(`[migrate] ${items.length} kullanici aktariliyor${KURU ? " (KURU CALISMA)" : ""}...`);
    await aktar(db, items);
  }

  const ok = await dogrula(db, items);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("[migrate] HATA:", e?.message || e);
  process.exit(1);
});
