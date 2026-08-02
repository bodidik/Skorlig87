"use strict";

/**
 * Mini Turnuva: kullanıcı 2-10 maç seçip turnuva kurar, arkadaşları
 * 6 haneli kodla katılır. Sıralama, seçilen maçların settle edilmiş
 * sonuçlarından (data/match-results.json içindeki kullanıcı-başına puan
 * satırlarından) hesaplanır. Tamamen dosya tabanlı, Mongo gerektirmez.
 *
 * Endpoint'ler (/api/mini):
 *   POST /create { userId, name, fixtures:[{fixtureId,home,away,kickoffISO,league}] }
 *   POST /join   { userId, code }
 *   GET  /mine?userId=
 *   GET  /board?id=   (veya ?code=)
 */

const express = require("express");
const router = express.Router();

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { guvenliYol } = require("../lib/guvenli-dosya.cjs");
const crypto = require("crypto");

// ⚠️ SKORLIG_DATA_DIR OKUNUYOR. Sabit yol testleri GERÇEK data/ dizinine
// yazdırıyordu: bir entegrasyon testi 7 kaydı canlı preds.json'a düşürdü.
// Ayrıca settle2 bu değişkeni okuyup pred okumayınca aynı zincirdeki iki
// modül maç durum dosyasını FARKLI dizinlerde arıyordu.
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const SocialStore = require("../lib/social-store.cjs");
const { withFileLock } = require("../lib/fileLock.cjs");
// ⚠️ Bu import BİR KEZ ATLANMIŞTI: koşullu ekleme ("dosyada 'verifyToken'
// geçmiyorsa ekle") kullanılmıştı, ama az önce eklenen rota tanımları o
// metni zaten içerdiği için koşul yanlış çalıştı. Aynı hata settle2'de de
// olmuştu. Ders: import eklemeyi metin varlığına bağlama.
const { verifyToken } = require("../middleware/verifyToken.cjs");
const { kimlikVeyaHata } = require("../lib/kimlik-kontrol.cjs");
const premium = require("../lib/premium.cjs");
const MatchResults = require("../lib/match-results.cjs");
const LIVE_DIR = path.join(DATA_DIR, "live");

const MIN_FIXTURES = 2;
const MAX_FIXTURES = 10;
const MAX_MEMBERS = 50;

// Turnuva birincisine LC (LigCoin) ödülü. Mongo varsa cüzdana `$inc` ile
// yazılır (lib/wallet-credit.cjs); dosya yalnızca ayna açıkken güncellenir.
const MINI_WIN_LC = Math.max(0, Number(process.env.SKORLIG_MINI_WIN_LC || 20));
const USERS_FILE = path.join(DATA_DIR, "users.json");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");
const { creditLc, kayipOdulKaydet } = require("../lib/wallet-credit.cjs");
// settle2 ile AYNI bayrak: cüzdan dosyası aynası.
const WALLET_FILE_MIRROR =
  String(process.env.SKORLIG_WALLET_FILE_MIRROR ?? "1") !== "0";

async function readJson(file, fb) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fb;
  }
}
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

// Mini turnuvalar Mongo birincil — bkz. lib/social-store.cjs. Dosyada
// tutulurken Render'da her deploy siliyordu; kullanıcının açtığı turnuva
// hiçbir kaynaktan geri gelmiyordu.
async function loadAll(db) {
  return SocialStore.loadMini(db || null);
}

function newCode(existing) {
  // karışması kolay karakterler yok (0/O, 1/I)
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let tries = 0; tries < 50; tries++) {
    let c = "";
    for (let i = 0; i < 6; i++) c += alpha[crypto.randomInt(alpha.length)];
    if (!existing.has(c)) return c;
  }
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function publicView(t) {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    ownerId: t.ownerId,
    fixtures: t.fixtures || [],
    members: t.members || [],
    memberCount: (t.members || []).length,
    createdAt: t.createdAt,
    finishedAt: t.finishedAt || null,
    winners: t.winners || null,
    rewardLc: t.rewardLc ?? null,
  };
}

// ---- LC ödülü (settle2 awardLcForRows ile aynı dosya deseninde) ----

/**
 * ⚠️ BOT TESPİTİ TEK KAYNAKTAN — BU DOSYA KENDİ KOPYASINI TAŞIYORDU VE
 * BOTLARIN %96.7'SİNİ GÖREMİYORDU.
 *
 * Eski hâli `String(uid).toLowerCase().startsWith("bot_")` idi. Ama üretimdeki
 * botların adları böyle değil: `Marakana49`, `AliSamiYen24`, `FBSpirit60`,
 * `TanjuColak`, `Hagi72`… Bot kimlikleri `bot-profiles.json` +
 * `bot-legacy-ids.json` dosyalarından gelen bir KÜMEDE tutuluyor
 * (`lib/botIds.cjs`), ad kalıbında değil.
 *
 * ÖLÇÜLDÜ: `BOT_ID_SET` 2720 kimlik içeriyor; bunların **2631'i** (%96.7)
 * `bot_` ile BAŞLAMIYOR, yani buradaki süzgeç onları "gerçek oyuncu" sayıyordu.
 *
 * ⚠️ BEDELİ PARA: `gercekKazananlar` mini turnuva LC ödülünü kimin alacağını
 * belirliyor (satır ~144 ve ~319). Bot kazanan elenmeyince ödül ona da
 * gidiyor — hem karşılıksız LC üretimi hem gerçek oyuncunun payının
 * bölünmesi (ödül bölüşülüyor, çoğaltılmıyor — bkz. aşağıdaki not).
 *
 * ÜRETİMDE HENÜZ SIZMADI, ölçtüm: tek turnuva `winners: []`, `rewardLc: 0`
 * ile bitmiş, mini ödül defter kaydı 0. Ama o turnuvanın üyelerinden
 * `FBSpirit60` gerçek bir bot ve bu süzgeçten geçiyordu — kazananla bitseydi
 * LC alacaktı.
 *
 * Bu depodaki en sık kusur şekli: aynı savunmanın ikinci bir kopyası, sessizce
 * ayrışıyor. Kopya kaldırıldı.
 */
const { isBot: isBotUser } = require("../lib/botIds.cjs");

/** Bot olmayan (yani ödül alabilecek) kazananlar. */
function gercekKazananlar(userIds) {
  return (userIds || []).filter((u) => u && !isBotUser(u));
}

/**
 * Kazanan BAŞINA düşen ödül.
 *
 * ⚠️ ÖDÜL BÖLÜŞÜLÜR, ÇOĞALTILMAZ. Eskiden beraberlikte HERKESE tam
 * MINI_WIN_LC veriliyordu: aynı tahmini yapan 5 hesap turnuva başına
 * 5×20 = 100 LC üretiyordu. Girişin ücretsiz olduğu düşünülünce bu
 * karşılıksız bir LC musluğuydu. Artık turnuva başına dağıtılan toplam
 * MINI_WIN_LC'yi AŞAMAZ.
 *
 * ⚠️ AŞAĞI yuvarlanır (0.1 adım). Yukarı yuvarlamak toplamı taşırırdı:
 * 20/3 = 6.666 → 6.7 verilseydi 3×6.7 = 20.1, yani 0.1 LC yoktan yaratılırdı.
 * 6.6 ile toplam 19.8 olur; artan 0.2 LC dağıtılmaz (yakılır). Enflasyon
 * yönünde hata yapmamak, kuruş kuruşuna dağıtmaktan önemli.
 *
 * Bölüşme BOT ELENDİKTEN SONRAKİ sayıya göre: bot para almıyor, yani
 * turnuvaya bot eklemek gerçek kazananın payını düşürmemeli.
 */
function kazananPayi(kazananSayisi) {
  const n = Number(kazananSayisi) || 0;
  if (n <= 0 || MINI_WIN_LC <= 0) return 0;
  return Math.floor((MINI_WIN_LC / n) * 10) / 10;
}

/**
 * Mini turnuva ödülü.
 *
 * ⚠️ MONGO ŞUBESİ ŞART: bakiye SKORLIG_WALLET_FILE_MIRROR=0 iken Mongo'dan
 * (`lc_wallet_users`) okunuyor. Bu fonksiyon bir süre YALNIZCA dosyalara
 * yazıyordu — kullanıcı turnuvayı kazanıyor, ödül kimsenin okumadığı bir
 * dosyaya düşüyor, bakiyesi hiç artmıyordu. Hata da üretilmiyordu.
 */
async function awardMiniWinLc(userIds, tournament, db) {
  const winners = gercekKazananlar(userIds);
  const pay = kazananPayi(winners.length);
  // Pay 0'a yuvarlandıysa (çok kalabalık beraberlik) kimseye yazma:
  // creditLc zaten 0'ı reddeder ama defterde anlamsız kayıt da oluşmasın.
  if (!winners.length || pay <= 0) return 0;

  const nowISO = new Date().toISOString();

  // Mongo tarafı: $inc göreli olduğu için dosyadan bağımsız ve doğru.
  //
  // ⚠️ DÖNÜŞ DEĞERİ KONTROL EDİLİYOR. Eskiden `await creditLc(...)` sonucu
  // yok sayılıyordu: `creditLc` hatayı kendi içinde yakalayıp false döner,
  // yani ödeme başarısız olsa bile burada hiçbir belirti oluşmuyordu. Turnuva
  // ise `finishMini` ile ÇOKTAN mühürlenmiş olduğu için tekrar denenmez —
  // kazanan "kazandın" görür, LC'si hiç gelmez.
  const odenemeyen = [];
  for (const uid of winners) {
    const ok = await creditLc(db, uid, pay, "mini_tournament_win", {
      tournamentId: tournament.id,
      tournamentName: tournament.name,
      kazananSayisi: winners.length,
    });
    if (!ok) odenemeyen.push(uid);
  }
  if (odenemeyen.length) {
    console.error(
      `[mini] ⛔ ODUL ODENEMEDI: turnuva=${tournament.id} kisi=${odenemeyen.join(", ")} ` +
      `tutar=${pay} — turnuva muhurlu, tekrar denenmeyecek`
    );
    await kayipOdulKaydet(db, {
      kaynak: "mini_tournament_win",
      tournamentId: tournament.id,
      tutar: pay,
      odemeler: odenemeyen.map((u) => ({ userIdLower: String(u).toLowerCase(), tutar: pay })),
      beklenen: winners.length,
      eksik: odenemeyen.length,
    });
  }

  // Mongo varsa ve ayna kapalıysa dosyaya hiç dokunma.
  if (db && !WALLET_FILE_MIRROR) return winners.length;

  // users.json ({items:[]} formatı)
  const usersRaw = await readJson(USERS_FILE, { items: [] });
  const usersItems = Array.isArray(usersRaw) ? usersRaw : usersRaw.items || usersRaw.users || [];

  // lc-wallet.json ({users:[], ledger:[]})
  const wallet = (await readJson(WALLET_FILE, { users: [], ledger: [], updatedAt: null })) || {};
  if (!Array.isArray(wallet.users)) wallet.users = [];
  if (!Array.isArray(wallet.ledger)) wallet.ledger = [];

  for (const uid of winners) {
    let u = usersItems.find((x) => String(x.userId) === uid);
    if (!u) {
      u = { userId: uid, mainTeam: null, createdAt: nowISO, lc: pay, lcLastDaily: null };
      usersItems.push(u);
    } else {
      u.lc = Number(u.lc || 0) + pay;
    }
    u.lcUpdatedAt = nowISO;
    u.lcLastReason = "mini_tournament_win";
    u.lcLastAmount = pay;

    let wu = wallet.users.find(
      (x) => String(x.userId || "").toLowerCase() === uid.toLowerCase()
    );
    if (!wu) {
      wu = {
        userId: uid,
        balance: 0,
        createdAt: nowISO,
        updatedAt: nowISO,
        lastDailyAt: null,
        totalEarned: 0,
        totalSpent: 0,
      };
      wallet.users.push(wu);
    }
    wu.balance = Number(wu.balance || 0) + pay;
    wu.totalEarned = Number(wu.totalEarned || 0) + pay;
    wu.updatedAt = nowISO;

    wallet.ledger.push({
      id: "tx_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex"),
      userId: uid,
      kind: "reward",
      amount: pay,
      reason: "mini_tournament_win",
      fixtureId: null,
      meta: { tournamentId: tournament.id, tournamentName: tournament.name },
      createdAt: nowISO,
    });
  }

  const usersOut = Array.isArray(usersRaw) ? usersItems : { ...usersRaw, items: usersItems };
  await writeJson(USERS_FILE, usersOut);
  wallet.updatedAt = nowISO;
  await writeJson(WALLET_FILE, wallet);

  return winners.length;
}

// Aynı turnuvanın eşzamanlı iki board isteğinde çifte ödülü engelle
const _finalizing = new Set();

/** Tüm maçlar settle olduysa turnuvayı bitir: kazananları yaz, LC ödülünü ver. */
/**
 * Turnuva bitmeye hazir mi?
 *
 * ⚠️ ESKIDEN "TUM MACLAR SETTLE OLMALI" SARTIYDI ve tek ertelenen mac
 * turnuvayi SONSUZA KADAR askida birakiyordu: kazananlar 20 LC odulunu hic
 * almiyordu ve turnuva, kurucunun ayni anda acik tutabilecegi turnuva
 * kotasindan bir yuvayi KALICI olarak isgal ediyordu.
 *
 * Ayni delik kuponda ve duello/havuzda da vardi (bkz. lib/bayat-mac.cjs).
 * Artik sonucu gelmeyen mac bekleme suresi dolunca YOK SAYILIR: turnuva
 * cozulen maclar uzerinden biter.
 */
async function bitmeyeHazirMi(t, settledCount, fixtureIds, db) {
  if (!fixtureIds.length) return false;
  if (settledCount >= fixtureIds.length) return true;

  // Eksik maclarin HEPSI bayatsa turnuva kapatilabilir. Biri hala
  // bekleniyorsa turnuva da bekler — erken kapatmak, sonucu gec gelen maci
  // haksiz yere yok saymak olurdu.
  const { bayatMi, sonucVarMi } = require("../lib/bayat-mac.cjs");
  const FixturesStore = require("../lib/fixtures-store.cjs");
  for (const fid of fixtureIds) {
    if (await sonucVarMi(fid, db)) continue;

    /* ⚠️ SAAT ÖNCE SUNUCUDAN. `/create` artık maç bilgisini depodan yazıyor,
     * ama BU DÜZELTMEDEN ÖNCE kurulmuş turnuvalar hâlâ istemcinin verdiği
     * saati taşıyor — ve karar tam o saate bakıyor. Geçmişe çekilmiş bir saat,
     * turnuvayı istenen anda bitirilebilir yapardı. Depoda karşılığı varsa
     * yetkili değer kullanılıyor; yoksa kayıttaki değere düşülüyor (yoksa
     * eski turnuvalar hiç kapanmaz ve para kilitli kalırdı — bu dosyanın
     * önlemek için yazıldığı durumun ta kendisi). */
    let saat = null;
    try {
      const sunucuFx = await FixturesStore.getOne(fid, db);
      saat = sunucuFx?.kickoffISO || sunucuFx?.kickoff || null;
    } catch (e) {
      console.error("[mini] fikstur saati okunamadi:", fid, e?.message || e);
    }
    if (!saat) {
      const kayit = (t.fixtures || []).find((f) => String(f.fixtureId) === String(fid));
      saat = kayit?.kickoffISO || null;
    }

    const durum = await bayatMi({ fixtureId: fid, kickoffISO: saat, db });
    if (!durum.bayat) return false;
  }
  return true;
}

async function finalizeIfDone(t, board, settledCount, fixtureCount, db, fixtureIds = null) {
  if (t.finishedAt) return t;
  const idListe = fixtureIds || (t.fixtures || []).map((f) => String(f.fixtureId));
  if (!(await bitmeyeHazirMi(t, settledCount, idListe, db))) return t;
  if (_finalizing.has(t.id)) return t;
  _finalizing.add(t.id);

  try {
    // Dosyadan taze oku (yarış koşullarına karşı) ve tekrar kontrol et
    const items = await loadAll(db);
    const cur = items.find((x) => x.id === t.id);
    if (!cur || cur.finishedAt) return cur || t;

    const top = board.length ? board[0].points : 0;
    // Kimse puan alamadıysa kazanan yok (hükümsüz biter, ödül dağıtılmaz)
    const winners = top > 0 ? board.filter((r) => r.points === top).map((r) => r.userId) : [];

    // ⚠️ `rewardLc` KİŞİ BAŞI düşen pay (toplam değil) — ekran bu alanı
    // gösteriyor. Bot olmayan kazanan sayısına göre hesaplanıyor, çünkü
    // ödemeyi alacak olanlar onlar (bkz. kazananPayi).
    const odulAlanlar = gercekKazananlar(winners);
    const kisiBasi = kazananPayi(odulAlanlar.length);

    const alanlar = {
      finishedAt: new Date().toISOString(),
      winners,
      rewardLc: kisiBasi,
    };

    // ⚠️ PARA KORUMASI: koşul (finishedAt boş mu) yazmanın İÇİNDE. Eskiden
    // yukarıdaki `if (cur.finishedAt) return` ile kontrol edilip sonra ödül
    // dağıtılıyordu; iki eşzamanlı çağrı ikisi de kontrolü geçip ödülü İKİ KEZ
    // verebilirdi. Artık yalnızca kazanan çağrı true alır.
    const bitirdi = await SocialStore.finishMini(t.id, alanlar, db);
    if (!bitirdi) return cur;
    Object.assign(cur, alanlar);

    if (winners.length) {
      const awarded = await awardMiniWinLc(winners, cur, db);
      console.log(
        `[mini] turnuva bitti: "${cur.name}" (${cur.id}) | kazanan: ${winners.join(", ")} | ` +
        `LC odulu: toplam ${MINI_WIN_LC} -> kisi basi ${kisiBasi} x ${awarded} kisi`
      );
    } else {
      console.log(`[mini] turnuva hükümsüz bitti (puan yok): "${cur.name}" (${cur.id})`);
    }
    return cur;
  } finally {
    _finalizing.delete(t.id);
  }
}

// ---- POST /api/mini/create ----
router.post("/create", verifyToken, express.json(), async (req, res) => {
  try {
    const db = req.app?.locals?.db || null;
    // ⚠️ KİMLİK GÖVDEDEN ALINMAZ. Bu üç uç kimlik doğrulamasızdı ve
    // `userId`'yi istek gövdesinden okuyordu: herkes BAŞKASININ adına turnuva
    // kurabiliyor, katılabiliyor ve davet edebiliyordu. Mini turnuva kazananı
    // LC alıyor (MINI_WIN_LC), yani bu doğrudan para yoluna açılan bir kimlik
    // taklidi açığıydı. Artık kimlik `req.uid`'den geliyor.
    const userId = String(req.uid || "").trim();
    const name = String(req.body?.name || "").trim().slice(0, 60);
    const fixtures = Array.isArray(req.body?.fixtures) ? req.body.fixtures : [];

    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });
    if (!name) return res.status(400).json({ ok: false, error: "NAME_REQUIRED" });
    // Turnuva başına maç sayısı üst sınırı premium'da daha yüksek
    // (erişim/kapasite ayrıcalığı — LC akışına dokunmaz).
    const isPrem = await premium.isPremium(userId, db);
    const maxFx = Math.max(MAX_FIXTURES, premium.miniMaxFixtures(isPrem));
    if (fixtures.length < MIN_FIXTURES || fixtures.length > maxFx) {
      return res.status(400).json({
        ok: false,
        error: "FIXTURE_COUNT_INVALID",
        detail: `${MIN_FIXTURES}-${maxFx} maç seçilmeli`,
      });
    }

    /* ⚠️ AÇIK MİNİ TURNUVA SINIRI — LC musluğunu sınırlar.
     *
     * Mini turnuvaya giriş ÜCRETSİZ ama bitince kazananlara MINI_WIN_LC
     * (varsayılan 20) veriliyor — yani karşılığı olmayan LC üretimi. Üstelik
     * kazanan "en yüksek puanda BERABERE kalan herkes": aynı tahmini yapan 5
     * hesap turnuva başına 5×20 = 100 LC üretir.
     *
     * Kaç turnuva kurulabileceğine dair hiçbir sınır yoktu (ne rotada ne
     * depoda); hız sınırı da dakikada 10 create'e izin veriyor.
     *
     * Sınır "aynı anda BİTMEMİŞ" üzerinden — günlük sayaç yerine bilinçli:
     * her turnuvanın bitmesi için seçilen maçların oynanması gerekir, yani
     * musluğun hızı gerçek fikstür takvimine bağlanır.
     *
     * ⚠️ Bu bir DENGE değil KÖTÜYE KULLANIM ayarı. Ödülün beraberlikte
     * bölüşülmesi mi yoksa herkese tam mı verilmesi gerektiği ayrı bir karar.
     */
    const maxOpen = premium.miniMaxOpen(isPrem);
    const hepsi = await loadAll(db);
    const acikTurnuvalar = hepsi.filter(
      (t) => !t.finishedAt && String(t.ownerId || t.creatorId || "").toLowerCase() === userId.toLowerCase()
    );
    const acik = acikTurnuvalar.length;

    /**
     * ⚠️ AYNI MAÇ SETİYLE İKİNCİ TURNUVA — ÖDÜLÜ ÇOĞALTIYORDU.
     *
     * Dosyanın kendi ilkesi: "ÖDÜL BÖLÜŞÜLÜR, ÇOĞALTILMAZ" (bkz. kazananPayi).
     * Ama o kural turnuvanın İÇİNDE uygulanıyordu; turnuvalar ARASI delikti.
     *
     * ÖLÇÜLDÜ (2026-08-02, ücretsiz kademe): aynı iki maçla ART ARDA iki
     * turnuva kuruldu, üçüncüsü TOO_MANY_OPEN_MINI ile durdu. Yani TEK tahmin
     * seti iki kez ödül alıyordu:
     *     2 maç x 3 LC giriş = 6 LC maliyet  →  2 x 20 = 40 LC ödül
     *     premium (6 açık)                   →  6 x 20 = 120 LC
     * `miniMaxOpen` musluğun HIZINI gerçek fikstüre bağlıyor ama aynı maçları
     * tekrar kullanmayı engellemiyordu — oysa asıl maliyet tahminler.
     *
     * ⚠️ YALNIZCA BİREBİR AYNI SET engelleniyor, kısmi örtüşme DEĞİL.
     * "Bugünün maçları" ve "hafta sonu" turnuvaları ortak maç taşıyabilir ve
     * bu meşru kullanım; hepsini kapatmak oyunu kırardı. Kısmi örtüşme hâlâ
     * çoğaltabilir — bu bir ÜRÜN kararı ve bilinçli olarak açık bırakıldı.
     */
    const setAnahtari = (liste) =>
      [...new Set(liste.map((f) => String(f?.fixtureId || f || "")).filter(Boolean))].sort().join("|");
    const yeniSet = setAnahtari(fixtures);
    if (yeniSet && acikTurnuvalar.some((t) => setAnahtari(t.fixtures || []) === yeniSet)) {
      return res.status(409).json({
        ok: false,
        error: "AYNI_MAC_SETI_ACIK",
        detail: "Bu maçlarla zaten açık bir turnuvan var; bitmesini bekle ya da farklı maç seç.",
      });
    }
    if (acik >= maxOpen) {
      return res.status(400).json({
        ok: false,
        error: "TOO_MANY_OPEN_MINI",
        open: acik,
        max: maxOpen,
        detail: `Aynı anda en fazla ${maxOpen} bitmemiş mini turnuvan olabilir.`,
      });
    }

    /* ⚠️ MAÇ BİLGİSİ ARTIK SUNUCUDAN — ÖZELLİKLE `kickoffISO`.
     *
     * Eskiden beş alan da istek gövdesinden olduğu gibi saklanıyordu. Bunlardan
     * `kickoffISO` GÖRÜNTÜ DEĞİL, KARAR verisi: turnuvanın bitip bitmeyeceğini
     * `bitmeyeHazirMi` → `bayatMi({ fixtureId, kickoffISO })` belirliyor ve
     * başlama saatinin üstünden `BEKLEME_SAAT` geçmişse maç "bayat" sayılıp
     * YOK SAYILIYOR.
     *
     * Yani kurucu her maça GEÇMİŞ bir saat yazarak turnuvayı istediği an
     * bitirilebilir hâle getiriyordu: kendi lehine sonuçlanan ilk maçtan sonra
     * `/board` çağırıp kalan maçları eledikten sonra MINI_WIN_LC'yi alıyordu.
     *
     * `lib/bayat-mac.cjs` sunucu tarafında bir yedek arama yapıyor ama YALNIZCA
     * saat OKUNAMADIĞINDA — geçerli ama yalan bir tarih o yedeği hiç
     * çalıştırmıyordu. (O dosyanın kendi notu bu alanın istemciden geldiğini
     * zaten yazıyor; eksik olan, yalan bir DEĞERİN de aynı kapıdan geçmesiydi.)
     *
     * Ek kazanç: fikstür kimliği artık var olmak zorunda. Önceden tamamen
     * uydurma kimliklerle turnuva kurulabiliyordu. */
    const FixturesStore = require("../lib/fixtures-store.cjs");
    const clean = [];
    const seen = new Set();
    const bulunamayan = [];
    for (const f of fixtures) {
      const fid = String(f?.fixtureId || "").trim();
      if (!fid || seen.has(fid)) continue;
      seen.add(fid);

      let fx = null;
      try {
        fx = await FixturesStore.getOne(fid, db);
      } catch (e) {
        console.error("[mini] fikstur okunamadi:", fid, e?.message || e);
      }
      if (!fx) { bulunamayan.push(fid); continue; }

      clean.push({
        fixtureId: fid,
        home: String(fx.home || fx.homeTeam || "").slice(0, 60) || null,
        away: String(fx.away || fx.awayTeam || "").slice(0, 60) || null,
        kickoffISO: fx.kickoffISO || fx.kickoff || null,
        league: String(fx.league || "").slice(0, 60) || null,
      });
    }
    if (bulunamayan.length) {
      return res.status(400).json({
        ok: false, error: "FIXTURE_NOT_FOUND", fixtures: bulunamayan,
        detail: "Bu maçlar bulunamadı; turnuva kurulamaz.",
      });
    }
    if (clean.length < MIN_FIXTURES) {
      return res.status(400).json({ ok: false, error: "FIXTURE_COUNT_INVALID" });
    }

    /* ⚠️ KOTA KAPISI YAZMAYLA AYNI KİLİTTE OLMAK ZORUNDA.
     *
     * Yukarıdaki sayım hızlı-ret için duruyor ama TEK BAŞINA yeterli değildi:
     * "kaç açık turnuvan var" OKUNUYOR, sonra turnuva YAZILIYOR — arada kilit
     * yoktu, yani eşzamanlı istekler hepsi aynı sayıyı görüp hepsi geçiyordu.
     *
     * ÖLÇÜLDÜ (bellek-içi Mongo, 8 eşzamanlı istek, 3 deneme, hepsinde aynı):
     *     kota 2 · kurulan turnuva 8   → kota 4 KAT aşıldı
     *
     * Bu bir görgü kuralı değil KÖTÜYE KULLANIM ayarı: yukarıdaki nota göre
     * mini turnuva girişi ÜCRETSİZ ama kazanana MINI_WIN_LC veriliyor, yani
     * karşılığı olmayan LC üretimi. Kotayı delmek muslugu açık bırakmak demek.
     *
     * ⚠️ KİLİT KULLANICI BAŞINA: kota da kullanıcı başına. Genel bir anahtar
     * tüm kullanıcıların turnuva kurmasını sıraya sokardı, gereksiz.
     * (`SocialStore.createMini` kendi içinde kilit almıyor — iç içe kilit
     * riski yok; `withFileLock` reentrant değildir.) */
    let sonuc = null;
    await withFileLock(`mini-create:${userId.toLowerCase()}`, async () => {
      const guncel = await loadAll(db);
      const acikSon = guncel.filter(
        (x) => !x.finishedAt && String(x.ownerId || x.creatorId || "").toLowerCase() === userId.toLowerCase()
      ).length;
      if (acikSon >= maxOpen) {
        sonuc = {
          kod: 400,
          govde: {
            ok: false, error: "TOO_MANY_OPEN_MINI", open: acikSon, max: maxOpen,
            detail: `Aynı anda en fazla ${maxOpen} bitmemiş mini turnuvan olabilir.`,
          },
        };
        return;
      }

      const codes = new Set(guncel.map((x) => x.code));
      const t = {
        id: "MINI-" + crypto.randomBytes(6).toString("hex"),
        code: newCode(codes),
        name,
        ownerId: userId,
        fixtures: clean,
        members: [userId],
        createdAt: new Date().toISOString(),
      };
      await SocialStore.createMini(t, db);
      sonuc = { kod: 200, govde: { ok: true, tournament: publicView(t) } };
    });

    return res.status(sonuc.kod).json(sonuc.govde);
  } catch (e) {
    console.error("[mini] create error:", e);
    return res.status(500).json({ ok: false, error: "MINI_CREATE_FAILED", detail: String(e?.message || e) });
  }
});

// ---- POST /api/mini/join ----
router.post("/join", verifyToken, express.json(), async (req, res) => {
  try {
    const db = req.app?.locals?.db || null;
    // ⚠️ KİMLİK GÖVDEDEN ALINMAZ. Bu üç uç kimlik doğrulamasızdı ve
    // `userId`'yi istek gövdesinden okuyordu: herkes BAŞKASININ adına turnuva
    // kurabiliyor, katılabiliyor ve davet edebiliyordu. Mini turnuva kazananı
    // LC alıyor (MINI_WIN_LC), yani bu doğrudan para yoluna açılan bir kimlik
    // taklidi açığıydı. Artık kimlik `req.uid`'den geliyor.
    const userId = String(req.uid || "").trim();
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!userId || !code) return res.status(400).json({ ok: false, error: "USER_OR_CODE_MISSING" });

    const items = await loadAll(db);
    const t = items.find((x) => String(x.code).toUpperCase() === code);
    if (!t) return res.status(404).json({ ok: false, error: "TOURNAMENT_NOT_FOUND" });

    // Kapasite koşulu sorgunun İÇİNDE ($expr + $size): eskiden kontrol ile
    // yazma arasında boşluk vardı, iki eşzamanlı katılım tavanı aşabilirdi.
    const sonuc = await SocialStore.addMiniMember(t.id, userId, MAX_MEMBERS, db);
    if (sonuc === "NOT_FOUND") return res.status(404).json({ ok: false, error: "TOURNAMENT_NOT_FOUND" });
    if (sonuc === "FULL")      return res.status(400).json({ ok: false, error: "TOURNAMENT_FULL" });

    t.members = Array.isArray(t.members) ? t.members : [];
    if (sonuc === "ALREADY") return res.json({ ok: true, tournament: publicView(t), already: true });
    if (!t.members.includes(userId)) t.members.push(userId);

    return res.json({ ok: true, tournament: publicView(t) });
  } catch (e) {
    console.error("[mini] join error:", e);
    return res.status(500).json({ ok: false, error: "MINI_JOIN_FAILED", detail: String(e?.message || e) });
  }
});

// ---- POST /api/mini/invite ----
// Üye olan bir kullanıcı, ARKADAŞI olan birini turnuvaya doğrudan ekler.
// Arkadaşlık zaten karşılıklı onayla kurulduğu için ayrıca kabul adımı yok;
// davet edilen, turnuvayı "Turnuvalarım" listesinde görür.

async function areFriends(u1, u2) {
  // Arkadaşlıklar Mongo birincil — bkz. lib/social-store.cjs
  const m = await SocialStore.loadFriends();
  const a = String(u1).toLowerCase();
  const b = String(u2).toLowerCase();

  const blocked = (m.blocks || []).some((x) => {
    const by = String(x.by || "").toLowerCase();
    const tg = String(x.target || "").toLowerCase();
    return (by === a && tg === b) || (by === b && tg === a);
  });
  if (blocked) return false;

  return (m.links || []).some((l) => {
    const la = String(l.a || "").toLowerCase();
    const lb = String(l.b || "").toLowerCase();
    return (la === a && lb === b) || (la === b && lb === a);
  });
}

router.post("/invite", verifyToken, express.json(), async (req, res) => {
  try {
    const db = req.app?.locals?.db || null;
    // ⚠️ KİMLİK GÖVDEDEN ALINMAZ. Bu üç uç kimlik doğrulamasızdı ve
    // `userId`'yi istek gövdesinden okuyordu: herkes BAŞKASININ adına turnuva
    // kurabiliyor, katılabiliyor ve davet edebiliyordu. Mini turnuva kazananı
    // LC alıyor (MINI_WIN_LC), yani bu doğrudan para yoluna açılan bir kimlik
    // taklidi açığıydı. Artık kimlik `req.uid`'den geliyor.
    const userId = String(req.uid || "").trim();
    const id = String(req.body?.id || "").trim();
    const friendUserId = String(req.body?.friendUserId || "").trim();
    if (!userId || !id || !friendUserId) {
      return res.status(400).json({ ok: false, error: "USER_ID_OR_FRIEND_MISSING" });
    }
    if (userId.toLowerCase() === friendUserId.toLowerCase()) {
      return res.status(400).json({ ok: false, error: "CANNOT_INVITE_SELF" });
    }

    const items = await loadAll();
    const t = items.find((x) => x.id === id);
    if (!t) return res.status(404).json({ ok: false, error: "TOURNAMENT_NOT_FOUND" });

    t.members = Array.isArray(t.members) ? t.members : [];
    if (!t.members.includes(userId)) {
      return res.status(403).json({ ok: false, error: "NOT_A_MEMBER" });
    }
    if (t.members.includes(friendUserId)) {
      return res.json({ ok: true, tournament: publicView(t), already: true });
    }
    if (!(await areFriends(userId, friendUserId))) {
      return res.status(403).json({ ok: false, error: "NOT_FRIENDS" });
    }
    const sonuc = await SocialStore.addMiniMember(t.id, friendUserId, MAX_MEMBERS, db);
    if (sonuc === "NOT_FOUND") return res.status(404).json({ ok: false, error: "TOURNAMENT_NOT_FOUND" });
    if (sonuc === "FULL")      return res.status(400).json({ ok: false, error: "TOURNAMENT_FULL" });
    if (sonuc === "ALREADY")   return res.json({ ok: true, tournament: publicView(t), already: true });

    t.members.push(friendUserId);
    return res.json({ ok: true, tournament: publicView(t), invited: friendUserId });
  } catch (e) {
    console.error("[mini] invite error:", e);
    return res.status(500).json({ ok: false, error: "MINI_INVITE_FAILED", detail: String(e?.message || e) });
  }
});

// ---- GET /api/mini/mine?userId= ----
router.get("/mine", verifyToken, async (req, res) => {
  try {
    // ⚠️ SAHIPLİK: kimlik sorgudan geliyordu; denetim yoktu.
    // bkz. lib/kimlik-kontrol.cjs
    const _k = kimlikVeyaHata(req, res, req.query.userId);
    if (!_k) return;
    const userId = _k.uid;

    const items = await loadAll();
    const mine = items
      .filter((t) => (t.members || []).includes(userId))
      .map(publicView)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return res.json({ ok: true, items: mine });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "MINI_LIST_FAILED", detail: String(e?.message || e) });
  }
});

/**
 * GET /api/mini/public?userId=  → katılınabilir turnuvalar
 *
 * ⚠️ NEDEN YENİ: mobil `app/(tabs)/live.tsx:954` bu ucu ÇAĞIRIYORDU ama uç
 * hiç yazılmamıştı. `apiJson` 404'te hata fırlatmayıp `{ok:false}` döndüğü
 * için çökme olmuyordu; "AÇIK TURNUVALAR" bölümü sadece KALICI OLARAK BOŞ
 * kalıyordu. Kullanıcı hiçbir turnuvayı keşfedemiyor, yalnızca kod elle
 * paylaşılırsa katılabiliyordu.
 *
 * ⚠️ "AÇIK" KAVRAMI VERİDE YOKTU, TANIMI BURADA YAPILIYOR. Turnuva belgesinde
 * görünürlük alanı yok (alanlar: id, code, name, ownerId, fixtures, members,
 * createdAt, finishedAt, winners, rewardLc). Katılım tek yoldan oluyor:
 * `POST /join` + `code`. Dolayısıyla "açık turnuva" = bitmemiş, dolmamış ve
 * kullanıcının zaten üye OLMADIĞI turnuva.
 *
 * ⚠️ LİSTELEMEK, KATILIM KODUNU YAYINLAMAKTIR — ve bu bilinçli bir karar.
 * `publicView` `code` alanını içeriyor ve mobil katılırken onu kullanıyor
 * (`/api/mini/join` yalnızca `code` kabul ediyor), yani kodsuz listeleme
 * işe yaramazdı. Sonuç: her turnuva fiilen herkese açık hâle geliyor.
 * Davet akışı (`POST /invite`) hâlâ çalışıyor ama artık tek keşif yolu değil.
 *
 * ⚠️ ÖZEL TURNUVA KAPISI ŞİMDİDEN VAR. Bugün hiçbir belgede `private` /
 * `visibility` alanı YOK, yani süzgeç hiçbir şeyi elemiyor. İleride "yalnızca
 * davetle" turnuva istenirse tek yapılacak `create`'te bu alanı yazmak;
 * listeleme tarafı hazır. Alanı sonradan eklerken burayı bulmak gerekmesin
 * diye baştan kondu.
 */
router.get("/public", async (req, res) => {
  try {
    /* Kimlik ZORUNLU DEĞİL: yalnızca "zaten üye olduklarını gizle" için
     * kullanılıyor, hiçbir gizli veri buna göre açılmıyor. Misafir de
     * turnuvaları görebilmeli — keşif ekranının amacı bu. */
    const userId = String(req.query.userId || "").trim();
    const uidLower = userId.toLowerCase();

    const items = await loadAll();
    const acik = items
      .filter((t) => {
        if (t.finishedAt) return false;                       // bitmiş
        if (t.private === true) return false;                 // ileriye dönük kapı
        if (String(t.visibility || "").toLowerCase() === "private") return false;
        const uyeler = t.members || [];
        if (uyeler.length >= MAX_MEMBERS) return false;        // dolu — katılınamaz
        if (uidLower && uyeler.some((m) => String(m).toLowerCase() === uidLower)) {
          return false;                                        // zaten üye → /mine'da
        }
        return true;
      })
      .map(publicView)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return res.json({ ok: true, items: acik });
  } catch (e) {
    console.error("[mini] public error:", e);
    return res.status(500).json({ ok: false, error: "MINI_PUBLIC_FAILED", detail: String(e?.message || e) });
  }
});

// ---- GET /api/mini/wins?userId= : kazanılan turnuvalar (profil vitrini) ----
router.get("/wins", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const items = await loadAll();
    const wins = items
      .filter(
        (t) =>
          t.finishedAt &&
          Array.isArray(t.winners) &&
          t.winners.some((w) => String(w).toLowerCase() === userId.toLowerCase())
      )
      .map((t) => ({
        id: t.id,
        name: t.name,
        finishedAt: t.finishedAt,
        rewardLc: t.rewardLc ?? 0,
        memberCount: (t.members || []).length,
        fixtureCount: (t.fixtures || []).length,
        shared: (t.winners || []).length > 1, // beraberlikte ortak şampiyonluk
      }))
      .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));

    return res.json({ ok: true, count: wins.length, items: wins });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "MINI_WINS_FAILED", detail: String(e?.message || e) });
  }
});

// ---- GET /api/mini/board?id= (veya ?code=) ----
router.get("/board", async (req, res) => {
  try {
    const id = String(req.query.id || "").trim();
    const code = String(req.query.code || "").trim().toUpperCase();
    if (!id && !code) return res.status(400).json({ ok: false, error: "ID_OR_CODE_REQUIRED" });

    const items = await loadAll();
    const t = items.find(
      (x) => (id && x.id === id) || (code && String(x.code).toUpperCase() === code)
    );
    if (!t) return res.status(404).json({ ok: false, error: "TOURNAMENT_NOT_FOUND" });

    const members = new Set(t.members || []);
    const fixtureIds = (t.fixtures || []).map((f) => String(f.fixtureId));

    // Settle edilmiş sonuç snapshot'ları (kullanıcı-başına puan satırları)
    // Yalnızca bu turnuvanın maçları — eskiden tüm kitap okunuyordu.
    const resultsArr = await MatchResults.listSnapshots({
      db: req.app?.locals?.db || null,
      fixtureIds,
    });
    const byFixture = new Map(resultsArr.map((r) => [String(r.fixtureId), r]));

    const totals = new Map(); // userId -> { points, settledMatches }
    for (const uid of members) totals.set(uid, { userId: uid, points: 0, settledMatches: 0 });

    const fixtureViews = [];
    let settledCount = 0;

    for (const f of t.fixtures || []) {
      const fid = String(f.fixtureId);
      const snap = byFixture.get(fid);

      // canlı/pending durum bilgisi için state dosyası
      const st = await readJson(guvenliYol(LIVE_DIR, fid, ".json"), null);

      const view = {
        ...f,
        status: st?.status || (snap ? "FT" : "NS"),
        score: st?.score || snap?.finalScore || null,
        settled: !!snap,
      };
      fixtureViews.push(view);

      if (!snap) continue;
      settledCount++;
      for (const row of snap.rows || []) {
        const uid = String(row.userId || "");
        if (!members.has(uid)) continue;
        const cur = totals.get(uid);
        cur.points += Number(row.points || 0);
        cur.settledMatches++;
      }
    }

    const board = Array.from(totals.values())
      .map((x) => ({ ...x, points: Math.round(x.points * 100) / 100 }))
      .sort((a, b) => b.points - a.points || a.userId.localeCompare(b.userId));

    // Tüm maçlar bittiyse turnuvayı sonlandır (kazanan + LC ödülü, bir kez)
    const finalT = await finalizeIfDone(t, board, settledCount, fixtureIds.length, req.app?.locals?.db || null, fixtureIds);

    return res.json({
      ok: true,
      tournament: publicView(finalT),
      fixtures: fixtureViews,
      board,
      settledCount,
      pendingCount: fixtureIds.length - settledCount,
    });
  } catch (e) {
    console.error("[mini] board error:", e);
    return res.status(500).json({ ok: false, error: "MINI_BOARD_FAILED", detail: String(e?.message || e) });
  }
});

module.exports = router;
// Test icin: odul bolusmesi PARA degismezi tasiyor (toplam MINI_WIN_LC'yi
// asamaz). Router'i ayaga kaldirmadan dogrulanabilsin diye disa aciliyor.
module.exports._kazananPayi = kazananPayi;
module.exports._MINI_WIN_LC = MINI_WIN_LC;
/* ⚠️ TEST GERCEK FONKSIYONU CAGIRSIN diye acildi. tests/mini-bot-odul-suzgeci
 * kendi kopyasini yaziyordu; buradaki suzgec bozulsa test YINE gecerdi. */
module.exports._gercekKazananlar = gercekKazananlar;
// Test icin: bitme sarti (bayat mac yok sayilmasi) dogrudan sinanabilsin.
module.exports._bitmeyeHazirMi = bitmeyeHazirMi;
