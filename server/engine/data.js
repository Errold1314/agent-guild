'use strict';

/**
 * 真实数据集与真实算法。
 *
 * 这里是整个 demo 可信度的地基：卡牌交付的成果**不是演出来的**，
 * 而是真正跑算法算出来的 JSON；验收检查器拿它与**ground truth**比对。
 *
 * 关键设计（让"分包"成为必需而非装饰）：
 *   1. 客户发布的转账日志里**混入了重复交易**（同一 txId 出现两次，其中一条金额被污染）。
 *   2. 重复交易的金额被放大 4 倍 —— 它们既会污染对账结果，**又会被异常检测误判为异常**。
 *   3. 因此：不先去重的卡牌，交出来的报告一定对不上账、异常清单一定多报。
 *   4. ground truth 只存在于检查器内部，Agent 看不到（commit-reveal）。
 */

// ── 播种式随机数（保证同一 seed 永远复现同一局） ──────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCOUNTS = [
  { id: 'acct-jia', name: '长庚商行' },
  { id: 'acct-yi', name: '白榆票号' },
  { id: 'acct-bing', name: '南浦货栈' },
  { id: 'acct-ding', name: '云间银庄' },
  { id: 'acct-wu', name: '北固工坊' },
];

const NORMAL_MIN = 10;
const NORMAL_MAX = 120;
const DUPLICATE_INFLATION = 4; // 重复交易的金额污染倍数
const ANOMALY_MIN = 700;
const ANOMALY_MAX = 1300;

const round2 = (x) => Math.round(x * 100) / 100;
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const amountIn = (rng, lo, hi) => round2(lo + rng() * (hi - lo));

/** 生成一批规范转账记录（双分录：每笔都 from −a / to +a，全球净额恒为 0）。 */
function makeTransfers(rng, count, anomalies = 0) {
  const entries = [];
  let ts = 1_700_000_000;
  for (let i = 0; i < count; i++) {
    const from = pick(rng, ACCOUNTS).id;
    let to = pick(rng, ACCOUNTS).id;
    while (to === from) to = pick(rng, ACCOUNTS).id;
    entries.push({ txId: `tx-${String(i + 1).padStart(4, '0')}`, from, to, amount: amountIn(rng, NORMAL_MIN, NORMAL_MAX), ts: ts++ });
  }
  const planted = [];
  for (let i = 0; i < anomalies; i++) {
    const from = pick(rng, ACCOUNTS).id;
    let to = pick(rng, ACCOUNTS).id;
    while (to === from) to = pick(rng, ACCOUNTS).id;
    const e = { txId: `tx-a${String(i + 1).padStart(3, '0')}`, from, to, amount: amountIn(rng, ANOMALY_MIN, ANOMALY_MAX), ts: ts++ };
    entries.push(e);
    planted.push(e.txId);
  }
  return { entries, planted };
}

/** 注入重复交易：同一 txId 再来一条，金额被放大，时间戳更晚。 */
function injectDuplicates(rng, entries, count) {
  const dupes = [];
  const pool = entries.filter((e) => e.amount < NORMAL_MAX); // 只污染正常交易
  for (let i = 0; i < count && pool.length > 0; i++) {
    const src = pool[Math.floor(rng() * pool.length)];
    dupes.push({ ...src, amount: round2(src.amount * DUPLICATE_INFLATION), ts: src.ts + 10_000 + i });
  }
  return dupes;
}

/** 打乱数组顺序（Fisher–Yates，用同一 rng）。 */
function shuffle(rng, arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── 任务一：对账报告（需要 dedupe + reconcile） ─────────────
function generateReconcileDataset(seed) {
  const rng = mulberry32(seed);
  const { entries } = makeTransfers(rng, 30);
  const dupes = injectDuplicates(rng, entries, 5);
  const published = shuffle(rng, [...entries, ...dupes]);

  // 权威余额：由**规范记录**算出（客户那边的真实账，Agent 看不到）
  const opening = {};
  for (const a of ACCOUNTS) opening[a.id] = amountIn(rng, 800, 2400);
  const net = {};
  for (const a of ACCOUNTS) net[a.id] = 0;
  for (const e of entries) {
    net[e.from] = round2(net[e.from] - e.amount);
    net[e.to] = round2(net[e.to] + e.amount);
  }
  const truth = {
    net,
    opening,
    closing: Object.fromEntries(ACCOUNTS.map((a) => [a.id, round2(opening[a.id] + net[a.id])])),
    canonicalCount: entries.length,
  };
  return { published, truth, accountCount: ACCOUNTS.length };
}

// ── 任务二：分类统计（只需 classify，数据干净） ─────────────
const BUCKETS = [
  { key: 'small', label: '小额（<40）', test: (a) => a < 40 },
  { key: 'mid', label: '中额（40–100）', test: (a) => a >= 40 && a <= 100 },
  { key: 'large', label: '大额（>100）', test: (a) => a > 100 },
];

function classifyEntries(entries) {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));
  for (const e of entries) {
    const b = BUCKETS.find((x) => x.test(e.amount));
    if (b) buckets[b.key] += 1;
  }
  return { buckets, total: entries.length };
}

function generateClassifyDataset(seed) {
  const rng = mulberry32(seed + 991);
  const { entries } = makeTransfers(rng, 36);
  return { published: shuffle(rng, entries), truth: classifyEntries(entries) };
}

// ── 任务三：异常检测（需要 dedupe + detect） ────────────────
/** 稳健异常检测：中位数 + 6×MAD，不被离群值本身带偏。 */
function detectAnomalies(entries) {
  const amounts = entries.map((e) => e.amount).sort((a, b) => a - b);
  if (amounts.length === 0) return { anomalies: [], median: 0, threshold: 0 };
  const median = amounts[Math.floor(amounts.length / 2)];
  const devs = amounts.map((a) => Math.abs(a - median)).sort((a, b) => a - b);
  const mad = devs[Math.floor(devs.length / 2)];
  const threshold = round2(median + 6 * mad);
  const anomalies = entries.filter((e) => e.amount > threshold).map((e) => e.txId).sort();
  return { anomalies, median, threshold };
}

function generateDetectDataset(seed) {
  // 少量重试以保证：去重后能精准命中植入的异常，且不去重一定会误报
  for (let attempt = 0; attempt < 20; attempt++) {
    const rng = mulberry32(seed + 337 + attempt * 17);
    const { entries, planted } = makeTransfers(rng, 30, 3);
    const dupes = injectDuplicates(rng, entries, 5);
    const published = shuffle(rng, [...entries, ...dupes]);

    const cleanResult = detectAnomalies(dedupe(published));
    const dirtyResult = detectAnomalies(published);
    const hitsExactly = cleanResult.anomalies.length === planted.length;
    const dirtyOverreports = dirtyResult.anomalies.length > cleanResult.anomalies.length;
    if (hitsExactly && dirtyOverreports) {
      return { published, truth: { ...cleanResult, planted }, discriminative: true };
    }
  }
  // 兜底：即使判别性不理想也返回，但标记出来（引擎会在事件里提示）
  const rng = mulberry32(seed + 337);
  const { entries, planted } = makeTransfers(rng, 30, 3);
  const dupes = injectDuplicates(rng, entries, 5);
  const published = shuffle(rng, [...entries, ...dupes]);
  return { published, truth: { ...detectAnomalies(dedupe(published)), planted }, discriminative: false };
}

// ── 真实算法（卡牌的"技能"就是这些函数） ────────────────────
/** 去重：同一 txId 保留时间戳最小的一条（原始记录）。 */
function dedupe(entries) {
  const best = new Map();
  for (const e of entries) {
    const cur = best.get(e.txId);
    if (!cur || e.ts < cur.ts) best.set(e.txId, e);
  }
  return [...best.values()].sort((a, b) => a.ts - b.ts);
}

/** 对账：逐账户净额与期末余额。 */
function reconcile(entries, accounts = ACCOUNTS) {
  const net = Object.fromEntries(accounts.map((a) => [a.id, 0]));
  for (const e of entries) {
    if (net[e.from] !== undefined) net[e.from] = round2(net[e.from] - e.amount);
    if (net[e.to] !== undefined) net[e.to] = round2(net[e.to] + e.amount);
  }
  return net;
}

module.exports = {
  mulberry32,
  ACCOUNTS,
  BUCKETS,
  dedupe,
  reconcile,
  classifyEntries,
  detectAnomalies,
  generateReconcileDataset,
  generateClassifyDataset,
  generateDetectDataset,
};
