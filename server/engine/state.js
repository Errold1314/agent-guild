'use strict';

/**
 * State model + immutable update helpers.
 *
 * Every transition returns a NEW object (never mutates in place).
 */

// ── Global constants ──────────────────────────────────────
const GUILD_START_CASH = 12;
const MAINTENANCE_FEE = 1; // per card, per round — idle cards bleed money
const VERIFIER_FEE = 1;
const MAX_ROUNDS = 3;
const MAX_GUILDS = 4;

// ── Card archetypes ───────────────────────────────────────
// `skills` decide what a card can actually do. A task lists the skills it
// requires — whoever lacks one of them must subcontract it.
//
// baseCost is deliberately IDENTICAL across archetypes. Giving one archetype a
// cost edge looks like flavour, but at a 4-seat table it is decisive: the
// expensive seats can never win a bid, never earn, and bleed upkeep until they
// are out of the game. Seats must differ by SKILL, not by efficiency.
const CARD_ARCHETYPES = [
  {
    key: 'accountant',
    name: 'Accountant',
    role: 'Reconciliation & reporting',
    skills: ['reconcile', 'report'], // sole issuer of signed reports
    baseCost: 1,
    accent: '#e8b64c',
  },
  {
    key: 'classifier',
    name: 'Classifier',
    role: 'Bucketing & statistics',
    skills: ['classify'],
    baseCost: 1,
    accent: '#7cc4e8',
  },
  {
    key: 'detective',
    name: 'Detective',
    role: 'Cleaning & anomaly detection',
    skills: ['dedupe', 'detect'],
    baseCost: 1,
    accent: '#d97b7b',
  },
  {
    key: 'auditor',
    name: 'Auditor',
    role: 'Audit & cross-check',
    skills: ['classify', 'reconcile'],
    baseCost: 1,
    accent: '#b48ce0',
  },
];

// ── Guilds (one per seat) ─────────────────────────────────
const GUILD_PALETTE = [
  { id: 'A', name: 'Cobalt Guild', accent: '#e8b64c', isHost: true },
  { id: 'B', name: 'Iron Anvil', accent: '#d97b7b' },
  { id: 'C', name: 'Jade Compact', accent: '#5fd39a' },
  { id: 'D', name: 'Violet Ledger', accent: '#b48ce0' },
];

/**
 * Which archetypes each seat gets, per table size.
 *
 * 2 players  → [Accountant, Classifier] vs [Detective, Auditor]  (the tuned baseline)
 * 3 players  → the third seat gets [Classifier, Detective]
 * 4 players  → the fourth seat gets [Auditor, Accountant]
 *
 * Every roster is a different pair, so no two seats are clones — but every
 * seat still lacks something, which is what keeps subcontracting alive.
 */
const ROSTER_PLANS = {
  2: [[0, 1], [2, 3]],
  3: [[0, 1], [2, 3], [1, 2]],
  4: [[0, 1], [2, 3], [1, 2], [3, 0]],
};

// ── Starting rules ────────────────────────────────────────
const DEFAULT_POLICY = {
  minPrice: 3, // hard floor enforced by the gate
  maxSubSpend: 3, // cap on a single subcontract
  minMargin: 1, // minimum profit the card demands
  pricing: 'balanced', // aggressive | balanced | greedy
  whitelist: ['reconcile', 'classify', 'analyze'],
  hireVerifier: true,
};

const AI_POLICY = {
  minPrice: 3,
  maxSubSpend: 3,
  minMargin: 1,
  pricing: 'balanced',
  whitelist: ['reconcile', 'classify', 'analyze'],
  hireVerifier: true,
};

/**
 * Every AI seat runs the SAME stance. Temperament variation looks like flavour
 * but it is really a handicap: an 'aggressive' seat hoovers every job and a
 * 'greedy' seat wins nothing and bleeds upkeep. Seats must differ by ROSTER,
 * not by how badly they want to win.
 */
const AI_PRICING = ['balanced', 'balanced', 'balanced', 'balanced'];

const NEUTRAL_DEFS = {
  customer: { id: 'CUS', name: 'Neutral Client', role: 'Publishes funded jobs' },
  verifier: { id: 'VER', name: 'Attestation Bureau', role: 'Replays the acceptance checker', fee: VERIFIER_FEE },
};

function aiPolicyFor(guildIndex) {
  return { ...AI_POLICY, pricing: AI_PRICING[guildIndex % AI_PRICING.length] };
}

// ── Initial state ─────────────────────────────────────────
function createInitialState({ seed = 20261013, maxRounds = MAX_ROUNDS, guildCount = 2, room = 'GUILD' } = {}) {
  const count = Math.max(2, Math.min(MAX_GUILDS, Number(guildCount) || 2));
  const plan = ROSTER_PLANS[count];

  const guilds = {};
  const cards = {};

  for (let i = 0; i < count; i++) {
    const g = GUILD_PALETTE[i];
    guilds[g.id] = {
      id: g.id,
      name: g.name,
      accent: g.accent,
      kind: i === 0 ? 'human' : 'ai',
      seat: i,
      cash: GUILD_START_CASH,
      frozen: 0,
      inEscrow: 0,
      earned: 0, // cumulative revenue (jobs + subcontracts) — drives tie-breaks
      reputation: 50,
      stats: { completed: 0, failed: 0, subHired: 0, subSold: 0 },
    };

    for (const archIdx of plan[i]) {
      const arch = CARD_ARCHETYPES[archIdx];
      const id = `${g.id}-${arch.key}`;
      cards[id] = {
        id,
        guildId: g.id,
        archetype: arch.key,
        name: arch.name,
        role: arch.role,
        skills: [...arch.skills],
        baseCost: arch.baseCost,
        accent: arch.accent,
        status: 'IDLE',
        cooldownUntilRound: 0,
        policy: { ...(i === 0 ? DEFAULT_POLICY : aiPolicyFor(i)) },
        stats: { completed: 0, failed: 0, firstPass: 0, reworks: 0, sold: 0 },
        lastAction: null,
      };
    }
  }

  // Neutral client: funds every job. Not a competitor, never scored.
  guilds.CUS = {
    id: 'CUS',
    name: 'Neutral Client',
    accent: '#6b7280',
    kind: 'neutral',
    seat: -1,
    cash: 1000,
    frozen: 0,
    inEscrow: 0,
    reputation: 0,
    stats: { completed: 0, failed: 0, subHired: 0, subSold: 0 },
  };

  // Seats: always 4 on the table; seats >= guildCount are empty.
  const seats = [];
  for (let i = 0; i < MAX_GUILDS; i++) {
    seats.push({
      index: i,
      guildId: i < count ? GUILD_PALETTE[i].id : null,
      claimedBy: null, // client id of the human sitting here
      address: null, // wallet address, if connected
      isHost: i === 0,
    });
  }

  return {
    room,
    matchId: `${room}-${seed}`,
    seed,
    round: 0,
    maxRounds,
    guildCount: count,
    phase: 'IDLE', // IDLE | POLICY | MARKET | WORK | SETTLE | DONE
    speed: 3,
    running: false,
    guilds,
    cards,
    seats,
    neutral: NEUTRAL_DEFS,
    tasks: [],
    escrows: [],
    roundSummaries: [],
    winner: null,
    finalStandings: null,
  };
}

// ── Immutable update helpers ──────────────────────────────
function withGuild(state, guildId, patch) {
  return { ...state, guilds: { ...state.guilds, [guildId]: { ...state.guilds[guildId], ...patch } } };
}

function withCard(state, cardId, patch) {
  return { ...state, cards: { ...state.cards, [cardId]: { ...state.cards[cardId], ...patch } } };
}

function upsertTask(state, task) {
  const exists = state.tasks.some((t) => t.id === task.id);
  const tasks = exists ? state.tasks.map((t) => (t.id === task.id ? task : t)) : [...state.tasks, task];
  return { ...state, tasks };
}

function withEscrow(state, escrowId, patch) {
  return { ...state, escrows: state.escrows.map((e) => (e.id === escrowId ? { ...e, ...patch } : e)) };
}

function upsertEscrow(state, escrow) {
  const exists = state.escrows.some((e) => e.id === escrow.id);
  const escrows = exists ? state.escrows.map((e) => (e.id === escrow.id ? escrow : e)) : [...state.escrows, escrow];
  return { ...state, escrows };
}

function withSeat(state, index, patch) {
  return { ...state, seats: state.seats.map((s) => (s.index === index ? { ...s, ...patch } : s)) };
}

/** Final score: cash + frozen + escrow + reputation bonus. */
function scoreOf(state, guildId) {
  const g = state.guilds[guildId];
  const reputationBonus = Math.round((g.reputation - 50) / 10);
  return g.cash + g.frozen + g.inEscrow + reputationBonus;
}

module.exports = {
  GUILD_START_CASH,
  MAINTENANCE_FEE,
  VERIFIER_FEE,
  MAX_ROUNDS,
  MAX_GUILDS,
  CARD_ARCHETYPES,
  GUILD_PALETTE,
  ROSTER_PLANS,
  DEFAULT_POLICY,
  AI_POLICY,
  NEUTRAL_DEFS,
  createInitialState,
  withGuild,
  withCard,
  upsertTask,
  upsertEscrow,
  withEscrow,
  withSeat,
  scoreOf,
};
