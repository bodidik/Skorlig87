"use strict";

/**
 * LC EKONOMİ RAPORU — arz, dağılım, giriş/çıkış akışı.
 *
 * NEDEN VAR: LC arzı kontrolsüz büyüyordu ve bu ancak 2026-07-29'da ELLE
 * ölçünce görüldü. O anki tablo:
 *
 *     toplam giriş 2.182 LC · toplam çıkış 15 LC · oran 145:1
 *     medyan bakiye 2 LC · en yüksek 229 LC
 *     1291 oyuncunun %100'ü her maçta kâr ediyordu
 *
 * Denge ayarları (iade eşiği, günlük taban, kesinti oranları) bu rapor olmadan
 * körlemesine yapılır. Değişikliğin etkisi ertesi gün burada görünmeli.
 *
 * Salt okunur — hiçbir şey yazmaz.
 */

const path = require("path");
const fsp = require("fs").promises;

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");

const sayi = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

function yuzdelik(sirali, f) {
  if (!sirali.length) return 0;
  return sirali[Math.min(sirali.length - 1, Math.floor(sirali.length * f))];
}

/** Bakiye dizisinden dağılım özeti. */
function dagilim(bakiyeler) {
  const s = [...bakiyeler].sort((a, b) => a - b);
  const toplam = s.reduce((a, b) => a + b, 0);
  // Yoğunlaşma: en zengin %10 toplam arzın ne kadarını tutuyor?
  const ustDilim = s.slice(Math.floor(s.length * 0.9));
  return {
    cuzdan: s.length,
    toplamArz: Math.round(toplam * 10) / 10,
    min: s[0] ?? 0,
    medyan: yuzdelik(s, 0.5),
    p75: yuzdelik(s, 0.75),
    p95: yuzdelik(s, 0.95),
    max: s[s.length - 1] ?? 0,
    ortalama: s.length ? Math.round((toplam / s.length) * 10) / 10 : 0,
    // Tek bir oyuncunun arzı domine etmesi erken uyarı işaretidir.
    enZenginYuzde10Payi:
      toplam > 0 ? Math.round((ustDilim.reduce((a, b) => a + b, 0) / toplam) * 100) : 0,
  };
}

/* ⚠️ BİR KERELİK GİRİŞLER — orandan HARİÇ TUTULUR.
 *
 * Bunlar hesap başına bir kez verilir; tekrarlayan bir musluk değildir ve
 * hiçbir denge kaldıracı bunları "kısarak" düzeltmez.
 *
 * Ayrım olmadan rapor tam da YAYINDA yanıltır: 1000 yeni kayıt = 30.000 LC
 * bir kerelik giriş, ve steady-state ekonomi kusursuz dengede olsa bile oran
 * haftalarca "ENFLASYONIST 15:1" gösterir. O rakama bakıp yanlış muslukları
 * kısmak, ölçüm hatasının verdiği yanlış karardır.
 *
 * Ölçüldü (üretim, 30 gün): giriş 69 LC'nin 60'ı `initial_default`. Oran
 * 3.3:1 "enflasyonist" görünüyordu; bir kerelikler çıkarılınca giriş 9 /
 * çıkış 21, yani aslında DEFLASYONIST.
 */
const BIR_KERELIK = new Set([
  "initial_default",
  "initial_1987",
  /* ⚠️ AŞAĞIDAKİ İKİSİNİ HİÇBİR KOD YAZMIYOR — bilerek duruyorlar.
   *
   * Rapor GEÇMİŞ defter satırlarını da okuyor; üretimde bu sebeplerle yazılmış
   * eski kayıtlar olabilir. Listeden çıkarmak onları "tekrarlayan giriş"
   * kovasına düşürür, yani bir kerelik geçmiş kayıtlar musluk gibi görünür ve
   * enflasyon ölçümü şişer. Ölü liste girdisi burada bir hata DEĞİL, geçmiş
   * veriye karşı koruma. */
  "signup_bonus",
  "migration",
]);

/* ⚠️ İADELER — ne giriş ne çıkış.
 *
 * İade, daha önce ALINAN parayı geri verir. Girişe yazılırsa hem giriş hem
 * çıkış şişer ve oran bozulur: 3 LC alınıp 3 LC iade edildiğinde ekonomi
 * değişmemiştir ama rapor "3 giriş / 3 çıkış" gösterir.
 */
/* ⚠️ LİSTE GERÇEKLİKTEN GERİ KALMIŞTI. Yukarıdaki kural dört sebeple
 * yazılmıştı; sonradan SEKİZ iade yolu daha eklendi ve hiçbiri buraya
 * yazılmadı. Sınıflandırılmayan pozitif kayıt varsayılan olarak MUSLUK
 * sayılıyor, yani rapor kendi anlattığı hatayı sekiz yerde yapıyordu:
 * iadeler enflasyon gibi görünüyor ve `durum: ENFLASYONIST` kararı şişiyordu.
 *
 * Ekonomiyi bu rapora bakarak dengelemek, var olmayan bir muslugu kısmak
 * demekti.
 *
 * Aşağıdaki nöbetçi (tests/ekonomi-siniflandirma.test.cjs) yeni bir iade
 * sebebinin listeye yazılmadan eklenmesini engelliyor. */
const IADE = new Set([
  "entry_refund",
  "duel_tie_refund",
  "duel_cancel_refund",
  "tournament_entry_refund",
  // Sonradan eklenen iade yolları:
  "duel_accept_refund",      // kabul alınamadı, bahis geri
  "duel_void_refund",        // maç bayat, düello geçersiz
  "pred_void_refund",        // maç bayat, tahmin bedeli geri
  "pool_void_refund",        // maç bayat, havuz bahsi geri
  "pool_bet_refund",         // bahis yazılamadı, LC geri
  "pool_refund_no_winner",   // kimse bilemedi, havuz tamamen iade
  "kupon_giris_iade",        // kupona katılım alınamadı
  "kupon_iade",              // yeterli sonuç yok, giriş bedeli geri
]);

/** Defter kayıtlarından kalem kalem giriş/çıkış. */
function akis(kayitlar, sinirISO) {
  const giris = {};
  const cikis = {};
  const birKerelik = {};
  const iade = {};
  let n = 0;

  for (const t of kayitlar) {
    if (sinirISO && String(t.createdAt || "") < sinirISO) continue;
    const a = sayi(t.amount);
    if (!a) continue;
    n++;
    const sebep = String(t.reason || t.kind || "bilinmiyor");
    const kova =
      IADE.has(sebep) ? iade :
      BIR_KERELIK.has(sebep) ? birKerelik :
      a > 0 ? giris : cikis;
    kova[sebep] = Math.round((sayi(kova[sebep]) + Math.abs(a)) * 10) / 10;
  }

  const topla = (o) => Math.round(Object.values(o).reduce((a, b) => a + b, 0) * 10) / 10;
  const tg = topla(giris);          // TEKRARLAYAN giriş — denge kaldıraçları bunu etkiler
  const tc = topla(cikis);
  const tbk = topla(birKerelik);
  const ti = topla(iade);

  return {
    islem: n,
    giris,
    cikis,
    // Ayrı raporlanır: arzı büyütürler ama "musluk" değildirler.
    birKerelik,
    iade,
    toplamGiris: tg,
    toplamCikis: tc,
    toplamBirKerelik: tbk,
    toplamIade: ti,
    // Arzın gerçek değişimi (bir kerelikler DAHİL) — büyüme takibi için.
    netArzDegisimi: Math.round((tg + tbk - tc) * 10) / 10,
    net: Math.round((tg - tc) * 10) / 10,
    // ⚠️ Oran YALNIZCA tekrarlayan kalemlerden. Bir kerelik açılış bakiyeleri
    // ve iadeler dışarıda; bkz. BIR_KERELIK / IADE notları.
    girisCikisOrani: tc > 0 ? Math.round((tg / tc) * 10) / 10 : null,
    durum: tg > tc ? "ENFLASYONIST" : tg < tc ? "deflasyonist" : "dengeli",
  };
}

async function dosyadanOku() {
  try {
    const raw = JSON.parse(await fsp.readFile(WALLET_FILE, "utf8"));
    return {
      users: Array.isArray(raw?.users) ? raw.users : [],
      ledger: Array.isArray(raw?.ledger) ? raw.ledger : [],
    };
  } catch {
    return { users: [], ledger: [] };
  }
}

/**
 * Ekonomi raporu.
 *
 * ⚠️ Defter tam taranır; büyük veride pahalıdır. Yönetim ucu için uygundur,
 * istek yolunda KULLANILMAMALI.
 *
 * @param {object|null} db  Mongo (yoksa dosyadan okunur)
 * @param {number} gun      akış penceresi (varsayılan 7)
 */
async function economyReport(db, gun = 7) {
  const sinirISO = new Date(Date.now() - gun * 86400000).toISOString();
  const gunlukSinirISO = new Date(Date.now() - 86400000).toISOString();

  let bakiyeler = [];
  let kayitlar = [];
  let kaynak = "dosya";

  if (db) {
    kaynak = "mongo";
    try {
      const users = await db
        .collection("lc_wallet_users")
        .find({}, { projection: { balance: 1 } })
        .toArray();
      bakiyeler = users.map((u) => sayi(u.balance));

      // Yalnızca pencere içindeki kayıtlar — tüm defteri çekmek gereksiz.
      kayitlar = await db
        .collection("lc_wallet_ledger")
        .find({ createdAt: { $gte: sinirISO } }, { projection: { amount: 1, reason: 1, kind: 1, createdAt: 1 } })
        .toArray();
    } catch (e) {
      console.error("[economy] mongo okunamadi, dosyaya dusuluyor:", e?.message || e);
      kaynak = "dosya (mongo hatasi)";
      const d = await dosyadanOku();
      bakiyeler = d.users.map((u) => sayi(u.balance));
      kayitlar = d.ledger;
    }
  } else {
    const d = await dosyadanOku();
    bakiyeler = d.users.map((u) => sayi(u.balance));
    kayitlar = d.ledger;
  }

  const d7 = akis(kayitlar, sinirISO);
  const d1 = akis(kayitlar, gunlukSinirISO);

  const uyarilar = [];
  if (d7.girisCikisOrani === null && d7.toplamGiris > 0) {
    uyarilar.push("Hiç gider kaydı yok — LC yalnızca yaratılıyor.");
  } else if (d7.girisCikisOrani !== null && d7.girisCikisOrani > 3) {
    uyarilar.push(
      `Tekrarlayan giriş/çıkış oranı ${d7.girisCikisOrani}:1 — gider kalemleri yetersiz.`
    );
  }
  // Bir kerelikler oranın DIŞINDA ama arzı büyütür. Yayında baskın kalem
  // onlar olacak; "enflasyon var mı" sorusuna oran değil bu satır cevap verir.
  if (d7.toplamBirKerelik > 0) {
    uyarilar.push(
      `Son 7 günde ${d7.toplamBirKerelik} LC bir kerelik giriş (açılış bakiyesi vb.) — ` +
      `orana dahil DEĞİL, hesap başına bir kez verilir. Toplam arz değişimi: ${d7.netArzDegisimi} LC.`
    );
  }
  const dag = dagilim(bakiyeler);
  if (dag.enZenginYuzde10Payi >= 60) {
    uyarilar.push(
      `Arzın %${dag.enZenginYuzde10Payi}'i en zengin %10'da — yoğunlaşma yüksek.`
    );
  }

  return {
    kaynak,
    olcumZamani: new Date().toISOString(),
    bakiye: dag,
    akis: { son24saat: d1, [`son${gun}gun`]: d7 },
    uyarilar,
    not:
      "Hedef: giriş/çıkış oranı 1'e yakın. Denge kaldıraçları — " +
      "SKORLIG_REFUND_MIN_BASE (iade eşiği), SKORLIG_DAILY_FLOOR (günlük taban), " +
      "havuz/düello kesinti oranları.",
  };
}

module.exports = { economyReport, _dagilim: dagilim, _akis: akis };
