"use strict";

/**
 * SEGMENT → ÜLKE — bot kadrosunun coğrafi karşılığı.
 *
 * NEDEN VAR: bot-profiles.json'da her botun bir `segment` kodu var (GS, ENG,
 * ESP...) ama ülkesi yok. Ülke sıralaması ("kendi ülkende yarış") botların da
 * bir ülkeye ait olmasını gerektiriyor — yoksa Portekizli kullanıcı kendi
 * listesinde tek başına kalır.
 *
 * Buradaki ülke adları `routes/live2.cjs` içindeki ALLOWED anahtarlarıyla
 * BİREBİR aynı olmalı; kullanıcıların `users.json` içindeki `country` alanı da
 * canonicalCountry() üzerinden aynı yazımı üretir. Üçü eşleşmezse ülke
 * sıralaması sessizce boş döner.
 *
 * GLB (Global XI) bilerek ülkesizdir: dünya seçmesi taraftarının tek bir ülke
 * ligine yazılması yanlış olurdu. Küresel sıralamada görünür, ülke
 * sıralamasında görünmez.
 */

const SEGMENT_COUNTRY = {
  GS:  "Türkiye",
  TR:  "Türkiye",
  ENG: "England",
  ESP: "Spain",
  ITA: "Italy",
  GER: "Germany",
  FRA: "France",
  NED: "Netherlands",
  BEL: "Belgium",
  POR: "Portugal",
  ARG: "Argentina",

  // Aşağıdakiler global genişleme ile eklendi.
  JPN: "Japan",
  BRA: "Brazil",
  USA: "USA",
  MEX: "Mexico",
  SAU: "Saudi Arabia",
  GRE: "Greece",
  RUS: "Russia",
  POL: "Poland",

  GLB: null, // ülkesiz — sadece küresel sıralamada
};

/** Bir segment kodunun ülkesi (yoksa null). */
function countryOfSegment(segment) {
  const s = String(segment || "").trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(SEGMENT_COUNTRY, s)
    ? SEGMENT_COUNTRY[s]
    : null;
}

/** Bir ülkeye ait segment kodları (ülke sıralamasında kimler görünecek). */
function segmentsOfCountry(country) {
  const c = String(country || "").trim();
  if (!c) return [];
  return Object.keys(SEGMENT_COUNTRY).filter((k) => SEGMENT_COUNTRY[k] === c);
}

module.exports = { SEGMENT_COUNTRY, countryOfSegment, segmentsOfCountry };
