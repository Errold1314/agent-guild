'use strict';

/**
 * 资金原语 —— 所有金币移动只经过这里，且每一步都是纯函数（返回新 state）。
 *
 * 账目分四档，互不混淆：
 *   cash       可用现金
 *   frozen     已发布任务冻结（客户"已备好资金"的证明）
 *   inEscrow   已授标、锁进托管（含子托管）
 *   platformFees 平台费沉淀（通胀泄压阀，不可回收）
 */

const PLATFORM_FEE_BP = 200; // 2%
const EPS = 1e-9;

const round2 = (x) => Math.round(x * 100) / 100;

function platformFee(amount) {
  return round2((amount * PLATFORM_FEE_BP) / 10000);
}

/** 内部换口袋（cash / frozen / inEscrow 三者之间）。 */
function move(state, guildId, from, to, amount) {
  if (amount < -EPS) throw new Error('资金移动金额不能为负');
  const g = state.guilds[guildId];
  if (!g) throw new Error(`商会 ${guildId} 不存在`);
  if (g[from] < amount - EPS) {
    throw new Error(`${g.name} 的 ${from} 余额不足：需要 ${amount}，实际 ${g[from]}`);
  }
  return {
    ...state,
    guilds: {
      ...state.guilds,
      [guildId]: { ...g, [from]: round2(g[from] - amount), [to]: round2(g[to] + amount) },
    },
  };
}

/** 客户发布任务：cash → frozen（"已备好资金"）。 */
function freeze(state, guildId, amount) {
  return move(state, guildId, 'cash', 'frozen', amount);
}

/** 授标后解冻差额：frozen → cash。 */
function unfreeze(state, guildId, amount) {
  if (amount <= EPS) return state;
  return move(state, guildId, 'frozen', 'cash', amount);
}

/** 冻结额转入托管：frozen → inEscrow。 */
function freezeToEscrow(state, guildId, amount) {
  return move(state, guildId, 'frozen', 'inEscrow', amount);
}

/** 自家现金转入托管（总包雇分包时）：cash → inEscrow。 */
function cashToEscrow(state, guildId, amount) {
  return move(state, guildId, 'cash', 'inEscrow', amount);
}

/**
 * 托管释放：inEscrow 出账，扣平台费后净额打给收款方。
 * 正确处理"同商会自雇"（payer === payee）的情形。
 * @returns {{state:object, fee:number, net:number}}
 */
function payFromEscrow(state, fromGuildId, toGuildId, amount) {
  const payer = state.guilds[fromGuildId];
  if (!payer) throw new Error(`商会 ${fromGuildId} 不存在`);
  if (payer.inEscrow < amount - EPS) {
    throw new Error(`${payer.name} 的托管余额不足：需要 ${amount}，实际 ${payer.inEscrow}`);
  }
  const fee = platformFee(amount);
  const net = round2(amount - fee);
  const sameGuild = fromGuildId === toGuildId;

  const guilds = { ...state.guilds };
  guilds[fromGuildId] = {
    ...payer,
    inEscrow: round2(payer.inEscrow - amount),
    cash: round2(payer.cash + (sameGuild ? net : 0)),
  };
  if (!sameGuild) {
    const payee = guilds[toGuildId];
    if (!payee) throw new Error(`Guild ${toGuildId} does not exist`);
    guilds[toGuildId] = { ...payee, cash: round2(payee.cash + net), earned: round2((payee.earned || 0) + net) };
  } else {
    guilds[fromGuildId] = { ...guilds[fromGuildId], earned: round2((guilds[fromGuildId].earned || 0) + net) };
  }
  return {
    state: { ...state, guilds, platformFees: round2((state.platformFees || 0) + fee) },
    fee,
    net,
  };
}

/** 托管退回付款方：inEscrow → cash（不扣费）。 */
function refundFromEscrow(state, fromGuildId, amount) {
  return move(state, fromGuildId, 'inEscrow', 'cash', amount);
}

/** 商会之间直接转账（现金 → 现金）。同会转账为 no-op。 */
function directPay(state, fromGuildId, toGuildId, amount) {
  if (amount <= EPS || fromGuildId === toGuildId) return state;
  const from = state.guilds[fromGuildId];
  if (from.cash < amount - EPS) {
    throw new Error(`${from.name} 现金不足：需要 ${amount}，实际 ${from.cash}`);
  }
  const to = state.guilds[toGuildId];
  if (!to) throw new Error(`商会 ${toGuildId} 不存在`);
  return {
    ...state,
    guilds: {
      ...state.guilds,
      [fromGuildId]: { ...from, cash: round2(from.cash - amount) },
      [toGuildId]: { ...to, cash: round2(to.cash + amount) },
    },
  };
}

/** 付给平台（购买中性服务，如独立验证）：cash → 平台沉淀。 */
function payFee(state, guildId, amount) {
  const g = state.guilds[guildId];
  if (g.cash < amount - EPS) throw new Error(`${g.name} 现金不足以支付 ${amount}`);
  return {
    ...state,
    guilds: { ...state.guilds, [guildId]: { ...g, cash: round2(g.cash - amount) } },
    platformFees: round2((state.platformFees || 0) + amount),
  };
}

/**
 * 卡牌自己的履约开销（人工/算力）：从商会现金支出，进入平台沉淀。
 * 现金不足时按可用额支付（不会因欠费卡死）。
 * @returns {{state:object, paid:number}}
 */
function payOperatingCost(state, guildId, amount) {
  const g = state.guilds[guildId];
  const paid = round2(Math.min(amount, g.cash));
  if (paid <= EPS) return { state, paid: 0 };
  return {
    state: {
      ...state,
      guilds: { ...state.guilds, [guildId]: { ...g, cash: round2(g.cash - paid) } },
      platformFees: round2((state.platformFees || 0) + paid),
    },
    paid,
  };
}

module.exports = {
  PLATFORM_FEE_BP,
  platformFee,
  freeze,
  unfreeze,
  freezeToEscrow,
  cashToEscrow,
  payFromEscrow,
  refundFromEscrow,
  directPay,
  payFee,
  payOperatingCost,
};
