'use strict';

/**
 * 事件日志 —— append-only，是整套系统唯一的"事实来源"。
 *
 * 设计原则（对应设计稿 §3.1）：
 *   卡牌桌 UI 只是本日志的一个只读投影。拔掉 UI，引擎照跑。
 *
 * 每条事件都带 seq（单调递增），SSE 断线重连后可用 since(seq) 补齐。
 */

const log = [];
const subscribers = new Set();
let seq = 0;

/**
 * 发射一条事件。
 * @param {string} type 事件类型，见 EVENT_TYPES
 * @param {object} data 载荷（会与本条元数据合并）
 */
function emit(type, data = {}) {
  const evt = { seq: ++seq, ts: Date.now(), type, ...data };
  log.push(evt);
  for (const fn of subscribers) {
    try {
      fn(evt);
    } catch {
      // 单个订阅者出错不影响其它订阅者，也绝不中断引擎
    }
  }
  return evt;
}

/** 订阅事件流，返回取消订阅函数。 */
function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** 取 seq 之后的所有事件（用于 SSE 重连补齐）。 */
function since(afterSeq) {
  return log.filter((e) => e.seq > afterSeq);
}

/** 全部事件。 */
function all() {
  return log;
}

/** 清空（重开一局时调用）。 */
function reset() {
  log.length = 0;
  seq = 0;
}

module.exports = { emit, subscribe, since, all, reset };
