'use strict';

const { CHECKERS, buildEvidence } = require('./checkers');
const { withGuild, withCard } = require('./state');

/**
 * Independent attestation and reputation.
 *
 * Trust comes from REPRODUCIBILITY: the checker is a fixed program with a
 * hash, and anyone can replay it. The Attestation Bureau sells exactly that —
 * a replay, an evidence bundle, and an early failure warning — so a card can
 * catch its own mistake before the client sees it and rework once.
 */

/** Run the acceptance checker for a job. */
function runChecker(task, deliverable) {
  const checker = CHECKERS[task.checkerKey];
  const result = checker.run(deliverable, task.truth);
  const evidence = buildEvidence({ checker, deliverable, result, inputSnapshot: task.dataset.published });
  return { checker, result, evidence };
}

/** Reputation deltas — written ONLY from neutral client outcomes. */
const REPUTATION = {
  firstPass: 4,
  afterRework: 1,
  failed: -6,
  expired: -8,
};

function applyReputation(state, guildId, cardId, outcome) {
  const delta = REPUTATION[outcome] ?? 0;
  const card = state.cards[cardId];
  let next = state;

  if (cardId && card) {
    const stats = { ...card.stats };
    if (outcome === 'firstPass') {
      stats.completed += 1;
      stats.firstPass += 1;
    }
    if (outcome === 'afterRework') {
      stats.completed += 1;
      stats.reworks += 1;
    }
    if (outcome === 'failed' || outcome === 'expired') stats.failed += 1;
    next = withCard(next, cardId, { stats });
  }

  if (!guildId) return { state: next, delta };
  const guild = next.guilds[guildId];
  return {
    state: withGuild(next, guildId, { reputation: Math.max(0, guild.reputation + delta) }),
    delta,
  };
}

/** Final standings. */
function finalize(state) {
  const contenders = Object.values(state.guilds).filter((g) => g.kind !== 'neutral');
  const scored = contenders
    .map((g) => {
      const reputationBonus = Math.round((g.reputation - 50) / 10);
      return {
        guildId: g.id,
        seat: g.seat,
        name: g.name,
        accent: g.accent,
        cash: g.cash,
        escrow: g.inEscrow,
        reputation: g.reputation,
        reputationBonus,
        score: Math.round((g.cash + g.frozen + g.inEscrow + reputationBonus) * 100) / 100,
      };
    })
    .sort((a, b) => b.score - a.score || b.reputation - a.reputation);
  return { ...state, winner: scored[0] || null, finalStandings: scored };
}

module.exports = { runChecker, applyReputation, REPUTATION, finalize };
