"use strict";

/**
 * EKONOMİ RAPORU İADEYİ MUSLUK SAYMAMALI.
 *
 * ⚠️ BULUNAN: `lib/economy-report.cjs` iadeleri ayrı kovada tutuyor ve
 * gerekçesini kendi yorumunda yazıyor —
 *
 *   "İade, daha önce ALINAN parayı geri verir. Girişe yazılırsa hem giriş hem
 *    çıkış şişer ve oran bozulur: 3 LC alınıp 3 LC iade edildiğinde ekonomi
 *    değişmemiştir ama rapor '3 giriş / 3 çıkış' gösterir."
 *
 * Ama liste DÖRT sebeple yazılmıştı ve sonradan SEKİZ iade yolu daha eklendi
 * (düello kabul/geçersiz iadesi, tahmin ve havuz bayat iadeleri, havuz yazım
 * hatası iadesi, kazanansız havuz iadesi, iki kupon iadesi). Hiçbiri listeye
 * yazılmadı. Sınıflandırılmayan pozitif kayıt varsayılan olarak MUSLUK
 * sayılıyor — yani rapor kendi anlattığı hatayı sekiz yerde yapıyordu ve
 * `durum: ENFLASYONIST` kararı şişiyordu.
 *
 * Ekonomiyi bu rapora bakarak dengelemek, var olmayan bir muslugu kısmak
 * demekti.
 *
 * ⚠️ AYNI SINIF ÜÇÜNCÜ KEZ: elle tutulan liste ile gerçeklik ayrışıyor
 * (istemci uç listesi, ödeme mührü sebep listesi, bu). Nöbetçi listeyi
 * KODDAN türetiyor, elle yazılmış bir kopyayla karşılaştırmıyor.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const RAPOR = path.join(KOK, "lib", "economy-report.cjs");

/** Yorumları boşaltır; satır numaraları korunur. */
function kodu(kaynak) {
  return kaynak
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

/** `const <AD> = new Set([...])` içeriği. */
function kume(ad) {
  const src = fs.readFileSync(RAPOR, "utf8");
  const bas = src.indexOf(`const ${ad} = new Set([`);
  if (bas < 0) return null;
  const son = src.indexOf("]);", bas);
  return new Set([...src.slice(bas, son).matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]));
}

/** Kod tabanında deftere yazılan TÜM sebepler. */
function defterSebepleri() {
  const out = new Set();
  for (const alt of ["routes", "lib", "services"]) {
    const d = path.join(KOK, alt);
    if (!fs.existsSync(d)) continue;
    for (const dosya of fs.readdirSync(d)) {
      if (!dosya.endsWith(".cjs")) continue;
      const src = kodu(fs.readFileSync(path.join(d, dosya), "utf8"));
      // creditLc/spendLc/ode(db, uid, tutar, "<sebep>")
      for (const m of src.matchAll(/(?:creditLc|spendLc|\bode)\([^,]+,[^,]+,[^,]+,\s*"([a-z_0-9]+)"/g)) {
        out.add(m[1]);
      }
      /* ⚠️ `reason:` SATIRINDAKİ TÜM METİNLER ALINIYOR, ilk tırnak değil.
       * İlk sürüm `reason:\s*"..."` arıyordu ve
       *     reason: is1987 ? "initial_1987" : "initial_default"
       * biçimini HİÇ görmedi — sonuç: "bu sebepler kodda yok" diye DOĞRU KODDA
       * yanlış alarm. Tarayıcının göremediği biçim, bu oturumda üçüncü kez
       * yanlış sonuç üretti. */
      for (const satir of src.split("\n")) {
        const i = satir.indexOf("reason:");
        if (i < 0) continue;
        for (const m of satir.slice(i).matchAll(/"([a-z_0-9]+)"/g)) out.add(m[1]);
      }
    }
  }
  return out;
}

/** Adı iade/geri-verme anlamı taşıyanlar. */
const IADE_GIBI = /(?:_refund|_iade|^iade_|_void_)/;

test("iade adı taşıyan her sebep İADE olarak sınıflandırılmış", () => {
  const IADE = kume("IADE");
  assert.ok(IADE, "IADE kumesi okunamadi — tarama bozuk");

  const hepsi = [...defterSebepleri()];
  assert.ok(hepsi.length >= 20, `cok az sebep bulundu (${hepsi.length}) — tarama bozulmus olabilir`);

  const adayLar = hepsi.filter((s) => IADE_GIBI.test(s)).sort();
  assert.ok(adayLar.length >= 8, `cok az iade sebebi bulundu (${adayLar.length})`);

  const eksik = adayLar.filter((s) => !IADE.has(s));
  assert.deepStrictEqual(
    eksik,
    [],
    "Bu iadeler MUSLUK olarak sayiliyor. Rapor kendi anlattigi hatayi yapar:\n" +
      "iade girise yazilinca hem giris hem cikis siser, `durum` yanlis cikar\n" +
      "ve ekonomi var olmayan bir muslugu kismaya calisir:\n" + eksik.join("\n")
  );
});

test("İADE listesi bayat değil — kodda olmayan sebep listede kalmasın", () => {
  /**
   * Ters yön de önemli: silinmiş bir sebep listede kalırsa liste güvenilmez
   * olur ve sonraki okuyan "burası zaten kapsanmış" diye bakmaz.
   */
  const IADE = kume("IADE");
  const hepsi = defterSebepleri();
  const artikYok = [...IADE].filter((s) => !hepsi.has(s));
  assert.deepStrictEqual(
    artikYok,
    [],
    "Bu sebepler kodda yok, IADE listesinden cikarilmali:\n" + artikYok.join("\n")
  );
});

/**
 * ⚠️ BURADA "BAYAT" ÖLÇÜTÜ İADE'DEN FARKLI.
 *
 * `signup_bonus` ve `migration` sebeplerini hiçbir kod yazmıyor ama listede
 * BİLEREK duruyorlar: rapor geçmiş defter satırlarını da okuyor ve üretimde
 * bu sebeplerle yazılmış eski kayıtlar olabilir. Listeden çıkarmak onları
 * "tekrarlayan giriş" kovasına düşürürdü — bir kerelik geçmiş kayıtlar musluk
 * gibi görünür, enflasyon ölçümü şişerdi.
 *
 * Yani ölü liste girdisi burada hata değil, geçmiş veriye karşı koruma. Test
 * onları muaf tutuyor ama YENİ bir ölü girdinin sessizce eklenmesini
 * engelliyor.
 */
const TARIHSEL = new Set(["signup_bonus", "migration"]);

test("BİR_KERELİK listesine gerekçesiz ölü girdi eklenemez", () => {
  const BK = kume("BIR_KERELIK");
  assert.ok(BK, "BIR_KERELIK kumesi okunamadi");
  const hepsi = defterSebepleri();
  const artikYok = [...BK].filter((s) => !hepsi.has(s) && !TARIHSEL.has(s));
  assert.deepStrictEqual(
    artikYok,
    [],
    "Bu sebepler kodda yok. Gecmis veri icin duruyorsa TARIHSEL listesine\n" +
      "gerekcesiyle ekle, degilse BIR_KERELIK'ten cikar:\n" + artikYok.join("\n")
  );

  // Ters yön: muafiyet listesi de bayatlamasın.
  const gereksizMuaf = [...TARIHSEL].filter((s) => hepsi.has(s));
  assert.deepStrictEqual(
    gereksizMuaf,
    [],
    "Bu sebepler artik kodda YAZILIYOR, TARIHSEL muafiyetinden cikarilmali:\n" +
      gereksizMuaf.join("\n")
  );
});

/* ── Davranış ────────────────────────────────────────────────────────────── */

test("iadeler GİRİŞ kovasına düşmüyor", async () => {
  /**
   * Asıl değişmez metinde değil davranışta: iade kayıtları `iade` kovasına
   * gitmeli, `giris`e değil. Sınıflandırma bozulursa `toplamGiris` ve
   * `girisCikisOrani` şişer, `durum` yanlış çıkar.
   *
   * ⚠️ İLK SÜRÜMÜM YANLIŞ ŞEYİ BEKLİYORDU: "harcama + iade çifti net arzı
   * değiştirmez" diye yazmıştım, ama `netArzDegisimi = giriş + birKerelik −
   * çıkış` ve iadeler bu formülde HİÇ yok. Yani çift, harcama kadar
   * DEFLASYON gibi görünüyor. Bu ayrı bir tasarım sorusu (kullanıcıya
   * bildirildi); burada sınıflandırmayı sınıyorum, formülü değil.
   */
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  const mongod = await MongoMemoryServer.create();
  const client = await MongoClient.connect(mongod.getUri());
  try {
    const db = client.db("test");
    const now = new Date().toISOString();
    await db.collection("lc_wallet_users").insertOne({
      userId: "u1", userIdLower: "u1", balance: 100, createdAt: now,
    });

    const IADE = kume("IADE");
    const ornek = [...IADE].filter((s) => s !== "entry_refund");
    assert.ok(ornek.length >= 4, "yeterli iade sebebi yok");

    const kayitlar = [];
    for (const sebep of ornek) {
      kayitlar.push({ userId: "u1", userIdLower: "u1", kind: "spend", amount: -10,
                      reason: "pool_bet", createdAt: now });
      kayitlar.push({ userId: "u1", userIdLower: "u1", kind: "reward", amount: 10,
                      reason: sebep, createdAt: now });
    }
    await db.collection("lc_wallet_ledger").insertMany(kayitlar);

    const { economyReport } = require("../lib/economy-report.cjs");
    const rap = await economyReport(db, 7);
    const h = rap.akis?.son7gun;
    assert.ok(h, "rapor sekli beklenmedik");

    assert.equal(
      h.toplamGiris, 0,
      `iadeler GIRIS kovasina dusmus (${JSON.stringify(h.giris)}) — musluk gibi sayiliyorlar`
    );
    assert.equal(h.toplamIade, 10 * ornek.length, "iade kovasi eksik");
    assert.equal(h.toplamCikis, 10 * ornek.length, "harcamalar cikis kovasinda olmali");

    /* Formülün bugünkü hâli belgeleniyor: iadeler `netArzDegisimi`ye HİÇ
     * girmiyor, yani harcama+iade çifti harcama kadar deflasyon gösteriyor.
     * Değişirse bu iddia kırılır ve karar bilinçli verilir. */
    assert.equal(
      h.netArzDegisimi, -10 * ornek.length,
      "netArzDegisimi formulu degismis — iadelerin cikisi dengeleyip dengelemedigi karari gozden gecirilmeli"
    );
  } finally {
    await client.close();
    await mongod.stop();
  }
});
