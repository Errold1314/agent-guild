'use strict';

/**
 * Scenario tests: prove the two on-stage demo moments actually happen.
 *
 *   node scripts/scenarios.js
 *
 *   A — tighten the subcontract budget → the gate blocks the card in public
 *   B — inject a workmanship fault → the subcontract is still paid, the prime refunds
 */

const game = require('../server/engine/game');
const { all } = require('../server/engine/events');

function assert(cond, msg) {
  if (!cond) {
    console.error(`\n❌ ${msg}\n`);
    process.exit(1);
  }
}

const HOST = 'test-host';
const OTHER = 'test-intruder';

async function scenarioA() {
  console.log('\n── Scenario A: tighten the subcontract budget → the gate blocks a bid ──');
  game.startMatch({ seed: 777, guildCount: 2 });
  game.setSpeed(8);

  // The host takes seat 1. Every seat — including this one — must be claimed;
  // there is no implicit ownership.
  const claim = game.claimSeat(0, HOST, '0xHOST');
  assert(claim.ok, 'the host should be able to claim seat 1');
  const double = game.claimSeat(0, OTHER, null);
  assert(!double.ok, 'a second client must not be able to take an occupied seat');
  assert(!game.updatePolicy('A-accountant', { minPrice: 1 }, null).ok, 'an unidentified client must be refused');
  assert(!game.updatePolicy('A-accountant', { minPrice: 1 }, OTHER).ok, 'a client that holds no seat must be refused');

  // The host cuts the Accountant's subcontract budget from 3 to 2 — no longer
  // enough to hire the Detective's data cleaning.
  const r = game.updatePolicy('A-accountant', { maxSubSpend: 2 }, HOST);
  assert(r.ok, 'editing your own standing rules should succeed');

  // A card that is not yours must be refused.
  const foreign = game.updatePolicy('B-detective', { minPrice: 0 }, HOST);
  assert(!foreign.ok, 'editing another guild’s card must be refused');
  console.log(`  🔒 ownership enforced: "${foreign.reason}"`);

  await game.runRound();
  const blocked = all().filter((e) => e.type === 'bid.blocked');
  const byBudget = blocked.filter((e) => e.blocks.some((b) => b.rule === 'Subcontract spend cap'));

  for (const e of byBudget) {
    console.log(`  ⛔ ${e.cardName} blocked: ${e.blocks.find((b) => b.rule === 'Subcontract spend cap').detail}`);
  }
  assert(byBudget.length > 0, 'at least one "Subcontract spend cap" block should appear');

  const t1 = game.getState().tasks.find((t) => t.id === 'R1-T1');
  console.log(`  → the reconciliation job ended as: ${t1.state}${t1.awardee ? ` (${t1.awardee})` : ''}`);
  console.log('  ✅ Scenario A passed: changing the rules visibly changed what the cards did');
}

async function scenarioB() {
  console.log('\n── Scenario B: inject a fault → subcontract paid, prime refunded ──');
  game.startMatch({ seed: 888, guildCount: 2 });
  game.setSpeed(8);
  game.claimSeat(0, HOST, null);
  game.injectFault();

  await game.runRound();
  const ev = all();
  const subRelease = ev.filter((e) => e.type === 'escrow.subrelease');
  const refund = ev.filter((e) => e.type === 'escrow.refund');
  const fault = ev.filter((e) => e.type === 'demo.fault');

  assert(fault.length === 1, 'the fault should fire exactly once');
  assert(subRelease.length > 0, 'the subcontractor should already have been paid');
  assert(refund.length > 0, 'the prime’s job should have failed and refunded the client');

  for (const e of game.getState().escrows.filter((x) => x.kind === 'sub')) {
    console.log(`  sub-escrow ${e.id}: ${e.history.map((h) => h.state).join(' → ')}`);
  }
  for (const e of refund) console.log(`  ↩ ${e.cardName}'s delivery rejected — client gets ${e.amount} back (reputation ${e.reputation})`);
  for (const e of subRelease) console.log(`  💸 subcontractor ${e.providerName} keeps ${e.amount} — no clawback`);

  const subEsc = game.getState().escrows.find((e) => e.kind === 'sub' && e.state === 'SUB_RELEASED');
  assert(subEsc, 'a sub-escrow must be sitting in SUB_RELEASED');
  console.log('  ✅ Scenario B passed: the risk asymmetry holds — the prime ate the loss');
}

(async () => {
  await scenarioA();
  await scenarioB();
  console.log('\n✅ both demo moments behave exactly as designed\n');
})();
