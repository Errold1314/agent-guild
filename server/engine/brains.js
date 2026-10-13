'use strict';

const { estimateCost, askingPrice, RESERVE, half } = require('./policy');
const { dedupe, reconcile, classifyEntries, detectAnomalies, ACCOUNTS } = require('./data');

/**
 * Card brains — they PROPOSE, they never execute.
 *
 *   proposeBid()   should I bid, and at what price      → a proposal
 *   quoteForSub()  my own asking price as a subcontractor
 *   doWork()       actually do the job (real algorithms)
 *
 * Every proposal goes through policy.gate* — deterministic adjudication.
 * Brain proposes → gate adjudicates → fixed code executes.
 *
 * NOTE: there is deliberately no LLM here. The hook is proposeBid(); swap it
 * for a model call and the gate still stands between the model and the money.
 */

const PRICING_LABEL = { aggressive: 'Aggressive', balanced: 'Balanced', greedy: 'Greedy' };

function ownNote(card, task) {
  const own = task.requires.filter((s) => card.skills.includes(s));
  return own.length ? `own skills ${own.join('+')} cost ${own.length * card.baseCost}` : 'no usable skill of its own';
}

/** A card's bid proposal for a job. */
function proposeBid(state, cardId, task) {
  const card = state.cards[cardId];
  if (card.cooldownUntilRound > 0 && card.cooldownUntilRound >= state.round) {
    return { action: 'pass', reason: `${card.name} is benched until round ${card.cooldownUntilRound}` };
  }
  if (card.status !== 'IDLE') {
    return { action: 'pass', reason: `${card.name} is already occupied with another order` };
  }
  if (!card.policy.whitelist.includes(task.type)) {
    return { action: 'pass', reason: `"${task.typeLabel}" is outside ${card.name}'s allowed task types` };
  }
  if (task.requiresVerification && !card.policy.hireVerifier) {
    return {
      action: 'pass',
      reason: `This is a large job (${task.maxReward} coins) that mandates third-party attestation, but your rules have it switched off`,
    };
  }

  const est = estimateCost(state, card, task);
  if (est.impossible) {
    let reason;
    if (est.noOwnSkill) reason = `${card.name} holds none of the skills "${task.typeLabel}" needs — pure pass-through brokering is not allowed`;
    else if (est.allBusy) reason = `Every card that can supply "${est.missingSkill}" is already booked this round`;
    else reason = `No card at the table can supply "${est.missingSkill}"`;
    return { action: 'pass', reason };
  }

  const mode = card.policy.pricing || 'balanced';
  const reserve = RESERVE[mode] ?? 0.4;
  const surplus = Math.max(0, task.maxReward - est.cost);
  const wantMargin = Math.max(card.policy.minMargin, surplus * reserve);
  let price = half(est.cost + wantMargin);
  price = Math.max(price, card.policy.minPrice);
  price = Math.min(price, task.maxReward);

  const subNote = est.subs.length
    ? `subcontract ${est.subs.map((s) => `${s.skills.join('+')}→${s.name}@${s.ask}`).join(', ')}`
    : 'no subcontract needed';
  return {
    action: 'bid',
    price,
    cost: est.cost,
    margin: price - est.cost,
    subs: est.subs,
    reason: `Estimated cost ${est.cost} (${ownNote(card, task)}; ${subNote}); ${PRICING_LABEL[mode]} stance keeps ${Math.round(reserve * 100)}% of the surplus → bid ${price}`,
  };
}

/** A card's asking price when it is the subcontractor. */
function quoteForSub(state, cardId, skillsNeeded) {
  const card = state.cards[cardId];
  const ownSteps = skillsNeeded.filter((s) => card.skills.includes(s)).length;
  const cost = ownSteps * card.baseCost;
  const price = askingPrice(state, cardId, skillsNeeded);
  return { price, cost, margin: price - cost, reason: `${card.name}: own cost ${cost}, asking ${price} per its own policy` };
}

/**
 * A subcontractor's work: produces an INTERMEDIATE artifact handed back to the
 * prime contractor.
 */
function doSubWork(task, skills) {
  const hasDedupe = skills.includes('dedupe');
  const entries = hasDedupe ? dedupe(task.dataset.published) : task.dataset.published;
  const out = { bySkills: skills };
  if (hasDedupe) out.dedupe = entries;
  if (skills.includes('detect')) out.anomalies = detectAnomalies(entries).anomalies;
  if (skills.includes('classify')) out.buckets = classifyEntries(entries).buckets;
  if (skills.includes('reconcile')) out.net = reconcile(entries);
  return out;
}

/** Objective check on a sub-delivery — no ground truth needed, anyone can replay it. */
function checkSubDeliverable(skills, provided, published) {
  const findings = [];
  if (skills.includes('dedupe')) {
    const e = provided.dedupe;
    if (!Array.isArray(e) || e.length === 0) {
      findings.push('no cleaned dataset was returned');
    } else {
      const ids = e.map((x) => x.txId);
      if (new Set(ids).size !== ids.length) findings.push('returned dataset still contains duplicate txIds');
      const pub = new Set(published.map((x) => x.txId));
      if (ids.some((id) => !pub.has(id))) findings.push('returned a transaction that does not exist in the source log');
      if (e.length < published.length * 0.3) findings.push('suspiciously few records survived cleaning — possible data loss');
    }
  }
  if (skills.includes('detect') && !Array.isArray(provided.anomalies)) findings.push('no anomaly list returned');
  if (skills.includes('classify') && !provided.buckets) findings.push('no bucket counts returned');
  if (skills.includes('reconcile') && !provided.net) findings.push('no reconciliation figures returned');
  return { pass: findings.length === 0, findings };
}

/**
 * The prime contractor does its own work.
 *
 * Deliverable quality is a DIRECT function of which skills it assembled:
 * without `dedupe`, the reconciliation cannot tie out and the anomaly scan
 * over-reports. That is the whole reason subcontracting matters.
 */
function doWork(task, skills, provided = {}) {
  const hasDedupe = skills.has('dedupe');
  const entries = hasDedupe ? provided.dedupe || dedupe(task.dataset.published) : task.dataset.published;

  /**
   * Intermediate artifacts must not cross a cleaning boundary.
   * If a subcontractor computed its figures on UNCLEANED data, and this card
   * has its own cleaned view, it must recompute — otherwise the report can
   * never tie out.
   */
  const trust = (sub) => sub !== undefined && !hasDedupe;

  switch (task.type) {
    case 'reconcile': {
      const net = trust(provided.net) ? provided.net : reconcile(entries);
      return {
        cleaned: hasDedupe,
        notes: hasDedupe
          ? `Cleaned duplicate entries first (${task.dataset.published.length} → ${entries.length} records), then reconciled`
          : 'Reconciled straight off the raw log, without cleaning',
        accounts: ACCOUNTS.map((a) => ({ id: a.id, name: a.name, net: net[a.id] })),
      };
    }
    case 'classify': {
      const res = trust(provided.buckets) ? { buckets: provided.buckets, total: entries.length } : classifyEntries(entries);
      return { ...res, cleaned: hasDedupe };
    }
    case 'analyze': {
      const r = trust(provided.anomalies) ? { anomalies: provided.anomalies, threshold: null } : detectAnomalies(entries);
      return {
        anomalies: r.anomalies,
        method: 'median + 6×MAD (robust statistics)',
        threshold: r.threshold,
        cleaned: hasDedupe,
      };
    }
    default:
      throw new Error(`Unknown task type ${task.type}`);
  }
}

module.exports = { proposeBid, quoteForSub, doSubWork, checkSubDeliverable, doWork, PRICING_LABEL };
