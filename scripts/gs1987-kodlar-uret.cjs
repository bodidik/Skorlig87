#!/usr/bin/env node
/**
 * 1987 grup kodlarını oluştur: 50 kod, her biri 2 kişiye
 *
 * Kullanım:
 *   node scripts/gs1987-kodlar-uret.cjs
 *
 * Çıktı: gs1987-kodlar-[TIMESTAMP].txt (dağıtımda kullan)
 */
"use strict";

require("dotenv").config();
const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/skorlig";
const DB_NAME = "skorlig";
const COLL = "invite_codes_1987";

const ADET = 50;
const MAX_USES = 2;

// 11 karakter, uppercase (rate limit saydığı kadarı)
function kodUret() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let kod = "";
  for (let i = 0; i < 11; i++) {
    kod += chars[Math.floor(Math.random() * chars.length)];
  }
  return kod;
}

async function main() {
  let client;
  try {
    console.log("[gs1987-kodlar-uret] Başlıyor...");
    console.log(`  Adet: ${ADET}`);
    console.log(`  Her biri: ${MAX_USES} kullanıcı`);

    client = await MongoClient.connect(MONGODB_URI);
    const db = client.db(DB_NAME);
    const col = db.collection(COLL);

    // Benzersiz kodlar oluştur
    const kodlar = [];
    const mevcutKodlar = new Set();
    const mevcutBelgeler = await col.find({}).project({ code: 1 }).toArray();
    mevcutBelgeler.forEach((d) => mevcutKodlar.add(d.code));

    while (kodlar.length < ADET) {
      const kod = kodUret();
      if (!mevcutKodlar.has(kod) && !kodlar.includes(kod)) {
        kodlar.push(kod);
      }
    }

    // MongoDB'ye ekle
    const belgeler = kodlar.map((kod) => ({
      code: kod,
      codeNorm: kod, // lowercase: kod.toLowerCase(), uppercase: kod
      label: `1987-grup-${String(kodlar.indexOf(kod) + 1).padStart(3, "0")}`,
      maxUses: MAX_USES,
      used: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
    }));

    const sonuc = await col.insertMany(belgeler);
    console.log(`✓ ${sonuc.insertedCount} kod oluşturuldu`);

    // TXT dosyasına yaz (dağıtımda kolay olsun)
    const timestamp = new Date().toISOString().slice(0, 10);
    const dosyaAdi = `gs1987-kodlar-${timestamp}.txt`;
    const metni = [
      "SkorLig 1987 Grup Kodları",
      "=" + "=".repeat(29),
      `Oluşturulma: ${new Date().toLocaleString("tr-TR")}`,
      `Toplam: ${ADET} kod`,
      `Kapasite: Her kod ${MAX_USES} kişiye`,
      "",
      "Kodlar (her biri WhatsApp grubu mesajı olarak dağıt):",
      "-" + "-".repeat(49),
      kodlar.join("\n"),
      "",
      "Kontrol:",
      `  curl -s "https://skorlig87.onrender.com/api/auth1987gs/diag?token=ADMIN_TOKEN" | jq .`,
    ].join("\n");

    fs.writeFileSync(dosyaAdi, metni, "utf8");
    console.log(`✓ Kodlar kaydedildi: ${dosyaAdi}`);
    console.log(`\nKodları WhatsApp grubuna yapıştır (her mesajda bir veya birkaç kod).`);
  } catch (e) {
    console.error("[gs1987-kodlar-uret] Hata:", e?.message || e);
    process.exit(1);
  } finally {
    if (client) await client.close();
  }
}

main();
