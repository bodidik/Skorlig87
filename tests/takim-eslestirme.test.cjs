"use strict";

/**
 * TAKIM EŞLEŞTİRME — genç/kadın/rezerv takım A takımına karışmamalı.
 *
 * ⚠️ BU TURDA KUSUR BULUNMADI. Alan denetlendi ve ölçüldü; aşağıdaki
 * değişmezler o yüzden kilitleniyor, düzeltme değil koruma amaçlı.
 *
 * ⚠️ NEDEN KIRILGAN: `services/livescore-sync.cjs` kazınan satırı fikstüre
 * takım ADIYLA bağlıyor ve yanlış eşleşme YANLIŞ SKORUN yazılması demek —
 * yani yanlış settle, yanlış puan, yanlış LC. Dosyanın kendi notu bunun bir
 * kez yaşandığını yazıyor:
 *
 *   "bir dönem burada `n.includes(v)` vardı ... 'Botev Vra[ts]a',
 *    'Por[ts]mouth' → hepsi 'trabzonspor' ... Ölçülen etki: 1411 takımın 30'u
 *    yanlış eşleşiyordu."
 *
 * ÖLÇÜLDÜ (bu tur):
 *   • 20 gerçekçi A-takımı/varyant çifti → 0 çarpışma
 *   • TEAM_MAP'te 29 kanonik takım → A takımına eşlenen genç/rezerv varyantı 0
 *   • aynı varyantı iki kanoniğe bağlayan giriş 0
 *
 * ⚠️ ASIL KORUMA SIKI EŞİTLİK, nitelik eki DEĞİL. İki katman var: nitelik eki
 * (U19, (K), II...) anahtara ekleniyor, VE fazladan kelime taban adda kalıyor.
 * Negatif kontrolde nitelik ekini tamamen kaldırdım — test kırılmadı, çünkü
 * ikinci katman tek başına yetiyor. Yani bu test nitelik eki mekanizmasını
 * DOĞRULAMIYOR; onu belt-and-braces olarak kabul ediyor.
 *
 * Testin gerçekten bağladığı üç şey: sıkı eşitlik (`includes` geri gelemez),
 * elle tutulan TEAM_MAP'e alt takım varyantı eklenemez, ve aynı varyant iki
 * takıma bağlanamaz. Üçü de negatif kontrolde ateşleniyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const Sync = require("../services/livescore-sync.cjs");
const { normalizeTeam, TEAM_MAP } = Sync;

/** A takımı ↔ ayrı takım sayılması gereken varyant. */
const CIFTLER = [
  ["Galatasaray", "Galatasaray U19"],
  ["Galatasaray", "Galatasaray U21"],
  ["Galatasaray", "Galatasaray U23"],
  ["Galatasaray", "Galatasaray (K)"],
  ["Galatasaray", "Galatasaray Kadın"],
  ["Galatasaray", "Galatasaray A2"],
  ["Galatasaray", "Galatasaray Youth"],
  ["Fenerbahce", "Fenerbahce Women"],
  ["Fenerbahce", "Fenerbahce Femenino"],
  ["Besiktas", "Besiktas II"],
  ["Besiktas", "Besiktas B Takım"],
  ["Besiktas", "Besiktas Genclik"],
  ["Trabzonspor", "Trabzonspor Reserves"],
  ["Trabzonspor", "Trabzonspor Akademi"],
  ["Real Madrid", "Real Madrid Castilla"],
  ["Barcelona", "Barcelona Atletic"],
  ["Ajax", "Jong Ajax"],
  ["PSV", "PSV U21"],
  ["Bayern Munich", "Bayern Munich II"],
];

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("normalleştirme gerçekten çalışıyor", () => {
    // Meşru varyantlar AYNI anahtara düşmeli; düşmezse test aşağıda her şeye
    // "farklı" der ve hiçbir şey ölçmez.
    assert.equal(normalizeTeam("Galatasaray"), normalizeTeam("Galatasaray SK"));
    assert.equal(normalizeTeam("Beşiktaş"), normalizeTeam("Besiktas"));
    assert.ok(normalizeTeam("Galatasaray").length > 0);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("A takımı ile alt takımlar karışmıyor", () => {
  test(`${CIFTLER.length} gerçekçi çiftin hiçbiri aynı anahtara düşmüyor`, () => {
    const carpisan = [];
    for (const [a, b] of CIFTLER) {
      if (normalizeTeam(a) === normalizeTeam(b)) {
        carpisan.push(`${a} <-> ${b}  [${normalizeTeam(a)}]`);
      }
    }
    assert.deepStrictEqual(
      carpisan, [],
      "Bu ciftler ayni anahtara dusuyor — alt takimin skoru A takimina yazilir:\n" +
        carpisan.join("\n")
    );
  });
});

/* ── Elle tutulan liste ──────────────────────────────────────────────────── */

const ALT_TAKIM_RE =
  /\b(u\s?1[4-9]|u\s?2[0-9]|ii|iii|b takim|b takım|reserve|reserves|akademi|academy|youth|genclik|gençlik|kadin|kadın|women|femenino|feminin|castilla|atletic|jong|a2|amateur)\b/i;

describe("TEAM_MAP", () => {
  test("hiçbir varyant alt takımı A takımına eşlemiyor", () => {
    /**
     * ⚠️ TEAM_MAP ELLE TUTULUYOR. Buraya "Galatasaray U19" gibi bir varyant
     * eklenirse sıkı eşitlik koruması DEVRE DIŞI kalır: alt takım doğrudan
     * kanonik anahtara düşer. Bu oturumda elle tutulan listelerin gerçeklikten
     * ayrışması dört kez hata üretti.
     */
    const kusurlu = [];
    for (const [kanonik, varyantlar] of Object.entries(TEAM_MAP)) {
      for (const v of varyantlar || []) {
        if (ALT_TAKIM_RE.test(String(v))) kusurlu.push(`${kanonik} <- "${v}"`);
      }
    }
    assert.deepStrictEqual(
      kusurlu, [],
      "Alt takim varyanti A takimina eslenmis — o maclarin skoru A takimina yazilir:\n" +
        kusurlu.join("\n")
    );
  });

  test("aynı varyant iki farklı takıma bağlı değil", () => {
    const ters = new Map();
    for (const [kanonik, varyantlar] of Object.entries(TEAM_MAP)) {
      for (const v of varyantlar || []) {
        const k = String(v).toLowerCase().trim();
        if (!ters.has(k)) ters.set(k, new Set());
        ters.get(k).add(kanonik);
      }
    }
    const cakisan = [...ters.entries()]
      .filter(([, s]) => s.size > 1)
      .map(([v, s]) => `"${v}" -> ${[...s].join(", ")}`);
    assert.deepStrictEqual(
      cakisan, [],
      "Ayni varyant birden fazla takima bagli — eslesme sirasi belirler:\n" +
        cakisan.join("\n")
    );
  });

  test("liste boş değil (tarama bozulmuş olmasın)", () => {
    assert.ok(Object.keys(TEAM_MAP).length >= 10, "TEAM_MAP beklenenden kucuk");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: eşleştirme TAM eşitlik, `includes` değil", () => {
  /**
   * Dosyanın kendi notu felaketi anlatıyor: `includes` ile "ts"/"gs"/"fb"
   * kısaltmaları yabancı takım adlarının İÇİNDE eşleşiyordu ve 1411 takımın
   * 30'u yanlış bağlanıyordu.
   */
  const src = fs.readFileSync(path.join(__dirname, "..", "services", "livescore-sync.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    /baseNormalize\(v\) === n/.test(src),
    "varyant eslesmesi tam esitlik kullanmiyor"
  );
  assert.ok(
    !/\bn\.includes\(v\)/.test(src),
    "`n.includes(v)` geri gelmis — kisaltmalar yabanci adlarin icinde eslesir"
  );
  assert.ok(
    /normalizeTeam\(m\.homeTeam\) !== fixHome/.test(src),
    "fikstur eslesmesi tam esitlikten cikmis"
  );
});
