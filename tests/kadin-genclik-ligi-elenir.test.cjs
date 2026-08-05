"use strict";

/**
 * KADIN VE GENÇLİK LİGLERİ YEREL ADLARIYLA DA ELENİR.
 *
 * ⚠️ BULUNAN: `lib/global-leagues.cjs EXCLUDED_LEAGUES` kadın liglerini
 * yalnızca İngilizce (`women`, `w.league`) ve Türkçe (`kadınlar`) adlarla
 * eliyordu. `lib/fixture-priority.cjs` başlığındaki ürün kararı ise net:
 * "Tek istisna: kadın/gençlik/yedek ligler elenmeye devam eder".
 *
 * ÖLÇÜLDÜ (gerçek veri: data/fixtures.json + data/livescore-cache.json,
 * 199 tekil lig adı) — üç kadın ligi süzgeçten KAÇIYORDU:
 *     Damallsvenskan        (İsveç)   8 maç
 *     Liga MX Femenil       (Meksika) 1 maç
 *     1. Division Kvinner   (Norveç)  2 maç
 * Toplam 11 maç havuza giriyordu. Düzeltmeden sonra üçü de eleniyor.
 *
 * ⚠️ FAZLA ELEME TEHLİKESİ GERÇEKTİ ve ölçerek kaçındım:
 *   • `damer` sözcük sınırsız yazılsaydı "SUDAMERICANA" elenirdi (3 maç).
 *   • `\bii\b` gibi bir kalıp "Liga II", "NB II", "II Liga" gibi ERKEK
 *     ikinci liglerini elerdi (18 maç) — onlar kalmalı.
 * Her yeni kalıp 199 gerçek lig adına karşı denendi: tam olarak üç lig
 * eleniyor, başka hiçbiri etkilenmiyor.
 *
 * ⚠️ İKİ KALIP İLERİYE DÖNÜK: `sub-\d\d` (İspanyolca/Portekizce gençlik) ve
 * `primavera` (İtalyan U19) ölçüm anındaki veride hiçbir lige denk gelmedi.
 * Abartmıyorum — bugün sıfır etkileri var.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { isExcludedLeague, isGlobalLeagueName } = require("../lib/global-leagues.cjs");
const { isAcceptableFixture } = require("../lib/fixture-priority.cjs");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("süzgeç zaten çalışan adları eliyor", () => {
    for (const ad of ["NWSL Kadınlar", "UEFA Women's Champions League", "CONCACAF U20", "MLS Next Pro"]) {
      assert.equal(isExcludedLeague(ad), true, `${ad} elenmiyor — suzgec hic calismiyor`);
    }
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("yerel adlı kadın ligleri", () => {
  const KADIN = [
    "Damallsvenskan",          // İsveç
    "Liga MX Femenil",         // Meksika
    "1. Division Kvinner",     // Norveç
    "Frauen-Bundesliga",       // Almanya
    "Division 1 Féminine",     // Fransa
    "Serie A Femminile",       // İtalya
    "Naisten Liiga",           // Finlandiya
    "Toppserien Damer",        // Norveç
  ];

  for (const ad of KADIN) {
    test(`"${ad}" eleniyor`, () => {
      assert.equal(isExcludedLeague(ad), true, `${ad} havuza giriyor — urun karari cignendi`);
    });
  }

  test("elenen lig havuza KABUL EDİLMİYOR (uçtan uca)", () => {
    // `isAcceptableFixture` gerçek kapı; süzgeç ona bağlı olmasa boşa çalışırdı.
    const mac = { home: "A", away: "B", league: "Damallsvenskan", country: "Sweden" };
    assert.equal(isAcceptableFixture(mac), false, "elenen lig hala havuza giriyor");
  });

  test("kadın küresel turnuvası KÜRESEL sayılmıyor", () => {
    assert.equal(isGlobalLeagueName("UEFA Women's Champions League"), false);
  });
});

describe("gençlik ligleri", () => {
  for (const ad of ["Sub-20 Brasileiro", "Campionato Primavera 1", "U19 Bundesliga", "Youth League"]) {
    test(`"${ad}" eleniyor`, () => {
      assert.equal(isExcludedLeague(ad), true);
    });
  }
});

/* ── Fazla eleme yok ─────────────────────────────────────────────────────── */

describe("meşru ligler ELENMİYOR", () => {
  /**
   * ⚠️ Bu blok düzeltmenin bedelini ölçüyor. Kadın ligi kalıpları gevşek
   * yazılırsa erkek ligleri de gider ve ekran boşalır — dosya başlığındaki
   * "her katman tek başına makul, üst üste binince ekran boşalıyor" tuzağı.
   */
  const MESRU = [
    "Sudamericana",            // `damer` sınırsız olsaydı elenirdi
    "Copa Sudamericana",
    "Liga II", "NB II", "II Liga",   // erkek ikinci ligleri
    "Premier League", "Süper Lig", "Serie A", "Bundesliga",
    "Brasileiro Serie B", "Primeira Liga", "Eredivisie",
  ];

  for (const ad of MESRU) {
    test(`"${ad}" elenmiyor`, () => {
      assert.equal(isExcludedLeague(ad), false, `${ad} yanlislikla elendi — ekran boşalir`);
    });
  }
});

/* ── Gerçek veriyle ──────────────────────────────────────────────────────── */

test("gerçek fikstürlerde eleme oranı makul", (t) => {
  /**
   * ⚠️ TAM SAYI DONDURULMUYOR: veri değiştikçe oran değişir. Ölçüm anında
   * 1453 maçın 10'u eleniyordu (%0.7). Aralık iki yönlü — sıfıra düşerse
   * süzgeç ölmüş, çok yükselirse meşru ligler gidiyor demektir.
   */
  const dosya = require("./_gercek-veri.cjs").veriYolu("fixtures.json");
  if (!fs.existsSync(dosya)) return t.skip("fikstur verisi yok");
  const items = (JSON.parse(fs.readFileSync(dosya, "utf8")).fixtures || []).filter((f) => f?.league);
  if (items.length < 100) return t.skip("yeterli fikstur yok");

  const elenen = items.filter((f) => isExcludedLeague(f.league)).length;
  const oran = elenen / items.length;
  assert.ok(elenen > 0, "hicbir mac elenmiyor — suzgec veriye hic denk gelmiyor olabilir");
  assert.ok(
    oran < 0.15,
    `maclarin %${(100 * oran).toFixed(1)}'i eleniyor — olcum aninda %0.7 idi, fazla eleme var`
  );
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: 'damer' sözcük sınırıyla yazılı", () => {
  /**
   * Sınırsız yazım Sudamericana'yı eler; bu tam olarak eklerken kaçındığım
   * hata ve regex bir gün "sadeleştirilirse" sessizce geri gelir.
   */
  const src = fs.readFileSync(path.join(KOK, "lib", "global-leagues.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
  assert.ok(/\/\\bdamer\\b\/i/.test(src), "damer kalibi sozcuk siniri olmadan yazilmis");
});
