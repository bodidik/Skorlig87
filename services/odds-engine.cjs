"use strict";

// ────────────────────────────────────────────────────────────────
// Global TEAM_RATINGS — ~500 takım, 40+ lig
//
// Rating ölçeği: 50-100 arası. Kaynak: UEFA koeffisiyent, ClubElo,
// FIFA sıralamaları ve lig gücü katsayıları.
//
// Lig gücü referansları (ortalama rating):
//   Premier League ~82, La Liga ~80, Serie A ~79, Bundesliga ~78,
//   Ligue 1 ~75, Süper Lig ~70, Eredivisie ~73, Liga Portugal ~72,
//   J-League ~65, K-League ~64, CSL ~63, MLS ~67, A-League ~62
// ────────────────────────────────────────────────────────────────

const TEAM_RATINGS = {
  // ── ENGLAND (Premier League + Championship) ────────────────────
  "Manchester City": 93, "Liverpool": 92, "Arsenal": 89, "Chelsea": 88,
  "Tottenham": 83, "Tottenham Hotspur": 83, "Spurs": 83,
  "Manchester United": 82, "Man United": 82, "Man Utd": 82,
  "Newcastle United": 82, "Newcastle": 82, "Aston Villa": 81,
  "Brighton": 80, "Brighton & Hove Albion": 80,
  "West Ham": 79, "West Ham United": 79, "Crystal Palace": 77,
  "Fulham": 76, "Wolverhampton": 76, "Wolves": 76,
  "Bournemouth": 75, "Brentford": 75, "Everton": 74,
  "Nottingham Forest": 76, "Leicester City": 74, "Leicester": 74,
  "Ipswich Town": 70, "Ipswich": 70, "Southampton": 71,
  "Burnley": 72, "Luton Town": 68, "Sheffield United": 70,
  "Leeds United": 73, "Leeds": 73, "Norwich City": 69,
  "Sunderland": 71, "Middlesbrough": 70, "West Bromwich": 69, "West Brom": 69,
  "Coventry City": 68, "Watford": 68, "Stoke City": 67,
  "Swansea City": 67, "Hull City": 67, "Blackburn Rovers": 66,
  "Bristol City": 66, "Millwall": 65, "Preston North End": 65,
  "Queens Park Rangers": 64, "QPR": 64, "Cardiff City": 65,
  "Plymouth Argyle": 63, "Sheffield Wednesday": 65, "Rotherham United": 62,

  // ── SPAIN (La Liga + Segunda) ──────────────────────────────────
  "Real Madrid": 97, "Barcelona": 95, "FC Barcelona": 95,
  "Atletico Madrid": 88, "Atlético Madrid": 88, "Atletico de Madrid": 88,
  "Real Sociedad": 80, "Villarreal": 79, "Athletic Bilbao": 79, "Athletic Club": 79,
  "Real Betis": 78, "Sevilla": 77, "Sevilla FC": 77,
  "Girona": 77, "Osasuna": 74, "Celta Vigo": 74, "Celta de Vigo": 74,
  "Getafe": 73, "Rayo Vallecano": 72, "Mallorca": 72, "RCD Mallorca": 72,
  "Las Palmas": 70, "Valencia": 75, "Valencia CF": 75,
  "Cadiz": 68, "Cádiz": 68, "Almeria": 67, "Almería": 67,
  "Granada": 68, "Alavés": 69, "Deportivo Alavés": 69,
  "Valladolid": 68, "Real Valladolid": 68, "Espanyol": 70, "RCD Espanyol": 70,
  "Leganes": 68, "Leganés": 68, "Real Zaragoza": 66, "Sporting Gijon": 66,
  "Elche": 65, "Huesca": 64, "Tenerife": 65, "Racing Santander": 63,

  // ── ITALY (Serie A + Serie B) ──────────────────────────────────
  "Inter": 88, "Inter Milan": 88, "Internazionale": 88,
  "Juventus": 86, "AC Milan": 84, "Milan": 84,
  "Napoli": 84, "Atalanta": 83, "Roma": 82, "AS Roma": 82,
  "Lazio": 80, "Fiorentina": 79, "Bologna": 77,
  "Torino": 74, "Monza": 72, "Udinese": 73,
  "Sassuolo": 72, "Empoli": 71, "Lecce": 70,
  "Cagliari": 70, "Verona": 69, "Hellas Verona": 69,
  "Genoa": 71, "Salernitana": 66, "Frosinone": 65,
  "Como": 68, "Venezia": 67, "Parma": 69, "Cremonese": 64,
  "Palermo": 66, "Sampdoria": 67, "Brescia": 64, "Bari": 65,
  "Catanzaro": 62, "Spezia": 66, "Pisa": 65, "Modena": 63,

  // ── GERMANY (Bundesliga + 2. Bundesliga) ───────────────────────
  "Bayern München": 94, "Bayern Münih": 94, "Bayern Munich": 94,
  "Borussia Dortmund": 85, "Dortmund": 85, "BVB": 85,
  "Bayer Leverkusen": 85, "Leverkusen": 85,
  "RB Leipzig": 83, "Leipzig": 83, "Eintracht Frankfurt": 80, "Frankfurt": 80,
  "VfB Stuttgart": 79, "Stuttgart": 79,
  "Wolfsburg": 76, "VfL Wolfsburg": 76,
  "Borussia Mönchengladbach": 75, "Mönchengladbach": 75, "Gladbach": 75,
  "Union Berlin": 74, "SC Freiburg": 76, "Freiburg": 76,
  "Hoffenheim": 74, "TSG Hoffenheim": 74,
  "Werder Bremen": 73, "Bremen": 73, "FC Augsburg": 72, "Augsburg": 72,
  "Mainz 05": 72, "Mainz": 72, "1. FC Köln": 71, "Köln": 71, "Cologne": 71,
  "Heidenheim": 70, "FC Heidenheim": 70,
  "Darmstadt 98": 67, "Darmstadt": 67, "Bochum": 68, "VfL Bochum": 68,
  "St. Pauli": 69, "FC St. Pauli": 69, "Holstein Kiel": 67,
  "Hamburger SV": 71, "HSV": 71, "Schalke 04": 70, "Schalke": 70,
  "Hertha BSC": 69, "Hertha Berlin": 69, "Nürnberg": 67,
  "Fortuna Düsseldorf": 68, "Düsseldorf": 68, "Hannover 96": 67,
  "Kaiserslautern": 66, "Karlsruher SC": 65, "Greuther Fürth": 64,
  "Paderborn": 64, "Elversberg": 63, "Braunschweig": 63,

  // ── FRANCE (Ligue 1 + Ligue 2) ─────────────────────────────────
  "PSG": 90, "Paris Saint-Germain": 90, "Paris SG": 90,
  "Olympique Marseille": 80, "Marseille": 80, "OM": 80,
  "Olympique Lyon": 79, "Lyon": 79, "OL": 79,
  "Monaco": 78, "AS Monaco": 78, "Lille": 77, "LOSC Lille": 77,
  "Lens": 76, "RC Lens": 76, "Nice": 76, "OGC Nice": 76,
  "Rennes": 75, "Stade Rennais": 75,
  "Strasbourg": 73, "RC Strasbourg": 73, "Toulouse": 72,
  "Montpellier": 72, "Nantes": 71, "FC Nantes": 71,
  "Reims": 71, "Stade de Reims": 71, "Brest": 73, "Stade Brestois": 73,
  "Le Havre": 68, "Lorient": 69, "Clermont": 67, "Clermont Foot": 67,
  "Metz": 68, "Auxerre": 68, "Angers": 67, "Saint-Étienne": 69,
  "Ajaccio": 63, "Troyes": 64, "Caen": 64, "Bordeaux": 66,
  "Guingamp": 63, "Bastia": 62, "Pau": 62, "Grenoble": 62,

  // ── PORTUGAL (Liga Portugal) ───────────────────────────────────
  "Benfica": 82, "SL Benfica": 82,
  "Porto": 81, "FC Porto": 81,
  "Sporting CP": 80, "Sporting Lisbon": 80, "Sporting": 80,
  "Braga": 76, "SC Braga": 76, "Vitória Guimarães": 72, "Guimarães": 72,
  "Gil Vicente": 68, "Famalicão": 69, "Rio Ave": 68,
  "Boavista": 67, "Casa Pia": 67, "Arouca": 66,
  "Estoril": 66, "Estoril Praia": 66, "Moreirense": 66,
  "Portimonense": 65, "Vizela": 64, "Chaves": 64,
  "Farense": 63, "Estrela Amadora": 63, "Nacional": 64,
  "Maritimo": 63, "Marítimo": 63, "Santa Clara": 65,
  "Tondela": 63, "Paços de Ferreira": 64,

  // ── NETHERLANDS (Eredivisie) ───────────────────────────────────
  "PSV": 80, "PSV Eindhoven": 80,
  "Ajax": 79, "AFC Ajax": 79,
  "Feyenoord": 79, "AZ Alkmaar": 76, "AZ": 76,
  "FC Twente": 74, "Twente": 74,
  "FC Utrecht": 72, "Utrecht": 72,
  "Vitesse": 70, "Go Ahead Eagles": 68, "Heerenveen": 68,
  "FC Groningen": 67, "Groningen": 67,
  "NEC Nijmegen": 67, "NEC": 67, "Sparta Rotterdam": 68,
  "Fortuna Sittard": 66, "Heracles Almelo": 65, "Heracles": 65,
  "RKC Waalwijk": 64, "Excelsior": 63, "Volendam": 62, "Almere City": 62,
  "PEC Zwolle": 64, "Willem II": 65, "NAC Breda": 64,

  // ── BELGIUM (Pro League) ───────────────────────────────────────
  "Club Brugge": 78, "Club Bruges": 78,
  "Union Saint-Gilloise": 75, "Union SG": 75,
  "Anderlecht": 75, "RSC Anderlecht": 75,
  "Gent": 74, "KAA Gent": 74, "Genk": 74, "KRC Genk": 74,
  "Antwerp": 73, "Royal Antwerp": 73,
  "Standard Liège": 71, "Standard Liege": 71,
  "Cercle Brugge": 69, "OH Leuven": 68, "KV Mechelen": 68,
  "Westerlo": 67, "Charleroi": 68, "Sint-Truiden": 66,
  "Kortrijk": 65, "Eupen": 64, "Oostende": 63,

  // ── TURKEY (Süper Lig + 1. Lig) ────────────────────────────────
  "Galatasaray": 78, "Fenerbahçe": 78, "Fenerbahce": 78,
  "Beşiktaş": 76, "Besiktas": 76,
  "Trabzonspor": 73, "Başakşehir": 71, "İstanbul Başakşehir": 71,
  "Adana Demirspor": 69, "Antalyaspor": 68,
  "Konyaspor": 67, "Sivasspor": 67,
  "Kayserispor": 65, "Samsunspor": 66, "Gaziantep FK": 66, "Gaziantep": 66,
  "Hatayspor": 64, "Ankaragücü": 65, "Pendikspor": 62,
  "Rizespor": 64, "Çaykur Rizespor": 64,
  "Alanyaspor": 66, "Kasımpaşa": 65,
  "Ümraniyespor": 58, "İstanbulspor": 57, "Giresunspor": 60,
  "Bodrum FK": 63, "Eyüpspor": 64, "Göztepe": 66,
  "MKE Ankaragücü": 65,
  "Fatih Karagümrük": 65, "Karagümrük": 65,
  "Bandırmaspor": 60, "Sakaryaspor": 59, "Boluspor": 58,
  "Tuzlaspor": 57, "Altay": 58, "Manisa FK": 58,
  "Keçiörengücü": 57, "Erzurumspor": 56, "Erzurumspor FK": 56,
  "Kocaelispor": 58, "Yeni Malatyaspor": 57, "Denizlispor": 56,
  "BB Erzurumspor": 56, "Altınordu": 56, "Bursaspor": 60,

  // ── SCOTLAND (SPFL) ────────────────────────────────────────────
  "Celtic": 76, "Rangers": 75,
  "Aberdeen": 68, "Hearts": 67, "Heart of Midlothian": 67,
  "Hibernian": 66, "Dundee United": 64, "Motherwell": 64,
  "St Mirren": 63, "Kilmarnock": 63, "Ross County": 61,
  "St Johnstone": 62, "Livingston": 61, "Dundee": 62,

  // ── UKRAINE ────────────────────────────────────────────────────
  "Shakhtar Donetsk": 77, "Dynamo Kyiv": 74, "Dynamo Kiev": 74,
  "Zorya Luhansk": 68, "Dnipro-1": 67, "Vorskla Poltava": 65,
  "Oleksandriya": 64, "Kolos Kovalivka": 63, "Metalist Kharkiv": 63,

  // ── AUSTRIA (Bundesliga) ───────────────────────────────────────
  "Red Bull Salzburg": 77, "RB Salzburg": 77, "Salzburg": 77,
  "Sturm Graz": 74, "SK Sturm Graz": 74,
  "Rapid Wien": 72, "Rapid Vienna": 72,
  "Austria Wien": 70, "Austria Vienna": 70,
  "LASK": 72, "LASK Linz": 72,
  "Wolfsberger AC": 68, "Hartberg": 65,
  "Altach": 64, "SCR Altach": 64, "Austria Klagenfurt": 65,
  "Blau-Weiß Linz": 63, "Rheindorf Altach": 64,

  // ── SWITZERLAND (Super League) ─────────────────────────────────
  "Young Boys": 74, "BSC Young Boys": 74,
  "FC Basel": 73, "Basel": 73,
  "FC Zürich": 70, "Zürich": 70, "Servette": 69,
  "Lugano": 68, "FC Lugano": 68, "St. Gallen": 68, "FC St. Gallen": 68,
  "Grasshoppers": 66, "Lausanne-Sport": 65, "Winterthur": 64,
  "Luzern": 67, "FC Luzern": 67, "Yverdon Sport": 63, "Sion": 64,

  // ── CZECH REPUBLIC (Chance Liga) ───────────────────────────────
  "Sparta Prague": 74, "Sparta Praha": 74,
  "Slavia Prague": 74, "Slavia Praha": 74,
  "Viktoria Plzeň": 72, "Viktoria Plzen": 72, "Plzeň": 72,
  "Baník Ostrava": 67, "Slovan Liberec": 66, "Jablonec": 65,
  "Slovácko": 64, "Hradec Králové": 64, "Bohemians 1905": 64,
  "Mladá Boleslav": 64, "Sigma Olomouc": 63, "Teplice": 62,

  // ── GREECE (Super League) ──────────────────────────────────────
  "Olympiacos": 75, "Olympiakos": 75,
  "PAOK": 74, "PAOK Thessaloniki": 74,
  "AEK Athens": 73, "Panathinaikos": 72,
  "Aris Thessaloniki": 68, "Aris": 68,
  "Asteras Tripolis": 65, "Volos": 64, "OFI Crete": 63,
  "Atromitos": 64, "Giannina": 63, "Lamia": 62, "Ionikos": 62,

  // ── DENMARK (Superliga) ────────────────────────────────────────
  "FC Copenhagen": 74, "København": 74,
  "FC Midtjylland": 73, "Midtjylland": 73,
  "Brøndby": 71, "Brondby": 71,
  "FC Nordsjælland": 69, "Nordsjælland": 69,
  "Aarhus GF": 67, "AGF": 67, "Silkeborg IF": 67,
  "Randers FC": 66, "Viborg FF": 65, "Lyngby": 63,
  "OB": 64, "Odense BK": 64, "Hvidovre IF": 62, "Vejle": 63,

  // ── CROATIA (HNL) ─────────────────────────────────────────────
  "Dinamo Zagreb": 74, "GNK Dinamo Zagreb": 74,
  "Hajduk Split": 71, "HNK Rijeka": 68, "Rijeka": 68,
  "Osijek": 67, "NK Osijek": 67, "Lokomotiva Zagreb": 64,
  "Gorica": 63, "Istra 1961": 62, "Slaven Belupo": 62,

  // ── SERBIA (Super Liga) ────────────────────────────────────────
  "Red Star Belgrade": 74, "Crvena Zvezda": 74,
  "Partizan Belgrade": 71, "Partizan": 71,
  "TSC Bačka Topola": 67, "TSC": 67, "Vojvodina": 66,
  "Čukarički": 64, "Radnički Niš": 63,

  // ── POLAND (Ekstraklasa) ───────────────────────────────────────
  "Legia Warsaw": 72, "Legia Warszawa": 72,
  "Lech Poznań": 70, "Lech Poznan": 70,
  "Raków Częstochowa": 70, "Raków": 70,
  "Jagiellonia Białystok": 69, "Jagiellonia": 69,
  "Pogoń Szczecin": 68, "Piast Gliwice": 66, "Śląsk Wrocław": 66,
  "Wisła Kraków": 65, "Cracovia": 65, "Górnik Zabrze": 64,
  "Zagłębie Lubin": 64, "Korona Kielce": 63, "Warta Poznań": 62,
  "Stal Mielec": 62, "Radomiak Radom": 63,

  // ── ROMANIA (SuperLiga) ────────────────────────────────────────
  "FCSB": 70, "Steaua Bucureşti": 70,
  "CFR Cluj": 69, "Rapid Bucureşti": 67, "Rapid Bucharest": 67,
  "Universitatea Craiova": 66, "U Craiova": 66,
  "Sepsi OSK": 64, "FC Voluntari": 62, "UTA Arad": 62,
  "Petrolul Ploiești": 62, "Hermannstadt": 62, "Farul Constanța": 64,

  // ── RUSSIA (Premier League) ────────────────────────────────────
  "Zenit St. Petersburg": 77, "Zenit": 77,
  "Spartak Moscow": 73, "CSKA Moscow": 72, "CSKA": 72,
  "Lokomotiv Moscow": 71, "Krasnodar": 72, "FK Krasnodar": 72,
  "Dynamo Moscow": 70, "Rubin Kazan": 67, "Rostov": 67,
  "Akhmat Grozny": 65, "Sochi": 64, "Ural": 63,

  // ── JAPAN (J1 League) ──────────────────────────────────────────
  "Vissel Kobe": 69, "Yokohama F. Marinos": 68, "Yokohama F Marinos": 68,
  "Urawa Red Diamonds": 67, "Urawa Reds": 67,
  "Kawasaki Frontale": 68, "Kashima Antlers": 67,
  "FC Tokyo": 66, "Cerezo Osaka": 66, "Gamba Osaka": 66,
  "Sanfrecce Hiroshima": 67, "Nagoya Grampus": 65,
  "Kashiwa Reysol": 65, "Consadole Sapporo": 64, "Sagan Tosu": 63,
  "Avispa Fukuoka": 63, "Albirex Niigata": 63,
  "Kyoto Sanga": 62, "Shonan Bellmare": 62, "Jubilo Iwata": 62,
  "Tokyo Verdy": 63, "Machida Zelvia": 64,

  // ── SOUTH KOREA (K League 1) ───────────────────────────────────
  "Jeonbuk Hyundai Motors": 67, "Jeonbuk": 67,
  "Ulsan Hyundai": 68, "Ulsan HD": 68,
  "Pohang Steelers": 65, "Suwon Samsung Bluewings": 64, "Suwon Bluewings": 64,
  "FC Seoul": 65, "Daegu FC": 63, "Gangwon FC": 63,
  "Incheon United": 62, "Jeju United": 62, "Gwangju FC": 61,
  "Gimcheon Sangmu": 63, "Suwon FC": 62,

  // ── CHINA (Chinese Super League) ───────────────────────────────
  "Shanghai Port": 65, "Shanghai SIPG": 65,
  "Shandong Taishan": 64, "Shandong Luneng": 64,
  "Beijing Guoan": 64, "Guangzhou FC": 62, "Guangzhou Evergrande": 62,
  "Wuhan Three Towns": 63, "Chengdu Rongcheng": 62,
  "Changchun Yatai": 61, "Tianjin Jinmen Tiger": 61,
  "Zhejiang": 62, "Shenzhen FC": 61, "Henan Songshan Longmen": 61,
  "Dalian Professional": 60, "Meizhou Hakka": 60,

  // ── AUSTRALIA (A-League) ───────────────────────────────────────
  "Melbourne Victory": 64, "Sydney FC": 64,
  "Melbourne City": 64, "Western Sydney Wanderers": 62, "WSW": 62,
  "Central Coast Mariners": 63, "Adelaide United": 62,
  "Perth Glory": 61, "Brisbane Roar": 61,
  "Wellington Phoenix": 62, "Macarthur FC": 61,
  "Newcastle Jets": 60, "Western United": 60,

  // ── USA/CANADA (MLS) ───────────────────────────────────────────
  "Inter Miami": 72, "LA Galaxy": 69, "Los Angeles FC": 70, "LAFC": 70,
  "FC Cincinnati": 68, "Columbus Crew": 68,
  "New York Red Bulls": 67, "NY Red Bulls": 67,
  "New York City FC": 67, "NYCFC": 67,
  "Atlanta United": 67, "Seattle Sounders": 68,
  "Philadelphia Union": 67, "Nashville SC": 66,
  "CF Montréal": 64, "CF Montreal": 64, "Toronto FC": 65,
  "Vancouver Whitecaps": 64, "Portland Timbers": 66,
  "Sporting Kansas City": 65, "Austin FC": 65,
  "Real Salt Lake": 66, "Minnesota United": 65,
  "Charlotte FC": 64, "Houston Dynamo": 65, "San Jose Earthquakes": 62,
  "DC United": 64, "Chicago Fire": 63, "Colorado Rapids": 64,
  "St. Louis City SC": 65, "St Louis City": 65,
  "New England Revolution": 64, "Orlando City": 65,
  "FC Dallas": 64, "Miami": 72,

  // ── MEXICO (Liga MX) ──────────────────────────────────────────
  "Club América": 78, "America": 78,
  "Chivas": 74, "Guadalajara": 74, "CD Guadalajara": 74,
  "Tigres UANL": 76, "Tigres": 76, "Monterrey": 75, "CF Monterrey": 75,
  "Cruz Azul": 74, "Pumas UNAM": 72, "León": 72, "Club León": 72,
  "Santos Laguna": 71, "Pachuca": 72, "CF Pachuca": 72,
  "Toluca": 71, "Deportivo Toluca": 71,
  "Atlas": 70, "Puebla": 69, "Necaxa": 68,
  "Mazatlán FC": 67, "Querétaro": 67, "FC Juárez": 66,
  "Tijuana": 67, "Club Tijuana": 67, "San Luis": 67, "Atlético San Luis": 67,

  // ── BRAZIL (Brasileirão Série A) ───────────────────────────────
  "Flamengo": 80, "CR Flamengo": 80,
  "Palmeiras": 79, "SE Palmeiras": 79,
  "River Plate": 81,
  "Boca Juniors": 80,
  "Fluminense": 76, "Athletico Paranaense": 75, "Athletico-PR": 75,
  "Internacional": 75, "SC Internacional": 75,
  "São Paulo": 75, "Sao Paulo": 75, "São Paulo FC": 75,
  "Grêmio": 74, "Gremio": 74,
  "Corinthians": 74, "SC Corinthians": 74,
  "Botafogo": 74, "Botafogo FR": 74,
  "Santos": 72, "Santos FC": 72,
  "Cruzeiro": 73, "Fortaleza": 72, "Fortaleza EC": 72,
  "Vasco da Gama": 71, "Vasco": 71,
  "Bahia": 70, "EC Bahia": 70, "Atlético Mineiro": 74, "Atletico-MG": 74,
  "Red Bull Bragantino": 71, "Bragantino": 71,
  "Cuiabá": 67, "Goiás": 67, "Coritiba": 67,
  "América Mineiro": 67, "América-MG": 67,

  // ── ARGENTINA (Liga Profesional) ───────────────────────────────
  "Racing Club": 74, "Independiente": 72,
  "San Lorenzo": 71, "Vélez Sarsfield": 71, "Velez Sarsfield": 71,
  "Estudiantes": 70, "Estudiantes de La Plata": 70,
  "Lanús": 69, "Lanus": 69, "Huracán": 68,
  "Argentinos Juniors": 68, "Defensa y Justicia": 68,
  "Talleres": 69, "Talleres de Córdoba": 69,
  "Rosario Central": 68, "Newell's Old Boys": 67,
  "Banfield": 66, "Colón": 66, "Godoy Cruz": 66,
  "Unión": 65, "Unión de Santa Fe": 65,
  "Gimnasia La Plata": 65, "Platense": 64,
  "Central Córdoba": 63, "Tigre": 65, "Arsenal de Sarandí": 64,
  "Belgrano": 66, "Sarmiento": 63, "Barracas Central": 62,

  // ── SAUDI ARABIA (SPL) ─────────────────────────────────────────
  "Al-Hilal": 82, "Al Hilal": 82,
  "Al-Nassr": 80, "Al Nassr": 80,
  "Al-Ahli": 76, "Al Ahli (SAU)": 76,
  "Al-Ittihad": 77, "Al Ittihad": 77,
  "Al-Shabab": 70, "Al Shabab": 70,
  "Al-Fateh": 67, "Al Fateh": 67,
  "Al-Fayha": 66, "Al-Raed": 65, "Al-Taawoun": 66,
  "Al-Ettifaq": 67, "Al Ettifaq": 67,
  "Damac FC": 64, "Abha": 63, "Al-Khaleej": 63, "Al-Hazem": 62,

  // ── EGYPT (Premier League) ─────────────────────────────────────
  "Al-Ahly": 78, "Al Ahly": 78,
  "Zamalek": 74, "Pyramids FC": 70,
  "Ismaily": 66, "El Gouna": 63, "Ceramica Cleopatra": 62,
  "Future FC": 64, "National Bank": 63,

  // ── QATAR (Stars League) ───────────────────────────────────────
  "Al-Sadd": 72, "Al Sadd": 72,
  "Al-Duhail": 71, "Al Duhail": 71,
  "Al-Rayyan": 68, "Al Rayyan": 68,
  "Al-Gharafa": 67, "Al-Arabi": 65, "Al-Wakrah": 65,
  "Qatar SC": 63, "Umm Salal": 62,

  // ── UAE (Pro League) ───────────────────────────────────────────
  "Al-Ain": 73, "Al Ain": 73,
  "Shabab Al-Ahli": 70, "Al-Wahda": 68,
  "Al-Jazira": 68, "Sharjah FC": 67, "Baniyas": 65, "Al-Wasl": 66,

  // ── INDIA (ISL) ────────────────────────────────────────────────
  "Mohun Bagan Super Giant": 63, "Mohun Bagan": 63,
  "Mumbai City FC": 62, "FC Goa": 61,
  "Bengaluru FC": 61, "ATK": 60, "Kerala Blasters": 60,
  "Chennaiyin FC": 59, "NorthEast United": 58, "Odisha FC": 59,
  "Jamshedpur FC": 59, "Hyderabad FC": 58,

  // ── COLOMBIA (Liga BetPlay) ────────────────────────────────────
  "Atlético Nacional": 73, "Atletico Nacional": 73,
  "Junior de Barranquilla": 71, "Junior": 71,
  "Millonarios": 71, "Deportivo Cali": 69,
  "Santa Fe": 68, "Independiente Santa Fe": 68,
  "América de Cali": 68, "Once Caldas": 66,
  "Deportes Tolima": 67, "Envigado": 63,

  // ── PERU (Liga 1) ─────────────────────────────────────────────
  "Alianza Lima": 67, "Universitario": 67,
  "Sporting Cristal": 66, "Melgar": 64, "Cienciano": 63,

  // ── CHILE (Primera División) ───────────────────────────────────
  "Colo-Colo": 70, "Colo Colo": 70,
  "Universidad de Chile": 68, "U. de Chile": 68,
  "Universidad Católica": 67, "UC": 67,
  "Unión Española": 64, "Cobresal": 62, "Huachipato": 63,
  "O'Higgins": 63, "Audax Italiano": 62,

  // ── URUGUAY (Primera División) ─────────────────────────────────
  "Peñarol": 72, "Penarol": 72,
  "Nacional (URU)": 71, "Club Nacional": 71,
  "Defensor Sporting": 65, "Liverpool (URU)": 64,
  "Wanderers (URU)": 63, "Racing (URU)": 63, "Plaza Colonia": 62,

  // ── SWEDEN (Allsvenskan) ───────────────────────────────────────
  "Malmö FF": 72, "Malmö": 72,
  "AIK": 69, "Djurgårdens IF": 69, "Djurgården": 69,
  "IF Elfsborg": 68, "Elfsborg": 68, "Hammarby": 68,
  "IFK Norrköping": 66, "IFK Göteborg": 66,
  "BK Häcken": 68, "Häcken": 68,
  "Sirius": 64, "Kalmar FF": 64, "Mjällby AIF": 63,
  "Halmstads BK": 63, "Varbergs BoIS": 62, "Degerfors": 62,

  // ── NORWAY (Eliteserien) ───────────────────────────────────────
  "Bodø/Glimt": 73, "Bodo/Glimt": 73,
  "Molde": 70, "Molde FK": 70,
  "Rosenborg": 68, "Brann": 67, "SK Brann": 67,
  "Viking FK": 66, "Lillestrøm": 65, "Strømsgodset": 64,
  "Vålerenga": 64, "Odd": 63, "Sarpsborg 08": 63,
  "Tromsø": 63, "Haugesund": 62, "HamKam": 62, "Sandefjord": 61,

  // ── FINLAND (Veikkausliiga) ────────────────────────────────────
  "HJK Helsinki": 67, "HJK": 67,
  "KuPS": 65, "Inter Turku": 63, "SJK": 62,
  "Ilves": 62, "AC Oulu": 61, "Haka": 61, "VPS": 60,

  // ── HUNGARY (NB I) ─────────────────────────────────────────────
  "Ferencváros": 72, "Ferencvaros": 72,
  "MOL Fehérvár": 66, "Puskás Akadémia": 65,
  "Debreceni VSC": 64, "Debrecen": 64, "Újpest": 64,
  "Kecskemét": 62, "Paks": 63, "Zalaegerszeg": 62,

  // ── BULGARIA (First League) ────────────────────────────────────
  "Ludogorets Razgrad": 72, "Ludogorets": 72,
  "CSKA Sofia": 66, "Levski Sofia": 65,
  "Lokomotiv Plovdiv": 64, "Botev Plovdiv": 63, "Slavia Sofia": 62,

  // ── CYPRUS (First Division) ────────────────────────────────────
  "APOEL": 69, "APOEL Nicosia": 69,
  "Omonia Nicosia": 67, "AEK Larnaca": 66, "Apollon Limassol": 65,
  "Anorthosis Famagusta": 64, "Aris Limassol": 63, "Pafos FC": 63,

  // ── ISRAEL (Premier League) ────────────────────────────────────
  "Maccabi Haifa": 70, "Maccabi Tel Aviv": 69,
  "Hapoel Be'er Sheva": 67, "Hapoel Beer Sheva": 67,
  "Bnei Yehuda": 63, "Maccabi Netanya": 63,
  "Hapoel Tel Aviv": 64, "Beitar Jerusalem": 64,

  // ── TUNISIA (Ligue 1) ──────────────────────────────────────────
  "Espérance de Tunis": 73, "Esperance Tunis": 73,
  "Club Africain": 68, "CS Sfaxien": 67, "Etoile du Sahel": 66,

  // ── MOROCCO (Botola Pro) ───────────────────────────────────────
  "Wydad Casablanca": 72, "WAC": 72,
  "Raja Casablanca": 71, "RS Berkane": 67, "FUS Rabat": 65,

  // ── SOUTH AFRICA (PSL) ─────────────────────────────────────────
  "Mamelodi Sundowns": 70, "Sundowns": 70,
  "Orlando Pirates": 67, "Kaizer Chiefs": 66,
  "Stellenbosch FC": 63, "SuperSport United": 63,

  // ── IRAN (Persian Gulf Pro League) ─────────────────────────────
  "Persepolis": 71, "Esteghlal": 70,
  "Sepahan": 68, "Tractor": 66,
  "Foolad Khuzestan": 65, "Zob Ahan": 64, "Nassaji": 62,

  // ── UZBEKISTAN ─────────────────────────────────────────────────
  "Pakhtakor Tashkent": 66, "Pakhtakor": 66,
  "Nasaf Qarshi": 64, "Bunyodkor": 63,

  // ── THAILAND (Thai League 1) ───────────────────────────────────
  "Buriram United": 65, "Muangthong United": 63,
  "BG Pathum United": 64, "Chiang Rai United": 62, "Port FC": 62,

  // ── INDONESIA (Liga 1) ─────────────────────────────────────────
  "Persib Bandung": 62, "Persija Jakarta": 62,
  "Bali United": 61, "Arema FC": 60, "PSM Makassar": 61,

  // ── MALAYSIA (Super League) ────────────────────────────────────
  "Johor Darul Ta'zim": 64, "JDT": 64,
  "Selangor FC": 61, "Kedah Darul Aman": 60,

  // ── PARAGUAY ───────────────────────────────────────────────────
  "Olimpia": 69, "Cerro Porteño": 68, "Libertad": 67,

  // ── ECUADOR ────────────────────────────────────────────────────
  "LDU Quito": 69, "Liga de Quito": 69,
  "Barcelona SC": 68, "Independiente del Valle": 70,
  "Emelec": 67, "El Nacional": 63,

  // ── BOLIVIA ────────────────────────────────────────────────────
  "Bolívar": 65, "The Strongest": 65, "Always Ready": 63,

  // ── VENEZUELA ──────────────────────────────────────────────────
  "Deportivo Táchira": 64, "Caracas FC": 64, "Monagas": 62,

  // ── COSTA RICA ─────────────────────────────────────────────────
  "LD Alajuelense": 65, "Saprissa": 65, "Herediano": 64,

  // ── JAMAICA ────────────────────────────────────────────────────
  "Cavalier FC": 58, "Waterhouse FC": 57,

  // ── CANADA (CPL) ───────────────────────────────────────────────
  "Forge FC": 62, "Pacific FC": 60, "Cavalry FC": 60,

  // ── ALGERIA (Ligue 1) ──────────────────────────────────────────
  "USM Alger": 66, "CR Belouizdad": 66, "JS Kabylie": 65,
  "MC Alger": 65, "ES Sétif": 65,

  // ── NIGERIA (NPFL) ─────────────────────────────────────────────
  "Enyimba": 63, "Rivers United": 62, "Remo Stars": 61,

  // ── GHANA (GPL) ────────────────────────────────────────────────
  "Asante Kotoko": 62, "Hearts of Oak": 62, "Medeama SC": 60,

  // ── DR CONGO ───────────────────────────────────────────────────
  "TP Mazembe": 67, "AS Vita Club": 63,

  // ── TANZANIA ───────────────────────────────────────────────────
  "Simba SC": 64, "Young Africans": 64,

  // ── NEW ZEALAND (ISPS Handa Premiership) ───────────────────────
  "Auckland City": 60, "Team Wellington": 58,
};

const DEFAULT_RATING = 65;
const HOME_ADVANTAGE = 3;

function getRating(teamName) {
  if (!teamName) return DEFAULT_RATING;
  if (TEAM_RATINGS[teamName] != null) return TEAM_RATINGS[teamName];
  const lower = teamName.toLowerCase();
  for (const [k, v] of Object.entries(TEAM_RATINGS)) {
    if (k.toLowerCase() === lower) return v;
  }
  return DEFAULT_RATING;
}

function calcOdds(homeTeam, awayTeam) {
  const hr = getRating(homeTeam) + HOME_ADVANTAGE;
  const ar = getRating(awayTeam);
  const diff = hr - ar;

  const homeWinProb = 1 / (1 + Math.pow(10, -diff / 15));
  const rawDraw = 0.22 + 0.06 * Math.exp(-Math.abs(diff) / 12);
  const remaining = 1 - rawDraw;
  const homeProb = remaining * homeWinProb;
  const awayProb = remaining * (1 - homeWinProb);
  const drawProb = rawDraw;

  const margin = 1.08;
  const homeOdds = Math.max(1.01, +(margin / homeProb).toFixed(2));
  const drawOdds = Math.max(1.01, +(margin / drawProb).toFixed(2));
  const awayOdds = Math.max(1.01, +(margin / awayProb).toFixed(2));

  return { home: homeOdds, draw: drawOdds, away: awayOdds };
}

function lcReward(baseLC, odds) {
  return Math.round(baseLC * odds);
}

module.exports = { calcOdds, getRating, lcReward, TEAM_RATINGS };
