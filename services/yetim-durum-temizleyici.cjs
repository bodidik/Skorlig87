"use strict";

/**
 * YETİM CANLI DURUM DOSYASI TEMİZLEYİCİ.
 *
 * ⚠️ NEDEN VAR: `data/live/<fixtureId>.json` durum dosyaları, fikstür deposu
 * kaydı silindikten sonra da diskte kalıyor. Fikstür deposu TAM DEĞİŞTİRME
 * semantiğiyle çalışıyor (`FixturesStore.saveAll` listede olmayanı siler),
 * yani eski maçlar listeden düştükçe durum dosyaları artık olarak birikiyor.
 * Silen hiçbir şey yoktu — `bayat-temizleyici` yalnızca PARA iadesiyle
 * ilgileniyor, dosyalara dokunmuyor.
 *
 * ÖLÇÜLDÜ (üretim, 2026-08-02): 1403 durum dosyasının **305'i yetim** (%22).
 * Doğrulandı: 305'inin HİÇBİRİNDE Mongo `fixtures` kaydı yok — yani okuma
 * hatası değil, gerçekten sahipsiz. 73'ü uzlaşmış (`match_results` kaydı var).
 * Yaş: <1gün 43 · 1-7gün 193 · 7-30gün 60 · 30gün+ 9.
 *
 * ⚠️ EN BÜYÜK TEHLİKE BURADA: "fikstür listesinde yoksa sil" kuralı, listeyi
 * BİR AN İÇİN boş okursak 1403 dosyanın TAMAMINI siler. `loadAll` Mongo
 * düşerse dosyaya, dosya da yoksa boş listeye düşüyor — yani boş liste
 * gerçekten olabilir bir sonuç. Bu yüzden üç kat fail-closed koruma var:
 *   1) Fikstür listesi TABAN'ın altındaysa hiçbir şey yapılmaz.
 *   2) Yalnızca `YETIM_GUN` günden eski dosyalar silinir (yeni yetimleşen
 *      bir kayıt, geçici bir depo tutarsızlığı olabilir).
 *   3) Tek turda silinebilecek dosya sayısı TAVAN ile sınırlı.
 * Üçü de aynı hatayı farklı yerden yakalıyor; biri yetmez.
 *
 * ⚠️ SİLMEK GÜVENLİ, ÇÜNKÜ DOSYA ULAŞILAMAZ. Durum dosyası her zaman bir
 * fikstür üzerinden okunuyor (`effectiveStatusForFixture(fixture)`); fikstür
 * kaydı yoksa dosyaya ulaşan bir yol da yok. Uzlaşmış maçların sonucu ayrıca
 * `match_results` içinde duruyor — asıl kayıt orası.
 *
 * Kapatmak için: SKORLIG_YETIM_TEMIZLE=0
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const FixturesStore = require("../lib/fixtures-store.cjs");

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const LIVE_DIR = path.join(DATA_DIR, "live");

/** Bu yaştan genç yetimlere DOKUNULMAZ (geçici depo tutarsızlığı olabilir). */
const YETIM_GUN = Number(process.env.SKORLIG_YETIM_GUN || 7);

/**
 * Fikstür listesi bundan azsa TEMİZLİK YAPILMAZ.
 * ⚠️ Sayı, üretimdeki gerçek büyüklüğe göre seçildi (1875 fikstür). Taban
 * düşük tutulursa koruma işe yaramaz; yüksek tutulursa yeni/küçük kurulumda
 * temizlik hiç çalışmaz. 100, ikisinin arasında bilinçli bir nokta.
 */
const TABAN_FIKSTUR = Number(process.env.SKORLIG_YETIM_TABAN || 100);

/** Tek turda silinecek en fazla dosya — beklenmedik bir kusurun yarıçapını sınırlar. */
const TUR_TAVANI = Number(process.env.SKORLIG_YETIM_TAVAN || 500);

let _timer = null;

/**
 * Bir tur.
 * @param {{kuru?: boolean}} [o] `kuru: true` → hiçbir şey silinmez, yalnızca sayılır.
 */
async function tur({ kuru = false } = {}) {
  if (!fs.existsSync(LIVE_DIR)) return { atlandi: "DIZIN_YOK" };

  const fixtures = await FixturesStore.loadAll(undefined, { taze: true });

  /* KORUMA 1 — fail-closed. Liste beklenenden küçükse depo sağlıklı
   * okunmamış olabilir; bu durumda HER dosya yetim görünür. */
  if (!Array.isArray(fixtures) || fixtures.length < TABAN_FIKSTUR) {
    console.warn(
      `[yetim-temizleyici] fikstur listesi ${fixtures?.length ?? 0} kayit ` +
      `(taban ${TABAN_FIKSTUR}) — temizlik ATLANDI, depo saglikli okunmamis olabilir`
    );
    return { atlandi: "TABAN_ALTI", fixtureAdedi: fixtures?.length ?? 0 };
  }

  const fixIds = new Set(fixtures.map((f) => String(f?.fixtureId || "")));
  const simdi = Date.now();
  const yasSiniri = YETIM_GUN * 86400000;

  let toplam = 0, yetim = 0, genc = 0, silinen = 0, hata = 0;

  let dosyalar;
  try {
    dosyalar = await fsp.readdir(LIVE_DIR);
  } catch (e) {
    console.error("[yetim-temizleyici] dizin okunamadi:", e?.message || e);
    return { atlandi: "DIZIN_OKUNAMADI" };
  }

  for (const d of dosyalar) {
    if (!d.endsWith(".json")) continue;
    toplam++;

    let st = null;
    try { st = JSON.parse(await fsp.readFile(path.join(LIVE_DIR, d), "utf8")); } catch { /* bozuk */ }

    const fid = String(st?.fixtureId || d.replace(/\.json$/, ""));
    if (fixIds.has(fid)) continue;
    yetim++;

    /* KORUMA 2 — yaş. Damgası okunamayan dosya GENÇ sayılır (fail-closed):
     * yaşını doğrulayamadığımız bir dosyayı silmek, yanlış yönde yanılmaktır. */
    const damga = Date.parse(st?.updatedAt || "");
    if (!Number.isFinite(damga) || simdi - damga < yasSiniri) { genc++; continue; }

    /* KORUMA 3 — tur tavanı. */
    if (silinen >= TUR_TAVANI) break;

    if (kuru) { silinen++; continue; }
    try {
      await fsp.unlink(path.join(LIVE_DIR, d));
      silinen++;
    } catch (e) {
      hata++;
      console.error(`[yetim-temizleyici] ${d} silinemedi:`, e?.message || e);
    }
  }

  const sonuc = { toplam, yetim, genc, silinen, hata, kuru };
  if (silinen || hata) {
    console.log(
      `[yetim-temizleyici] ${kuru ? "(KURU) " : ""}${toplam} dosya · yetim ${yetim} · ` +
      `${YETIM_GUN} gunden genc ${genc} (dokunulmadi) · silinen ${silinen}` +
      (hata ? ` · hata ${hata}` : "")
    );
  }
  return sonuc;
}

function start(intervalMs = 6 * 3600 * 1000) {
  if (_timer) return;
  if (String(process.env.SKORLIG_YETIM_TEMIZLE ?? "1") === "0") {
    console.log("[yetim-temizleyici] SKORLIG_YETIM_TEMIZLE=0 — kapali");
    return;
  }
  /* İlk tur hemen değil: fikstür senkronunun ilk turunu bitirmesine fırsat
   * ver, yoksa henüz yazılmamış fikstürler yüzünden liste küçük görünür. */
  setTimeout(() => { tur().catch(() => {}); }, 10 * 60 * 1000);
  _timer = setInterval(() => { tur().catch(() => {}); }, intervalMs);
  if (typeof _timer.unref === "function") _timer.unref();
  console.log(
    `[yetim-temizleyici] basladi · her ${Math.round(intervalMs / 3600000)} saatte · ` +
    `${YETIM_GUN} gunden eski yetimler`
  );
}

function stop() { if (_timer) clearInterval(_timer); _timer = null; }

module.exports = { start, stop, tur, YETIM_GUN, TABAN_FIKSTUR, TUR_TAVANI };
