'use strict';

/**
 * Headless smoke test: play full matches without the UI and check the hard
 * invariants. Runs every table size.
 *
 *   node scripts/smoke.js
 *   node scripts/smoke.js 12345 4      # specific seed and table size
 *
 * Invariants checked:
 *   1. Conservation of money — cash + frozen + escrow + platform take is
 *      constant for the whole match
 *   2. Every escrow reaches a terminal state
 *   3. Every task reaches a terminal state
 *   4. Every escrow transition is legal (replayed against the whitelist)
 */

const game = require('../server/engine/game');
const ev = require('../server/engine/events');
const { TRANSITIONS } = require('../server/engine/escrow');

const TERMINAL_ESCROW = ['RELEASED', 'REFUNDED', 'SUB_RELEASED', 'SUB_REFUNDED'];
const TERMINAL_TASK = ['SUBMITTED', 'NO_BID', 'EXPIRED'];

function totals(s) {
  const sum = (k) => Math.round(Object.values(s.guilds).reduce((a, g) => a + g[k], 0) * 100) / 100;
  const cash = sum('cash');
  const frozen = sum('frozen');
  const esc = sum('inEscrow');
  const fees = Math.round((s.platformFees || 0) * 100) / 100;
  return { cash, frozen, esc, fees, total: Math.round((cash + frozen + esc + fees) * 100) / 100 };
}

let failures = 0;
function fail(msg) {
  console.error(`  ✗ ${msg}`);
  failures++;
}

async function playMatch(seed, guildCount) {
  console.log(`\n═══ ${guildCount}-player table (seed ${seed}) ═══`);
  game.startMatch({ seed, guildCount });
  game.setSpeed(8);

  const s0 = game.getState();
  const initial = totals(s0);
  console.log(`  start: cash ${initial.cash} | platform ${initial.fees} | total ${initial.total}`);

  for (let r = 0; r < s0.maxRounds; r++) {
    const t0 = Date.now();
    const res = await game.runRound();
    if (!res.ok) return fail(`round failed to start: ${res.reason}`);

    const s = game.getState();
    const t = totals(s);
    console.log(
      `  R${s.round} (${((Date.now() - t0) / 1000).toFixed(1)}s) | cash ${t.cash} frozen ${t.frozen} escrow ${t.esc} platform ${t.fees} | total ${t.total}`
    );
    if (Math.abs(t.total - initial.total) > 0.01) {
      fail(`money is not conserved: started ${initial.total}, now ${t.total}`);
    }
  }

  const s = game.getState();

  const stuck = s.escrows.filter((e) => !TERMINAL_ESCROW.includes(e.state));
  if (stuck.length) fail(`${stuck.length} escrow(s) never settled: ${stuck.map((e) => `${e.id}(${e.state})`).join(', ')}`);

  for (const e of s.escrows) {
    for (let i = 1; i < e.history.length; i++) {
      const from = e.history[i - 1].state;
      const to = e.history[i].state;
      if (!(TRANSITIONS[from] || []).includes(to)) fail(`illegal escrow transition on ${e.id}: ${from} → ${to}`);
    }
  }

  const open = s.tasks.filter((t) => !TERMINAL_TASK.includes(t.state));
  if (open.length) fail(`${open.length} task(s) never settled: ${open.map((t) => `${t.id}(${t.state})`).join(', ')}`);

  for (const t of s.tasks) {
    const esc = s.escrows.find((x) => x.id === t.escrowId);
    const outcome = t.verification ? (t.verification.pass ? 'accepted' : 'rejected') : t.state.toLowerCase();
    console.log(`    ${t.id} ${t.typeLabel.padEnd(15)} ${String(t.maxReward).padStart(3)}c  ${(t.awardee || '—').padEnd(16)} ${outcome}`);
  }

  console.log('  standings:');
  for (const [i, st] of s.finalStandings.entries()) {
    console.log(`    ${i + 1}. ${st.name.padEnd(14)} ${String(st.score).padStart(6)}  (cash ${st.cash} · escrow ${st.escrow} · rep ${st.reputation})`);
  }

  const counts = {};
  for (const e of ev.all()) counts[e.type] = (counts[e.type] || 0) + 1;
  const key = ['bid.accept', 'bid.blocked', 'award', 'card.reserved', 'task.nobid', 'escrow.sublock', 'escrow.subrelease', 'escrow.release', 'escrow.refund', 'order.expired'];
  console.log(`  events: ${key.map((k) => `${k}=${counts[k] || 0}`).join('  ')}`);
}

(async () => {
  const seed = Number(process.argv[2]) || 12345;
  const sizes = process.argv[3] ? [Number(process.argv[3])] : [2, 3, 4];

  for (const n of sizes) await playMatch(seed, n);

  console.log('');
  if (failures === 0) console.log('✅ all invariants hold across every table size\n');
  else {
    console.error(`❌ ${failures} invariant violation(s)\n`);
    process.exit(1);
  }
})();
