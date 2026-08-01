"use strict";

/**
 * TAKILI KALMIŞ "LIVE" FİKSTÜR KAYITLARINI KAPATIR.
 *
 * ⚠️ NEDEN GEREKLİ: `services/mackolik-fixture-sync.cjs` bitmiş maçları
 * BİLİNÇLİ olarak eliyor ("bitmiş maç yayınlama" ürün kararı). Yan etkisi
 * kapatılmamıştı: bir maç canlıyken `LIVE` yazılıyor, bittiğinde artık hiç
 * görülmediği için durumu O HÂLDE KALIYOR. Sonraki bir commit yeni biten
 * maçları kapatıyor ama ÖNBELLEKTEN ÇOKTAN DÜŞMÜŞ eski kayıtlara ulaşamıyor —
 * bu betik onlar için.
 *
 * ⚠️ SONUÇ UYDURMUYOR. Bir kayıt yalnızca `match_results` içinde GERÇEK bir
 * final skoru varsa `FT` yapılır; skor da eksikse oradan doldurulur. Sonucu
 * bilinmeyen kayda dokunulmaz — "bitti" demek, oynanmamış olabilecek bir maç
 * için sessiz bir yalan olurdu.
 *
 * ⚠️ HEDEFLİ YAZMA. `lib/fixtures-store.cjs saveAll` TAM DEĞİŞTİRME yapıyor
 * ve listede olmayan kaydı SİLİYOR. Bu betik onu kullanmaz; yalnızca uygun
 * kayıtlara `updateOne` atar ve yalnızca `status`/skor alanlarını yazar.
 *
 * ⚠️ VARSAYILAN KURU ÇALIŞMA. Yazmak için açıkça `--apply` gerekir.
 *
 * KULLANIM:
 *     node scripts/duzelt-takili-live.cjs                # kuru calisma
 *     node scripts/duzelt-takili-live.cjs --saat=6       # esik (varsayilan 6)
 *     node scripts/duzelt-takili-live.cjs --apply        # YAZAR
 *
 * ⚠️ ÇALIŞAN SUNUCUYU DURDUR. Arka plan senkronu aynı kayıtları yazıyor;
 * betik çalışırken sunucu açıksa yazmalar çakışabilir.
 */

require("dotenv").config({ quiet: true });

const path = require("path");
const fs = require("fs");

const APPLY = process.argv.includes("--apply");
const SAAT = (() => {
  const a = process.argv.find((x) => x.startsWith("--saat="));
  const n = a ? Number(a.split("=")[1]) : 6;
  return Number.isFinite(n) && n > 0 ? n : 6;
})();

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");

/**
 * İKİNCİ KANIT KAYNAĞI: `data/live/<fixtureId>.json` durum dosyaları.
 *
 * ⚠️ NEDEN GÜVENİLİR: `routes/settle2.cjs` maçın skorunu TAM BU DOSYADAN
 * okuyup parayı ona göre dağıtıyor. Yani "durum dosyası FT ve skor tam" demek,
 * ödeme zincirinin kanıt saydığı şeyin ta kendisi.
 *
 * ⚠️ YALNIZCA `FT`. Ölçüldü: kalan 83 kaydın 54'ünde durum dosyası var ama
 * 16'sında durum hâlâ `LIVE` — oradaki skor MAÇ ORTASI olabilir (ör.
 * "Gornik Zabrze 1-1 Fenerbahce", senkron durduğu andaki skor). Onu final
 * saymak yanlış skor yazmak olurdu. 38'i `FT` ve skoru tam; yalnızca onlar
 * kullanılıyor.
 */
function durumDosyasiSonuclari(idler) {
  const harita = new Map();
  const dizin = path.join(DATA_DIR, "live");
  for (const id of idler) {
    const p = path.join(dizin, String(id) + ".json");
    if (!fs.existsSync(p)) continue;
    try {
      const st = JSON.parse(fs.readFileSync(p, "utf8"));
      if (String(st?.status || "").toUpperCase() !== "FT") continue;
      if (!skorOk(st?.score)) continue;
      harita.set(String(id), st.score);
    } catch { /* bozuk dosya — yok say */ }
  }
  return harita;
}

/** Sonuç kaynağı: fixtureId → finalScore. Mongo varsa oradan, yoksa dosyadan. */
async function sonucHaritasi(db) {
  const harita = new Map();
  if (db) {
    try {
      const docs = await db.collection("match_results")
        .find({}, { projection: { fixtureId: 1, finalScore: 1, _id: 0 } }).toArray();
      for (const d of docs) if (d?.fixtureId) harita.set(String(d.fixtureId), d.finalScore);
      if (harita.size) return harita;
    } catch (e) {
      console.warn("[duzelt] match_results okunamadi:", e?.message || e);
    }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "match-results.json"), "utf8"));
    const arr = Array.isArray(raw) ? raw : raw.items || raw.results || [];
    for (const r of arr) if (r?.fixtureId) harita.set(String(r.fixtureId), r.finalScore);
  } catch { /* dosya yoksa sorun değil */ }
  return harita;
}

const skorOk = (s) =>
  s && Number.isFinite(Number(s.home)) && Number.isFinite(Number(s.away));

async function main() {
  let db = null;
  try {
    const { getDb } = require("../lib/mongo.cjs");
    db = await getDb();
  } catch (e) {
    console.warn("[duzelt] Mongo yok, dosya uzerinde calisilacak:", e?.message || e);
  }

  const FIX_FILE = path.join(DATA_DIR, "fixtures.json");
  let kayitlar = [];
  if (db) {
    kayitlar = await db.collection("fixtures").find({}).toArray();
  } else {
    const raw = JSON.parse(fs.readFileSync(FIX_FILE, "utf8"));
    kayitlar = raw.fixtures || raw.items || [];
  }

  const sonuclar = await sonucHaritasi(db);
  const simdi = Date.now();
  const sinir = SAAT * 3600 * 1000;

  // Önce eski LIVE kayıtları belirle, sonra ikinci kaynağı YALNIZCA onlar için oku.
  const eskiler = [];
  let live = 0;
  for (const f of kayitlar) {
    if (String(f?.status || "").toUpperCase() !== "LIVE") continue;
    live++;
    const ko = Date.parse(f.kickoffISO || f.kickoff || "");
    if (Number.isFinite(ko) && simdi - ko >= sinir) eskiler.push(f);
  }
  const durumSonuc = durumDosyasiSonuclari(eskiler.map((f) => f.fixtureId));

  const kapatilacak = [];
  const sonucsuz = [];
  let kaynakMR = 0, kaynakDurum = 0;

  for (const f of eskiler) {
    const id = String(f.fixtureId);
    const mr = sonuclar.get(id);
    if (skorOk(mr)) { kapatilacak.push({ f, skor: mr, kaynak: "match_results" }); kaynakMR++; continue; }
    const ds = durumSonuc.get(id);
    if (skorOk(ds)) { kapatilacak.push({ f, skor: ds, kaynak: "durum-dosyasi" }); kaynakDurum++; continue; }
    sonucsuz.push(f);
  }

  console.log(`kaynak            : ${db ? "MongoDB" : FIX_FILE}`);
  console.log(`toplam kayit      : ${kayitlar.length}`);
  console.log(`LIVE kayit        : ${live}`);
  console.log(`${SAAT} saatten eski   : ${kapatilacak.length + sonucsuz.length}`);
  console.log(`  sonucu BILINEN  : ${kapatilacak.length}  → FT yapilacak`);
  console.log(`     match_results : ${kaynakMR}`);
  console.log(`     durum dosyasi : ${kaynakDurum}  (yalnizca status=FT olanlar)`);
  console.log(`  sonucu bilinmeyen: ${sonucsuz.length}  → DOKUNULMAYACAK`);

  if (kapatilacak.length) {
    console.log("\nornek (ilk 5):");
    for (const { f, skor, kaynak } of kapatilacak.slice(0, 5)) {
      const yas = ((simdi - Date.parse(f.kickoffISO || f.kickoff)) / 3600000).toFixed(1);
      console.log(`   ${f.fixtureId}  ${f.home} - ${f.away}  ${skor.home}-${skor.away}  (${yas} saat once, ${kaynak})`);
    }
  }

  if (!APPLY) {
    console.log("\nKURU CALISMA — hicbir sey yazilmadi. Yazmak icin: --apply");
    return;
  }

  console.log("\n--apply verildi, yaziliyor...");
  let yazilan = 0;
  if (db) {
    const col = db.collection("fixtures");
    for (const { f, skor } of kapatilacak) {
      const alanlar = { status: "FT" };
      // Skoru YALNIZCA eksikse doldur; var olan skoru ezme.
      if (!skorOk(f.score)) alanlar.score = { home: Number(skor.home), away: Number(skor.away) };
      if (!Number.isFinite(Number(f.homeGoals))) alanlar.homeGoals = Number(skor.home);
      if (!Number.isFinite(Number(f.awayGoals))) alanlar.awayGoals = Number(skor.away);
      alanlar.statusFixedAt = new Date().toISOString();
      alanlar.statusFixedBy = "duzelt-takili-live";

      // ⚠️ KOSUL YAZMANIN ICINDE: arada senkron kaydi degistirdiyse dokunma.
      const r = await col.updateOne(
        { fixtureId: String(f.fixtureId), status: "LIVE" },
        { $set: alanlar }
      );
      if (r.modifiedCount) yazilan++;
    }
  } else {
    const { writeJsonAtomic } = require("../lib/fileLock.cjs");
    const raw = JSON.parse(fs.readFileSync(FIX_FILE, "utf8"));
    const liste = raw.fixtures || raw.items || [];
    const hedef = new Map(kapatilacak.map(({ f, skor }) => [String(f.fixtureId), skor]));
    for (const f of liste) {
      const skor = hedef.get(String(f.fixtureId));
      if (!skor || String(f.status || "").toUpperCase() !== "LIVE") continue;
      f.status = "FT";
      if (!skorOk(f.score)) f.score = { home: Number(skor.home), away: Number(skor.away) };
      if (!Number.isFinite(Number(f.homeGoals))) f.homeGoals = Number(skor.home);
      if (!Number.isFinite(Number(f.awayGoals))) f.awayGoals = Number(skor.away);
      f.statusFixedAt = new Date().toISOString();
      f.statusFixedBy = "duzelt-takili-live";
      yazilan++;
    }
    await writeJsonAtomic(FIX_FILE, raw);
  }

  console.log(`YAZILDI: ${yazilan} kayit FT yapildi.`);
  if (sonucsuz.length) {
    console.log(`${sonucsuz.length} kayit sonucu bilinmedigi icin LIVE birakildi.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("[duzelt] hata:", e); process.exit(1); });
