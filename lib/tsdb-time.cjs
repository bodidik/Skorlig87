"use strict";

/**
 * TheSportsDB tarih/saat → ISO 8601.
 *
 * NEDEN AYRI: İki yerde (routes/fixtures.cjs, routes/live2.cjs) aynı satır
 * vardı ve ikisi de aynı hatayı yapıyordu:
 *
 *     `${dateEvent}T${strTime}:00Z`
 *
 * TSDB `strTime`'ı bazen `"22:00"`, bazen `"22:00:00"` döndürüyor. İkinci
 * durumda koşulsuz `:00` eklemek `22:00:00:00Z` üretiyordu — geçersiz ISO.
 * `Date.parse` NaN döner; maç sıralamada yanlış yere düşer ya da pencere
 * filtresinden sessizce elenir. Üretimde iki fikstürde görüldü.
 *
 * Hata vermez, yalnızca yanlış sıralanır — bu yüzden fark edilmesi zor.
 */

/**
 * @param {string} dateEvent  "2026-07-28"
 * @param {string} strTime    "22:00" | "22:00:00" | "22:00:00+00:00" | ""
 * @returns {string|null} ISO 8601 (UTC) ya da ayrıştırılamazsa null
 */
function tsdbKickoffISO(dateEvent, strTime) {
  const gun = String(dateEvent || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gun)) return null;

  const ham = String(strTime || "").trim();
  if (!ham) return `${gun}T00:00:00Z`;

  // Saat dilimi eki varsa at — TSDB saatleri zaten UTC.
  const saatsiz = ham.replace(/(?:Z|[+-]\d{2}:?\d{2})$/i, "").trim();

  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(saatsiz);
  if (!m) return null;

  const hh = String(Math.min(23, Number(m[1]))).padStart(2, "0");
  const mm = m[2];
  const ss = m[3] || "00";

  const iso = `${gun}T${hh}:${mm}:${ss}Z`;
  // Son kontrol: üretilen değer gerçekten ayrıştırılabiliyor mu.
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

module.exports = { tsdbKickoffISO };
