'use strict';

const crypto = require('crypto');
const { ACCOUNTS, BUCKETS } = require('./data');

/**
 * Executable acceptance checkers — a PROGRAM pinned when the job is posted,
 * not a sentence of prose.
 *
 * Trust comes from REPRODUCIBILITY, not from trusting the verifier.
 * Each checker has: source (hashed), run() (actually executes), evidence shape.
 * The ground truth lives only inside this module — cards never see it.
 */

const EQ = 1e-6;
const near = (a, b) => Math.abs(a - b) < EQ;

// ── Checker 1: reconciliation ties out ────────────────────
const reconcileChecker = {
  id: 'check-reconcile',
  name: 'Reconciliation Tie-out Checker',
  version: '1.0.0',
  source: [
    'for each account: reported.net === truth.net',
    'for each account: opening + net === closing (authoritative ledger)',
    'reported.cleaned === true',
  ].join('\n'),
  run(d, truth) {
    const findings = [];
    if (!d || !Array.isArray(d.accounts)) {
      return { pass: false, findings: ['deliverable is missing the `accounts` field — malformed'] };
    }
    for (const a of ACCOUNTS) {
      const row = d.accounts.find((x) => x.id === a.id);
      if (!row) {
        findings.push(`no line for account ${a.name}`);
        continue;
      }
      const want = truth.net[a.id];
      if (!near(row.net, want)) {
        findings.push(`${a.name}: reported net ${row.net}, authoritative net ${want}, off by ${Math.round((row.net - want) * 100) / 100}`);
      }
      if (!near(truth.opening[a.id] + row.net, truth.closing[a.id])) {
        findings.push(`${a.name}: opening + net does not reach the authoritative closing balance ${truth.closing[a.id]}`);
      }
    }
    if (d.cleaned !== true) findings.push('deliverable does not declare a cleaned dataset (cleaned !== true)');
    return {
      pass: findings.length === 0,
      findings,
      evidence: { accountsChecked: ACCOUNTS.length, canonicalCount: truth.canonicalCount },
    };
  },
};

// ── Checker 2: classification counts match ────────────────
const classifyChecker = {
  id: 'check-classify',
  name: 'Classification Count Checker',
  version: '1.0.0',
  source: ['compare all three buckets', 'compare the total', 'bucket counts must sum to the total'].join('\n'),
  run(d, truth) {
    const findings = [];
    if (!d || typeof d.buckets !== 'object' || !d.buckets) {
      return { pass: false, findings: ['deliverable is missing the `buckets` field — malformed'] };
    }
    for (const b of BUCKETS) {
      if (d.buckets[b.key] !== truth.buckets[b.key]) {
        findings.push(`${b.label}: reported ${d.buckets[b.key] ?? 'missing'}, actual ${truth.buckets[b.key]}`);
      }
    }
    if (d.total !== truth.total) findings.push(`total: reported ${d.total ?? 'missing'}, actual ${truth.total}`);
    const sum = BUCKETS.reduce((acc, b) => acc + (d.buckets[b.key] || 0), 0);
    if (sum !== (d.total ?? -1)) findings.push(`bucket counts sum to ${sum}, which does not match the declared total ${d.total}`);
    return { pass: findings.length === 0, findings, evidence: { buckets: truth.buckets, total: truth.total } };
  },
};

// ── Checker 3: anomaly set is exact ───────────────────────
const detectChecker = {
  id: 'check-detect',
  name: 'Anomaly Set Exactness Checker',
  version: '1.0.0',
  source: ['the reported anomaly set must match ground truth exactly', 'no false negatives, no false positives'].join('\n'),
  run(d, truth) {
    const findings = [];
    if (!d || !Array.isArray(d.anomalies)) {
      return { pass: false, findings: ['deliverable is missing the `anomalies` field — malformed'] };
    }
    const got = [...d.anomalies].sort();
    const want = [...truth.anomalies].sort();
    const missing = want.filter((x) => !got.includes(x));
    const extra = got.filter((x) => !want.includes(x));
    if (missing.length) findings.push(`${missing.length} false negative(s): ${missing.join(', ')}`);
    if (extra.length) findings.push(`${extra.length} false positive(s): ${extra.join(', ')} — likely uncleaned duplicates`);
    return { pass: findings.length === 0, findings, evidence: { expected: want.length, got: got.length } };
  },
};

const CHECKERS = {
  reconcile: reconcileChecker,
  classify: classifyChecker,
  detect: detectChecker,
};

/** Checker source hash — pinned when the job posts, anyone can replay it later. */
function checkerHash(checker) {
  return crypto.createHash('sha256').update(`${checker.id}@${checker.version}\n${checker.source}`).digest('hex').slice(0, 16);
}

/** Evidence bundle: replay command + input snapshot + output + signature. */
function buildEvidence({ checker, deliverable, result, inputSnapshot }) {
  const body = {
    checkerId: checker.id,
    checkerVersion: checker.version,
    checkerHash: checkerHash(checker),
    inputHash: crypto.createHash('sha256').update(JSON.stringify(inputSnapshot)).digest('hex').slice(0, 16),
    outputHash: crypto.createHash('sha256').update(JSON.stringify(deliverable)).digest('hex').slice(0, 16),
    replayCmd: `node -e "require('./server/engine/checkers').CHECKERS['${checker.id.replace('check-', '')}'].run(require('./.evidence/output.json'), require('./.evidence/truth.json'))"`,
    verdict: result.pass ? 'PASS' : 'FAIL',
    findings: result.findings,
  };
  body.signature = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24);
  return body;
}

module.exports = { CHECKERS, checkerHash, buildEvidence, near };
