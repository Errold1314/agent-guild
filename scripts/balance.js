'use strict';

/**
 * Balance check: play many matches and report how the prize money spreads
 * across seats. A seat that never earns is a design bug, not bad luck.
 *
 *   node scripts/balance.js [matches] [guildCount]
 */

const game = require('../server/engine/game');
const { all } = require('../server/engine/events');

const N = Number(process.argv[2]) || 12;
const G = Number(process.argv[3]) || 4;

(async () => {
  const totals = {};
  const wins = {};
  let minScore = Infinity;
  let maxScore = -Infinity;

  for (let i = 0; i < N; i++) {
    game.startMatch({ seed: 1000 + i * 37, guildCount: G });
    game.setSpeed(8);
    for (let r = 0; r < 3; r++) await game.runRound();

    const s = game.getState();
    for (const st of s.finalStandings) {
      totals[st.guildId] = (totals[st.guildId] || 0) + st.score;
      wins[st.guildId] = wins[st.guildId] || 0;
      minScore = Math.min(minScore, st.score);
      maxScore = Math.max(maxScore, st.score);
    }
    wins[s.winner.guildId] = (wins[s.winner.guildId] || 0) + 1;
  }

  console.log(`\n${N} matches at a ${G}-player table (start: 12 coins each)\n`);
  console.log('seat                 avg score   share of prize money   matches won');
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const grand = sorted.reduce((a, [, v]) => a + v, 0);
  for (const [gid, total] of sorted) {
    const avg = (total / N).toFixed(1);
    const share = ((total / grand) * 100).toFixed(0);
    console.log(`  ${gid.padEnd(20)} ${avg.padStart(8)}   ${share.padStart(16)}%   ${String(wins[gid] || 0).padStart(10)}`);
  }
  console.log(`\n  score range across every seat/match: ${minScore.toFixed(1)} … ${maxScore.toFixed(1)}`);
  const spread = (sorted[0][1] / sorted[sorted.length - 1][1]).toFixed(2);
  console.log(`  best seat / worst seat: ${spread}×\n`);
})();
