'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const game = require('./engine/game');
const eventLog = require('./engine/events');
const a2a = require('./protocol/a2a');
const bagClient = require('./protocol/bagClient');

/**
 * HTTP + SSE.
 *
 * The table UI is a READ-ONLY projection of the engine's event log.
 * There is no /api/sign and no /api/pay here — only the engine moves money.
 */

const PORT = Number(process.env.PORT) || 9200;
const WEB_DIR = path.join(__dirname, '..', 'web');
const ROOM = (process.env.ROOM || crypto.randomBytes(2).toString('hex')).toUpperCase().slice(0, 4);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** LAN addresses, so a host can hand out a link that works on other devices. */
function lanUrls(req) {
  if (req?.headers['x-forwarded-host']) {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    return [`${protocol}://${req.headers['x-forwarded-host']}`];
  }
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${PORT}`);
    }
  }
  if (out.length === 0) out.push(`http://localhost:${PORT}`);
  return out;
}

/** Projection: hide unrevealed ground truth and the bulky raw datasets. */
function publicState() {
  const s = game.getState();
  if (!s) return null;
  return {
    ...s,
    tasks: s.tasks.map((t) => ({
      ...t,
      dataset: { total: t.dataset.published.length, unique: new Set(t.dataset.published.map((e) => e.txId)).size },
      truth: t.truthRevealed ? t.truth : undefined,
    })),
  };
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(WEB_DIR, rel);
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      // Local demo server: never cache, so a refresh always shows fresh edits.
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(buf);
  });
}

// ── SSE ───────────────────────────────────────────────────
const sseClients = new Set();
eventLog.subscribe((evt) => {
  const frame = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/events') {
    if (url.searchParams.has('since')) {
      const since = Number(url.searchParams.get('since')) || 0;
      const events = eventLog.all();
      return json(res, 200, { events: eventLog.since(since), lastSeq: events.at(-1)?.seq || 0, room: ROOM });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    for (const evt of eventLog.all()) res.write(`data: ${JSON.stringify(evt)}\n\n`);
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  // ── Read ──
  if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, publicState());

  if (url.pathname === '/api/room' && req.method === 'GET') {
    return json(res, 200, { room: ROOM, port: PORT, urls: lanUrls(req), seats: game.getState().seats });
  }

  if (url.pathname === '/api/agents' && req.method === 'GET') {
    const s = game.getState();
    const cards = Object.values(s.cards).map((c) =>
      a2a.agentCard({ id: c.id, name: c.name, role: c.role, skills: c.skills, endpoint: `${lanUrls(req)[0]}/a2a/${c.id}` })
    );
    return json(res, 200, cards);
  }

  // ── Write ──
  if (url.pathname === '/api/round' && req.method === 'POST') {
    const r = await game.runRound();
    return json(res, r.ok ? 200 : 409, r);
  }

  if (url.pathname === '/api/policy' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, game.updatePolicy(body.cardId, body.patch || {}, body.clientId));
  }

  if (url.pathname === '/api/speed' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, { speed: game.setSpeed(body.speed) });
  }

  if (url.pathname === '/api/seat/claim' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, game.claimSeat(Number(body.index), body.clientId, body.address));
  }

  if (url.pathname === '/api/seat/release' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, game.releaseSeat(Number(body.index), body.clientId));
  }

  if (url.pathname === '/api/wallet/link' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, game.linkWallet(body.clientId, body.address));
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    const body = await readBody(req);
    eventLog.reset();
    sseClients.forEach((r) => {
      try {
        r.write('event: reset\ndata: {}\n\n');
      } catch {
        /* dropped sockets get cleaned up on the next write */
      }
    });
    const s = game.startMatch({
      seed: body.seed ? Number(body.seed) : undefined,
      guildCount: body.guildCount,
      room: ROOM,
    });
    return json(res, 200, { ok: true, seed: s.seed, guildCount: s.guildCount });
  }

  if (url.pathname === '/api/fault' && req.method === 'POST') return json(res, 200, game.injectFault());

  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  return json(res, 404, { error: 'not found' });
}

game.startMatch({ room: ROOM });

if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
  const urls = lanUrls();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   AGENT GUILD                                ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Table     →  http://localhost:${PORT}`);
  console.log(`  Room code →  ${ROOM}`);
  if (urls.length > 1 || !urls[0].includes('localhost')) {
    console.log(`  Invite    →  ${urls[0]}`);
  }
  console.log(`  Roster    →  http://localhost:${PORT}/api/agents`);

  const external = Object.keys(game.getState().cards).filter((id) => bagClient.endpointFor(id));
  if (external.length) {
    console.log('');
    console.log(`  Live bag agents wired: ${external.join(', ')}`);
    console.log('  (those cards quote from real endpoints; the rest use the built-in brain)');
  }
  console.log('');
  console.log('  Ctrl+C to stop');
  console.log('');
  });
}

module.exports = handleRequest;
