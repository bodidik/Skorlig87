"use strict";

/**
 * MOBİL DEPONUN YERİ — TEK KAYNAK.
 *
 * ⚠️ NEDEN VAR: 30 test dosyası yolu kendi hesaplıyordu ve hepsi aynı
 * varsayımı gömüyordu —
 *
 *     const MOBIL = path.join(KOK, "..", "mobile");
 *
 * `KOK` sunucu deposunun kökü. Normal checkout'ta bu doğru: `mobile` yan
 * klasördür. GIT WORKTREE'de DEĞİL — orada `KOK` bir worktree dizini
 * (`api/.claude/worktrees/xxx`), yani `..` `worktrees` klasörünü gösteriyor ve
 * `mobile` bulunamıyor.
 *
 * Bulunamayınca testler ÇÖKMÜYOR, `t.skip`/`return` ile sessizce atlanıyor.
 * Sonuç yeşil, iddia hiç koşmamış.
 *
 * ÖLÇÜLDÜ (2026-08-05, bir worktree'de): 33 mobil bağımlı iddia atlanıyordu.
 * İçlerinde şunlar var — istemci jetonu gönderiyor mu, istemci ham `fetch`
 * kullanıyor mu, yönetici ucuna `x-admin-token` gidiyor mu, ekranın sunduğu
 * her bahis sunucuda geçerli mi, 21 dilin hepsi çekirdek sözlüğü taşıyor mu.
 * Yani sözleşme ve yetki nöbetçilerinin çoğu.
 *
 * ⚠️ ATLANAN NÖBETÇİ, YALAN SÖYLEYEN NÖBETÇİDİR. Bu cümle `istemci-uc-eslesme`
 * içinde zaten yazılıydı ve orada `SKORLIG_MOBILE_DIR` override'ı ile
 * çözülmüştü — ama YALNIZCA o dosyada. Kalan 29 dosya aynı sabit yolu
 * gömmeye devam ediyordu. Aynı sınıfın ikinci yarısı budur.
 *
 * ⚠️ ÇÖZÜM ORTAM DEĞİŞKENİNE BAĞLI DEĞİL. `git-common-dir` worktree'den de
 * ANA depoyu gösteriyor, yani yol elle bir şey ayarlamadan çözülüyor.
 * Güvenliği elle ayarlanan tek bir değişkene bağlamamak bu depoda zaten
 * yazılı bir ders (bkz. lib/ortam.cjs: NODE_ENV unutulduğunda sessizce gevşek
 * moda düşmek). Aynısı burada geçerli: override'ı ŞART koşsaydık, kimse onu
 * ayarlamadığında nöbetçiler yine sessizce atlanırdı.
 *
 * Sıra: açık override → git ana deposunun yanı → yan klasör.
 */

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const KOK = path.join(__dirname, "..");

/** Ana deponun (worktree değil) kökü — bulunamazsa null. */
function anaDepoKoku() {
  try {
    /* `--git-common-dir` worktree'de bile ANA deponun `.git`ini verir;
     * worktree'ye özel `--git-dir`den farkı tam budur. */
    const ortak = cp.execSync("git rev-parse --path-format=absolute --git-common-dir", {
      cwd: KOK, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!ortak) return null;
    return path.dirname(ortak); // .../api/.git → .../api
  } catch {
    return null; // git yok ya da depo değil — aşağıdaki yedek kullanılır
  }
}

function coz() {
  const acik = String(process.env.SKORLIG_MOBILE_DIR || "").trim();
  if (acik) return acik;

  const ana = anaDepoKoku();
  if (ana) {
    const aday = path.join(ana, "..", "mobile");
    if (fs.existsSync(aday)) return aday;
  }

  /* Git yoksa (ör. paketlenmiş kopya) eski davranış. */
  return path.join(KOK, "..", "mobile");
}

/**
 * Mobil deponun mutlak yolu. Depo gerçekten orada mı, çağıran
 * `fs.existsSync` ile bakmaya devam ediyor — bu modül yalnızca YERİ söyler.
 */
const MOBIL = coz();

/** `path.join(MOBIL, ...)` kısayolu: mobilYol("app", "stats", "me.tsx") */
function mobilYol(...parcalar) {
  return path.join(MOBIL, ...parcalar);
}

/** Mobil depo erişilebilir mi — `t.skip` kararı için. */
function mobilVarMi() {
  return fs.existsSync(MOBIL);
}

module.exports = { MOBIL, mobilYol, mobilVarMi, _anaDepoKoku: anaDepoKoku };
