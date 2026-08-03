"use strict";

/**
 * GEÇMİŞ İKİZ FİKSTÜRLERİ BİRLEŞTİRİR.
 *
 * `lib/fikstur-ikiz.cjs` YENİ kopyaları engelliyor; bu betik depoda hâlihazırda
 * duran geçmiş ikizleri temizler. Ölçüm (2026-08-02): 115 çift / 230 kayıt,
 * 23'ünde uzlaşma yalnızca bir tarafta.
 *
 * KULLANIM:
 *   node scripts/ikiz-birlestir.cjs            # KURU KOŞU — hiçbir şey yazmaz
 *   node scripts/ikiz-birlestir.cjs --uygula   # gerçekten birleştirir
 *
 * KAZANAN KURALI (para etkiler, sıra önemli):
 *   1) Yalnızca biri uzlaşmışsa (match_results kaydı varsa) UZLAŞAN kazanır —
 *      ödemeler ona bağlı, onu silmek ödenmiş parayı tarihsiz bırakır.
 *   2) İKİSİ DE uzlaşmışsa ÇİFTE DOKUNULMAZ — iki tarafta da ödeme dönmüş,
 *      birleştirme çifte ödemeyi tekilleştiremez; yalnızca raporlanır.
 *   3) Hiçbiri uzlaşmamışsa bağlı verisi (insan tahmini + bahis + düello)
 *      fazla olan kazanır; eşitlikte daha uzun (kanonik) ad; yine eşitlikte
 *      kimlik sırası — fikstur-ikiz.cjs ile aynı determinizm gerekçesi.
 *
 * TAŞIMA KURALLARI (kaybeden → kazanan):
 *   - predictions: kullanıcının kazananda tahmini YOKSA fixtureId güncellenir.
 *     Varsa kaybedendeki SİLİNİR ve uzlaşmamışsa giriş bedeli İADE edilir
 *     (kullanıcı aynı maça iki kez ödemişti — bizim kopyamız yüzünden).
 *   - pool_bets: aynı kural; çakışmada kaybedendeki bahis tutarı iade edilir
 *     (havuz uzlaşmamışsa). pools belgesi kazananda yoksa taşınır, varsa
 *     kaybedeninki silinir (özet bahislerden yeniden hesaplanıyor).
 *   - duels: fixtureId güncellenir (uzlaşmış düelloya dokunulmaz — para döndü).
 *   - fixtures: kaybeden Mongo'dan silinir, dosya aynası tam listeyle yazılır.
 *
 * ⚠️ İADELER creditLc İLE — defter izi düşer (reason: ikiz_birlestirme_iade).
 */

require("dotenv").config({ quiet: true });
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const path = require("path");
const fs = require("fs");
const { ikizMi, _ad } = require("../lib/fikstur-ikiz.cjs");
const FixturesStore = require("../lib/fixtures-store.cjs");
const { getDb, close } = require("../lib/mongo.cjs");
const { MAC_GIRIS_BEDELI } = require("../lib/ekonomi.cjs");

const UYGULA = process.argv.includes("--uygula");

async function main() {
  const db = await getDb();
  if (!db) throw new Error("Mongo baglantisi yok — MONGODB_URI kontrol et");

  const fikstur = await FixturesStore.loadAll(db);
  const list = Array.isArray(fikstur) ? fikstur : [];
  console.log(`fikstur: ${list.length} kayit`);

  /* Çift bulma — fikstur-ikiz.cjs ile aynı kovalamayla ama BİLİNENLERİ
   * atlamadan: buradaki amaç tam tersine, bilinen ikizleri bulmak. */
  const kova = new Map();
  for (const f of list) {
    if (!f || f.fixtureId == null) continue;
    const k = `${String(f.kickoffISO || "").slice(0, 16)}|${_ad(f.country)}`;
    if (!kova.has(k)) kova.set(k, []);
    kova.get(k).push(f);
  }
  const ciftler = [];
  const eslesti = new Set();
  for (const grup of kova.values()) {
    if (grup.length < 2) continue;
    for (let i = 0; i < grup.length; i++) {
      for (let j = i + 1; j < grup.length; j++) {
        const a = grup[i], b = grup[j];
        const ia = String(a.fixtureId), ib = String(b.fixtureId);
        if (eslesti.has(ia) || eslesti.has(ib)) continue;
        if (!ikizMi(a, b)) continue;
        eslesti.add(ia); eslesti.add(ib);
        ciftler.push([a, b]);
      }
    }
  }
  console.log(`ikiz cifti: ${ciftler.length}`);

  const Preds = db.collection("predictions");
  const Bets = db.collection("pool_bets");
  const Pools = db.collection("pools");
  const Duels = db.collection("duels");
  const Results = db.collection("match_results");

  async function ekler(fid) {
    const [preds, bets, pool, duels, snap] = await Promise.all([
      Preds.find({ fixtureId: fid }).project({ userIdLower: 1, isBot: 1, _id: 0 }).toArray(),
      Bets.find({ fixtureId: fid }).project({ userIdLower: 1, amount: 1, side: 1, _id: 0 }).toArray(),
      Pools.findOne({ fixtureId: fid }),
      Duels.find({ fixtureId: fid }).project({ id: 1, status: 1, _id: 0 }).toArray(),
      Results.findOne({ fixtureId: fid }, { projection: { fixtureId: 1, settledAt: 1 } }),
    ]);
    const insanPred = preds.filter((p) => !p.isBot).length;
    return { preds, bets, pool, duels, snap, insanPred,
      agirlik: insanPred + bets.length + duels.length };
  }

  const plan = [];
  const sayac = { birlesecek: 0, dokunulmaz: 0,
    predTasi: 0, predSilIade: 0, betTasi: 0, betSilIade: 0,
    duelTasi: 0, poolTasi: 0, poolSil: 0, botPredSil: 0 };

  for (const [a, b] of ciftler) {
    const ia = String(a.fixtureId), ib = String(b.fixtureId);
    const [ea, eb] = await Promise.all([ekler(ia), ekler(ib)]);

    // Kural 2: ikisi de uzlaşmış → dokunma.
    if (ea.snap && eb.snap) {
      sayac.dokunulmaz++;
      plan.push({ eylem: "DOKUNMA", neden: "ikisi de uzlasmis",
        a: { id: ia, mac: `${a.home} - ${a.away}` }, b: { id: ib, mac: `${b.home} - ${b.away}` } });
      continue;
    }

    // Kural 1 ve 3: kazananı seç.
    let kazanan, kaybeden, ek;
    if (!!ea.snap !== !!eb.snap) {
      [kazanan, kaybeden] = ea.snap ? [a, b] : [b, a];
    } else if (ea.agirlik !== eb.agirlik) {
      [kazanan, kaybeden] = ea.agirlik > eb.agirlik ? [a, b] : [b, a];
    } else {
      const uzA = _ad(a.home).length + _ad(a.away).length;
      const uzB = _ad(b.home).length + _ad(b.away).length;
      if (uzA !== uzB) [kazanan, kaybeden] = uzA > uzB ? [a, b] : [b, a];
      else [kazanan, kaybeden] = ia < ib ? [a, b] : [b, a];
    }
    const kW = String(kazanan.fixtureId), kL = String(kaybeden.fixtureId);
    const eW = kW === ia ? ea : eb;
    const eL = kW === ia ? eb : ea;

    const adimlar = [];
    const wUsers = new Set(eW.preds.map((p) => p.userIdLower));
    for (const p of eL.preds) {
      /* ⚠️ BOT TAHMİNİ + KAZANAN UZLAŞMIŞ → SİL, TAŞIMA. Uzlaşma mühürlü;
       * taşınan tahmin bir daha asla uzlaşmaz ve kalıcı "uzlaşmamış" gürültü
       * olur. Botun parası yok, kaybı yok. İnsan tahmini olsaydı taşınırdı —
       * geçmişi kullanıcıya görünür kalsın diye. */
      if (p.isBot && (wUsers.has(p.userIdLower) || eW.snap)) { adimlar.push({ t: "botPredSil", u: p.userIdLower }); sayac.botPredSil++; }
      else if (!wUsers.has(p.userIdLower)) { adimlar.push({ t: "predTasi", u: p.userIdLower }); sayac.predTasi++; }
      else { adimlar.push({ t: "predSilIade", u: p.userIdLower, iade: MAC_GIRIS_BEDELI }); sayac.predSilIade++; }
    }
    const wBet = new Set(eW.bets.map((x) => x.userIdLower));
    const havuzUzlasti = !!(eL.pool && eL.pool.settledAt);
    for (const x of eL.bets) {
      if (!wBet.has(x.userIdLower)) { adimlar.push({ t: "betTasi", u: x.userIdLower, tutar: x.amount }); sayac.betTasi++; }
      else { adimlar.push({ t: "betSilIade", u: x.userIdLower, tutar: x.amount, havuzUzlasti }); sayac.betSilIade++; }
    }
    if (eL.pool) {
      if (!eW.pool) { adimlar.push({ t: "poolTasi" }); sayac.poolTasi++; }
      else { adimlar.push({ t: "poolSil" }); sayac.poolSil++; }
    }
    for (const d of eL.duels) {
      adimlar.push({ t: "duelTasi", id: d.id, status: d.status }); sayac.duelTasi++;
    }

    sayac.birlesecek++;
    plan.push({ eylem: "BIRLESTIR",
      kazanan: { id: kW, mac: `${kazanan.home} - ${kazanan.away}`, uzlasti: !!eW.snap, insanPred: eW.insanPred, bahis: eW.bets.length, duello: eW.duels.length },
      kaybeden: { id: kL, mac: `${kaybeden.home} - ${kaybeden.away}`, uzlasti: !!eL.snap, insanPred: eL.insanPred, bahis: eL.bets.length, duello: eL.duels.length,
        botPred: eL.preds.length - eL.insanPred },
      adimlar });
  }

  const raporYolu = path.join(__dirname, "..", "data", `ikiz-birlestirme-raporu${UYGULA ? "" : "-KURU"}.json`);
  fs.writeFileSync(raporYolu, JSON.stringify({ tarih: new Date().toISOString(), uygula: UYGULA, sayac, plan }, null, 2));
  console.log(`\nOZET  ${JSON.stringify(sayac)}`);
  console.log(`rapor: ${raporYolu}`);

  if (!UYGULA) {
    console.log("\nKURU KOSU — hicbir sey yazilmadi. Uygulamak icin: --uygula");
    await close().catch(() => {});
    return;
  }

  /* ─────────────────────────── UYGULAMA ─────────────────────────── */

  // Önce YEDEK: silinecek/taşınacak her belgenin tam kopyası diske.
  const yedek = { tarih: new Date().toISOString(), ciftler: [] };
  for (const p of plan) {
    if (p.eylem !== "BIRLESTIR") continue;
    const kL = p.kaybeden.id;
    yedek.ciftler.push({
      kazanan: p.kazanan.id,
      fikstur: await db.collection(FixturesStore.COLL).findOne({ fixtureId: kL }, { projection: { _id: 0 } }),
      preds: await Preds.find({ fixtureId: kL }).project({ _id: 0 }).toArray(),
      bets: await Bets.find({ fixtureId: kL }).project({ _id: 0 }).toArray(),
      pool: await Pools.findOne({ fixtureId: kL }, { projection: { _id: 0 } }),
      duels: await Duels.find({ fixtureId: kL }).project({ _id: 0 }).toArray(),
    });
  }
  const yedekYolu = path.join(__dirname, "..", "data", `ikiz-birlestirme-yedek-${Date.now()}.json`);
  fs.writeFileSync(yedekYolu, JSON.stringify(yedek, null, 2));
  console.log(`yedek: ${yedekYolu} (${yedek.ciftler.length} cift)`);

  const Wallet = require("../lib/wallet-credit.cjs");
  let hata = 0;

  for (const p of plan) {
    if (p.eylem !== "BIRLESTIR") continue;
    const kW = p.kazanan.id, kL = p.kaybeden.id;
    try {
      for (const s of p.adimlar) {
        if (s.t === "predTasi") {
          await Preds.updateOne({ fixtureId: kL, userIdLower: s.u }, { $set: { fixtureId: kW, ikizden: kL } });
        } else if (s.t === "predSilIade") {
          await Preds.deleteOne({ fixtureId: kL, userIdLower: s.u });
          /* Kaybeden uzlaşmamış (uzlaşan taraf her zaman kazanan seçiliyor;
           * ikisi de uzlaşmışsa çifte hiç dokunulmuyor) → giriş bedeli iade. */
          const ok = await Wallet.creditLc(db, s.u, s.iade, "ikiz_birlestirme_iade", { fixtureId: kL, tasindi: kW });
          if (!ok) { hata++; console.error(`IADE YAZILAMADI pred ${s.u} ${kL}`); }
        } else if (s.t === "botPredSil") {
          await Preds.deleteOne({ fixtureId: kL, userIdLower: s.u });
        } else if (s.t === "betTasi") {
          await Bets.updateOne({ fixtureId: kL, userIdLower: s.u }, { $set: { fixtureId: kW, ikizden: kL } });
        } else if (s.t === "betSilIade") {
          await Bets.deleteOne({ fixtureId: kL, userIdLower: s.u });
          if (!s.havuzUzlasti) {
            const ok = await Wallet.creditLc(db, s.u, Number(s.tutar) || 0, "ikiz_birlestirme_iade", { fixtureId: kL, tur: "pool_bet", tasindi: kW });
            if (!ok) { hata++; console.error(`IADE YAZILAMADI bet ${s.u} ${kL}`); }
          }
        } else if (s.t === "poolTasi") {
          await Pools.updateOne({ fixtureId: kL }, { $set: { fixtureId: kW, ikizden: kL } });
        } else if (s.t === "poolSil") {
          await Pools.deleteOne({ fixtureId: kL });
        } else if (s.t === "duelTasi") {
          await Duels.updateOne({ id: s.id }, { $set: { fixtureId: kW, ikizden: kL } });
        }
      }
      // Uzlaşma kaydı kaybedende olamaz (kural 1) ama yine de kontrol:
      const artan = await Results.findOne({ fixtureId: kL }, { projection: { _id: 1 } });
      if (artan) { hata++; console.error(`BEKLENMEDIK: ${kL} uzlasma kaydi tasiyor, fikstur silinmedi`); continue; }
      await db.collection(FixturesStore.COLL).deleteOne({ fixtureId: kL });
    } catch (e) {
      hata++; console.error(`cift islenemedi ${kL}: ${e?.message || e}`);
    }
  }

  // Dosya aynasını tam listeyle tazele (saveAll tam-liste semantiği).
  const kalanlar = await db.collection(FixturesStore.COLL)
    .find({}, { projection: { _id: 0 } }).toArray();
  FixturesStore.invalidateCache();
  await FixturesStore.saveAll(kalanlar, db);

  console.log(`\nUYGULANDI  hata=${hata}  kalan fikstur=${kalanlar.length}`);
  await close().catch(() => {});
  if (hata) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
