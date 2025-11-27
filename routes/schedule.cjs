"use strict";

const { buildOrder, markUsage, setPreferred } = require("../lib/providers.cjs");

/** Sağlayıcıya göre tek gün fikstürü çek (TSDB → FDO → AF; kota/başarı durumuna göre) */
async function provGetFixturesByDate(isoDate, teamHint){
  const order = await buildOrder(teamHint||"");
  for (const NAME of order){
    const t0 = Date.now();
    try{
      if (NAME==="TSDB"){
        const arr = await tsdbByDate_real(isoDate); // aşağıda ekleyeceğiz/yada mevcutsa kullan
        await markUsage("TSDB", true, Date.now()-t0);
        if (arr && arr.length){ if(teamHint) await setPreferred(teamHint,"TSDB"); return arr; }
      } else if (NAME==="FDO"){
        const arr = await fdoByDate(isoDate);
        await markUsage("FDO", true, Date.now()-t0);
        if (arr && arr.length){ if(teamHint) await setPreferred(teamHint,"FDO"); return arr; }
      } else if (NAME==="AF"){
        const arr = await provGetFixturesByDate(isoDate);
        await markUsage("AF", true, Date.now()-t0);
        if (arr && arr.length){ if(teamHint) await setPreferred(teamHint,"AF"); return arr; }
      }
    }catch(e){
      try{ await markUsage(NAME, false, Date.now()-t0); }catch{}
      // sonraki sağlayıcıya dene
    }
  }
  return [];
}
module.exports = require("./live.cjs");
async function tsdbByDate_real(isoDate){
  try{
    // TheSportsDB ücretsiz uç: günde tarihe göre country filtre yok — basit örnek
    // Bu örnek minimal: boş dizi dönüyorsa AF/FDO devralacak.
    return [];
  }catch{ return []; }
}

async function fdoByDate(isoDate){
  try{
    // football-data.org benzeri ücretsiz sınırlı uçlar olabilir; örnek/placeholder
    return [];
  }catch{ return []; }
}

/** === TSDB gerçek: gün bazında futbol maçları (ülke + üst lig filtreli) ===
 *  Kaynak: https://www.thesportsdb.com/api/v1/json/1/eventsday.php?d=YYYY-MM-DD&s=Soccer
 *  Not: Ücretsiz uç genel gün listesi döndürür; biz ALLOWED / isTopLeague ile süzeriz.
 */
async function tsdbByDate_real(isoDate){
  try{
    const base = process.env.TSDB_BASE || "https://www.thesportsdb.com/api/v1/json/1";
    const url  = `${base}/eventsday.php?d=${encodeURIComponent(isoDate)}&s=Soccer`;

    // safeFetch zaten dosyada var (schedule.cjs içinde kullandık)
    const r = await safeFetch(url, {}, 12000);
    const j = await r.json();
    const arr = Array.isArray(j?.events) ? j.events : [];

    // TSDB → normalize
    const list = arr.map(x => {
      // TSDB alanları: idEvent, strLeague, strCountry, strHomeTeam, strAwayTeam, strTimestamp (UTC ISO), dateEvent, strTime
      const ts = x?.strTimestamp
        || (x?.dateEvent ? `${x.dateEvent}T${(x.strTime||"00:00:00")}Z` : null);

      return {
        fixtureId:  x?.idEvent || null,
        kickoffISO: ts,
        league:     x?.strLeague  || null,
        country:    x?.strCountry || null,
        home:       x?.strHomeTeam|| null,
        away:       x?.strAwayTeam|| null,
        status:     "NS",
        source:     "tsdb"
      };
    });

    // Ülke ve üst lig filtresi (schedule.cjs’te tanımlı: ALLOWED + isTopLeague)
    return list.filter(it => it.country && ALLOWED[it.country] && isTopLeague(it.country, it.league));
  }catch{
    return [];
  }
}
