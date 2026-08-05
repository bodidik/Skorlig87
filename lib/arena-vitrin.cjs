"use strict";

/**
 * ARENA VİTRİNİ — arena boşken gösterilecek popüler maçlar.
 *
 * SORUN: Arena yalnızca AÇIK düelloları listeliyor. Hiç kimse düello açmamışsa
 * ekran tamamen boş kalıyor. Kullanıcı sekmeye kadar geliyor ve yapacak bir şey
 * bulamadan çıkıyor — düello açma fikri hiç aklına gelmiyor, çünkü ekranda
 * düellonun neye benzediğini gösteren tek bir örnek bile yok.
 *
 * ÇÖZÜM: Gerçek düello sayısı azken listeye yaklaşan popüler maçları "vitrin"
 * olarak ekle. Kullanıcı bunlara dokununca o maçın düello sayfasına gider ve
 * ilk düelloyu KENDİSİ açar.
 *
 * ⚠️ VİTRİN SAHTE DÜELLO DEĞİLDİR. Kart `openCount: 0` ve `vitrin: true` ile
 * gelir, `preview` dizisi BOŞTUR. Olmayan bir rakibi varmış gibi göstermek
 * kullanıcıyı düello açmaya kandırmak olurdu; para söz konusu olduğu için bu
 * çizgi net tutuluyor. Ekran bu kartları "ilk sen aç" diye etiketler.
 *
 * ⚠️ GERÇEK DÜELLOLAR HER ZAMAN ÜSTTE. Vitrin yalnızca listenin SONUNA eklenir
 * ve gerçek düellosu olan bir maç asla vitrin olarak tekrarlanmaz.
 */

const { sortByPriority, isAcceptableFixture } = require("./fixture-priority.cjs");
const { duelloyaUygunMu } = require("./mac-denge.cjs");

/** Arena bu sayının altına düşerse vitrin devreye girer. */
const HEDEF_KART = Number(process.env.SKORLIG_ARENA_VITRIN_HEDEF || 2);

/**
 * Maç en az bu kadar sonra başlamalı. Düello kilidi kickoff'tan 10 dk önce
 * kapanıyor; kilide çok yakın bir maçı vitrine koymak, kullanıcı sayfayı
 * açtığında "düello kapandı" ile karşılaşması demek.
 */
const ASGARI_DK = Number(process.env.SKORLIG_ARENA_VITRIN_ASGARI_DK || 30);

/** Bu kadar ileri tarihli maçlar vitrine girmez — "yaklaşan" olmaktan çıkar. */
const AZAMI_SAAT = Number(process.env.SKORLIG_ARENA_VITRIN_AZAMI_SAAT || 72);

/**
 * Vitrine uygun maçları seçer.
 *
 * @param {object[]} fixtures      tüm fikstür listesi
 * @param {Set<string>} haricTut   zaten listede olan fixtureId'ler (küçük harf)
 * @param {string} userCountry     sıralama için kullanıcının ülkesi
 * @param {number} simdi           şimdiki zaman (ms) — test için dışarıdan
 * @returns {object[]} öncelik sırasına dizilmiş aday fikstürler
 */
function vitrinAdaylari(fixtures, haricTut, userCountry, simdi) {
  const altSinir = simdi + ASGARI_DK * 60 * 1000;
  const ustSinir = simdi + AZAMI_SAAT * 60 * 60 * 1000;

  const uygun = (fixtures || []).filter((fx) => {
    if (!isAcceptableFixture(fx)) return false;

    const fid = String(fx?.fixtureId || "").trim();
    if (!fid) return false;
    if (haricTut.has(fid.toLowerCase())) return false;

    /* Başlamış ya da bitmiş maç vitrine girmez. Durum alanı kaynağa göre
     * değişebildiği için yalnızca "açıkça oynanmamış" sayılanlar geçer. */
    const durum = String(fx?.status || "").trim().toUpperCase();
    if (durum && !["NS", "TBD", "SCHEDULED", ""].includes(durum)) return false;

    const ko = Date.parse(fx?.kickoffISO || "");
    if (!Number.isFinite(ko)) return false;
    return ko >= altSinir && ko <= ustSinir;
  });

  return sortByPriority(uygun, userCountry);
}

/**
 * Vitrin kartlarını üretir ve gerçek maç listesinin SONUNA ekler.
 *
 * @param {object[]} matches     `/duels/arena` gerçek maç kartları
 * @param {object} secenek
 * @param {object[]} secenek.fixtures
 * @param {string} [secenek.userCountry]
 * @param {object} [secenek.db]        maç dengesi denetimi için
 * @param {number} [secenek.simdi]
 * @returns {Promise<object[]>}
 */
async function vitrinleZenginlestir(matches, secenek = {}) {
  const mevcut = Array.isArray(matches) ? matches : [];
  const eksik = HEDEF_KART - mevcut.length;
  if (eksik <= 0) return mevcut;

  const simdi = Number.isFinite(secenek.simdi) ? secenek.simdi : Date.now();
  const haricTut = new Set(
    mevcut.map((m) => String(m?.fixtureId || "").trim().toLowerCase()).filter(Boolean)
  );

  const adaylar = vitrinAdaylari(
    secenek.fixtures, haricTut, secenek.userCountry, simdi
  );

  const vitrin = [];
  for (const fx of adaylar) {
    if (vitrin.length >= eksik) break;

    /* ⚠️ DENGE DENETİMİ VİTRİNDE DE GEÇERLİ. Tek taraflı bir maçta
     * `/duels/create` zaten reddediyor; denetlemeden vitrine koyarsak
     * kullanıcı karta dokunur, düello açmaya çalışır ve reddedilir. */
    let uygun = true;
    try {
      const d = await duelloyaUygunMu(fx.fixtureId, secenek.db);
      uygun = d?.uygun !== false;
    } catch { /* denetim patlarsa maçı eleme — kapı /duels/create'te zaten var */ }
    if (!uygun) continue;

    vitrin.push({
      fixtureId: fx.fixtureId,
      home: fx.home || "?",
      away: fx.away || "?",
      league: fx.league || null,
      country: fx.country || null,
      kickoffISO: fx.kickoffISO || null,
      openCount: 0,
      minStake: 0,
      maxStake: 0,
      preview: [],
      /* Ekran bu bayrağa bakıp "ilk düelloyu sen aç" rozetini gösteriyor.
       * İstemcinin `openCount === 0` çıkarımı yapmasını beklemiyoruz: sunucu
       * ne demek istediğini AÇIKÇA söylüyor. */
      vitrin: true,
    });
  }

  return mevcut.concat(vitrin);
}

module.exports = {
  vitrinleZenginlestir,
  vitrinAdaylari,
  HEDEF_KART,
  ASGARI_DK,
  AZAMI_SAAT,
};
