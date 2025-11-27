/**
 * Basit puan motoru:
 * - Outcome (1X2): doğru +10, yanlış 0
 * - Skor tam isabet: +15 (bonus)
 * - Mikro: İlk gol tahmini doğruysa +5; değilse 0
 * Toplam = outcome + exactScore + micro
 */
function outcome(home, away){
  if(home>away) return "H";
  if(home<away) return "A";
  return "D";
}

function scorePrediction(pred, result){
  const { predOutcome, predHome, predAway, firstGoalTeam } = pred;
  const { home, away, firstGoal } = result;

  const o = outcome(home, away);
  let macro = 0;
  if (predOutcome && ["H","D","A"].includes(predOutcome) && predOutcome===o) macro += 10;

  let exact = 0;
  if (typeof predHome==="number" && typeof predAway==="number" && predHome===home && predAway===away) exact += 15;

  let micro = 0;
  if (firstGoal && firstGoalTeam && firstGoalTeam===firstGoal) micro += 5;

  return { macro, exact, micro, total: macro+exact+micro };
}

module.exports = { scorePrediction, outcome };
