"use strict";

/**
 * ÜLKE BOTU ÜRETECİ — bot-profiles.json'a eksik ülkeleri ekler.
 *
 * NEDEN: Kadro 12 segmentten oluşuyordu ve hepsi Avrupa + Arjantin'di. Japon
 * bir kullanıcı ülke sıralamasını açtığında listede kendinden başka kimse
 * olmuyordu — "kendi ülkende yarış" vaadi boş kalıyordu.
 *
 * Üretim DETERMİNİSTİK: aynı segment aynı isimleri üretir. Tekrar
 * çalıştırılabilir (idempotent) — var olan bot kimlikleri korunur, sadece
 * eksikler eklenir. Böylece emekli/aktif ayrımı (bot-legacy-ids.json)
 * bozulmaz.
 *
 * Kullanım:
 *   node scripts/gen-country-bots.cjs           # ne olacağını yazar, dosyaya dokunmaz
 *   node scripts/gen-country-bots.cjs --write   # bot-profiles.json'u günceller
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILES = path.join(DATA_DIR, "bot-profiles.json");

/**
 * pred.cjs → apply1987Logic() bot kimliğinde bu parçaları görürse botu
 * "1987 Galatasaray romantiği" sayar ve skor tahminini GS lehine büker.
 * Japon/Brezilyalı bota bu mantık uygulanamaz — üretilen hiçbir kimlik bu
 * parçaları İÇERMEMELİ. Özellikle "87": rastgele numara aralığı 17-99 olduğu
 * için kolayca oluşuyor (ilk denemede Mengao87 üretildi).
 */
const RESERVED_1987 = ["87", "1987", "prekazi", "hagi", "cimbom", "aslan", "sami", "metin"];

function is1987Reserved(id) {
  const s = String(id).toLowerCase();
  return RESERVED_1987.some((k) => s.includes(k));
}

/* ── Kadro planı ───────────────────────────────────────────────────────────
 * Kulüp adları odds-engine.cjs TEAM_RATINGS ile birebir aynı olmalı; yoksa
 * bot DEFAULT_RATING (65) alır ve taraftarlık karakteri kaybolur.
 *
 * Lakaplar KULÜBE BAĞLI. Mevcut kadro da böyle: Godenzonen→Ajax,
 * Dragao→Porto, Anderlecht→Anderlecht. Bağımsız eşleme "Mengao" (Flamengo
 * lakabı) botunu Palmeiras taraftarı yapıyordu — o ülkenin oyuncusu için
 * anında sahte görünen bir detay.
 *
 * Bot sayısı ligin kullanıcı potansiyeline göre: bir ülke sıralamasının canlı
 * hissettirmesi için ~40 kişi yeterli, altındaki liste seyrek görünüyor.
 */
const PLAN = {
  JPN: {
    count: 40,
    clubs: {
      "Kawasaki Frontale":   ["Frontale", "Kawasaki", "Todoroki"],
      "Yokohama F. Marinos": ["Marinos", "Yokohama", "Torikolo"],
      "Urawa Reds":          ["UrawaRed", "RedsFan", "Saitama"],
      "Vissel Kobe":         ["Vissel", "KobeFan", "Noevir"],
      "Gamba Osaka":         ["GambaOsk", "Osaka", "Suita"],
      "Kashima Antlers":     ["Antlers", "Kashima", "Ibaraki"],
    },
  },
  BRA: {
    count: 60,
    clubs: {
      "Flamengo":      ["Mengao", "Rubronegro", "Nacao"],
      "Palmeiras":     ["Verdao", "Porco", "Alviverde"],
      "Corinthians":   ["Fiel", "Timao", "Alvinegro"],
      "São Paulo":     ["Tricolor", "SoberanoSP", "Morumbi"],
      "Santos":        ["Peixe", "Alvinegro", "VilaBelmiro"],
      "Grêmio":        ["Imortal", "Tricolor", "Arena"],
      "Internacional": ["Colorado", "Beira", "Inter"],
      "Fluminense":    ["Flu", "Tricolor", "Laranjeiras"],
    },
  },
  USA: {
    count: 40,
    clubs: {
      "LA Galaxy":            ["GalaxyFan", "CarsonLA", "LAGalaxy"],
      "LAFC":                 ["Blackblue", "LAFCFan", "Angeleno"],
      "Inter Miami":          ["MiamiPink", "InterMia", "Herons"],
      "Seattle Sounders":     ["Sounder", "CascadiaS", "RaveGreen"],
      "Atlanta United":       ["ATLUTD", "FiveStripe", "Mercedes"],
      "New York Red Bulls":   ["RBNY", "MetroFan", "Harrison"],
    },
  },
  MEX: {
    count: 40,
    clubs: {
      "Club América": ["Aguila", "Americanista", "Azulcrema"],
      "Guadalajara":  ["Chiva", "Rojiblanco", "Chivahermano"],
      "Cruz Azul":    ["Cementero", "Maquina", "CruzAzul"],
      "Tigres UANL":  ["Tigre", "Incomparable", "Volcan"],
      "Monterrey":    ["Rayado", "Albiazul", "Gigante"],
      "Pumas UNAM":   ["Puma", "Auriazul", "Universidad"],
    },
  },
  SAU: {
    count: 40,
    clubs: {
      "Al-Hilal":    ["Zaeem", "Hilali", "Azraq"],
      "Al-Nassr":    ["Nasrawi", "Alami", "Asfar"],
      "Al-Ittihad":  ["Ittihadi", "Amid", "Jeddah"],
      "Al-Ahli":     ["Ahlawi", "Raqi", "Akhdar"],
    },
  },
  GRE: {
    count: 20,
    clubs: {
      "Olympiakos":    ["Thrylos", "Pireas", "Erythrolefkos"],
      "Panathinaikos": ["Trifylli", "Prasinos", "Leoforos"],
      "AEK Athens":    ["Dikefalos", "Enosi", "Kitrinos"],
      "PAOK":          ["Aspromavros", "Toumba", "Salonika"],
    },
  },
  RUS: {
    count: 20,
    clubs: {
      "Zenit St. Petersburg": ["Zenitchik", "Piter", "Nevsky"],
      "Spartak Moscow":       ["Krasnobely", "Myaso", "Spartach"],
      "CSKA Moscow":          ["Armeec", "Konyushnya", "Krasnosiny"],
      "Lokomotiv Moscow":     ["Zheleznaya", "Parovoz", "Cherkizovo"],
    },
  },
  POL: {
    count: 20,
    clubs: {
      "Legia Warsaw":        ["Legionista", "Wojskowi", "Lazienkowska"],
      "Lech Poznań":         ["Kolejorz", "Lechita", "Bulgarska"],
      "Raków Częstochowa":   ["Medaliki", "Rakow", "Czestochowa"],
      "Wisła Kraków":        ["BialaGwiazda", "Wislak", "Reymonta"],
    },
  },

  /* ── İkinci dalga: bot doluluk sistemi kurulunca fark edilen boşluk ───────
   * Sunucunun desteklediği 28 ülkenin 9'unda hiç bot yoktu; o ülkelerin
   * maçları global kadroyla doluyor, ülke sıralamaları boş kalıyordu.
   * Lakaplar yine KULÜBE BAĞLI (tribün/şehir/stadyum karşılığı).
   */
  UKR: {
    count: 20,
    clubs: {
      "Shakhtar Donetsk": ["Hirnyky", "Shakhtar", "Donbas"],
      "Dynamo Kyiv":      ["Dynamivets", "Kyivlyanyn", "Lobanovskyi"],
      "Zorya Luhansk":    ["Zorya", "Luhansk", "Chornomorets"],
      "Dnipro-1":         ["Dnipro", "Sicheslav", "Dniprovets"],
    },
  },
  SUI: {
    count: 20,
    clubs: {
      "FC Basel":     ["Bebbi", "Rotblau", "Joggeli"],
      "Young Boys":   ["Gelbschwarz", "Wankdorf", "Berner"],
      "Servette":     ["Grenat", "Geneve", "Praille"],
      "FC St. Gallen": ["Espenblock", "Gallus", "Kybunpark"],
    },
  },
  CRO: {
    count: 20,
    clubs: {
      "Dinamo Zagreb": ["Modri", "Maksimir", "Purger"],
      "Hajduk Split":  ["Bili", "Poljud", "Torcida"],
      "HNK Rijeka":    ["Rijeka", "Kvarner", "Rujevica"],
      "NK Osijek":     ["Osijek", "Slavonac", "Drava"],
    },
  },
  SRB: {
    count: 20,
    clubs: {
      "Red Star Belgrade": ["Zvezdas", "Marakana", "Delija"],
      "Partizan Belgrade": ["Grobar", "Humska", "Parni"],
      "Vojvodina":         ["Vosa", "Novisad", "Karadjordje"],
    },
  },
  CZE: {
    count: 20,
    clubs: {
      "Slavia Prague":  ["Sesivani", "Eden", "Slavista"],
      "Sparta Prague":  ["Letna", "Sparta", "Rudi"],
      "Viktoria Plzen": ["Viktorka", "Plzen", "Doosan"],
    },
  },
  ROU: {
    count: 20,
    clubs: {
      "FCSB":                  ["Ros-albastru", "Ghencea", "Stelist"],
      "CFR Cluj":              ["Feroviar", "Cluj", "Gruia"],
      "Universitatea Craiova": ["Craiova", "Oltenia", "Stiinta"],
      "Rapid Bucureşti":       ["Giulesti", "Rapidist", "Vișinii"],
    },
  },
  HUN: {
    count: 20,
    clubs: {
      "Ferencváros":     ["Fradi", "Groupama", "Zoldfeher"],
      "MOL Fehérvár":    ["Fehervar", "Sostoi", "Videoton"],
      "Puskás Akadémia": ["Felcsut", "Akademia", "Pancho"],
      "Újpest":          ["Ujpest", "Lilak", "Megyeri"],
    },
  },
  SVK: {
    count: 20,
    clubs: {
      "Slovan Bratislava":   ["Belasi", "Tehelne", "Slovanista"],
      "Spartak Trnava":      ["Andel", "Trnava", "Spartakovec"],
      "MŠK Žilina":          ["Sosoni", "Zilina", "Vodarska"],
      "DAC Dunajská Streda": ["Zlatozluti", "Dunajska", "Sarlo"],
    },
  },
  BUL: {
    count: 20,
    clubs: {
      "Ludogorets Razgrad": ["Orlite", "Razgrad", "Ludogorec"],
      "CSKA Sofia":         ["Armeec", "Balgarska", "Chervenite"],
      "Levski Sofia":       ["Sinite", "Gerena", "Levskar"],
      "Lokomotiv Plovdiv":  ["Smurfove", "Plovdiv", "Lokomotiv"],
    },
  },
};

/* Mevcut kadronun tier oranı: elite %15 · solid %50 · wild %35.
   Yeni ülkeler aynı dağılımı almalı — yoksa bir ülkenin botları sistematik
   olarak daha iyi/kötü tahmin eder ve ülke sıralamaları kıyaslanamaz olur. */
function tierFor(i, total) {
  const r = i / total;
  if (r < 0.15) return "elite";
  if (r < 0.65) return "solid";
  return "wild";
}

/**
 * Deterministik üretim. Kulüpler sırayla dolaşılır, her kulübün kendi lakap
 * havuzundan isim alınır — böylece lakap-kulüp eşlemesi hep doğru kalır.
 *
 * Numara 17-99 arası; "87" içeren veya çakışan kimlikler atlanıp bir sonraki
 * numaraya geçilir (üretim yine deterministik, sadece bazı numaralar boş kalır).
 */
function buildProfiles(segment, spec, taken) {
  const out = [];
  const clubNames = Object.keys(spec.clubs);

  for (let i = 0; i < spec.count; i++) {
    const club = clubNames[i % clubNames.length];
    const pool = spec.clubs[club];
    const handle = pool[Math.floor(i / clubNames.length) % pool.length];

    // Aynı handle için farklı numara; çakışma/rezerve durumunda ilerle.
    let id = null;
    for (let step = 0; step < 90; step++) {
      const num = 17 + ((i * 37 + step * 11) % 83);
      const cand = `${handle}${num}`;
      const key = cand.toLowerCase();
      if (is1987Reserved(cand) || taken.has(key)) continue;
      taken.add(key);
      id = cand;
      break;
    }
    if (!id) throw new Error(`${segment}/${handle} için uygun kimlik bulunamadı`);

    out.push({ id, club, segment, tier: tierFor(i, spec.count) });
  }
  return out;
}

function main() {
  const write = process.argv.includes("--write");
  const existing = JSON.parse(fs.readFileSync(PROFILES, "utf8"));
  if (!Array.isArray(existing)) throw new Error("bot-profiles.json dizi degil");

  const taken = new Set(existing.map((p) => String(p.id).toLowerCase()));
  const added = [];
  const skipped = [];

  // Segment düzeyinde idempotanlık — ŞART.
  // buildProfiles çakışan kimlik bulunca bir sonraki numaraya geçer; bu yüzden
  // zaten üretilmiş bir segment tekrar işlenirse çakışma yaşamaz, sadece FARKLI
  // numaralarla ikinci bir kadro üretir ve o ülkenin bot sayısını ikiye katlar.
  // Kimlik bazlı `taken` kontrolü bunu yakalayamaz.
  const existingSegments = new Set(
    existing.map((p) => String(p.segment || "").toUpperCase())
  );

  for (const [segment, spec] of Object.entries(PLAN)) {
    if (existingSegments.has(segment.toUpperCase())) {
      skipped.push(segment);
      continue;
    }
    added.push(...buildProfiles(segment, spec, taken));
  }

  if (skipped.length) {
    console.log(`Atlanan (kadrosu zaten var): ${skipped.join(", ")}\n`);
  }

  const bySeg = {};
  for (const p of added) bySeg[p.segment] = (bySeg[p.segment] || 0) + 1;

  console.log("Eklenecek botlar:");
  for (const [s, n] of Object.entries(bySeg)) console.log(`  ${s.padEnd(4)} ${n}`);
  console.log(`  toplam: ${added.length}`);
  console.log(`Kadro: ${existing.length} → ${existing.length + added.length}`);

  const leaked = added.filter((p) => is1987Reserved(p.id));
  console.log(`1987GS mantığını tetikleyen kimlik: ${leaked.length}${leaked.length ? " → " + leaked.map(p => p.id).join(", ") : " ✓"}`);

  if (!write) {
    console.log("\n(kuru calisma — dosyaya yazmak icin --write)");
    return;
  }

  fs.writeFileSync(PROFILES, JSON.stringify(existing.concat(added), null, 2) + "\n", "utf8");
  console.log("\nYAZILDI:", PROFILES);
}

main();
