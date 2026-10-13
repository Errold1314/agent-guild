'use strict';

/** Throwaway diagnostic: print every bid and award for a 4-player match. */

const game = require('../server/engine/game');
const { all } = require('../server/engine/events');

(async () => {
  game.startMatch({ seed: 12345, guildCount: 4 });
  game.setSpeed(8);
  await game.runRound();

  const ev = all();
  const byTask = {};
  for (const e of ev) {
    if (!e.taskId) continue;
    byTask[e.taskId] = byTask[e.taskId] || { bids: [], award: null, passes: [] };
    if (e.type === 'bid.accept') byTask[e.taskId].bids.push(`${e.cardName}@${e.price}`);
    if (e.type === 'bid.pass') byTask[e.taskId].passes.push(`${e.cardName}: ${e.reason}`);
    if (e.type === 'award') byTask[e.taskId].award = `${e.cardName}@${e.price}${e.tie ? ` [TIE of ${e.tiedWith.length}: ${e.tiedWith.join(', ')}]` : ''}`;
  }

  for (const [id, t] of Object.entries(byTask)) {
    console.log(`\n${id}`);
    console.log(`  bids:   ${t.bids.join('  ') || '—'}`);
    console.log(`  award:  ${t.award || '—'}`);
    for (const p of t.passes) console.log(`  pass:   ${p}`);
  }
})();
