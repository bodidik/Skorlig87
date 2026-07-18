"use strict";

const { calcOdds } = require("./odds-engine.cjs");

const BASE_LC = 10;

function outcome(home, away) {
  if (home > away) return "H";
  if (home < away) return "A";
  return "D";
}

function scorePrediction(pred, result) {
  const { predOutcome, predHome, predAway, firstGoalTeam } = pred;
  const { home, away, firstGoal, homeTeam, awayTeam } = result;

  const o = outcome(home, away);

  const odds = (homeTeam && awayTeam) ? calcOdds(homeTeam, awayTeam) : null;

  let macro = 0;
  let oddsUsed = 1;
  if (predOutcome && ["H", "D", "A"].includes(predOutcome) && predOutcome === o) {
    if (odds) {
      oddsUsed = predOutcome === "H" ? odds.home : predOutcome === "D" ? odds.draw : odds.away;
      macro = Math.round(BASE_LC * oddsUsed);
    } else {
      macro = 10;
    }
  }

  let exact = 0;
  if (typeof predHome === "number" && typeof predAway === "number" && predHome === home && predAway === away) {
    exact = Math.round(BASE_LC * 1.5);
  }

  let micro = 0;
  if (firstGoal && firstGoalTeam && firstGoalTeam === firstGoal) micro = 5;

  return { macro, exact, micro, total: macro + exact + micro, oddsUsed };
}

module.exports = { scorePrediction, outcome };
