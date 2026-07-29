"use strict";

/**
 * SEZON — sıralamanın zaman penceresi.
 *
 * NEDEN VAR (bkz. docs/ekonomi-tasarim.md §3.2): kümülatif tek bir tablo
 * zamanla kopuyor. İki ay önce başlayan oyuncu erişilemez bir toplama ulaşıyor,
 * yeni gelen "zaten geçemem" diyor. Sezon üç şey sağlıyor:
 *   • tazelik — her sezon herkes eşit başlar
 *   • anlatı  — "bu sezon 3.'yüm"
 *   • bayat zirvenin temizlenmesi
 *
 * KARAR: AYLIK. Üç aylık da desteklenir (SKORLIG_SEASON_LENGTH=quarter).
 * Gerekçe: oyuncu havuzu küçükken sık tazelik daha canlı bir tablo veriyor;
 * ayrıca sezonu sonradan UZATMAK, kısaltmaktan kolay (kısaltmak yarım kalmış
 * sezonları böler).
 *
 * ⚠️ ANAHTAR SIRALANABİLİR OLMALI: "2026-07" < "2026-08" karşılaştırması
 * doğrudan çalışsın diye sıfır dolgulu. Arşiv sorguları bunu kullanıyor.
 *
 * ⚠️ ZAMAN DİLİMİ: sezon sınırı Europe/Istanbul'a göre hesaplanır. Sunucu UTC
 * çalışıyor (Render) ve `getMonth()` kullanmak ayın ilk/son gününde sezonu
 * 3 saat kaydırırdı — aynı hata fikstür filtresinde yaşandı.
 */

const TZ = process.env.SKORLIG_TZ || "Europe/Istanbul";

/** "month" (varsayılan) | "quarter" */
const LENGTH = String(process.env.SKORLIG_SEASON_LENGTH || "month").toLowerCase();

/** Yerel (TZ) yıl/ay döndürür — sunucu saat diliminden bağımsız. */
function yerelParcalar(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, g] = f.format(d).split("-").map(Number);
  return { yil: y, ay: m, gun: g };
}

/**
 * Verilen anın sezon anahtarı.
 *   aylık    → "2026-07"
 *   üç aylık → "2026-Q3"
 */
function seasonKey(d = new Date()) {
  const { yil, ay } = yerelParcalar(d);
  if (LENGTH === "quarter") {
    return `${yil}-Q${Math.floor((ay - 1) / 3) + 1}`;
  }
  return `${yil}-${String(ay).padStart(2, "0")}`;
}

/** Bir önceki sezonun anahtarı (arşiv bağlantısı için). */
function previousKey(key = seasonKey()) {
  const s = String(key);
  const q = s.match(/^(\d{4})-Q([1-4])$/);
  if (q) {
    const yil = Number(q[1]);
    const ceyrek = Number(q[2]);
    return ceyrek === 1 ? `${yil - 1}-Q4` : `${yil}-Q${ceyrek - 1}`;
  }
  const m = s.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const yil = Number(m[1]);
  const ay = Number(m[2]);
  return ay === 1 ? `${yil - 1}-12` : `${yil}-${String(ay - 1).padStart(2, "0")}`;
}

/** Anahtar biçimi geçerli mi (istemciden gelen `?season=` için). */
function isValidKey(key) {
  const s = String(key || "");
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) || /^\d{4}-Q[1-4]$/.test(s);
}

/** İnsan okunur etiket: "Temmuz 2026" / "2026 3. çeyrek". */
function label(key = seasonKey()) {
  const s = String(key);
  const q = s.match(/^(\d{4})-Q([1-4])$/);
  if (q) return `${q[1]} ${q[2]}. çeyrek`;
  const m = s.match(/^(\d{4})-(\d{2})$/);
  if (!m) return s;
  const aylar = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
  return `${aylar[Number(m[2]) - 1]} ${m[1]}`;
}

module.exports = { seasonKey, previousKey, isValidKey, label, LENGTH, TZ };
