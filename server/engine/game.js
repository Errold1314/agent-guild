'use strict';

const { emit } = require('./events');
const { createInitialState, withCard, upsertTask, withSeat, MAINTENANCE_FEE } = require('./state');
const { buildRoundTasks, award } = require('./market');
const { proposeBid, doSubWork, checkSubDeliverable, doWork } = require('./brains');
const { gateBid, gateSubcontract, gateVerifier, estimateCost } = require('./policy');
const escrow = require('./escrow');
const money = require('./money');
const { signQuote } = require('./signing');
const { runChecker, applyReputation, finalize } = require('./verify');
const a2a = require('../protocol/a2a');
const bagClient = require('../protocol/bagClient');

/**
 * Round orchestration — four phases:
 *   1. POLICY   players edit their standing rules (the only human input)
 *   2. MARKET   the client posts jobs → cards bid → deterministic award
 *   3. WORK     winners subcontract, work, get attested, submit
 *   4. SETTLE   acceptance → release or refund → upkeep → reputation
 */

const BASE_STEP_MS = 460;
let S = null;
let running = false;
let bidSeq = 0;
let armedFault = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function set(next) {
  S = next;
  return S;
}

// ── Public API ────────────────────────────────────────────
function startMatch(opts = {}) {
  set(createInitialState(opts));
  running = false;
  bidSeq = 0;
  armedFault = false;
  emit('match.start', {
    seed: S.seed,
    room: S.room,
    maxRounds: S.maxRounds,
    guildCount: S.guildCount,
    guilds: Object.values(S.guilds)
      .filter((g) => g.kind !== 'neutral')
      .map((g) => ({ id: g.id, name: g.name, seat: g.seat, accent: g.accent })),
  });
  return S;
}

function getState() {
  return S;
}

function setSpeed(n) {
  set({ ...S, speed: Math.max(1, Math.min(8, Number(n) || 3)) });
  return S.speed;
}

/**
 * Claim a seat at the table.
 *
 * Every seat — including the host's — belongs to whichever client claimed it
 * first. There is no other notion of identity here, so "the host always holds
 * seat 1" would let any later visitor edit the host's cards.
 */
function claimSeat(index, clientId, address) {
  if (!clientId) return { ok: false, reason: 'missing client id' };
  if (running) return { ok: false, reason: 'A round is in progress — take a seat between rounds' };
  const seat = S.seats[index];
  if (!seat || !seat.guildId) return { ok: false, reason: 'That seat is empty at this table' };
  if (seat.claimedBy && seat.claimedBy !== clientId) return { ok: false, reason: 'That seat is already taken' };

  set(withSeat(S, index, { claimedBy: clientId, address: address || seat.address || null }));
  // A human sitting here takes the guild off autopilot.
  const guild = S.guilds[seat.guildId];
  if (guild) set({ ...S, guilds: { ...S.guilds, [seat.guildId]: { ...guild, kind: 'human' } } });
  emit('seat.claimed', { seat: index, guildId: seat.guildId, name: guild ? guild.name : '', address: address || null });
  return { ok: true, seat: S.seats[index] };
}

function releaseSeat(index, clientId) {
  const seat = S.seats[index];
  if (!seat || seat.claimedBy !== clientId) return { ok: false, reason: 'You do not hold that seat' };
  set(withSeat(S, index, { claimedBy: null }));
  const guild = S.guilds[seat.guildId];
  if (guild) set({ ...S, guilds: { ...S.guilds, [seat.guildId]: { ...guild, kind: 'ai' } } });
  emit('seat.released', { seat: index, guildId: seat.guildId });
  return { ok: true };
}

/** Seal a wallet address onto a seat (identity only — see README). */
function linkWallet(clientId, address) {
  const seat = S.seats.find((s) => s.claimedBy === clientId);
  if (!seat) return { ok: false, reason: 'Take a seat before linking a wallet' };
  set(withSeat(S, seat.index, { address }));
  emit('seat.wallet', { seat: seat.index, guildId: seat.guildId, address });
  return { ok: true, seat: S.seats[seat.index] };
}

/**
 * Who is allowed to edit this card's standing rules?
 *
 * Uniform rule: you may configure exactly the cards sitting in a seat YOU
 * hold. No special case for the host seat — a special case is precisely how a
 * second player ends up able to rewrite the host's rules.
 */
function canEdit(state, cardId, clientId) {
  if (!clientId) return false;
  const card = state.cards[cardId];
  if (!card) return false;
  const guild = state.guilds[card.guildId];
  if (!guild || guild.kind === 'neutral') return false;
  const seat = state.seats[guild.seat];
  return !!seat && seat.claimedBy === clientId;
}

function updatePolicy(cardId, patch, clientId) {
  if (running) return { ok: false, reason: 'A round is in progress — edit your rules during the policy window' };
  if (!canEdit(S, cardId, clientId)) return { ok: false, reason: 'That card is not yours to configure' };

  const card = S.cards[cardId];
  const clean = {};
  if (patch.minPrice !== undefined) clean.minPrice = Math.max(0, Number(patch.minPrice) || 0);
  if (patch.maxSubSpend !== undefined) clean.maxSubSpend = Math.max(0, Number(patch.maxSubSpend) || 0);
  if (patch.minMargin !== undefined) clean.minMargin = Math.max(0, Number(patch.minMargin) || 0);
  if (patch.hireVerifier !== undefined) clean.hireVerifier = !!patch.hireVerifier;
  if (patch.pricing && ['aggressive', 'balanced', 'greedy'].includes(patch.pricing)) clean.pricing = patch.pricing;
  if (Array.isArray(patch.whitelist)) {
    clean.whitelist = patch.whitelist.filter((t) => ['reconcile', 'classify', 'analyze'].includes(t));
  }

  set({ ...S, cards: { ...S.cards, [cardId]: { ...card, policy: { ...card.policy, ...clean } } } });
  emit('policy.update', { cardId, cardName: card.name, guildId: card.guildId, policy: S.cards[cardId].policy });
  return { ok: true, policy: S.cards[cardId].policy };
}

/** Demo aid: make the next deliverable wrong, to show the refund path. */
function injectFault() {
  if (running) return { ok: false, reason: 'A round is in progress — arm the fault before starting one' };
  armedFault = true;
  emit('demo.fault.armed', {
    note: 'Armed one workmanship fault: the next deliverable will be wrong, so the refund path can be demonstrated',
  });
  return { ok: true };
}

async function tick(mult = 1) {
  await sleep((BASE_STEP_MS * mult) / Math.max(1, S?.speed ?? 3));
}

// ── Match / round flow ────────────────────────────────────
async function runRound() {
  if (!S) startMatch();
  if (running) return { ok: false, reason: 'This round is still running' };
  if (S.phase === 'DONE') return { ok: false, reason: 'The match is over — reset to play again' };

  running = true;
  try {
    set({ ...S, round: S.round + 1, phase: 'POLICY' });
    emit('phase', {
      phase: 'POLICY',
      round: S.round,
      title: `Round ${S.round} / ${S.maxRounds} · Policy Window`,
      desc: 'Every card is reading the standing rules its owner set',
    });
    await tick(2);

    // Clear last round's occupancy and cooldowns.
    const cards = {};
    for (const [id, c] of Object.entries(S.cards)) cards[id] = { ...c, status: 'IDLE' };
    set({ ...S, cards });

    await marketPhase();
    await workPhase();
    await settlePhase();

    if (S.round >= S.maxRounds) {
      set(finalize({ ...S, phase: 'DONE' }));
      emit('match.end', { standings: S.finalStandings, winner: S.winner });
    } else {
      set({ ...S, phase: 'IDLE' });
      emit('phase', { phase: 'IDLE', round: S.round, title: `Round ${S.round} complete`, desc: 'Adjust your standing rules and deal again' });
    }
  } finally {
    running = false;
  }
  return { ok: true };
}

// ── Phase 2: MARKet ───────────────────────────────────────
async function marketPhase() {
  set({ ...S, phase: 'MARKET' });
  emit('phase', {
    phase: 'MARKET',
    round: S.round,
    title: `Round ${S.round} · Job Market`,
    desc: 'The neutral client posts funded jobs; cards bid on their own',
  });
  await tick();

  const templates = buildRoundTasks(S.round, S.seed, S.guildCount);
  const ids = [];
  for (const t of templates) {
    const { state: s1, escrow: esc } = escrow.createEscrow(S, {
      orderId: t.id,
      amount: t.maxReward,
      payerGuildId: 'CUS',
      kind: 'main',
      label: `Job ${t.id} · ${t.typeLabel}`,
    });
    set(s1);
    set(escrow.publishFreeze(S, esc.id, 'CUS', t.maxReward));
    set(upsertTask(S, { ...t, escrowId: esc.id }));
    ids.push(t.id);
    emit('task.publish', {
      taskId: t.id,
      title: t.title,
      typeLabel: t.typeLabel,
      brief: t.brief,
      requires: t.requires,
      maxReward: t.maxReward,
      requiresVerification: t.requiresVerification,
      checkerName: t.checkerName,
      checkerHash: t.checkerHash,
      rowCount: t.dataset.published.length,
      escrowId: esc.id,
    });
    await tick(1.1);
  }

  for (const id of ids) await auction(id);
}

function taskById(id) {
  return S.tasks.find((t) => t.id === id);
}

/**
 * Where a quote comes from: the built-in brain by default; if the card has a
 * BAG_ENDPOINT_* set, a REAL `bag dev` agent is asked instead.
 * Either way the same deterministic gate adjudicates the result.
 */
async function proposeFor(card, task) {
  const endpoint = bagClient.endpointFor(card.id);
  if (!endpoint) return proposeBid(S, card.id, task);
  try {
    const { price, raw } = await bagClient.negotiateQuote(endpoint, {
      taskId: task.id,
      description: task.title,
      deliverables: task.brief,
      qualityStandards: `${task.checkerName}@${task.checkerHash}`,
    });
    emit('bag.quote', {
      taskId: task.id,
      cardId: card.id,
      cardName: card.name,
      endpoint,
      price,
      quote: raw,
      note: 'This bid came from a live bag agent, not from the local brain',
    });
    return {
      action: 'bid',
      price,
      external: true,
      reason: `Signed quote from live bag agent ${endpoint} (negotiation_hash ${String(raw.negotiation_hash || '').slice(0, 12)}…)`,
    };
  } catch (err) {
    const msg = String(err.message || err);
    emit('bag.error', { taskId: task.id, cardId: card.id, cardName: card.name, endpoint, error: msg });
    return { action: 'pass', reason: `Live bag agent ${endpoint} unreachable: ${msg}` };
  }
}

async function auction(taskId) {
  const task = taskById(taskId);
  const bids = [];

  for (const card of Object.values(S.cards)) {
    const prop = await proposeFor(card, task);

    if (prop.action === 'pass') {
      emit('bid.pass', { taskId, cardId: card.id, cardName: card.name, guildId: card.guildId, reason: prop.reason });
      await tick(0.65);
      continue;
    }

    const gate = gateBid(S, card.id, task, prop.price);
    if (!gate.ok) {
      emit('bid.blocked', {
        taskId,
        cardId: card.id,
        cardName: card.name,
        guildId: card.guildId,
        price: prop.price,
        reason: prop.reason,
        blocks: gate.blocks,
      });
      await tick(0.85);
      continue;
    }

    const quote = signQuote({ cardId: card.id, taskId, price: prop.price });
    const bid = {
      cardId: card.id,
      cardName: card.name,
      guildId: card.guildId,
      price: prop.price,
      cost: prop.cost,
      margin: prop.margin,
      quote,
      gateOk: true,
      seq: ++bidSeq,
      reason: prop.reason,
      envelope: a2a.negotiateEnvelope({
        taskId,
        description: task.title,
        deliverables: task.brief,
        qualityStandards: `${task.checkerName}@${task.checkerHash}`,
      }),
    };
    bids.push(bid);
    set({ ...S, tasks: S.tasks.map((t) => (t.id === taskId ? { ...t, bids: [...bids] } : t)) });
    emit('bid.accept', {
      taskId,
      cardId: bid.cardId,
      cardName: bid.cardName,
      guildId: bid.guildId,
      price: bid.price,
      margin: bid.margin,
      reason: bid.reason,
      quote: bid.quote,
    });
    await tick(0.85);
  }

  const winner = award(bids, S, taskId);
  if (!winner) {
    set(upsertTask(S, { ...task, state: 'NO_BID', bids }));
    set(escrow.abortFrozen(S, task.escrowId, 'CUS'));
    emit('task.nobid', { taskId, maxReward: task.maxReward, note: 'No eligible bid — the client gets its funds back' });
    await tick(1.1);
    return;
  }

  // The winner locks in its suppliers right now, and that exact plan is what
  // it will execute later. Deciding the suppliers here (rather than at work
  // time) is what makes "booking a scarce card" a real strategy.
  const est = estimateCost(S, S.cards[winner.cardId], task);
  const subPlan = est.subs.map((g) => ({ cardId: g.cardId, name: g.name, skills: [...g.skills], ask: g.ask }));

  set(upsertTask(S, { ...task, state: 'AWARDED', bids, awardee: winner.cardId, winnerPrice: winner.price, subPlan }));
  set(escrow.lockForAward(S, task.escrowId, 'CUS', task.maxReward, winner.price));
  set(
    withCard(S, winner.cardId, {
      // One card, one order. Occupying the winner immediately is what makes
      // every later job in this round see it as unavailable.
      status: 'BUSY',
      lastAction: { text: `Won "${task.typeLabel}" at ${winner.price}`, reason: winner.reason, gate: 'pass', ts: Date.now() },
    })
  );
  emit('award', {
    taskId,
    cardId: winner.cardId,
    cardName: winner.cardName,
    guildId: winner.guildId,
    price: winner.price,
    maxReward: task.maxReward,
    quote: winner.quote,
    tie: !!winner._tied,
    tiedWith: winner._tiedWith || [],
  });
  await tick(1.1);

  // Scarce skills are a real bottleneck; grabbing that card is legitimate play.
  for (const g of subPlan) {
    set(
      withCard(S, g.cardId, {
        status: 'BUSY',
        lastAction: {
          text: `Booked this round by ${winner.cardName} (${g.skills.join('+')} @ ${g.ask})`,
          reason: `${winner.cardName} won "${task.typeLabel}" and locked in its supplier immediately — one card, one order`,
          gate: 'pass',
          ts: Date.now(),
        },
      })
    );
    emit('card.reserved', {
      taskId,
      cardId: g.cardId,
      cardName: g.name,
      guildId: S.cards[g.cardId].guildId,
      byCardId: winner.cardId,
      byCardName: winner.cardName,
      skills: g.skills,
      ask: g.ask,
    });
    await tick(0.7);
  }
}

// ── Phase 3: WORK ─────────────────────────────────────────
async function workPhase() {
  set({ ...S, phase: 'WORK' });
  emit('phase', {
    phase: 'WORK',
    round: S.round,
    title: `Round ${S.round} · Fulfilment`,
    desc: 'Winners subcontract, work, get attested, and submit',
  });
  await tick();
  const workable = S.tasks.filter((t) => t.round === S.round && t.state === 'AWARDED');
  for (const t of workable) await fulfill(t.id);
}

async function fulfill(taskId) {
  const task = taskById(taskId);
  const card = S.cards[task.awardee];
  const guildId = card.guildId;
  const skills = new Set(card.skills);
  const provided = {};
  let subTotal = 0;

  set(upsertTask(S, { ...task, state: 'WORKING' }));

  // ── Subcontracting ── the plan was fixed at award time; execute it as-is.
  const est = { subs: (task.subPlan || []).map((g) => ({ ...g, ask: g.ask })) };
  for (const group of est.subs) {
    const provider = S.cards[group.cardId];
    const price = group.ask;

    const gate = gateSubcontract(S, card.id, price);
    if (!gate.ok) {
      emit('sub.blocked', { taskId, buyerCardName: card.name, providerName: provider.name, price, blocks: gate.blocks });
      await tick();
      return expireOrder(taskId, 'Subcontract blocked by the gate — the order cannot be fulfilled', gate.blocks);
    }

    const quote = signQuote({ cardId: provider.id, taskId, price });
    emit('sub.negotiate', {
      taskId,
      buyerCardId: card.id,
      buyerCardName: card.name,
      providerCardId: provider.id,
      providerCardName: provider.name,
      skills: group.skills,
      price,
      quote,
      envelope: a2a.negotiateEnvelope({
        taskId,
        description: `Subcontract: ${group.skills.join(' / ')}`,
        deliverables: 'Cleaned intermediate artifact',
        qualityStandards: 'structural integrity + no duplicate txIds',
      }),
    });
    await tick();

    // Hire = escrow, immediately.
    const { state: s1, escrow: esc } = escrow.createEscrow(S, {
      orderId: taskId,
      amount: price,
      payerGuildId: guildId,
      payeeGuildId: provider.guildId,
      kind: 'sub',
      label: `Subcontract ${group.skills.join('+')} → ${provider.name}`,
    });
    set(s1);
    set(escrow.lockSubcontract(S, esc.id, guildId, price));
    emit('escrow.sublock', {
      taskId,
      escrowId: esc.id,
      amount: price,
      from: guildId,
      to: provider.guildId,
      label: esc.label,
      note: 'Hired means escrowed — the subcontractor’s fee is locked before any work starts',
    });
    await tick();

    const delivered = doSubWork(task, group.skills);
    const check = checkSubDeliverable(group.skills, delivered, task.dataset.published);
    emit('sub.deliver', {
      taskId,
      providerCardId: provider.id,
      providerCardName: provider.name,
      guildId: provider.guildId,
      skills: group.skills,
      pass: check.pass,
      findings: check.findings,
      summary: subSummary(group.skills, delivered),
    });
    await tick();

    if (check.pass) {
      const r = escrow.releaseSub(S, esc.id, provider.guildId);
      set(r.state);
      const pc = S.cards[provider.id];
      set(withCard(S, provider.id, { stats: { ...pc.stats, sold: pc.stats.sold + 1 } }));
      emit('escrow.subrelease', {
        taskId,
        escrowId: esc.id,
        amount: r.paid,
        fee: r.fee,
        toGuildId: provider.guildId,
        providerName: provider.name,
        irreversible: true,
        note: 'Sub-delivery accepted → paid on the spot. This transfer never rolls back',
      });
      group.skills.forEach((sk) => skills.add(sk));
      const { bySkills, ...payload } = delivered;
      Object.assign(provided, payload);
      subTotal += price;
    } else {
      set(escrow.refundSub(S, esc.id));
      emit('escrow.subrefund', { taskId, escrowId: esc.id, amount: price, toGuildId: guildId });
      await tick();
      return expireOrder(taskId, `Sub-delivery failed its objective check: ${check.findings.join('; ')}`);
    }
    await tick();
  }

  // ── The prime's own operating cost (real cash, not a paper number) ──
  const ownSteps = task.requires.filter((s) => card.skills.includes(s)).length;
  const ownCost = ownSteps * card.baseCost;
  const { state: afterCost, paid } = money.payOperatingCost(S, guildId, ownCost);
  set(afterCost);
  if (paid > 0) {
    emit('cost.operating', { taskId, guildId, cardId: card.id, cardName: card.name, amount: paid });
    await tick(0.5);
  }

  // ── The prime does the work (real algorithms) ──
  await tick(0.9);
  let deliverable = doWork(task, skills, provided);

  // An armed fault is a defect in THIS card's workmanship — rework cannot fix it.
  let faulted = taskById(taskId).faulted === true;
  if (armedFault) {
    armedFault = false;
    faulted = true;
    set(upsertTask(S, { ...taskById(taskId), faulted: true }));
    emit('demo.fault', {
      taskId,
      note: 'The armed workmanship fault has landed: this card’s pipeline is defective, and rework will not repair it',
    });
    await tick();
  }
  if (faulted) deliverable = corruptDeliverable(task, deliverable);

  emit('card.work', {
    taskId,
    cardId: card.id,
    cardName: card.name,
    guildId,
    skills: [...skills],
    subTotal,
    ownCost: paid,
    summary: deliverableSummary(task.type, deliverable),
  });
  await tick(1.1);

  // ── Optional independent attestation ── without it a card submits blind
  let verifiedBy = null;
  let reworked = false;
  if (card.policy.hireVerifier) {
    const vgate = gateVerifier(S, guildId);
    if (vgate.ok) {
      set(escrow.payVerifier(S, guildId, vgate.fee));
      emit('verifier.hired', { taskId, guildId, cardId: card.id, cardName: card.name, fee: vgate.fee });
      await tick();
      const vr = runChecker(task, deliverable);
      verifiedBy = 'VER';
      emit('verifier.result', { taskId, pass: vr.result.pass, findings: vr.result.findings, evidence: vr.evidence });
      await tick();

      if (!vr.result.pass) {
        reworked = true;
        const missing = task.requires.filter((s) => !skills.has(s));
        let extra = 0;
        for (const sk of missing) {
          const g = est.subs.find((x) => x.skills.includes(sk));
          if (!g) continue;
          const gGate = gateSubcontract(S, card.id, g.ask);
          if (!gGate.ok) continue;
          const { state: s2, escrow: esc2 } = escrow.createEscrow(S, {
            orderId: taskId,
            amount: g.ask,
            payerGuildId: guildId,
            payeeGuildId: S.cards[g.cardId].guildId,
            kind: 'sub',
            label: `Rework: buy missing skill ${sk}`,
          });
          set(s2);
          set(escrow.lockSubcontract(S, esc2.id, guildId, g.ask));
          const extraDelivered = doSubWork(task, [sk]);
          const r2 = escrow.releaseSub(S, esc2.id, S.cards[g.cardId].guildId);
          set(r2.state);
          skills.add(sk);
          const { bySkills, ...payload } = extraDelivered;
          Object.assign(provided, payload);
          extra += g.ask;
          emit('rework.sub', { taskId, skill: sk, cardName: S.cards[g.cardId].name, price: g.ask });
          await tick();
        }
        emit('rework.start', { taskId, cardName: card.name, note: 'Attestation failed — using the one rework allowance', extraCost: extra });
        await tick(1.2);
        deliverable = doWork(task, skills, provided);
        if (taskById(taskId).faulted) deliverable = corruptDeliverable(task, deliverable);
        emit('card.work', {
          taskId,
          cardId: card.id,
          cardName: card.name,
          guildId,
          skills: [...skills],
          rework: true,
          summary: deliverableSummary(task.type, deliverable),
        });
        await tick(1.1);
      }
    } else {
      emit('verifier.blocked', { taskId, blocks: vgate.blocks });
    }
  } else {
    emit('submit.blind', { taskId, cardName: card.name, note: 'No attestation bought — submitting blind, with no rework if it fails' });
    await tick(0.8);
  }

  emit('order.submitted', {
    taskId,
    cardId: card.id,
    cardName: card.name,
    guildId,
    verifiedBy,
    reworked,
    subTotal,
    deliverable,
  });
  await tick(0.9);

  const cur = taskById(taskId);
  set(upsertTask(S, { ...cur, deliverable, verifiedBy, reworked, state: 'SUBMITTED' }));
}

function expireOrder(taskId, reason, blocks = []) {
  const task = taskById(taskId);
  const card = S.cards[task.awardee];
  set(upsertTask(S, { ...task, state: 'EXPIRED', failureReason: reason }));
  set(escrow.refundMain(S, task.escrowId));
  const rep = applyReputation(S, card.guildId, card.id, 'expired');
  set(rep.state);
  set(withCard(S, card.id, { cooldownUntilRound: S.round + 1 }));
  emit('order.expired', {
    taskId,
    cardId: card.id,
    cardName: card.name,
    guildId: card.guildId,
    reason,
    blocks,
    refund: task.winnerPrice,
    reputation: rep.delta,
    note: 'Order voided → the client is refunded in full, and the card is benched next round',
  });
}

// ── Phase 4: SETTLE ───────────────────────────────────────
async function settlePhase() {
  set({ ...S, phase: 'SETTLE' });
  emit('phase', {
    phase: 'SETTLE',
    round: S.round,
    title: `Round ${S.round} · Settlement`,
    desc: 'Acceptance → release or refund → upkeep → reputation',
  });
  await tick();

  for (const t of S.tasks.filter((x) => x.round === S.round && x.state === 'SUBMITTED')) {
    const seller = S.cards[t.awardee];

    // A large job with no attestation cannot be accepted, full stop.
    if (t.requiresVerification && !t.verifiedBy) {
      set(upsertTask(S, { ...t, truthRevealed: true, verification: { pass: false, findings: ['Client mandates third-party attestation; this submission carries no evidence bundle'] } }));
      set(escrow.refundMain(S, t.escrowId));
      const rep0 = applyReputation(S, seller.guildId, t.awardee, 'failed');
      set(rep0.state);
      emit('escrow.refund', {
        taskId: t.id,
        amount: t.winnerPrice,
        toGuildId: 'CUS',
        cardName: seller.name,
        guildId: seller.guildId,
        findings: ['no attestation attached'],
        reputation: rep0.delta,
        note: 'No attestation → the client is refunded in full',
      });
      await tick();
      continue;
    }

    const res = runChecker(t, t.deliverable);
    set(upsertTask(S, { ...t, truthRevealed: true, verification: res.result, evidence: res.evidence }));
    emit('settle.verify', {
      taskId: t.id,
      pass: res.result.pass,
      findings: res.result.findings,
      checkerHash: t.checkerHash,
      note: 'Checker replayed; ground truth revealed (commit–reveal)',
    });
    await tick();

    if (res.result.pass) {
      const r = escrow.releaseMain(S, t.escrowId, seller.guildId);
      set(r.state);
      const rep = applyReputation(S, seller.guildId, t.awardee, t.reworked ? 'afterRework' : 'firstPass');
      set(rep.state);
      emit('escrow.release', {
        taskId: t.id,
        amount: r.paid,
        fee: r.fee,
        toGuildId: seller.guildId,
        cardName: seller.name,
        guildId: seller.guildId,
        reputation: rep.delta,
      });
    } else {
      set(escrow.refundMain(S, t.escrowId));
      const rep = applyReputation(S, seller.guildId, t.awardee, 'failed');
      set(rep.state);
      set(withCard(S, t.awardee, { cooldownUntilRound: S.round + 1 }));
      emit('escrow.refund', {
        taskId: t.id,
        amount: t.winnerPrice,
        toGuildId: 'CUS',
        cardName: seller.name,
        guildId: seller.guildId,
        findings: res.result.findings,
        reputation: rep.delta,
        note: 'Acceptance failed → the client is refunded in full (already-accepted subcontracts are NOT clawed back)',
      });
    }
    await tick(1.1);
  }

  // Upkeep — sitting still bleeds money.
  for (const g of Object.values(S.guilds).filter((x) => x.kind !== 'neutral')) {
    const count = Object.values(S.cards).filter((c) => c.guildId === g.id).length;
    const fee = MAINTENANCE_FEE * count;
    const { state: s2, paid } = money.payOperatingCost(S, g.id, fee);
    set(s2);
    emit('cost.maintenance', { guildId: g.id, guildName: g.name, cardCount: count, amount: paid });
    await tick(0.4);
  }

  const standings = Object.values(S.guilds)
    .filter((g) => g.kind !== 'neutral')
    .map((g) => ({
      guildId: g.id,
      seat: g.seat,
      name: g.name,
      accent: g.accent,
      cash: g.cash,
      escrow: g.inEscrow,
      reputation: g.reputation,
      score: Math.round((g.cash + g.frozen + g.inEscrow + Math.round((g.reputation - 50) / 10)) * 100) / 100,
    }))
    .sort((a, b) => b.score - a.score);
  set({ ...S, roundSummaries: [...S.roundSummaries, { round: S.round, standings }] });
  emit('round.summary', { round: S.round, standings, platformFees: S.platformFees });
}

// ── Helpers ───────────────────────────────────────────────
function subSummary(skills, delivered) {
  const parts = [];
  if (delivered.dedupe) parts.push(`${delivered.dedupe.length} records after cleaning`);
  if (delivered.anomalies) parts.push(`${delivered.anomalies.length} preliminary anomalies`);
  if (delivered.buckets) parts.push(`buckets ${Object.values(delivered.buckets).join('/')}`);
  return `${skills.join('+')}: ${parts.join(', ') || 'done'}`;
}

function deliverableSummary(type, d) {
  if (type === 'reconcile') {
    const worst = d.accounts.reduce((a, b) => (Math.abs(a.net) > Math.abs(b.net) ? a : b));
    return `${d.cleaned ? 'cleaned' : 'NOT cleaned'}; largest account net ${worst.net} (${worst.name})`;
  }
  if (type === 'classify') return `buckets ${Object.values(d.buckets).join(' / ')}, total ${d.total}`;
  if (type === 'analyze') return `${d.anomalies.length} anomalies reported${d.cleaned ? ' (cleaned)' : ' (NOT cleaned)'}`;
  return '';
}

/** Demo corruption: makes a correct deliverable wrong, to show the refund path. */
function corruptDeliverable(task, d) {
  if (task.type === 'reconcile') {
    const accounts = d.accounts.map((a, i) => (i === 0 ? { ...a, net: Math.round((a.net + 37.5) * 100) / 100 } : a));
    return { ...d, accounts, notes: `${d.notes} (demo-injected drift)` };
  }
  if (task.type === 'classify') return { ...d, buckets: { ...d.buckets, small: d.buckets.small + 3 } };
  if (task.type === 'analyze') return { ...d, anomalies: [...d.anomalies, 'tx-9999'] };
  return d;
}

module.exports = {
  startMatch,
  getState,
  setSpeed,
  claimSeat,
  releaseSeat,
  linkWallet,
  canEdit,
  updatePolicy,
  injectFault,
  runRound,
  isRunning: () => running,
};
