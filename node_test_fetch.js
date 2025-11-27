(async ()=>{
  try {
    const r = await fetch("https://www.thesportsdb.com/api/v1/json/1/searchteams.php?t=Galatasaray");
    const j = await r.json();
    console.log("✅ TheSportsDB bağlantısı başarılı:", j.teams?.[0]?.strTeam || "Bulunamadı");
  } catch(err) {
    console.error("❌ Hata:", err);
  }
})();
