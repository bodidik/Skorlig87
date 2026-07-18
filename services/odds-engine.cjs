"use strict";

const TEAM_RATINGS = {
  "Real Madrid": 97, "Barcelona": 95, "Bayern München": 94, "Bayern Münih": 94,
  "Manchester City": 93, "Liverpool": 92, "PSG": 90, "Arsenal": 89, "Chelsea": 88,
  "Atletico Madrid": 88, "Inter": 88, "Inter Milan": 88, "Juventus": 86,
  "Borussia Dortmund": 85, "Bayer Leverkusen": 85, "Napoli": 84,
  "AC Milan": 84, "Milan": 84, "Tottenham": 83, "Manchester United": 82,
  "Atalanta": 83, "RB Leipzig": 83, "Roma": 82, "Benfica": 82,
  "Porto": 81, "Sporting CP": 80, "Olympique Marseille": 80,
  "Real Sociedad": 80, "Lazio": 80, "PSV": 80, "Eintracht Frankfurt": 80,
  "River Plate": 81, "Boca Juniors": 80, "Flamengo": 80,
  "Villarreal": 79, "Athletic Bilbao": 79, "Fiorentina": 79,
  "Ajax": 79, "Feyenoord": 79, "Palmeiras": 79, "Olympique Lyon": 79,
  "Galatasaray": 78, "Fenerbahçe": 78, "Club América": 78,
  "Al-Hilal": 82, "Al-Nassr": 80, "Al-Ahly": 78,
  "Shakhtar Donetsk": 77, "Beşiktaş": 76, "Celtic": 76,
  "Rangers": 75, "Dynamo Kyiv": 74, "Chivas": 74,
  "Trabzonspor": 73, "Başakşehir": 71, "Adana Demirspor": 69,
  "Antalyaspor": 68, "Konyaspor": 67, "Sivasspor": 67,
  "Kayserispor": 65, "Samsunspor": 66, "Gaziantep FK": 66,
  "Hatayspor": 64, "Ankaragücü": 65, "Pendikspor": 62,
  "Rizespor": 64, "Alanyaspor": 66, "Kasımpaşa": 65,
  "Ümraniyespor": 58, "İstanbulspor": 57, "Giresunspor": 60,
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
