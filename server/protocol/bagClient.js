'use strict';

const a2a = require('./a2a');

/**
 * 真实 bag agent 客户端 —— 把一个内置大脑替换成真 `bag dev` 端点的接缝。
 *
 * 用法：给某张卡设环境变量，游戏就会去问真 agent 要报价，而不是用内置大脑。
 *
 *   $env:BAG_ENDPOINT_A_REPORT = "http://localhost:9001"
 *   node server/index.js
 *
 * 之后：
 *   · 报价 = 真 agent 的签名报价（bag 的 negotiate 技能，链下 EIP-191，零 gas）
 *   · 游戏侧仍然过一遍**同一个确定性闸门** —— 外部 agent 越界一样被拦
 *
 * 这就是"拔掉卡牌桌，商业照跑"的接缝：线上格式一字不改。
 */

/** 卡牌 id → 端点（从环境变量读）。 */
function endpointFor(cardId) {
  const key = 'BAG_ENDPOINT_' + cardId.toUpperCase().replace(/-/g, '_');
  return process.env[key] || null;
}

/** 卡牌 id → ERC-8183 里的 provider 地址（上链买断时用）。 */
function providerAddressFor(cardId) {
  const key = 'BAG_PROVIDER_' + cardId.toUpperCase().replace(/-/g, '_');
  return process.env[key] || null;
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

/**
 * 向真 bag agent 要一张签名报价单。
 *
 * bag 侧要求 terms 里必须同时有 deliverables 和 quality_standards，
 * 少任何一个都会被拒签（reason_code 0x04）—— 这正是任务牌的两个核心字段。
 *
 * @returns {Promise<{price:number, raw:object}>} price 已换算成游戏币（1 币 = 0.01 USD）
 */
async function negotiateQuote(endpoint, { taskId, description, deliverables, qualityStandards }, timeoutMs = 8000) {
  const envelope = a2a.negotiateEnvelope({ taskId, description, deliverables, qualityStandards });
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();

    // bag 把 NegotiationResult 放在回复的 DataPart 里
    const part = body?.result?.parts?.find((p) => p.kind === 'data') || body?.parts?.find((p) => p.kind === 'data');
    const quote = part?.data?.quote || part?.data || body?.result?.data || body?.data;
    if (!quote || typeof quote.price === 'undefined') {
      throw new Error('回复里没有可用的报价（bag 会把 NegotiationResult 放在 DataPart 里）');
    }

    // 报价单位是 USD 字符串（如 "0.10"）→ 换算成游戏币
    const priceUsd = Number(quote.price);
    if (!Number.isFinite(priceUsd)) throw new Error(`报价不是合法数字：${quote.price}`);

    return { price: Math.max(1, Math.round(priceUsd * 100)), raw: quote };
  } finally {
    done();
  }
}

/**
 * 通知真 bag agent 已托管，请它交付。
 * 注意：bag 的 seller 会**立即 ack accepted，然后在后台干活**，
 * 交付物要等它上链后再从链上读——这里只负责把通知送到。
 */
async function notifyFunded(endpoint, jobId, timeoutMs = 8000) {
  const envelope = a2a.notifyFundedEnvelope({ jobId });
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const part = body?.result?.parts?.find((p) => p.kind === 'data');
    return part?.data || body?.result || body;
  } finally {
    done();
  }
}

/** 探测某个端点是否活着（真 bag agent 会暴露 agent card）。 */
async function probe(endpoint, timeoutMs = 3000) {
  const base = endpoint.replace(/\/+$/, '');
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${base}/.well-known/agent-card.json`, { signal });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const card = await res.json();
    return { ok: true, card };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  } finally {
    done();
  }
}

module.exports = { endpointFor, providerAddressFor, negotiateQuote, notifyFunded, probe };
