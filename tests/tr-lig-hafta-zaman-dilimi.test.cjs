"use strict";

/**
 * TR LİGİ HAFTA HESABI TEK ZAMAN DİLİMİNDE OLMALI (Europe/Istanbul).
 *
 * ⚠️ BULUNAN: `routes/tr-league.cjs` iki zaman dilimini karıştırıyordu.
 * `collectFixtures` sağlayıcıya sorulacak günleri Europe/Istanbul'a göre
 * sayıyor, ama `isoWeekKey` ve `weekRange` haftayı SAF UTC ile hesaplıyordu
 * (`getUTCFullYear`, `Date.UTC`). Türkiye yıl boyu UTC+3; 21:00Z ve sonrası
 * Istanbul'da ZATEN ertesi gün. Aynı an, iki cevap:
 *
 *     2026-08-02T21:00:00Z → Istanbul Pzt 00:00 → UTC 2026-W31 / IST 2026-W32
 *     2026-08-09T21:15:00Z → Istanbul Pzt 00:15 → UTC 2026-W32 / IST 2026-W33
 *
 * Sonuç: geç pazar maçı BİR ÖNCEKİ haftaya gruplanıyor, yanlış haftalık
 * sıralamada sayılıyor ve yanlış haftanın ödülüne (`WEEKLY_REWARDS`) giriyordu.
 * `weekRange` de pazartesi 00:00Z (= Istanbul 03:00) döndürdüğü için hafta
 * kullanıcıya üç saat geç dönüyordu.
 *
 * Bug bulunduğunda UYUYORDU: `data/fixtures.json` içindeki 21:00Z sonrası 161
 * başlama saatinin hepsi Brezilya/Paraguay, yani `isTrLeagueFixture`
 * filtresinin dışında. Bu test uyanmasını engelliyor.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const trLeague = require("../routes/tr-league.cjs");
const { _isoWeekKey: isoWeekKey, _weekRange: weekRange, _tzGunAnahtari: gunAnahtari, _TZ: TZ } =
  trLeague;

/** Referans: bağımsız hesap — anı Istanbul takvimine çevirip ISO hafta bulur. */
function istanbulHaftasi(iso) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(iso))
    .split("-")
    .map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const gun = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - gun);
  const yilBasi = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const no = Math.ceil(((t - yilBasi) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(no).padStart(2, "0")}`;
}

/** UTC hesabı — düzeltmeden ÖNCEKİ davranış; negatif kontrol için. */
function utcHaftasi(iso) {
  const d = new Date(iso);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const gun = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - gun);
  const yilBasi = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const no = Math.ceil(((t - yilBasi) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(no).padStart(2, "0")}`;
}

// ÖLÇÜLDÜ: bu üç an için UTC ve Istanbul FARKLI hafta veriyor.
const GEC_PAZAR = [
  { iso: "2026-08-02T21:00:00Z", utc: "2026-W31", ist: "2026-W32" },
  { iso: "2026-08-02T22:30:00Z", utc: "2026-W31", ist: "2026-W32" },
  { iso: "2026-08-09T21:15:00Z", utc: "2026-W32", ist: "2026-W33" },
];

test("21:00Z ve sonrasi pazar maci ISTANBUL haftasina dusuyor", () => {
  for (const { iso, ist } of GEC_PAZAR) {
    assert.strictEqual(isoWeekKey(iso), ist, `${iso} Istanbul haftasina dusmeli`);
  }
});

test("NEGATIF KONTROL: bu anlar gercekten ayrisiyor (test kendini kandirmiyor)", () => {
  for (const { iso, utc, ist } of GEC_PAZAR) {
    assert.notStrictEqual(utc, ist, `${iso} icin iki hesap ayni cikiyorsa ornek ise yaramaz`);
    assert.strictEqual(utcHaftasi(iso), utc, "eski UTC davranisi bu ornekte gercekten farkli");
    assert.notStrictEqual(isoWeekKey(iso), utc, `${iso} hala UTC haftasina dusuyor`);
  }
});

test("pazar 20:59Z hala AYNI haftada — sinir asiri kaydirilmadi", () => {
  // Istanbul'da 23:59 pazar: hafta değişmemeli.
  assert.strictEqual(isoWeekKey("2026-08-02T20:59:00Z"), "2026-W31");
  assert.strictEqual(isoWeekKey("2026-08-09T20:59:00Z"), "2026-W32");
});

test("genis tarama: her an icin bagimsiz Istanbul hesabiyla ayni sonuc", () => {
  // 2025-12-15'ten itibaren 120 gun, saat basi — yil sinirini da kapsar.
  const bas = Date.UTC(2025, 11, 15);
  for (let saat = 0; saat < 120 * 24; saat++) {
    const iso = new Date(bas + saat * 3600000).toISOString();
    assert.strictEqual(isoWeekKey(iso), istanbulHaftasi(iso), `hafta ayristi: ${iso}`);
  }
});

test("weekRange sinirlari Istanbul gece yarisi — 00:00Z degil", () => {
  const r = weekRange("2026-W32");
  // Istanbul'da pazartesi 00:00 = 2026-08-02T21:00:00Z (UTC+3)
  assert.strictEqual(new Date(r.fromMs).toISOString(), "2026-08-02T21:00:00.000Z");
  assert.strictEqual(new Date(r.toMs + 1).toISOString(), "2026-08-09T21:00:00.000Z");
  assert.strictEqual(r.fromISO, "2026-08-03");
  assert.strictEqual(r.toISO, "2026-08-09");
});

test("weekRange ile isoWeekKey AYNI sinirda anlasiyor", () => {
  // finalizeWeekIfDone haftanin bittigini weekRange.toMs ile olcuyor; gruplama
  // isoWeekKey ile yapiliyor. Ikisi ayrisirsa hafta yanlis anda kapanir.
  for (const wk of ["2026-W01", "2026-W31", "2026-W32", "2026-W33", "2026-W52"]) {
    const { fromMs, toMs } = weekRange(wk);
    assert.strictEqual(isoWeekKey(new Date(fromMs).toISOString()), wk, `${wk} baslangici`);
    assert.strictEqual(isoWeekKey(new Date(toMs).toISOString()), wk, `${wk} bitisi`);
    assert.notStrictEqual(isoWeekKey(new Date(fromMs - 1).toISOString()), wk, `${wk} oncesi`);
    assert.notStrictEqual(isoWeekKey(new Date(toMs + 1).toISOString()), wk, `${wk} sonrasi`);
  }
});

test("fikstur toplama ile hafta hesabi AYNI zaman dilimini kullaniyor", () => {
  assert.strictEqual(TZ, "Europe/Istanbul");

  // Gün anahtarı gerçekten Istanbul: 21:00Z zaten ertesi gün.
  assert.strictEqual(gunAnahtari(Date.parse("2026-08-02T21:00:00Z")), "2026-08-03");
  assert.strictEqual(gunAnahtari(Date.parse("2026-08-02T20:59:00Z")), "2026-08-02");

  // Toplanan gün, o anin haftasiyla tutarli olmalı (gün → hafta zinciri kopmasin).
  for (let saat = 0; saat < 30 * 24; saat++) {
    const ms = Date.UTC(2026, 6, 20) + saat * 3600000;
    const gun = gunAnahtari(ms);
    assert.strictEqual(
      isoWeekKey(new Date(ms).toISOString()),
      isoWeekKey(`${gun}T12:00:00Z`),
      `gun anahtari ${gun} ile hafta hesabi ayristi`
    );
  }

  // YAPISAL NÖBET: dosyada zaman dilimi tek yerde tanımlı olmalı. Ikinci bir
  // `Europe/Istanbul` (ya da baska bir timeZone) yazmak bu bugu geri getirir.
  const kaynak = fs.readFileSync(path.join(__dirname, "..", "routes", "tr-league.cjs"), "utf8");
  const tzSayisi = (kaynak.match(/"Europe\/Istanbul"/g) || []).length;
  assert.strictEqual(tzSayisi, 1, "zaman dilimi tek sabitte tanimli kalmali");
  const digerTz = kaynak.match(/timeZone:[ \t]*(?!TZ\b)\S/g) || [];
  assert.strictEqual(digerTz.length, 0, "timeZone yalnizca TZ sabitinden verilmeli");
  assert.ok(
    !/getUTCFullYear|getUTCMonth\(\)/.test(kaynak.split("function isoWeekKey(")[1].split("\n}")[0]),
    "isoWeekKey UTC alanlarina geri donmemeli"
  );
});
