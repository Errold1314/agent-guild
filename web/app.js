'use strict';

/**
 * The table UI — a read-only projection of the engine's event log.
 *
 * There is no signing and no payment in this file. It reads state, asks the
 * server to deal a round, and lets you edit the standing rules of the cards
 * that are yours. Money only ever moves inside the engine's deterministic code.
 */

const $ = (id) => document.getElementById(id);
const TYPE_LABEL = { reconcile: 'Reconciliation', classify: 'Classification', analyze: 'Anomaly Scan' };
const SKILLS = ['reconcile', 'report', 'classify', 'dedupe', 'detect'];

const CHAIN_NAMES = {
  1: 'Ethereum',
  56: 'BNB Chain',
  97: 'BSC Testnet',
  11155111: 'Sepolia',
  8453: 'Base',
  42161: 'Arbitrum',
};

// ── Client identity ───────────────────────────────────────
const CLIENT_ID = (() => {
  let id = localStorage.getItem('ag.clientId');
  if (!id) {
    id = 'c-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('ag.clientId', id);
  }
  return id;
})();

let state = null;
let room = null;
let refetchTimer = null;
const wallet = { address: null, chainId: null, balance: null, signed: false };

// ── Sync ──────────────────────────────────────────────────
async function fetchState() {
  try {
    state = await (await fetch('/api/state')).json();
    render();
  } catch (err) {
    console.error('Could not fetch state', err);
  }
}

function scheduleRefetch() {
  clearTimeout(refetchTimer);
  refetchTimer = setTimeout(fetchState, 70);
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    appendEvent(JSON.parse(m.data));
    scheduleRefetch();
  };
  es.addEventListener('reset', () => {
    $('log').innerHTML = '';
    fetchState();
  });
  es.onerror = () => console.warn('SSE dropped — the browser will reconnect');
}

let eventSeq = 0;
let eventRoom = null;
async function pollEvents() {
  try {
    const response = await fetch(`/api/events?since=${eventSeq}`, { cache: 'no-store' });
    const data = await response.json();
    if ((eventRoom && data.room !== eventRoom) || data.lastSeq < eventSeq) {
      $('log').innerHTML = '';
      eventSeq = 0;
      await fetchState();
    }
    eventRoom = data.room;
    for (const event of data.events) {
      if (event.seq <= eventSeq) continue;
      appendEvent(event);
      eventSeq = event.seq;
    }
    if (data.events.length) scheduleRefetch();
  } catch (err) {
    console.warn('Event polling failed', err);
  } finally {
    setTimeout(pollEvents, 1000);
  }
}

// ── Helpers ───────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');
const coin = (n) => (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '');

/** The seats this browser holds. Empty until the client claims one. */
function mySeats() {
  return state ? state.seats.filter((s) => s.claimedBy === CLIENT_ID) : [];
}

function myGuildIds() {
  return mySeats().map((s) => s.guildId).filter(Boolean);
}

/** First visitor to load the page takes the host seat if it is free. */
async function autoClaimHostSeat() {
  if (!state) return;
  const host = state.seats[0];
  if (!host || !host.guildId || host.claimedBy) return;
  await post('/api/seat/claim', { index: 0, clientId: CLIENT_ID, address: wallet.address || null });
  await fetchState();
}

function canIConfigure(cardId) {
  const card = state.cards[cardId];
  if (!card) return false;
  return myGuildIds().includes(card.guildId);
}

function taskOutcome(t) {
  if (t.verification) return t.verification.pass ? 'accepted' : 'rejected';
  if (t.state === 'NO_BID') return 'no bid';
  if (t.state === 'EXPIRED') return 'voided';
  return null;
}

// ── Render ────────────────────────────────────────────────
function render() {
  if (!state) return;
  renderTopbar();
  renderSeats();
  renderBoard();
}

const PHASES = { IDLE: 'between rounds', POLICY: 'policy window', MARKET: 'job market', WORK: 'fulfilment', SETTLE: 'settlement', DONE: 'match over' };

function renderTopbar() {
  const running = ['POLICY', 'MARKET', 'WORK', 'SETTLE'].includes(state.phase);
  $('phaseChip').textContent =
    state.phase === 'DONE'
      ? `Match over — ${state.winner ? state.winner.name : '—'} takes it`
      : `Round ${Math.max(1, state.round)} / ${state.maxRounds} · ${PHASES[state.phase] || state.phase}`;
  $('btnRound').disabled = running || state.phase === 'DONE';
  $('btnRound').textContent = state.phase === 'DONE' ? 'Match over' : `Deal round ${state.round + 1}`;
  $('btnFault').disabled = running;
  if (room) $('roomChip').textContent = `ROOM ${room.room}`;
  renderWalletButton();
}

// ── Seats ─────────────────────────────────────────────────
// Seat 0 sits opposite the viewer at the bottom; seats 1..3 go round the table.
const SEAT_CLASS = ['seat-south', 'seat-west', 'seat-north', 'seat-east'];

function renderSeats() {
  for (let i = 0; i < 4; i++) {
    const el = document.querySelector(`.${SEAT_CLASS[i]}`);
    if (!el) continue;
    const seat = state.seats[i];
    el.className = `seat ${SEAT_CLASS[i]}`;
    if (!seat || !seat.guildId) {
      el.classList.add('empty');
      el.innerHTML = '<span>Empty seat</span>';
      continue;
    }
    el.innerHTML = guildHtml(seat);
    el.querySelectorAll('.chipcard.clickable').forEach((c) => c.addEventListener('click', () => openCardPanel(c.dataset.card)));
  }
}

function guildHtml(seat) {
  const g = state.guilds[seat.guildId];
  const mine = seat.claimedBy === CLIENT_ID;
  const cards = Object.values(state.cards).filter((c) => c.guildId === seat.guildId);
  const bonus = Math.round((g.reputation - 50) / 10);

  return `
  <div class="guildbox${mine ? ' you' : ''}" style="border-left-color:${g.accent}">
    <div class="guildhead">
      <div class="guildname">${esc(g.name)}${mine ? '<span class="youtag">YOU</span>' : ''}</div>
      <div class="guildmoney"><b>${coin(g.cash)}</b> cash <span class="sep">·</span> ${coin(g.inEscrow)} held <span class="sep">·</span> rep ${g.reputation} (${bonus >= 0 ? '+' : ''}${bonus})</div>
    </div>
    ${seat.address ? `<div class="guildaddr" title="${esc(seat.address)}">${short(seat.address)}</div>` : `<div class="guildaddr">${seat.claimedBy ? 'human seat' : 'AI seat'}</div>`}
    <div class="cards">${cards.map((c) => cardChip(c, mine)).join('')}</div>
  </div>`;
}

function cardChip(card, mine) {
  const benched = card.cooldownUntilRound > 0 && card.cooldownUntilRound >= state.round;
  const cls = `chipcard${mine ? ' clickable' : ''}${benched ? ' benched' : ''}${card.status === 'BUSY' ? ' busy' : ''}`;
  const dot = benched ? 'benched' : card.status === 'BUSY' ? 'busy' : 'idle';
  const note = benched ? `benched until round ${card.cooldownUntilRound}` : card.status === 'BUSY' ? 'occupied' : card.lastAction ? card.lastAction.text : 'idle';
  return `
  <div class="${cls}" data-card="${card.id}" style="border-left-color:${card.accent}" title="${esc(note)}">
    <div class="chiprow"><span class="cdot ${dot}"></span><span class="cname">${esc(card.name)}</span></div>
    <div class="cskills">${card.skills.map((s) => `<span class="skill">${s}</span>`).join('')}</div>
    <div class="cnote">${esc(note)}</div>
  </div>`;
}

// ── Board ─────────────────────────────────────────────────
function renderBoard() {
  const round = Math.max(1, state.round);
  const tasks = state.tasks.filter((t) => t.round === round);
  const head = `<div class="board-head">Job market <span class="rt">round ${round}</span></div>`;

  if (tasks.length === 0) {
    $('board').innerHTML = `${head}<div class="tasks"><div class="tasktile tt-empty">No jobs posted yet — deal a round.</div></div>`;
    return;
  }
  $('board').innerHTML = `${head}<div class="tasks">${tasks.map(taskTile).join('')}</div>`;
  document.querySelectorAll('.tasktile[data-task]').forEach((el) => el.addEventListener('click', () => openTaskPanel(el.dataset.task)));
}

function taskTile(t) {
  const settled = t.verification ? (t.verification.pass ? 'SETTLED' : 'NO_BID') : t.state;
  const winner = t.awardee ? state.cards[t.awardee] : null;
  const outcome = taskOutcome(t);
  return `
  <div class="tasktile st-${t.state}" data-task="${t.id}">
    <div class="tt-top">
      <span class="tt-type">${esc(t.typeLabel)}</span>
      <span class="tt-reward">${coin(t.maxReward)}c</span>
    </div>
    <div class="tt-title">${esc(t.title)}</div>
    <div class="tt-meta">
      ${t.requires.map((r) => `<span>${r}</span>`).join('')}
      ${t.requiresVerification ? '<span class="tt-badge">attested</span>' : ''}
    </div>
    <div class="tt-winner">${
      winner
        ? `<span style="color:${state.guilds[winner.guildId].accent}">●</span> ${esc(winner.name)} @ ${coin(t.winnerPrice)}${outcome ? ` · ${outcome}` : ''}`
        : t.state === 'NO_BID'
        ? 'no eligible bid · client refunded'
        : `${(t.bids || []).length} bid${(t.bids || []).length === 1 ? '' : 's'} in`
    }</div>
  </div>`;
}

// ── Panels ────────────────────────────────────────────────
function openPanel(html, wide) {
  const ov = $('overlay');
  ov.innerHTML = `<div class="panel${wide ? ' wide' : ''}">${html}</div>`;
  ov.hidden = false;
  ov.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));
  ov.addEventListener('click', (e) => {
    if (e.target === ov) closePanel();
  });
  return ov.querySelector('.panel');
}

function closePanel() {
  const ov = $('overlay');
  ov.hidden = true;
  ov.innerHTML = '';
}

// ── Card panel (zoom to configure) ────────────────────────
function openCardPanel(cardId) {
  const card = state.cards[cardId];
  if (!card) return;
  const guild = state.guilds[card.guildId];
  const mine = canIConfigure(cardId);
  const running = ['POLICY', 'MARKET', 'WORK', 'SETTLE'].includes(state.phase);
  const a = card.lastAction;

  const p = card.policy;
  const priceOpts = [
    ['aggressive', 'Aggressive — chase volume, thin margin'],
    ['balanced', 'Balanced — hold 40% of the surplus'],
    ['greedy', 'Greedy — hold 60%, risk losing the job'],
  ];

  const body = `
    <h2>${esc(card.name)}</h2>
    <div class="sub">${esc(card.role)} · ${esc(guild.name)} · <span style="font-family:var(--mono)">${esc(card.id)}</span></div>

    <div class="tilegrid">
      <div class="mini"><div class="k">Status</div><div class="v">${card.status === 'BUSY' ? 'occupied' : 'idle'}</div></div>
      <div class="mini"><div class="k">Jobs delivered</div><div class="v">${card.stats.completed}</div></div>
      <div class="mini"><div class="k">Sold as subcontractor</div><div class="v">${card.stats.sold}</div></div>
      <div class="mini"><div class="k">Reworks used</div><div class="v">${card.stats.reworks}</div></div>
    </div>

    <h3>What it can do</h3>
    <div class="cskills">${card.skills.map((s) => `<span class="skill">${s}</span>`).join('')}</div>
    <div class="reason"><span class="who">Last decision</span>${a ? `${esc(a.text)}<br/><span style="color:var(--muted)">${esc(a.reason || '')}</span>` : 'No orders handled yet.'}</div>

    ${
      mine
        ? `
    <h3>Standing rules ${running ? '(locked while a round is running)' : ''}</h3>
    <div class="field" style="margin-bottom:10px">
      <label>Pricing stance — the one lever you can turn directly</label>
      <select data-k="pricing" ${running ? 'disabled' : ''}>
        ${priceOpts.map(([v, t]) => `<option value="${v}" ${p.pricing === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
    </div>
    <div class="grid3">
      <div class="field"><label>Price floor</label><input type="number" min="0" step="0.5" data-k="minPrice" value="${p.minPrice}" ${running ? 'disabled' : ''}/></div>
      <div class="field"><label>Subcontract cap</label><input type="number" min="0" step="0.5" data-k="maxSubSpend" value="${p.maxSubSpend}" ${running ? 'disabled' : ''}/></div>
      <div class="field"><label>Minimum margin</label><input type="number" min="0" step="0.5" data-k="minMargin" value="${p.minMargin}" ${running ? 'disabled' : ''}/></div>
    </div>
    <div class="wl">
      ${Object.entries(TYPE_LABEL)
        .map(([t, lab]) => `<label><input type="checkbox" data-wl="${t}" ${p.whitelist.includes(t) ? 'checked' : ''} ${running ? 'disabled' : ''}/>${lab}</label>`)
        .join('')}
    </div>
    <label class="checkline"><input type="checkbox" data-k="hireVerifier" ${p.hireVerifier ? 'checked' : ''} ${running ? 'disabled' : ''}/>
      Buy independent attestation (1 coin per job). Jobs worth 12+ coins mandate it — without it this card cannot bid on the big ones, and it submits blind on the rest.</label>
    `
        : `<div class="reason"><span class="who">Not yours</span>This card belongs to ${esc(guild.name)}. Only its owner sets its standing rules.</div>`
    }

    <div class="closebar"><button class="btn" data-close>Close</button></div>`;

  const panel = openPanel(body, true);
  wirePolicy(panel, card, running);
}

function wirePolicy(panel, card, running) {
  if (running) return;
  const push = (patch) => {
    fetch('/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId: card.id, patch, clientId: CLIENT_ID }),
    })
      .then((r) => r.json())
      .then((res) => {
        toast(res.ok ? `${card.name}'s standing rules updated` : res.reason || 'Could not update');
        fetchState();
      })
      .catch(() => toast('Could not update'));
  };

  panel.querySelectorAll('input[data-k]').forEach((input) => {
    input.addEventListener('change', () => {
      const k = input.dataset.k;
      push({ [k]: k === 'hireVerifier' ? input.checked : Number(input.value) });
    });
  });
  panel.querySelectorAll('select[data-k]').forEach((sel) => sel.addEventListener('change', () => push({ [sel.dataset.k]: sel.value })));
  panel.querySelectorAll('input[data-wl]').forEach((input) =>
    input.addEventListener('change', () => {
      const picked = [...panel.querySelectorAll('input[data-wl]')].filter((i) => i.checked).map((i) => i.dataset.wl);
      push({ whitelist: picked });
    })
  );
}

// ── Task panel ────────────────────────────────────────────
function openTaskPanel(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;

  const bids = (t.bids || [])
    .map(
      (b) => `<div class="bidrow${t.awardee === b.cardId ? ' win' : ''}">
        <span class="who">${esc(b.cardName)}</span>
        <span class="amt">${coin(b.price)}c</span>
        ${t.awardee === b.cardId ? '<span class="tt-badge" style="border-color:var(--green);color:var(--green)">won</span>' : `<span class="why">margin ${coin(b.margin)}</span>`}
      </div>`
    )
    .join('');

  const blocked = (t.bids || []).filter((b) => b.gateOk === false);

  let reveal = '';
  if (t.verification) {
    reveal = `<div class="reveal ${t.verification.pass ? 'pass' : 'fail'}">
      <b>${t.verification.pass ? 'Accepted — escrow released to the winner' : 'Rejected — client refunded in full'}</b>
      ${t.verification.findings && t.verification.findings.length ? `<ul>${t.verification.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      ${t.evidence ? `<div class="hashline">evidence ${esc(t.evidence.checkerHash)} · replay command recorded · verdict ${esc(t.evidence.verdict)} · sig ${esc(t.evidence.signature)}</div>` : ''}
    </div>`;
  } else if (t.state === 'NO_BID') {
    reveal = '<div class="reveal fail">No eligible bid — the client’s funds were unfrozen and returned.</div>';
  } else if (t.state === 'EXPIRED') {
    reveal = `<div class="reveal fail">Voided: ${esc(t.failureReason || '')}</div>`;
  }

  const truth = t.truthRevealed && t.truth ? `<div class="hashline">ground truth revealed — canonical records: ${t.truth.canonicalCount ?? '—'}${t.truth.anomalies ? `, anomalies: ${t.truth.anomalies.length}` : ''}${t.truth.total !== undefined ? `, total: ${t.truth.total}` : ''}</div>` : '';

  openPanel(
    `
    <h2>${esc(t.title)}</h2>
    <div class="sub">${esc(t.typeLabel)} · job ${esc(t.id)} · round ${t.round}</div>

    <div class="tilegrid">
      <div class="mini"><div class="k">Ceiling</div><div class="v">${coin(t.maxReward)}c</div></div>
      <div class="mini"><div class="k">State</div><div class="v" style="font-size:13px">${esc(t.state.toLowerCase())}</div></div>
    </div>

    <h3>What the client asked for</h3>
    <div style="font-size:12px;color:#c3d2ca;line-height:1.55">${esc(t.brief)}</div>
    <div style="margin-top:8px" class="cskills">${t.requires.map((r) => `<span class="skill">${r}</span>`).join('')}</div>
    <div class="hashline">acceptance checker <b style="color:var(--blue)">${esc(t.checkerName)}</b> · source hash ${esc(t.checkerHash)} — pinned when posted, anyone can replay it</div>
    <div class="hashline">source log: ${t.dataset.total} records, ${t.dataset.unique} unique ids${t.dataset.unique < t.dataset.total ? ' — duplicates present' : ''}</div>
    ${t.requiresVerification ? '<div class="hashline" style="color:var(--purple)">large job: third-party attestation is mandatory</div>' : ''}

    <h3>Bids${bids ? '' : ' — none yet'}</h3>
    <div class="bids">${bids || '<div class="tt-empty">No bids have been placed on this job.</div>'}</div>
    ${blocked.length ? `<div class="hashline" style="color:var(--red)">${blocked.length} bid(s) were refused by the gate — see the table log for the exact rule</div>` : ''}

    ${reveal}
    ${truth}
    <div class="closebar"><button class="btn" data-close>Close</button></div>
    `,
    true
  );
}

// ── Rules panel ───────────────────────────────────────────
function openRulesPanel() {
  openPanel(`
    <h2>How a match works</h2>
    <div class="sub">You never move a card. You write the rules a card lives by, then watch what it does with them.</div>
    <div class="rules">
      <ol>
        <li><b>Standing rules.</b> Each card has a price floor, a subcontract cap, a minimum margin, a pricing stance, a task whitelist and an attestation switch. Edit them in the policy window — click any card of yours to zoom in.</li>
        <li><b>The client posts funded jobs.</b> Money is frozen the moment a job appears. Every job carries an executable acceptance checker and its hash.</li>
        <li><b>Cards bid on their own.</b> A bid is a signed off-chain quote — it costs no gas. The client's rule is fixed: lowest price wins, ties go to reputation, then to whoever has earned least.</li>
        <li><b>One card, one order.</b> The moment a card wins, it books the subcontractors it needs — and those cards are unavailable to everyone else for the rest of the round. Grabbing a scarce skill is legitimate play.</li>
        <li><b>Hiring means escrowing.</b> A subcontractor's fee is locked the instant it is hired, and released the instant its work passes. Once released it <i>never</i> rolls back — not even if the prime contractor fails.</li>
        <li><b>Attestation.</b> The Attestation Bureau replays the checker and hands back a signed evidence bundle. Buy it and you can catch your own failure and rework once. Skip it and you submit blind. Jobs worth 12+ coins mandate it.</li>
        <li><b>Upkeep.</b> Every card costs 1 coin per round whether it works or not. Doing nothing bleeds.</li>
        <li><b>Scoring.</b> Cash + escrow + a reputation bonus (every 10 points of reputation is 1 coin) — highest total wins.</li>
      </ol>
      <div class="note">Nothing here is a performance. The cards run real algorithms on real data, the checker compares against ground truth the cards cannot see, and the gate that decides whether money moves is fixed code — not a model.</div>
    </div>
    <div class="closebar"><button class="btn" data-close>Close</button></div>
  `);
}

// ── Start / table size ────────────────────────────────────
function openStartPanel() {
  let chosen = state ? state.guildCount : 2;
  const panel = openPanel(`
    <h2>Take a seat</h2>
    <div class="sub">Pick how many sit at this table. Seats nobody takes are played by AI. Everyone at the table gets different skills — nobody can do everything alone.</div>
    <div class="choicegrid">
      ${[2, 3, 4]
        .map(
          (n) => `<div class="choice${n === chosen ? ' on' : ''}" data-n="${n}">
            <div class="num">${n}</div>
            <div class="lab">${n} players</div>
          </div>`
        )
        .join('')}
    </div>
    <div class="seatlist" id="startSeats"></div>
    <div class="closebar"><button class="btn primary" id="btnStart">Start a new match</button></div>
  `);

  const paint = () => {
    panel.querySelectorAll('.choice').forEach((c) => c.classList.toggle('on', Number(c.dataset.n) === chosen));
    panel.querySelector('#startSeats').innerHTML = [0, 1, 2, 3]
      .map((i) => {
        const g = state.guilds[state.seats[i] && state.seats[i].guildId];
        const on = i < chosen;
        const label = !on ? '<span class="swho">empty</span>' : i === 0 ? '<span class="swho">you (host)</span>' : (state.seats[i].claimedBy ? '<span class="swho">human</span>' : '<span class="swho">AI</span>');
        return `<div class="seatrow"><span class="sname" style="color:${g ? g.accent : '#4a5f55'}">${g ? esc(g.name) : '— seat ' + (i + 1) + ' —'}</span>${label}</div>`;
      })
      .join('');
  };
  paint();

  panel.querySelectorAll('.choice').forEach((c) =>
    c.addEventListener('click', () => {
      chosen = Number(c.dataset.n);
      paint();
    })
  );
  panel.querySelector('#btnStart').addEventListener('click', async () => {
    await post('/api/reset', { guildCount: chosen });
    closePanel();
    toast(`New ${chosen}-player table dealt`);
    fetchState();
  });
}

// ── Invite + seats ────────────────────────────────────────
async function openInvitePanel() {
  const info = await (await fetch('/api/room')).json();
  room = info;

  const rows = state.seats
    .map((s) => {
      const g = state.guilds[s.guildId];
      const mine = s.claimedBy === CLIENT_ID;
      const free = s.guildId && !s.claimedBy;
      const who = !s.guildId
        ? '<span class="swho">empty seat</span>'
        : s.claimedBy
        ? `<span class="swho">${mine ? 'you' : 'human'}${s.address ? ' · ' + short(s.address) : ''}</span>`
        : `<span class="swho">AI${s.isHost ? ' · host seat' : ''}</span>`;
      const btn = free
        ? `<button class="btn sbtn" data-claim="${s.index}">Sit here</button>`
        : mine
        ? `<button class="btn ghost sbtn" data-release="${s.index}">Leave</button>`
        : '';
      return `<div class="seatrow"><span class="sname" style="color:${g ? g.accent : '#4a5f55'}">${g ? esc(g.name) : 'seat ' + (s.index + 1)}</span>${who}${btn}</div>`;
    })
    .join('');

  const panel = openPanel(`
    <h2>Invite players</h2>
    <div class="sub">Anyone who can reach this server can take an open seat. Hand them one of these links — they open the same table in their own browser.</div>

    <h3>Room code</h3>
    <div class="addrbox" style="font-size:20px;letter-spacing:.3em;text-align:center">${esc(info.room)}</div>

    <h3>Links</h3>
    ${info.urls.map((u) => `<div class="inviteurl"><code>${esc(u)}</code><button class="btn" data-copy="${esc(u)}">Copy</button></div>`).join('')}

    <h3>Seats</h3>
    <div class="seatlist">${rows}</div>
    <div class="note" style="font-size:11px;color:var(--muted);margin-top:12px;line-height:1.6">
      A seat marked AI is played by the engine. Sit in it and its cards become yours to configure.
      Seats can only change hands between rounds.
    </div>
    <div class="closebar"><button class="btn" data-close>Close</button></div>
  `);

  panel.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('Invite link copied');
      } catch {
        toast('Copy failed — select the link manually');
      }
    })
  );
  panel.querySelectorAll('[data-claim]').forEach((b) =>
    b.addEventListener('click', async () => {
      const r = await post('/api/seat/claim', {
        index: Number(b.dataset.claim),
        clientId: CLIENT_ID,
        address: wallet.address || null,
      });
      toast(r.ok ? 'Seat taken' : r.reason);
      closePanel();
      fetchState();
    })
  );
  panel.querySelectorAll('[data-release]').forEach((b) =>
    b.addEventListener('click', async () => {
      const r = await post('/api/seat/release', { index: Number(b.dataset.release), clientId: CLIENT_ID });
      toast(r.ok ? 'Seat released — the AI takes over' : r.reason);
      closePanel();
      fetchState();
    })
  );
}

// ── Wallet ────────────────────────────────────────────────
function renderWalletButton() {
  const label = $('walletLabel');
  const dot = $('wdot');
  if (wallet.address) {
    label.textContent = short(wallet.address);
    dot.classList.add('on');
  } else {
    label.textContent = 'Connect Wallet';
    dot.classList.remove('on');
  }
}

function hasWallet() {
  return typeof window !== 'undefined' && !!window.ethereum;
}

async function connectWallet() {
  if (!hasWallet()) {
    toast('No EIP-1193 wallet found — install MetaMask (or any injected wallet) and reload');
    return;
  }
  try {
    const [addr] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    wallet.address = addr;
    const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
    wallet.chainId = parseInt(chainHex, 16);
    const balHex = await window.ethereum.request({ method: 'eth_getBalance', params: [addr, 'latest'] });
    wallet.balance = Number(BigInt(balHex) / 10n ** 12n) / 1e6;
    renderWalletButton();
    // Seal the address onto your seat so it shows at the table.
    await post('/api/wallet/link', { clientId: CLIENT_ID, address: addr });
    fetchState();
    openWalletPanel();
  } catch (err) {
    toast(err && err.code === 4001 ? 'Connection rejected in your wallet' : 'Could not connect the wallet');
  }
}

async function signIn() {
  if (!wallet.address) return;
  const msg = `Agent Guild — sign in\n\nroom: ${room ? room.room : '?'}\ntable: ${state ? state.matchId : '?'}\naddress: ${wallet.address}\nissued: ${new Date().toISOString()}`;
  try {
    await window.ethereum.request({ method: 'personal_sign', params: [msg, wallet.address] });
    wallet.signed = true;
    toast('Address verified — you are signed in at this table');
    openWalletPanel();
  } catch (err) {
    toast(err && err.code === 4001 ? 'Signature rejected' : 'Signing failed');
  }
}

function openWalletPanel() {
  const chain = wallet.chainId ? CHAIN_NAMES[wallet.chainId] || `chain ${wallet.chainId}` : '—';
  const body = wallet.address
    ? `
    <h2>Wallet connected</h2>
    <div class="sub">This is your identity at the table.</div>
    <div class="addrbox">${esc(wallet.address)}</div>
    <dl class="kv">
      <dt>Network</dt><dd>${esc(chain)}</dd>
      <dt>Native balance</dt><dd>${wallet.balance != null ? coin(wallet.balance) : '—'}</dd>
      <dt>Proof of ownership</dt><dd>${wallet.signed ? '✓ signed' : 'not signed yet'}</dd>
    </dl>
    ${wallet.signed ? '' : '<div class="closebar" style="justify-content:flex-start"><button class="btn primary" id="btnSign">Sign in (personal_sign)</button></div>'}
    <div class="note" style="font-size:11px;color:var(--muted);margin-top:14px;line-height:1.65">
      <b>Scope, honestly:</b> the wallet identifies you and seals its address onto your seat. Nothing is transacted —
      the escrow in this build is the engine's own deterministic ledger, and the signature is a plain sign-in challenge.
      Swapping that ledger for real ERC-8183 escrow on BSC testnet is one module (<span style="font-family:var(--mono)">server/engine/escrow.js</span>);
      see <span style="font-family:var(--mono)">scripts/bag-adapter.md</span>.
    </div>`
    : `
    <h2>Connect a wallet</h2>
    <div class="sub">Connect to show up as a real address at the table.</div>
    <div class="note" style="font-size:12px;color:var(--muted);line-height:1.7">
      ${hasWallet() ? 'A wallet was detected in this browser.' : 'No EIP-1193 wallet detected. Install MetaMask (or any injected wallet) and reload this page.'}
    </div>`;
  const panel = openPanel(body);
  const sign = panel.querySelector('#btnSign');
  if (sign) sign.addEventListener('click', signIn);
}

function watchWallet() {
  if (!hasWallet()) return;
  window.ethereum.on?.('accountsChanged', (accs) => {
    wallet.address = accs[0] || null;
    wallet.signed = false;
    renderWalletButton();
  });
  window.ethereum.on?.('chainChanged', () => window.location.reload());
}

// ── Log ───────────────────────────────────────────────────
function appendEvent(e) {
  const host = $('log');
  if (!host) return;
  const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 90;
  const f = fmt(e);
  const div = document.createElement('div');
  div.className = `ev ${f.cls || ''}`;
  div.innerHTML = `<span class="ev-ico">${f.icon}</span><div class="ev-body">
      <div class="ev-title">${f.title}</div>
      ${f.detail ? `<div class="ev-detail${f.mono ? ' mono' : ''}">${f.detail}</div>` : ''}
    </div>`;
  host.appendChild(div);
  if (nearBottom) host.scrollTop = host.scrollHeight;
}

function fmt(e) {
  const d = e;
  switch (e.type) {
    case 'match.start':
      return { icon: '🎲', cls: 'phase', title: `Match dealt — ${d.guildCount} seats, seed ${d.seed}`, detail: `room ${esc(d.room)} · ${d.guilds.map((g) => g.name).join(' · ')}` };
    case 'phase':
      return { icon: '⏱', cls: 'phase', title: d.title, detail: d.desc || '' };
    case 'seat.claimed':
      return { icon: '🪑', cls: 'blue', title: `A human took seat ${d.seat + 1} (${d.name})`, detail: d.address ? `wallet ${short(d.address)}` : 'playing without a wallet' };
    case 'seat.released':
      return { icon: '🪑', cls: '', title: `Seat ${d.seat + 1} released — back on autopilot`, detail: '' };
    case 'seat.wallet':
      return { icon: '🔗', cls: 'blue', title: `Wallet sealed onto seat ${d.seat + 1}`, detail: esc(d.address), mono: true };
    case 'policy.update':
      return { icon: '⚙️', cls: 'blue', title: `${d.cardName}'s standing rules changed`, detail: `floor ${d.policy.minPrice} · subcontract cap ${d.policy.maxSubSpend} · min margin ${d.policy.minMargin} · ${d.policy.pricing} · attestation ${d.policy.hireVerifier ? 'on' : 'off'}` };
    case 'task.publish':
      return { icon: '📜', cls: 'blue', title: `Client posts ${d.typeLabel} — ceiling ${coin(d.maxReward)}c`, detail: `${d.brief} · needs ${d.requires.join('+')}${d.requiresVerification ? ' · attestation mandatory' : ''} · checker ${d.checkerHash}` };
    case 'bid.pass':
      return { icon: '·', title: `${d.cardName} holds back`, detail: esc(d.reason) };
    case 'bid.blocked':
      return { icon: '⛔', cls: 'block', title: `Gate refused ${d.cardName}'s bid of ${coin(d.price)}c`, detail: d.blocks.map((b) => `<b>${esc(b.rule)}</b> — ${esc(b.detail)}`).join('<br/>') };
    case 'bid.accept':
      return { icon: '💬', cls: 'gold', title: `${d.cardName} bids ${coin(d.price)}c (margin ${coin(d.margin)})`, detail: `${esc(d.reason)} · signed ${String(d.quote.provider_sig).slice(0, 10)}… off-chain, zero gas`, mono: true };
    case 'award':
      return { icon: '⚔️', cls: 'gold', title: `${d.cardName} wins at ${coin(d.price)}c${d.tie ? ` — dead heat of ${d.tiedWith.length}` : ''}`, detail: d.tie ? `tied with ${d.tiedWith.join(', ')}; the tie went to whoever had earned least` : `ceiling was ${coin(d.maxReward)}; the difference is unfrozen back to the client` };
    case 'card.reserved':
      return { icon: '🔒', cls: 'gold', title: `${d.cardName} is booked by ${d.byCardName}`, detail: `${d.skills.join('+')} at ${coin(d.ask)}c — unavailable to everyone else this round` };
    case 'task.nobid':
      return { icon: '🕳', cls: 'red', title: `No eligible bid for a ${coin(d.maxReward)}c job`, detail: d.note };
    case 'sub.blocked':
      return { icon: '⛔', cls: 'block', title: `Subcontract refused: ${d.buyerCardName} → ${d.providerName}`, detail: d.blocks.map((b) => `<b>${esc(b.rule)}</b> — ${esc(b.detail)}`).join('<br/>') };
    case 'sub.negotiate':
      return { icon: '🤝', cls: 'blue', title: `${d.buyerCardName} asks ${d.providerCardName} for a price: ${coin(d.price)}c`, detail: `subcontracting ${d.skills.join('+')} · A2A negotiate, signed ${String(d.quote.provider_sig).slice(0, 10)}…`, mono: true };
    case 'escrow.sublock':
      return { icon: '🔐', cls: 'gold', title: `${coin(d.amount)}c locked for the subcontract`, detail: d.note };
    case 'sub.deliver':
      return { icon: d.pass ? '✅' : '❌', cls: d.pass ? 'green' : 'red', title: `${d.providerCardName} hands back the intermediate artifact`, detail: `${esc(d.summary)}${d.findings.length ? ' · ' + d.findings.map(esc).join('; ') : ''}` };
    case 'escrow.subrelease':
      return { icon: '💸', cls: 'green', title: `Sub-delivery accepted → ${coin(d.amount)}c paid to ${d.providerName}`, detail: `${d.note} (platform fee ${coin(d.fee)})` };
    case 'escrow.subrefund':
      return { icon: '↩️', cls: 'red', title: `Sub-delivery failed → ${coin(d.amount)}c returned to the prime`, detail: 'the prime still owes the client the full delivery' };
    case 'cost.operating':
      return { icon: '🧾', title: `${d.cardName} pays ${coin(d.amount)}c in operating cost`, detail: 'real cash out the door, not a paper figure' };
    case 'card.work':
      return { icon: d.rework ? '🔧' : '🔨', cls: d.rework ? 'purple' : '', title: `${d.cardName} finishes its pass`, detail: `worked with ${d.skills.join('+')} · ${esc(d.summary)}` };
    case 'verifier.hired':
      return { icon: '🔍', cls: 'purple', title: `${d.cardName} hires the Attestation Bureau (${coin(d.fee)}c)`, detail: 'a replay and a signed evidence bundle come back' };
    case 'verifier.result':
      return { icon: d.pass ? '🛡' : '🚨', cls: d.pass ? 'green' : 'red', title: `Attestation replay: ${d.pass ? 'PASS' : 'FAIL'}`, detail: d.findings.length ? d.findings.map(esc).join('; ') : `evidence sig ${esc(d.evidence.signature)}` };
    case 'verifier.blocked':
      return { icon: '⛔', cls: 'block', title: 'Could not afford attestation', detail: d.blocks.map((b) => esc(b.detail)).join('<br/>') };
    case 'rework.sub':
      return { icon: '🔧', cls: 'purple', title: `Rework: buys the missing ${d.skill} from ${d.cardName} (${coin(d.price)}c)`, detail: '' };
    case 'rework.start':
      return { icon: '🔁', cls: 'purple', title: `${d.cardName} uses its one rework`, detail: `${d.note}${d.extraCost ? ` · extra spend ${coin(d.extraCost)}c` : ''}` };
    case 'submit.blind':
      return { icon: '🙈', cls: 'red', title: `${d.cardName} submits blind`, detail: d.note };
    case 'order.submitted':
      return { icon: '📦', title: `${d.cardName} submits the deliverable`, detail: `${coin(d.subTotal)}c spent on subcontracts${d.reworked ? ' · reworked once' : ''}${d.verifiedBy ? ' · attested' : ''}` };
    case 'order.expired':
      return { icon: '⛔', cls: 'red', title: `${d.cardName} cannot fulfil — the order is voided`, detail: `${esc(d.reason)} · client refunded ${coin(d.refund)}c · reputation ${d.reputation}` };
    case 'settle.verify':
      return { icon: d.pass ? '✓' : '✗', cls: d.pass ? 'green' : 'red', title: `Client-side acceptance: ${d.pass ? 'PASS' : 'FAIL'}`, detail: `${esc(d.note)}${d.findings.length ? ' — ' + d.findings.map(esc).join('; ') : ''}` };
    case 'escrow.release':
      return { icon: '🏆', cls: 'green', title: `Escrow released — ${coin(d.amount)}c to ${d.cardName}`, detail: `platform fee ${coin(d.fee)} · reputation ${d.reputation > 0 ? '+' : ''}${d.reputation}` };
    case 'escrow.refund':
      return { icon: '↩️', cls: 'red', title: `Client refunded ${coin(d.amount)}c in full`, detail: `${esc(d.note)} · ${d.cardName} reputation ${d.reputation}` };
    case 'cost.maintenance':
      return { icon: '🧾', title: `${d.guildName} pays ${coin(d.amount)}c upkeep`, detail: `${d.cardCount} cards × 1 coin — sitting still bleeds` };
    case 'round.summary': {
      const line = d.standings.map((s) => `${s.name} ${s.score}`).join(' · ');
      return { icon: '📊', cls: 'phase', title: `Round ${d.round} settled`, detail: line };
    }
    case 'match.end':
      return { icon: '👑', cls: 'gold', title: `Match over — ${d.winner ? d.winner.name : '—'} takes it`, detail: d.standings.map((s) => `${s.name} ${s.score}`).join(' · ') };
    case 'bag.quote':
      return { icon: '📡', cls: 'gold', title: `Live bag agent quotes ${coin(d.price)}c`, detail: `${d.cardName} @ ${esc(d.endpoint)} · ${esc(d.note)}`, mono: true };
    case 'bag.error':
      return { icon: '📡', cls: 'red', title: `Live bag agent unreachable: ${d.cardName}`, detail: `${esc(d.endpoint)} — ${esc(d.error)}` };
    case 'demo.fault.armed':
      return { icon: '⚠️', cls: 'fault', title: 'A workmanship fault is armed', detail: esc(d.note) };
    case 'demo.fault':
      return { icon: '💥', cls: 'fault', title: 'The armed fault has landed', detail: esc(d.note) };
    default:
      return { icon: '•', title: esc(e.type), detail: esc(JSON.stringify(d).slice(0, 180)), mono: true };
  }
}

// ── Controls ──────────────────────────────────────────────
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2400);
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

function bindControls() {
  $('btnRound').addEventListener('click', async () => {
    $('btnRound').disabled = true;
    const res = await post('/api/round');
    if (!res.ok) toast(res.reason || 'Could not deal');
    fetchState();
  });
  $('speed').addEventListener('input', (ev) => post('/api/speed', { speed: Number(ev.target.value) }));
  $('btnFault').addEventListener('click', async () => {
    const res = await post('/api/fault');
    toast(res.ok ? 'Fault armed — the next delivery will be wrong' : res.reason);
  });
  $('btnReset').addEventListener('click', () => openStartPanel());
  $('btnInvite').addEventListener('click', openInvitePanel);
  $('roomChip').addEventListener('click', openInvitePanel);
  $('btnRules').addEventListener('click', openRulesPanel);
  $('btnWallet').addEventListener('click', () => (wallet.address ? openWalletPanel() : connectWallet()));
  $('btnLogToggle').addEventListener('click', () => {
    const p = $('logpane');
    p.classList.toggle('collapsed');
    $('btnLogToggle').textContent = p.classList.contains('collapsed') ? '▸' : '◂';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });
}

// ── Boot ──────────────────────────────────────────────────
try {
  bindControls();
} catch (err) {
  console.error('Control binding failed', err);
}
watchWallet();
pollEvents();

(async () => {
  await fetchState();
  await autoClaimHostSeat();
  try {
    room = await (await fetch('/api/room')).json();
    $('roomChip').textContent = `ROOM ${room.room}`;
  } catch {
    /* the room chip just stays blank */
  }
  // Only interrupt with the seating panel on a fresh table.
  if (state && state.round === 0 && state.phase === 'IDLE') openStartPanel();
})();
