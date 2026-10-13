'use strict';

/**
 * The policy gate — deterministic code. The model never touches money.
 *
 * Brains PROPOSE (a bid, a subcontract). This module ADJUDICATES.
 * Every verdict is auditable and surfaces in the UI as a gate block.
 */

/** How much of the surplus a card keeps as margin, per pricing stance. */
const RESERVE = { aggressive: 0.2, balanced: 0.4, greedy: 0.6 };
const PRICING_LABEL = { aggressive: 'Aggressive', balanced: 'Balanced', greedy: 'Greedy' };

/**
 * Half-coin price granularity.
 *
 * Whole-coin rounding swallowed every cost difference: a card that is 1 coin
 * cheaper to run would round to the same bid as everyone else, and the job
 * would be decided by a coin flip. Pricing in halves lets efficiency actually
 * show up in the market.
 */
const half = (x) => Math.round(x * 2) / 2;

/**
 * A card's own asking price for a set of skills — pure function, same inputs
 * always produce the same number. No model is consulted for a price.
 */
function askingPrice(state, cardId, skillsNeeded) {
  const card = state.cards[cardId];
  const ownSteps = skillsNeeded.filter((s) => card.skills.includes(s)).length;
  const cost = ownSteps * card.baseCost;
  // Every skill step must clear at least 1 coin, otherwise bundling several
  // skills into one subcontract becomes a backdoor price weapon.
  const wantMargin = Math.max(card.policy.minMargin, ownSteps);
  return Math.max(card.policy.minPrice, half(cost + wantMargin));
}

/** FNV-1a — a small stable string hash, used to spread equally-good choices. */
function hashInt(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Cheapest card that can supply a given skill.
 *
 * Two subtleties that matter enormously at tables bigger than two seats:
 *
 *  - `preferIdle` skips cards already booked this round, so a card whose first
 *    choice is taken reaches for the next supplier instead of giving up.
 *  - When several suppliers are equally cheap, the choice is salted by the
 *    TASK id rather than by iteration order. Always taking the first-found
 *    monopolises one supplier: it gets booked for every cleaning job, and the
 *    card that could have primed another job never gets to bid at all.
 */
function cheapestProvider(state, skill, excludeCardId, preferIdle = true, salt = '') {
  const candidates = [];
  for (const card of Object.values(state.cards)) {
    if (card.id === excludeCardId) continue;
    if (!card.skills.includes(skill)) continue;
    candidates.push({ cardId: card.id, name: card.name, ask: askingPrice(state, card.id, [skill]), idle: card.status === 'IDLE' });
  }
  if (candidates.length === 0) return null;

  const idle = candidates.filter((c) => c.idle);
  const pool = preferIdle && idle.length > 0 ? idle : candidates;
  if (pool.length === 0) return { allBusy: true, name: null, ask: Infinity };

  const minAsk = Math.min(...pool.map((c) => c.ask));
  const cheapest = pool.filter((c) => c.ask === minAsk).sort((a, b) => (a.cardId < b.cardId ? -1 : 1));
  const pick = cheapest[hashInt(`${salt}|${skill}`) % cheapest.length];
  return { cardId: pick.cardId, name: pick.name, ask: pick.ask };
}

/**
 * Group the skills a card is missing by the card that can supply them, so a
 * single subcontract can bundle several skills from one provider.
 */
function groupProviders(state, missingSkills, excludeCardId, salt = '') {
  if (missingSkills.length === 0) return { ok: true, groups: [] };
  const byProvider = new Map();
  for (const skill of missingSkills) {
    const provider = cheapestProvider(state, skill, excludeCardId, true, salt);
    if (!provider) return { ok: false, missingSkill: skill };
    if (provider.allBusy) return { ok: false, missingSkill: skill, allBusy: true };
    if (!byProvider.has(provider.cardId)) {
      byProvider.set(provider.cardId, { cardId: provider.cardId, name: provider.name, skills: [] });
    }
    byProvider.get(provider.cardId).skills.push(skill);
  }
  const groups = [...byProvider.values()].map((g) => ({ ...g, ask: askingPrice(state, g.cardId, g.skills) }));
  return { ok: true, groups };
}

/**
 * Estimated cost of taking a job: own skill steps at baseCost, plus whatever
 * the subcontractors will charge for the skills this card lacks.
 */
function estimateCost(state, card, task) {
  const ownSteps = task.requires.filter((s) => card.skills.includes(s)).length;
  const missing = task.requires.filter((s) => !card.skills.includes(s));
  let cost = ownSteps * card.baseCost;

  // A prime contractor must contribute at least one skill of its own.
  // No pure pass-through brokering.
  if (ownSteps === 0) {
    return { cost: Infinity, subs: [], impossible: true, missingSkill: task.requires[0], noOwnSkill: true };
  }

  const grouped = groupProviders(state, missing, card.id, task.id);
  if (!grouped.ok) {
    return { cost: Infinity, subs: [], impossible: true, missingSkill: grouped.missingSkill, allBusy: !!grouped.allBusy };
  }
  for (const g of grouped.groups) cost += g.ask;
  return { cost, subs: grouped.groups, impossible: false };
}

/** Adjudicate a bid proposal. */
function gateBid(state, cardId, task, price) {
  const card = state.cards[cardId];
  const pol = card.policy;
  const blocks = [];

  if (card.cooldownUntilRound > 0 && card.cooldownUntilRound >= state.round) {
    blocks.push({ rule: 'Cooldown', detail: `${card.name} is benched until round ${card.cooldownUntilRound}` });
  }
  if (card.status !== 'IDLE') {
    blocks.push({ rule: 'Card occupied', detail: `${card.name} is ${card.status} — one card, one order at a time` });
  }
  if (!pol.whitelist.includes(task.type)) {
    blocks.push({ rule: 'Task whitelist', detail: `"${task.typeLabel}" is not in ${card.name}'s allowed task types` });
  }
  if (price > task.maxReward) {
    blocks.push({ rule: 'Client budget cap', detail: `Bid ${price} exceeds the client's ceiling of ${task.maxReward}` });
  }
  if (price < pol.minPrice) {
    blocks.push({ rule: 'Price floor', detail: `Bid ${price} is below ${card.name}'s floor of ${pol.minPrice}` });
  }
  if (task.requiresVerification && !pol.hireVerifier) {
    blocks.push({
      rule: 'Attestation required',
      detail: `Large jobs (${task.maxReward} coins) require third-party attestation, but this card has it switched off`,
    });
  }

  const est = estimateCost(state, card, task);
  if (est.impossible) {
    blocks.push({
      rule: est.noOwnSkill ? 'Own-skill requirement' : 'Missing capability',
      detail: est.noOwnSkill
        ? `${card.name} holds none of the skills "${task.typeLabel}" needs — pure pass-through brokering is not allowed`
        : `No card in the market can supply "${est.missingSkill}"`,
    });
  } else {
    const overBudget = est.subs.find((g) => g.ask > pol.maxSubSpend);
    if (overBudget) {
      blocks.push({
        rule: 'Subcontract spend cap',
        detail: `${overBudget.skills.join('+')} would have to go to ${overBudget.name} at ${overBudget.ask}, over this card's cap of ${pol.maxSubSpend}`,
      });
    }
    const margin = price - est.cost;
    if (margin < pol.minMargin) {
      blocks.push({
        rule: 'Minimum margin',
        detail: `Bid ${price} − estimated cost ${est.cost} = ${margin}, below the required minimum of ${pol.minMargin}`,
      });
    }
  }

  const margin = est.impossible ? -Infinity : price - est.cost;
  return { ok: blocks.length === 0, blocks, estCost: est.cost, margin, subs: est.subs };
}

/**
 * Adjudicate a subcontract hire. The prime must escrow the sub's fee at the
 * moment of hiring — insufficient balance means the hire simply fails.
 */
function gateSubcontract(state, buyerCardId, subPrice) {
  const buyer = state.cards[buyerCardId];
  const guild = state.guilds[buyer.guildId];
  const pol = buyer.policy;
  const blocks = [];

  if (subPrice > pol.maxSubSpend) {
    blocks.push({
      rule: 'Subcontract spend cap',
      detail: `Subcontract at ${subPrice} exceeds ${buyer.name}'s cap of ${pol.maxSubSpend}`,
    });
  }
  if (guild.cash < subPrice) {
    blocks.push({
      rule: 'Insufficient balance',
      detail: `${guild.name} holds ${guild.cash} in cash — not enough to escrow ${subPrice}`,
    });
  }
  return { ok: blocks.length === 0, blocks };
}

/** Adjudicate hiring the neutral Attestation Bureau. */
function gateVerifier(state, guildId) {
  const guild = state.guilds[guildId];
  const fee = state.neutral.verifier.fee;
  if (guild.cash < fee) {
    return { ok: false, blocks: [{ rule: 'Insufficient balance', detail: `Attestation costs ${fee}; ${guild.name} cannot cover it` }] };
  }
  return { ok: true, blocks: [], fee };
}

module.exports = {
  RESERVE,
  PRICING_LABEL,
  half,
  hashInt,
  gateBid,
  gateSubcontract,
  gateVerifier,
  estimateCost,
  cheapestProvider,
  groupProviders,
  askingPrice,
};
