(async ()=>{
  const urls = [
    // Genel test / echo
    "https://httpbin.org/get",
    "https://api.ipify.org?format=json",
    "https://jsonplaceholder.typicode.com/posts/1",

    // Spor odaklı (genelde ücretsiz/public)
    "https://www.thesportsdb.com/api/v1/json/1/searchteams.php?t=Galatasaray",
    "https://www.scorebat.com/video-api/v3/",

    // API-Football host (sadece host erişim testi)
    "https://v3.football.api-sports.io/status",
    // fallback: public CDN (küçük JSON)
    "https://api.github.com/zen"
  ];

  for (const u of urls){
    try {
      const r = await fetch(u, { method: "GET", redirect: "follow" });
      const ct = r.headers.get("content-type") || "";
      const status = r.status;
      // read as text to avoid parse error
      const txt = await r.text();
      const snippet = txt.slice(0,300).replace(/\n/g,' ');
      console.log("----");
      console.log("URL: " + u);
      console.log("Status:", status, "Content-Type:", ct);
      console.log("Body start:", snippet.length ? snippet : "(empty)");
    } catch (e) {
      console.log("----");
      console.log("URL: " + u);
      console.log("ERROR:", e.toString());
    }
  }
})();
