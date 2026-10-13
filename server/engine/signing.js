'use strict';

const crypto = require('crypto');

/**
 * 固定代码签名 —— 模型永远够不到这里（设计稿 §3.1 的"两道墙"之一）。
 *
 * ⚠️ demo 说明：本文件用 HMAC-SHA256 模拟 bag 的 EIP-191 签名。
 *    真实实现里，签名由 bag 的 app/agent/src/signing.ts 完成（固定代码），
 *    模型只能"提案报价"，最终签名与否由确定性代码决定。
 *    密钥在进程启动时随机生成，不落盘、不进代码（对应"禁止硬编码密钥"）。
 */

const SIGNING_SECRET = crypto.randomBytes(32);

const CHAIN = {
  chainId: 97, // BSC testnet
  verifyingContract: '0x8183' + '0'.repeat(36), // 占位：真实部署时是 Commerce 合约地址
  token: 'TEST_U',
  tokenDecimals: 18,
  quoteTtlSeconds: 300, // 报价有效期 —— 与 bag 的 [payments.erc8183] quote_ttl_seconds 对齐
};

/** 把 USD 金额换算成分币最小单位（字符串，绝不经过浮点）。 */
function toRaw(priceUsd) {
  return BigInt(Math.round(priceUsd * 100)).toString() + '0'.repeat(16);
}

/**
 * 签发一张报价单。字段全部绑定进哈希 —— 防止跨链 / 跨合约 / 跨资产重放。
 * @returns {{price:number, currency:string, chain_id:number, verifying_contract:string,
 *            token:string, raw_amount:string, ttl_seconds:number,
 *            negotiation_hash:string, provider_sig:string, expires_at:number}}
 */
function signQuote({ cardId, taskId, price, now = Date.now() }) {
  const body = {
    provider: cardId,
    task_id: taskId,
    price,
    currency: CHAIN.token,
    chain_id: CHAIN.chainId,
    verifying_contract: CHAIN.verifyingContract,
    raw_amount: toRaw(price),
    ttl_seconds: CHAIN.quoteTtlSeconds,
  };
  const negotiation_hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const provider_sig = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`${negotiation_hash}|${cardId}|${CHAIN.verifyingContract}`)
    .digest('hex');
  return { ...body, negotiation_hash, provider_sig, expires_at: now + CHAIN.quoteTtlSeconds * 1000 };
}

/** 校验报价单（确定性，无 LLM）。 */
function verifyQuote(quote, expected = {}) {
  const recomputed = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        provider: quote.provider,
        task_id: quote.task_id,
        price: quote.price,
        currency: quote.currency,
        chain_id: quote.chain_id,
        verifying_contract: quote.verifying_contract,
        raw_amount: quote.raw_amount,
        ttl_seconds: quote.ttl_seconds,
      })
    )
    .digest('hex');
  if (recomputed !== quote.negotiation_hash) return { ok: false, reason: '报价单哈希不匹配（条款被篡改）' };
  const sig = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`${quote.negotiation_hash}|${quote.provider}|${CHAIN.verifyingContract}`)
    .digest('hex');
  if (sig !== quote.provider_sig) return { ok: false, reason: '签名不合法' };
  if (expected.price !== undefined && expected.price !== quote.price) return { ok: false, reason: '报价与中标价不一致' };
  if (quote.chain_id !== CHAIN.chainId) return { ok: false, reason: '链 ID 不匹配（疑似跨链重放）' };
  if (quote.verifying_contract !== CHAIN.verifyingContract) return { ok: false, reason: '合约地址不匹配（疑似重放）' };
  return { ok: true, reason: '签名与条款校验通过' };
}

module.exports = { CHAIN, signQuote, verifyQuote, toRaw };
