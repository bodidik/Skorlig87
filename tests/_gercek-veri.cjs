"use strict";

/**
 * GERÇEK ÇALIŞMA ZAMANI VERİSİNİN YERİ — TEK KAYNAK.
 *
 * ⚠️ NEDEN VAR: bir grup test, senteti̇k girdiyle değil GERÇEK veriyle sınıyor
 * (fikstür listesi, canlı skor önbelleği, sıralama tabloları). Hepsi yolu
 * kendi hesaplıyordu:
 *
 *     const dosya = path.join(KOK, "data", "fixtures.json");
 *     if (!fs.existsSync(dosya)) return t.skip("fikstur verisi yok");
 *
 * `KOK` deponun kökü. Bu dosyalar git tarafından İZLENMİYOR — çalışma zamanı
 * önbelleği, scraper yazıyor. GIT WORKTREE'ye yalnızca izlenen dosyalar
 * gelir, yani orada `data/fixtures.json` HİÇBİR ZAMAN yoktur ve bu testler
 * her koşuda sessizce atlanır.
 *
 * ÖLÇÜLDÜ (2026-08-05, bir worktree'de): 10 iddia bu yüzden atlanıyordu.
 * Ana checkout'ta aynı dosyalar duruyor ve tazeydi (fixtures.json 0,65 MB,
 * dakikalar önce yazılmış).
 *
 * ⚠️ AYNI SINIFIN ÜÇÜNCÜ ÖRNEĞİ. Önce `node_modules` (worktree'de yok), sonra
 * `../mobile` (worktree'nin bir üstü yanlış klasör), şimdi bu. Üçü de aynı
 * şekil: kaynak ANA checkout'a bağlı, worktree kendi kökünden hesaplıyor,
 * bulamıyor, test sessizce atlanıyor — yeşil görünür, hiçbir şey ölçmez.
 * bkz. tests/bagimlilik-yolu-nobetcisi.test.cjs, tests/mobil-yol-nobetcisi.test.cjs
 *
 * ⚠️ YALNIZCA İZLENMEYEN DOSYALAR İÇİN. `countries-teams.json`,
 * `bot-profiles.json` gibi İZLENEN dosyalar buradan OKUNMAMALI: onlar depo
 * içeriği, yani dala göre değişebilir ve test çalıştığı DALIN sürümünü
 * görmeli. Ana checkout'a yönlendirmek, başka bir dalın verisini okumak
 * olurdu. Bu modül yalnızca dala ait olmayan, makineye ait çalışma zamanı
 * önbelleği için.
 *
 * ⚠️ ATLAMA DAVRANIŞI KORUNUYOR. Veri yoksa (temiz klon, CI) `varMi` false
 * döner ve çağıran yine `t.skip` eder. Amaç "her yerde koşsun" değil,
 * "VARKEN bulunabilsin" — worktree'de var olan veriyi görememek kusurdu.
 */

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const KOK = path.join(__dirname, "..");

/** Ana deponun (worktree değil) kökü — bulunamazsa null. */
function anaDepoKoku() {
  try {
    /* `--git-common-dir` worktree'de bile ANA deponun `.git`ini verir. */
    const ortak = cp.execSync("git rev-parse --path-format=absolute --git-common-dir", {
      cwd: KOK, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return ortak ? path.dirname(ortak) : null;
  } catch {
    return null;
  }
}

function coz() {
  const acik = String(process.env.SKORLIG_GERCEK_VERI_DIR || "").trim();
  if (acik) return acik;

  /* Kendi kökümüzde varsa onu kullan — normal checkout'ta doğru cevap bu ve
   * git çağrısına hiç gerek kalmaz. */
  const kendi = path.join(KOK, "data");
  if (fs.existsSync(path.join(kendi, "fixtures.json"))) return kendi;

  const ana = anaDepoKoku();
  if (ana) {
    const aday = path.join(ana, "data");
    if (fs.existsSync(aday)) return aday;
  }
  return kendi;
}

/** Gerçek veri dizininin mutlak yolu (var olmak zorunda değil). */
const VERI_DIZINI = coz();

/** Dosyanın tam yolu — varlığını çağıran denetler. */
function veriYolu(ad) {
  return path.join(VERI_DIZINI, ad);
}

/** Dosya gerçekten okunabilir mi — `t.skip` kararı için. */
function varMi(ad) {
  return fs.existsSync(veriYolu(ad));
}

/** JSON'u oku; yoksa null (çağıran atlar). */
function oku(ad) {
  try {
    return JSON.parse(fs.readFileSync(veriYolu(ad), "utf8"));
  } catch {
    return null;
  }
}

module.exports = { VERI_DIZINI, veriYolu, varMi, oku, _anaDepoKoku: anaDepoKoku };
