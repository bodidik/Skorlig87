"use strict";

/**
 * HESAP SİLME KAPSAMI — yeni koleksiyon eklendiğinde unutulmasın.
 *
 * `routes/users.cjs` içindeki silme listesi elle tutuluyor ve yorumda "yeni
 * bir koleksiyon eklendiğinde buraya da eklenmeli" yazıyor — ama bunu zorlayan
 * bir şey yoktu. Nitekim `push_tokens` depo Mongo'ya taşınırken eklendi,
 * listeye yazılmadı: hesabını silen kullanıcının CİHAZ JETONU ve bildirim
 * tercihleri kalıyordu. Play Store "kullanıcı verisini sil" şartı bunu kapsar.
 *
 * Bu test kodda geçen koleksiyon adlarını toplar ve her birinin ya silme
 * listesinde ya da AŞAĞIDAKİ gerekçeli muafiyet listesinde olmasını ister.
 * Yeni bir kullanıcı koleksiyonu eklenip listeye yazılmazsa test düşer.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/** Kullanıcıya ait OLMAYAN koleksiyonlar — silinmemeleri kasıtlı. */
const MUAF = {
  fixtures: "maç listesi, kullanıcı verisi değil",
  match_results: "maç sonucu, kullanıcı verisi değil",
  pools: "maç bazlı havuz özeti (bahisler pool_bets'te ve siliniyor)",
  app_settings: "uygulama ayarları",
  kuponlar: "haftalik kupon TANIMI (hangi maclar, bedel) — kullanici verisi degil; katilimlar kupon_katilim'da ve siliniyor",
  app_runtime: "runtime modu (profil/takim sayisi) — uygulama yapilandirmasi, kullanici verisi degil",
  tr_league_weeks: "hafta mührü — silinirse ödül tekrar dağıtılır",
  invite_codes_1987: "davet kodu kotası — silinirse kota sıfırlanır",
  admin_users: "yetki listesi",
  banned_users: "YASAK KAYDI KALMALI — silinirse hesap silip yasaktan kaçmak mümkün olur",
  failed_awards: "ödenmemiş ödül izi (muhasebe); kullanıcıya borç kaydı",
  groups: "SocialStore ile ayrıca temizleniyor (dosya adımı 5-6)",
  friend_links: "SocialStore ile ayrıca temizleniyor",
  friend_requests: "SocialStore ile ayrıca temizleniyor",
  friend_blocks: "SocialStore ile ayrıca temizleniyor",
  fixture_competitions: "maç↔yarışma eşlemesi, kullanıcı verisi değil",
  competitions: "yarışma tanımları, kullanıcı verisi değil",
  manual_fixtures: "yönetici eklediği maçlar, kullanıcı verisi değil",
  leaderboard: "maç bazlı anlık görüntü — belge silinmez, kullanıcı satırı $pull ile çekilir",
  users: "profil satırı UsersStore.deleteUser ile siliniyor (döngünün dışında)",
};

function kaynaklar() {
  const out = [];
  for (const alt of ["routes", "lib", "services"]) {
    const d = path.join(KOK, alt);
    for (const ad of fs.readdirSync(d)) {
      if (ad.endsWith(".cjs")) out.push(fs.readFileSync(path.join(d, ad), "utf8"));
    }
  }
  return out;
}

describe("hesap silme — tüm kullanıcı koleksiyonlarını kapsar", () => {
  test("kodda geçen her koleksiyon ya siliniyor ya gerekçeyle muaf", () => {
    const hepsi = new Set();
    for (const src of kaynaklar()) {
      // collection("ad") ve COLL sabitlerinin degerleri
      for (const m of src.matchAll(/collection\(\s*"([a-z_0-9]+)"/g)) hepsi.add(m[1]);
      for (const m of src.matchAll(/const\s+COLL[A-Z_]*\s*=\s*"([a-z_0-9]+)"/g)) hepsi.add(m[1]);
    }
    assert.ok(hepsi.size > 10, `koleksiyon taramasi calismadi (${hepsi.size})`);

    const silme = fs.readFileSync(path.join(KOK, "routes", "users.cjs"), "utf8");
    const blok = silme.slice(silme.indexOf("const islemler = ["));
    const liste = blok.slice(0, blok.indexOf("];"));

    const eksik = [];
    for (const k of hepsi) {
      if (MUAF[k]) continue;
      if (!liste.includes(`"${k}"`)) eksik.push(k);
    }
    assert.deepEqual(
      eksik, [],
      `Bu koleksiyonlar hesap silmede temizlenmiyor ve muafiyet gerekçesi de yok: ${eksik.join(", ")}.\n` +
      `routes/users.cjs icindeki \`islemler\` listesine ekle ya da bu testteki MUAF'a gerekceyle yaz.`
    );
  });

  test("push_tokens siliniyor (cihaz jetonu kişisel veridir)", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "users.cjs"), "utf8");
    assert.ok(/\["push_tokens"/.test(src), "push_tokens silme listesinde yok");
  });

  test("yasak kaydı SİLİNMİYOR (hesap silip yasaktan kaçılmasın)", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "users.cjs"), "utf8");
    const blok = src.slice(src.indexOf("const islemler = ["));
    const liste = blok.slice(0, blok.indexOf("];"));
    assert.ok(!liste.includes('"banned_users"'), "yasak kaydi siliniyor — yasaktan kacis mumkun");
  });
});

describe("hesap silme — döngü dışındaki temizlikler", () => {
  const fs = require("fs");
  const path = require("path");
  const src = () => fs.readFileSync(path.join(__dirname, "..", "routes", "users.cjs"), "utf8");

  test("Mongo profil satırı siliniyor (dosya yeterli değil)", () => {
    assert.ok(/UsersStore\.deleteUser\(/.test(src()),
      "users koleksiyonundaki profil silinmiyor — kullanici aramalarda gorunmeye devam eder");
  });

  test("users-store'da silme fonksiyonu var", () => {
    const store = fs.readFileSync(path.join(__dirname, "..", "lib", "users-store.cjs"), "utf8");
    assert.ok(/async function deleteUser\(/.test(store));
    assert.ok(/deleteUser,/.test(store), "deleteUser disa acilmamis");
  });

  test("sıralama anlık görüntüsünden kullanıcı satırı çekiliyor", () => {
    const s = src();
    assert.ok(/collection\("leaderboard"\)[\s\S]{0,200}\$pull/.test(s),
      "leaderboard anlik goruntusunde kullanici satiri kaliyor");
  });
});
