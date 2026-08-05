"use strict";

/**
 * TOPLU SNAPSHOT YAZIMI YENİ YERLERDE ORTAYA ÇIKMASIN.
 *
 * ⚠️ NEDEN VAR: `lib/social-store.cjs` içindeki toplu kaydediciler
 * (`saveTournaments`, `saveGroups`, `saveMini`, `saveDuels`, `saveFriends`)
 * `replaceAll` ile TÜM KOLEKSİYONU verilen listeyle değiştiriyor. Bir çağıran
 * "listeyi oku → değiştir → hepsini geri yaz" desenini kullanırsa, arada
 * yapılan HER yazma sessizce silinir.
 *
 * BU KUSUR ÜRETİMDE ÖLÇÜLDÜ (2026-08-05, services/tournament.cjs):
 *
 *   create  4 eşzamanlı → 3 çağrı BAŞARILI döndü, koleksiyonda 0 turnuva,
 *           3 kurucudan 30 LC alınmış
 *   join    4 eşzamanlı → 4 çağrı BAŞARILI döndü, kayıtta kurucu + 1 kişi,
 *           havuz 20 (olması gereken 50)
 *   predict 3 eşzamanlı → 3 çağrı BAŞARILI döndü, kayıtta 1 tahmin
 *   settle  A sonuçlanırken B'ye katılım → join BAŞARILI döndü ama B'nin
 *           listesinde yok, 10 LC gitti; ayrıca BAŞKA bir çağrının attığı
 *           mühür geri alındı ("settled" → "open"), yani ödeme İKİNCİ KEZ
 *           yapılırdı
 *
 *   settle2 auto-settle — aynısı, canlı yolda: araya giren katılım ve araya
 *           giren YENİ turnuva silindi (routes/settle2.cjs)
 *
 * Hepsi SESSİZ: `saveX` hata vermediği için çağıranların iade kolları
 * ("create_save_failed", "join_save_failed") hiç çalışmıyor ve uç `ok:true`
 * dönüyor. Kullanıcı parasını verip "katıldın" cevabı alıyor ve turnuvada
 * görünmüyor.
 *
 * ⚠️ BEŞ YOLDAN ÜÇÜNÜ DÜZELTMEK YETMEDİ: `create`/`join`/`predict` atomik
 * hâle geldikten sonra bile `settle` ve settle2 auto-settle snapshot yazmaya
 * devam ediyor, ötekilerin atomik yazmalarını geri alıyorlardı. Kusur her
 * seferinde "düzeltildi" sanılan bir dosyada, kalan yoldan geri geldi. Bu
 * yüzden kural dosya bazında değil, ÇAĞRI bazında uygulanıyor.
 *
 * KURAL: bir toplu kaydediciyi, aynı fonksiyonda yapılmış bir toplu okumadan
 * sonra çağırmak yasak. Doğrusu tek belgeye atomik işlem (`updateOne` koşulu
 * filtrenin içinde, `insertOne`, `$push`/`$inc`/`arrayFilters`) — örnekler:
 * `SocialStore.joinTournamentAtomik`, `addMiniMember`, `claimDuelAccept`.
 *
 * Yeni bir yer eklenirse bu test kırılır ve kırılması DOĞRUDUR.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

const KOK = nodePath.join(__dirname, "..");

/** `replaceAll` ile tüm koleksiyonu değiştiren kaydediciler. */
const TOPLU_YAZICI = [
  "saveTournaments", "saveGroups", "saveMini", "saveDuels", "saveFriends",
];
/** Aynı verinin toplu okuyucuları. */
const TOPLU_OKUYUCU =
  /\b(loadTournaments|loadGroups|loadMini|loadDuels|loadFriends|loadAll)\s*\(/;

/**
 * BİLİNEN VE KABUL EDİLEN yerler. Her biri için GEREKÇE şart — gerekçesiz
 * girdi eklemek bu nöbetçiyi işlevsizleştirir.
 */
const MUAF = [
  /* NOT: `services/tournament.cjs` burada DEĞİL. Snapshot yazımları
   * atomik depoya taşındı; kalan tek kullanım `NO_DB` yedek kolunda ve
   * tarayıcı onu zaten muaf tutuyor. Muafiyet olarak eklemek bayat girdi
   * olurdu — nitekim ilk hâlinde eklemiştim ve aşağıdaki ikinci test onu
   * "artık desen taşımıyor" diye yakaladı. */
  {
    dosya: "routes/duels.cjs",
    gerekce:
      "`withFileLock(DUELS_FILE)` ile sarılı — tek süreçte sıraya sokuyor. " +
      "Kritik para yolları (accept/cancel/settle) zaten atomik mühür kullanıyor.",
  },
  /* NOT: `routes/settle2.cjs` de burada DEĞİL — ARTIK. Muafiyet
   * "tryAutoSettleTournaments hâlâ toptan yazıyor, düzeltilince bu girdi
   * SİLİNMELİ" gerekçesiyle konmuştu; auto-settle üç hedefli yazmaya geçince
   * (mühür + payouts, mühür + voided alanları, setTournamentScoresAtomik)
   * desen kalmadı ve girdi silindi. Aşağıdaki ikinci test tam bunun için var:
   * bayat muafiyet bırakılsaydı, sonraki geliştirici "burası zaten muaf" diye
   * aynı deseni yeniden ekleyebilirdi. */
];

function kodOku(rel) {
  return fs.readFileSync(nodePath.join(KOK, rel), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

/**
 * Bir dosyadaki "toplu oku → toplu yaz" noktaları.
 *
 * ⚠️ TEK KAYNAK: iki test de bunu kullanır. İlk hâlde tarama mantığı iki yerde
 * kopyalanmıştı ve biri `NO_DB` muafiyetini uygularken öteki uygulamıyordu —
 * sonuç: gereksizleşmiş bir muafiyet "hâlâ geçerli" görünüyordu, yani bayat
 * muafiyeti yakalaması gereken test kendi körlüğüyle onu gizliyordu.
 */
function snapshotYazimlari(rel) {
  const kod = kodOku(rel);
  const out = [];
  for (const yazici of TOPLU_YAZICI) {
    const re = new RegExp(`\\b${yazici}\\s*\\(`, "g");
    let m;
    while ((m = re.exec(kod))) {
      /**
       * ⚠️ PENCERE FONKSİYON SINIRINDA BİTER — sabit karakter penceresi
       * YANILTIYORDU. `tournament.cjs`teki `loadAll`/`saveAll` sarmalayıcı
       * çifti arka arkaya iki AYRI fonksiyon; 1500 karakterlik pencere ikisini
       * birden kapsayıp meşru bir sarmalayıcıyı "oku-değiştir-yaz" sanıyordu.
       * Sonuç: muafiyet geçerli görünüyordu ama gerekçesi yanlıştı.
       */
      const oncesi = kod.slice(0, m.index);
      const fnBas = Math.max(
        oncesi.lastIndexOf("\nasync function "),
        oncesi.lastIndexOf("\nfunction "),
        oncesi.lastIndexOf("router.get("),
        oncesi.lastIndexOf("router.post("),
      );
      const pencere = oncesi.slice(fnBas < 0 ? Math.max(0, m.index - 1500) : fnBas);
      if (!TOPLU_OKUYUCU.test(pencere)) continue;
      /* `NO_DB` yedek kolu meşru: atomik depo Mongo bulamazsa tek süreçli
       * kurulumda snapshot yazımı tek seçenek. Muafiyet DAR — koşulun
       * kendisi pencerede geçmeli. */
      if (/reason === "NO_DB"/.test(pencere)) continue;
      out.push({ satir: kod.slice(0, m.index).split("\n").length, yazici });
    }
  }
  return out;
}

function taranacakDosyalar() {
  const out = [];
  for (const dir of ["routes", "services"]) {
    const d = nodePath.join(KOK, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith(".cjs")) out.push(`${dir}/${f}`);
    }
  }
  return out;
}

test("toplu okuma + toplu yazma deseni yalnızca GEREKÇELİ yerlerde", () => {
  const bulgular = [];

  for (const rel of taranacakDosyalar()) {
    for (const b of snapshotYazimlari(rel)) bulgular.push({ rel, ...b });
  }

  /* Tarama gerçekten çalışıyor mu? Muaf listesi boş değilse en az o kadar
   * bulgu çıkmalı; hiç çıkmazsa desen değişmiş ve nöbetçi körelmiş demektir. */
  assert.ok(
    bulgular.length > 0,
    "hicbir toplu yazma bulunamadi — tarama bozuk (fonksiyon adlari degisti mi?)"
  );

  const muafDosyalar = new Set(MUAF.map((x) => x.dosya));
  const yeni = bulgular.filter((b) => !muafDosyalar.has(b.rel.replace(/\\/g, "/")));

  assert.deepEqual(
    yeni.map((b) => `${b.rel}:${b.satir} ${b.yazici}()`), [],
    "YENI toplu snapshot yazimi eklenmis.\n" +
    "Bu desen (listeyi oku -> degistir -> hepsini geri yaz) es zamanli her\n" +
    "yazmayi SESSIZCE siler; olculdu: 4 es zamanli turnuva katiliminda 3 kisi\n" +
    "ucretini odeyip katilamadi ve hicbiri hata gormedi.\n" +
    "Dogrusu tek belgeye atomik islem: kosul filtrenin ICINDE olsun\n" +
    "(ornekler: joinTournamentAtomik, addMiniMember, claimDuelAccept).\n" +
    "Gercekten kacinilmazsa MUAF listesine GEREKCESIYLE ekle."
  );
});

test("muafiyet listesi güncel — kapanan açık listede kalmasın", () => {
  /**
   * ⚠️ Muafiyetler eskir. `settle2` düzeltilince bu girdi silinmeli; yoksa
   * bir sonraki geliştirici "burada zaten muaf" diye aynı deseni yeniden
   * ekler. Aynı tuzağa bu depoda düşülmüş: `mongo-birincil.test.cjs`
   * `totals-read.cjs`'i "istemci çağırmıyor" gerekçesiyle muaf tutuyordu ve
   * o gerekçe yanlıştı — ekran çağırıyordu, veri yolu ölüydü.
   */
  for (const { dosya, gerekce } of MUAF) {
    const tam = nodePath.join(KOK, dosya);
    assert.ok(
      fs.existsSync(tam),
      `muaf dosya artik yok: ${dosya} — listeden cikarilmali`
    );
    assert.ok(
      gerekce && gerekce.length > 40,
      `${dosya} icin gerekce yetersiz — muafiyet gerekcesiz eklenmemeli`
    );

    /* Muafiyet hâlâ GEÇERLİ mi: dosyada desen gerçekten duruyor mu?
     * İlk testle AYNI tarama — ayrışırsa bayat muafiyet görünmez olur. */
    assert.ok(
      snapshotYazimlari(dosya).length > 0,
      `${dosya} artik toplu snapshot yazmiyor — MUAF listesinden CIKAR. ` +
      `Bayat muafiyet, ayni deseni yeniden eklemenin onunu acar.`
    );
  }
});
