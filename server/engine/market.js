'use strict';

const { generateReconcileDataset, generateClassifyDataset, generateDetectDataset } = require('./data');
const { CHECKERS, checkerHash } = require('./checkers');

/**
 * The job market — a neutral client posts task cards, cards bid on them,
 * and a deterministic rule picks the winner.
 *
 * Award rule (hard-coded, non-negotiable):
 *   eligibility filter → lowest price → higher reputation → earlier bid
 */

/**
 * Task templates.
 *
 * `type` is the BUSINESS category (used by a card's whitelist).
 * `requires` are the SKILLS needed (this is what forces subcontracting).
 * They are different namespaces: an `analyze` job needs `dedupe` + `detect`.
 */
const TASK_TEMPLATES = {
  reconcile: {
    type: 'reconcile',
    typeLabel: 'Reconciliation',
    title: 'Reconcile the on-chain transfer log',
    brief: 'The log may contain duplicate entries. Your report must tie out to the authoritative closing balance, account by account.',
    requires: ['dedupe', 'reconcile', 'report'], // `report` is the Accountant's moat
    checkerKey: 'reconcile',
    makeDataset: (seed) => generateReconcileDataset(seed),
  },
  classify: {
    type: 'classify',
    typeLabel: 'Classification',
    title: 'Bucket the transfer stream by size',
    brief: 'Count transfers in three amount tiers. The tier counts must sum to the total.',
    requires: ['classify'],
    checkerKey: 'classify',
    makeDataset: (seed) => generateClassifyDataset(seed),
  },
  analyze: {
    type: 'analyze',
    typeLabel: 'Anomaly Scan',
    requires: ['dedupe', 'detect'],
    title: 'Flag the anomalous transfers',
    brief: 'Find the unusually large transfers. No false negatives, no false positives.',
    checkerKey: 'detect',
    makeDataset: (seed) => generateDetectDataset(seed),
  },
};

/**
 * One job per seat at the table. Plans are per table size so that two jobs
 * competing for the same scarce skill never land in the same round when
 * there is only one provider for it.
 */
const PLANS = {
  2: [
    ['reconcile', 'classify'],
    ['analyze', 'classify'],
    ['reconcile', 'classify'],
  ],
  3: [
    ['reconcile', 'classify', 'analyze'],
    ['analyze', 'classify', 'reconcile'],
    ['reconcile', 'classify', 'analyze'],
  ],
  4: [
    ['reconcile', 'classify', 'classify', 'analyze'],
    ['analyze', 'reconcile', 'classify', 'classify'],
    ['reconcile', 'classify', 'analyze', 'classify'],
  ],
};

const BASE_REWARD = { reconcile: 14, classify: 9, analyze: 12 };
const ROUND_REWARD_MULT = [1, 1, 1.15];
/** Bigger table = bigger client budget, so per-guild economics stay stable. */
const TABLE_SCALE = { 2: 1, 3: 1.2, 4: 1.4 };

function rewardFor(type, round, guildCount) {
  const base = BASE_REWARD[type] || 10;
  const mult = (ROUND_REWARD_MULT[round - 1] ?? 1) * (TABLE_SCALE[guildCount] ?? 1);
  return Math.round(base * mult);
}

/** Build this round's task cards. */
function buildRoundTasks(round, seed, guildCount = 2) {
  const plans = PLANS[guildCount] || PLANS[2];
  const types = plans[Math.min(round, plans.length) - 1];

  return types.map((key, i) => {
    const tpl = TASK_TEMPLATES[key];
    const checker = CHECKERS[tpl.checkerKey];
    const dataset = tpl.makeDataset(seed + round * 1000 + i * 77);
    const maxReward = rewardFor(key, round, guildCount);
    return {
      id: `R${round}-T${i + 1}`,
      round,
      type: tpl.type,
      typeLabel: tpl.typeLabel,
      title: tpl.title,
      brief: tpl.brief,
      requires: [...tpl.requires],
      maxReward,
      // Large jobs force third-party attestation — that is what makes the
      // Attestation Bureau a real business rather than a decoration.
      requiresVerification: maxReward >= 12,
      checkerKey: tpl.checkerKey,
      checkerName: checker.name,
      checkerVersion: checker.version,
      checkerHash: checkerHash(checker),
      dataset, // public data
      truth: dataset.truth, // private ground truth until settlement
      truthRevealed: false,
      state: 'PUBLISHED',
      escrowId: null,
      bids: [],
      awardee: null,
      winnerPrice: null,
      failureReason: null,
      deliverable: null,
      verifiedBy: null,
      reworked: false,
      faulted: false,
      verification: null,
      evidence: null,
    };
  });
}

const { hashInt } = require('./policy');

const guildOf = (state, b) => state.guilds[state.cards[b.cardId].guildId];
const repOf = (state, b) => guildOf(state, b).reputation;
const earnedOf = (state, b) => guildOf(state, b).earned || 0;

/**
 * Deterministic winner selection.
 *
 *   1. lowest price
 *   2. higher reputation
 *   3. LOWEST CUMULATIVE EARNINGS — a self-correcting fairness rule
 *   4. a seed-salted hash of (card, task), i.e. a reproducible coin flip
 *
 * Step 3 is what keeps a bigger table playable. Cards routinely bid the same
 * price, and breaking every dead heat by seat order means one seat can end a
 * match with nothing purely because the engine iterated it second. Handing the
 * tie to whoever has earned least so far makes the standings self-balancing
 * without rigging anything: you still win by bidding well, you just stop
 * losing to arbitrary ordering.
 *
 * Step 4 is salted with the match seed so two matches are actually different
 * games rather than the same script replayed.
 *
 * @returns {{winner:object|null, tie:boolean, tiedWith:string[]}}
 */
function award(bids, state, taskId) {
  const qualified = bids.filter((b) => b.gateOk);
  if (qualified.length === 0) return null;

  // Salt the coin flip with the table position too, so the same card does not
  // win the same task every time the seed happens to line up.
  const flip = (b) => hashInt(`${state.seed}|${state.guildCount}|${taskId}|${b.cardId}`);

  const sorted = [...qualified].sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price; // 1. lowest price
    const ra = repOf(state, b);
    const rb = repOf(state, a);
    if (ra !== rb) return ra - rb; // 2. higher reputation
    const ea = earnedOf(state, a);
    const eb = earnedOf(state, b);
    if (ea !== eb) return ea - eb; // 3. least-earned so far
    return flip(a) - flip(b); // 4. reproducible coin flip
  });

  const best = sorted[0];
  const tied = sorted.filter(
    (b) => b.price === best.price && repOf(state, b) === repOf(state, best) && earnedOf(state, b) === earnedOf(state, best)
  );
  return Object.assign(best, { _tied: tied.length > 1, _tiedWith: tied.map((b) => b.cardName) });
}

module.exports = { TASK_TEMPLATES, PLANS, BASE_REWARD, buildRoundTasks, rewardFor, award };
