'use strict';

/**
 * A2A 报文格式 —— 与 bag（@bnbagent/studio-cli）的 seller runtime **完全一致**。
 *
 * 真实 bag agent 对外只暴露两个固定技能（A2A DataPart）：
 *
 *   报价  {"skill":"negotiate",     "task_description":"…",
 *          "terms":{"deliverables":"…","quality_standards":"…"}}
 *   履约  {"skill":"notify_funded", "job_id": <int>}
 *
 * ⚠️ 两个关键事实：
 *   1. negotiate 是**链下签名报价**（EIP-191），零 gas —— 所以投标不花钱，游戏节奏可行。
 *   2. terms 里少了 deliverables 或 quality_standards，报价会被直接拒签（reason_code 0x04）。
 *
 * 本 demo 的引擎内部就走这套报文，因此把内置大脑换成真 `bag dev` 端点时，
 * 线上格式**不需要任何改动** —— 这就是"拔掉界面，商业照跑"的接缝。
 */

let msgSeq = 0;

/** 组装一条 A2A negotiate 报文。 */
function negotiateEnvelope({ taskId, description, deliverables, qualityStandards }) {
  return {
    jsonrpc: '2.0',
    id: ++msgSeq,
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        messageId: `nego-${taskId}-${msgSeq}`,
        parts: [
          {
            kind: 'data',
            data: {
              skill: 'negotiate',
              task_description: description,
              terms: { deliverables, quality_standards: qualityStandards },
            },
          },
        ],
      },
    },
  };
}

/** 组装一条 A2A notify_funded 报文。 */
function notifyFundedEnvelope({ jobId }) {
  return {
    jsonrpc: '2.0',
    id: ++msgSeq,
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        messageId: `notify-${jobId}-${msgSeq}`,
        parts: [{ kind: 'data', data: { skill: 'notify_funded', job_id: jobId } }],
      },
    },
  };
}

/** 从报文里取出 DataPart（对应 bag executor 的派发逻辑）。 */
function parseDataPart(envelope) {
  const part = envelope?.params?.message?.parts?.find((p) => p.kind === 'data');
  if (!part) throw new Error('报文中缺少 DataPart（bag 侧会拒签，reason_code 0x04）');
  return part.data;
}

/** 卡牌的 A2A AgentCard（bag 部署后暴露在 /.well-known/agent-card.json）。 */
function agentCard({ id, name, role, skills, endpoint }) {
  return {
    name,
    description: `${role} —— 代理商会卡牌 agent（技能：${skills.join('、')}）`,
    url: endpoint,
    version: '0.3.0',
    capabilities: { streaming: false, pushNotifications: false },
    skills: [
      { id: 'negotiate', name: '报价', description: '按自身政策对任务报价并签名（链下，零 gas）' },
      { id: 'notify_funded', name: '履约', description: '校验托管任务并交付成果' },
    ],
    'x-card-id': id,
    'x-domain-skills': skills,
  };
}

module.exports = { negotiateEnvelope, notifyFundedEnvelope, parseDataPart, agentCard };
