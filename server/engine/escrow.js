'use strict';

const money = require('./money');
const { upsertEscrow, withEscrow } = require('./state');

/**
 * 托管状态机 —— 与 ERC-8183 的 job 生命周期同构。
 *
 *   FROZEN ──授标──> PARTIALLY_RELEASED ──fund──> LOCKED
 *                                                    │
 *              ┌─────────────────────────────────────┤
 *              │                                     │
 *        SUB_LOCKED（总包雇分包）              RELEASED / REFUNDED / DISPUTED
 *              │
 *        SUB_RELEASED（不可逆！）/ SUB_REFUNDED
 *
 * ⚠️ 核心规则（设计稿 §2.7）：SUB_RELEASED 是一条**单向边** ——
 *    子托管一旦释放给分包商，无论总包最终成败，这笔钱都不回滚。
 *    这就是"风险不对称"在状态机里的形式化表达。
 */

let escrowSeq = 0;

/**
 * 合法转移白名单。任何越界转移都会抛异常（烟雾测试会重放校验）。
 *
 * FROZEN 的语义是"托管记录已创建、资金尚未锁定"：
 *   · 主托管停在这里时，钱在客户的 frozen 口袋（发布任务时冻结）
 *   · 子托管停在这里时，钱还在总包的 cash 口袋（尚未雇佣）
 * 所以 FROZEN 既能走向主托管的 PARTIALLY_RELEASED，也能走向子托管的 SUB_LOCKED。
 */
const TRANSITIONS = {
  FROZEN: ['PARTIALLY_RELEASED', 'LOCKED', 'REFUNDED', 'SUB_LOCKED'], // REFUNDED = 流标解冻
  PARTIALLY_RELEASED: ['LOCKED'],
  LOCKED: ['SUB_LOCKED', 'RELEASED', 'REFUNDED', 'DISPUTED'],
  SUB_LOCKED: ['SUB_RELEASED', 'SUB_REFUNDED'],
  SUB_RELEASED: [], // 终点，不可逆
  SUB_REFUNDED: [],
  RELEASED: [], // 终点
  REFUNDED: [], // 终点
  DISPUTED: ['RELEASED', 'REFUNDED'],
};

function createEscrow(state, { orderId, amount, payerGuildId, payeeGuildId, kind, label }) {
  const escrow = {
    id: `esc-${String(++escrowSeq).padStart(3, '0')}`,
    orderId,
    kind, // 'main' | 'sub' | 'verify'
    label,
    amount,
    payerGuildId,
    payeeGuildId: payeeGuildId || null,
    state: 'FROZEN',
    history: [{ state: 'FROZEN', note: `${label}：冻结 ${amount} 币` }],
  };
  return { state: upsertEscrow(state, escrow), escrow };
}

/** 状态转移（带合法性校验）。 */
function transition(state, escrowId, to, note) {
  const esc = state.escrows.find((e) => e.id === escrowId);
  if (!esc) throw new Error(`托管 ${escrowId} 不存在`);
  if (!TRANSITIONS[esc.state].includes(to)) {
    throw new Error(`非法托管转移：${esc.state} → ${to}`);
  }
  return withEscrow(state, escrowId, {
    state: to,
    history: [...esc.history, { state: to, note }],
  });
}

// ── 高层结算流程 ──────────────────────────────────────────

/** 客户发布任务时冻结资金（托管记录停在 FROZEN，钱在商会的 frozen 口袋）。 */
function publishFreeze(state, escrowId, guildId, amount) {
  return money.freeze(state, guildId, amount);
}

/**
 * 授标：解冻差额（FROZEN→PARTIALLY_RELEASED），再托管中标价（→LOCKED）。
 *
 * ⚠️ 关键：托管记录的 amount 必须从「最高报酬」收敛为「中标价」，
 * 否则结算时会按最高报酬扣款，而实际只锁了中标价 —— 账会错。
 */
function lockForAward(state, escrowId, guildId, maxReward, awardPrice) {
  const diff = round2(maxReward - awardPrice);
  let next = money.unfreeze(state, guildId, diff);
  next = transition(next, escrowId, 'PARTIALLY_RELEASED', `授标价 ${awardPrice}，差额 ${diff} 币解冻退回客户`);
  next = money.freezeToEscrow(next, guildId, awardPrice);
  next = withEscrow(next, escrowId, { amount: awardPrice });
  next = transition(next, escrowId, 'LOCKED', `中标金额 ${awardPrice} 币已锁定进托管`);
  return next;
}

const round2 = (x) => Math.round(x * 100) / 100;

/** 总包雇佣分包：现金立即进子托管（余额不足则调用方已在前置闸门拦截）。 */
function lockSubcontract(state, escrowId, guildId, amount) {
  let next = money.cashToEscrow(state, guildId, amount);
  next = transition(next, escrowId, 'SUB_LOCKED', `分包款 ${amount} 币已锁定（授标即托管）`);
  return next;
}

/** 子验收通过 → 释放给分包商。不可回滚。 */
function releaseSub(state, escrowId, subGuildId) {
  const esc = state.escrows.find((e) => e.id === escrowId);
  const { state: paid, fee } = money.payFromEscrow(state, esc.payerGuildId, subGuildId, esc.amount);
  let next = transition(paid, escrowId, 'SUB_RELEASED', `子验收通过 → 支付 ${esc.amount} 币（平台费 ${fee}）。此笔不可回滚`);
  return { state: next, paid: esc.amount, fee };
}

/** 子交付失败/过期 → 退回总包。 */
function refundSub(state, escrowId) {
  const esc = state.escrows.find((e) => e.id === escrowId);
  let next = money.refundFromEscrow(state, esc.payerGuildId, esc.amount);
  next = transition(next, escrowId, 'SUB_REFUNDED', `子交付未通过 → ${esc.amount} 币退回总包`);
  return next;
}

/** 主验收通过 → 释放给中标卡所属商会。 */
function releaseMain(state, escrowId, sellerGuildId) {
  const esc = state.escrows.find((e) => e.id === escrowId);
  const { state: paid, fee, net } = money.payFromEscrow(state, esc.payerGuildId, sellerGuildId, esc.amount);
  let next = transition(paid, escrowId, 'RELEASED', `主验收通过 → 支付 ${net} 币给卖家（平台费 ${fee}）`);
  return { state: next, paid: net, fee };
}

/** 流标：任务无人合格投标 → 解冻退回客户。 */
function abortFrozen(state, escrowId, guildId) {
  const esc = state.escrows.find((e) => e.id === escrowId);
  let next = money.unfreeze(state, guildId, esc.amount);
  next = transition(next, escrowId, 'REFUNDED', `流标 → ${esc.amount} 币解冻退回客户`);
  return next;
}

/** 主验收失败 / 过期 → 全额退回客户。 */
function refundMain(state, escrowId) {
  const esc = state.escrows.find((e) => e.id === escrowId);
  let next = money.refundFromEscrow(state, esc.payerGuildId, esc.amount);
  next = transition(next, escrowId, 'REFUNDED', `主验收未通过 → ${esc.amount} 币全额退回客户`);
  return next;
}

/** 购买独立验证：付给平台（中性服务）。 */
function payVerifier(state, guildId, fee) {
  return money.payFee(state, guildId, fee);
}

module.exports = {
  createEscrow,
  transition,
  publishFreeze,
  lockForAward,
  lockSubcontract,
  releaseSub,
  refundSub,
  releaseMain,
  refundMain,
  abortFrozen,
  payVerifier,
  TRANSITIONS,
};
