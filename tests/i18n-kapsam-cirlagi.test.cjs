"use strict";

/**
 * MOBİL i18n KAPSAM CIRCIRI (ratchet) — SABİT TÜRKÇE METİN GERİ GELMESİN.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-08-03, mobil depo): 52 ekran dosyasının yalnızca 1'i i18n
 * kullanıyordu; 783 satırda sabit Türkçe metin vardı. Uygulama 22 dil
 * biliyor ama Yunan/Japon kullanıcı çoğu ekranı Türkçe görüyordu — global
 * oyun (19 ülkelik bot kadrosu, ülke sıralaması) bunun üstüne kurulu.
 *
 * KAPSAM KARARI (2026-08-03): yeni anahtarlar yalnız tr+en; diğer 20 dil
 * t()'nin İngilizce yedeğine düşer. 783 × 22 el çevirisi yerine önce Türkçe
 * sabitten kurtulmak seçildi. Admin ekranları BİLİNÇLİ hariç (tek kullanıcı).
 *
 * CIRCIR: toplam sabit-Türkçe satır sayısı TAVANI aşamaz. Geçiş ilerledikçe
 * tavan AŞAĞI çekilir; yukarı çekmek bilinçli bir karar olmalı.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const MOBIL = path.join(__dirname, "..", "..", "mobile");
const TR = /[çğıöşüÇĞİÖŞÜ]/;

/**
 * Geçişi TAMAMLANMIŞ dosyalar. `izin` = bilinçli bırakılan satır sayısı:
 * admin kartı/ban paneli (me), admin runtime modalı + profil etiketleri
 * (stats) tek kullanıcıya (sana) görünür ve kapsam kararıyla hariç;
 * predict'teki 2 satır sunucu ETİKETİYLE karşılaştırma + veri istisnası.
 * İzin AŞILIRSA kullanıcıya görünen yeni Türkçe sabit girmiş demektir.
 */
const TAMAMLANAN = [
  { rel: "app/(tabs)/me.tsx", izin: 12 },
  { rel: "app/(tabs)/predict.tsx", izin: 2 },
  { rel: "app/(tabs)/stats.tsx", izin: 18 },
];

/* Takım/özel adlar Türkçe karakter taşıyabilir (Fenerbahçe, Beşiktaş) —
 * bunlar çeviri değil VERİ. Tamamlanan dosyalarda kalmasına izin verilenler: */
const VERI_ISTISNASI = /Fenerbahçe|Beşiktaş|KartalGözü/;

/** Ölçüm — scratchpad'deki i18n-olc ile AYNI kural: yorumlar atılır,
 *  string literallerinde ve JSX metinlerinde Türkçe karakter aranır. */
const TAVAN = 340; // 2026-08-03: ... -> 360 -> 340 (mystatus+OyunModlari)

function say(dosya) {
  const src = fs.readFileSync(dosya, "utf8");
  let n = 0;
  const bulunan = [];
  for (const l of src.split(/\r?\n/)) {
    const kirp = l.trim();
    if (kirp.startsWith("//") || kirp.startsWith("*") || kirp.startsWith("/*")) continue;
    const m = l.match(/"[^"]*"|'[^']*'|`[^`]*`|>[^<>{}]*</g) || [];
    for (const x of m) {
      if (TR.test(x)) { n++; bulunan.push(kirp.slice(0, 90)); break; }
    }
  }
  return { n, bulunan };
}

function dosyalar() {
  const out = [];
  for (const kok of ["app", "components"]) {
    const d = path.join(MOBIL, kok);
    if (!fs.existsSync(d)) continue;
    (function gez(p) {
      for (const a of fs.readdirSync(p, { withFileTypes: true })) {
        const yol = path.join(p, a.name);
        if (a.isDirectory()) gez(yol);
        else if (/\.tsx?$/.test(a.name)) out.push(yol);
      }
    })(d);
  }
  return out;
}

describe("mobil i18n kapsam cırcırı", () => {
  test("kurulum sınandı: sayaç GERÇEKTEN Türkçe metin yakalıyor", () => {
    /* ⚠️ Sayaç bozulursa (regex, yorum süzgeci) her iddia boş yere yeşil
     * kalır. Bilinen Türkçe-metinli bir dosya pozitif vermeli. */
    if (!fs.existsSync(MOBIL)) return; // başka checkout — iddia atlanır
    const p = path.join(MOBIL, "lib", "i18n.ts");
    assert.ok(say(p).n > 30, "sayac i18n.ts'in tr blogunu bile gormuyor — olcum bozuk");
  });

  test("geçişi tamamlanan ekranlar admin-payının üstüne ÇIKMAZ", () => {
    if (!fs.existsSync(MOBIL)) return;
    const suclu = [];
    for (const { rel, izin } of TAMAMLANAN) {
      const { bulunan } = say(path.join(MOBIL, rel));
      const gercek = bulunan.filter((l) => !VERI_ISTISNASI.test(l));
      if (gercek.length > izin) {
        suclu.push(`${rel}: ${gercek.length} > izin ${izin}, ornek: ${gercek[0]}`);
      }
    }
    assert.deepEqual(suclu, [],
      "tamamlanan ekrana sabit Turkce metin GERI geldi:\n" + suclu.join("\n"));
  });

  test(`CIRCIR: toplam sabit Türkçe satır ≤ ${TAVAN}`, () => {
    if (!fs.existsSync(MOBIL)) return;
    let toplam = 0;
    const enKotu = [];
    for (const f of dosyalar()) {
      const { n } = say(f);
      toplam += n;
      if (n > 0) enKotu.push({ f: path.relative(MOBIL, f), n });
    }
    enKotu.sort((a, b) => b.n - a.n);
    assert.ok(toplam <= TAVAN,
      `sabit Turkce metinli satir ${toplam} > tavan ${TAVAN} — yeni ekran Turkce sabitle mi yazildi? ` +
      `En kotu 5: ${enKotu.slice(0, 5).map((x) => `${x.f}(${x.n})`).join(", ")}. ` +
      `Gecis ILERLEDIKCE tavani asagi cek; yukari cekmek bilincli karar olmali.`);
  });

  test("tr'deki HER anahtar en'de de var (yedek zinciri kopmasın)", () => {
    /**
     * ⚠️ Kapsam kararının bel kemiği: 20 dil en'e düşüyor. tr'ye eklenen bir
     * anahtar en'de yoksa t() anahtarın KENDİSİNİ basar ("nickSaved" gibi) —
     * kullanıcıya kod sızar.
     */
    if (!fs.existsSync(MOBIL)) return;
    const src = fs.readFileSync(path.join(MOBIL, "lib", "i18n.ts"), "utf8");
    const blok = (ad) => {
      const i = src.indexOf(`  ${ad}: {`);
      assert.ok(i > 0, `${ad} blogu bulunamadi — dosya bicimi degisti, test guncellenmeli`);
      const j = src.indexOf("\n  },", i);
      return src.slice(i, j);
    };
    const anahtarlar = (b) => new Set(
      [...b.matchAll(/^\s{4}([A-Za-z0-9_]+):\s/gm)].map((m) => m[1])
    );
    const tr = anahtarlar(blok("tr"));
    const en = anahtarlar(blok("en"));
    assert.ok(tr.size > 100, `tr anahtar sayisi supheli az (${tr.size}) — ayristirma bozuk`);
    const eksik = [...tr].filter((k) => !en.has(k));
    assert.deepEqual(eksik, [],
      "tr'de olup en'de olmayan anahtar(lar): " + eksik.join(", "));
  });

  test("parametreli anahtarların {yer} tutucuları tr/en'de AYNI", () => {
    /* ⚠️ t() yer tutucuyu adla dolduruyor: en çevirisi {n} yerine {x} yazarsa
     * kullanıcı ekranda "{n}" görür. */
    if (!fs.existsSync(MOBIL)) return;
    const src = fs.readFileSync(path.join(MOBIL, "lib", "i18n.ts"), "utf8");
    const cek = (ad) => {
      const i = src.indexOf(`  ${ad}: {`);
      const j = src.indexOf("\n  },", i);
      const out = new Map();
      for (const m of src.slice(i, j).matchAll(/^\s{4}([A-Za-z0-9_]+):\s+"((?:[^"\\]|\\.)*)"/gm)) {
        const ph = [...m[2].matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((x) => x[1]).sort().join(",");
        out.set(m[1], ph);
      }
      return out;
    };
    const tr = cek("tr"), en = cek("en");
    const uyusmayan = [];
    for (const [k, ph] of tr) {
      if (en.has(k) && en.get(k) !== ph) uyusmayan.push(`${k}: tr={${ph}} en={${en.get(k)}}`);
    }
    assert.deepEqual(uyusmayan, [],
      "yer tutuculari uyusmayan anahtar(lar): " + uyusmayan.join("; "));
  });
});
