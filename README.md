# Agent Guild

A card table where **every card is a real agent doing real work** — and the only thing you control is the rules it lives by.

Four seats around a square table. Each guild owns cards with different skills, so nobody can do everything alone: the jobs demand skills you don't have, and the only way to get them is to subcontract somebody else's card — at a price they set, with money escrowed before they lift a finger.

You never move a card. **You write its standing rules**, then watch what it does with them.

---

## Quick start

```powershell
cd D:\AgentGuild
node server/index.js
```

Open **http://localhost:9200**

No dependencies, no build step, no network. Node ≥ 22 is the only requirement.

### Vercel demo

The repository includes a Vercel configuration for an online demo. Its API runs in Vercel Functions, so match state is held in a function instance's memory and can reset when the instance restarts or traffic reaches another instance. Use the local Node server for a shared, continuous multiplayer match until durable state storage is added.

---

## The table

```
                        ┌──────────────────────┐
                        │   NORTH — seat 3     │
                        └──────────────────────┘
   ┌──────────────┐     ┌──────────────────────┐     ┌──────────────┐
   │ WEST         │     │                      │     │ EAST         │
   │  seat 2      │     │     JOB MARKET       │     │  seat 3      │
   │              │     │  (funded job tiles)  │     │              │
   └──────────────┘     └──────────────────────┘     └──────────────┘
                        ┌──────────────────────┐
                        │   SOUTH — YOU        │
                        └──────────────────────┘
```

| Where | What |
|---|---|
| **Your side (south)** | Your guild's cards. **Click a card to zoom in and configure it.** |
| **Other three sides** | Rival guilds. Their cards, cash, escrow, reputation and last decision are all visible. |
| **Centre** | The job market: funded jobs, who won, and how it turned out. Click a tile for bids, the checker hash, and the acceptance verdict. |
| **Right rail** | The table log — every proposal, every gate ruling, every coin. Collapsible. |
| **Bottom bar** | Deal a round · arm a fault · new match · animation speed. |

### Taking a seat

The first browser to load the page takes the **host seat**. Everyone else picks a free seat from **Invite → Sit here**. A seat nobody takes is played by AI.

Your seat is tied to a per-browser client id, and **you can only configure cards sitting in a seat you hold**. That rule is enforced server-side.

---

## How to play

You get four levers per card. They are the whole game.

| Lever | What it does | The lesson |
|---|---|---|
| **Pricing stance** | Aggressive keeps 20% of the surplus, Balanced 40%, Greedy 60% | Greedy is free money when nobody else can do the job — and a straight loss when somebody can |
| **Price floor** | A hard floor the gate enforces | Set it above the market and your card sits out the entire match |
| **Subcontract cap** | Most you'll pay a single supplier | Set it one coin too low and **the gate blocks your card in public** |
| **Minimum margin** | The profit a card demands before it bids | |
| **Attestation** | 1 coin per job | Jobs worth 12+ coins **mandate** it — without it your card cannot bid on the big ones at all |
| **Task whitelist** | Which job types it may accept | Turning one off gives up that market entirely |

Tips and upkeep are real: **every card costs 1 coin per round whether it works or not.** Sitting still bleeds.

### Two moments worth putting on stage

**① Change a rule → the card gets blocked in public.**
Between rounds, drop your Accountant's **subcontract cap** from 3 to 2. Next round it needs to pay the Detective 3 for data cleaning, can't, and the table log prints a red `⛔ Gate refused …`. A rival takes the job instead.

> Nothing about this is choreographed. Prices come from a deterministic function, the gate is fixed code, and no model is anywhere near the money.

**② Arm a fault → the subcontract is still paid.**
Click **Arm a fault**, then deal a round. Your card wins, hires the Detective, escrows the fee, and the Detective delivers and **is paid on the spot**. Then your card's own pipeline produces a bad deliverable → acceptance fails → **the client is refunded in full, and the Detective's fee is not clawed back.**

That asymmetry is the design. `SUB_RELEASED` is a one-way edge in the escrow state machine. The prime carries the risk.

---

## What is actually real here

This is the part that matters. Nothing below is simulated for show.

| Mechanism | How it works | Where |
|---|---|---|
| **Cards do real work** | Deliverables are computed by real algorithms: deduplication, double-entry reconciliation, tier bucketing, `median + 6×MAD` anomaly detection | `server/engine/data.js` |
| **Acceptance is a real program** | The checker is code with a pinned hash. It compares against ground truth the cards **cannot see** — revealed only at settlement (commit–reveal) | `server/engine/checkers.js` |
| **Subcontracting is necessary, not decorative** | The client's transfer log carries duplicate entries with amounts inflated 4×. Skip the cleaning step and the reconciliation cannot tie out and the anomaly scan over-reports | `data.js` → `injectDuplicates` |
| **No model touches money** | Brains *propose*; prices come from a pure function; the gate adjudicates with fixed rules; signing is fixed code | `policy.js`, `signing.js` |
| **The escrow state machine** | Isomorphic to ERC-8183's job lifecycle; illegal transitions throw | `escrow.js` |
| **The wire format is bag's** | A2A `DataPart` messages identical to `@bnbagent/studio-cli`'s seller runtime | `server/protocol/a2a.js` |

### Invariants, checked automatically

```powershell
node scripts/smoke.js        # plays full matches at every table size
node scripts/scenarios.js    # proves both demo moments fire
node scripts/balance.js 16 4 # plays 16 matches, reports how prize money spreads
```

`smoke.js` asserts after every round that **cash + frozen + escrow + platform take is constant** for the whole match. Any accounting slip trips it immediately.

Current spread across 16 matches:

| Table | Result |
|---|---|
| 2 players | 17.2 vs 17.9 — near even |
| 3 players | 25.0 / 22.7 / 15.7 |
| 4 players | 32.8 / 20.3 / 19.9 / 17.9 |

---

## Wallet connect

**Connect Wallet** uses any injected EIP-1193 wallet (MetaMask and friends) — no dependencies, no SDK. It reads the address, the chain, and the native balance, then asks for a `personal_sign` challenge and seals the address onto your seat so it shows at the table.

**Scope, honestly:** the wallet is identity, not custody. Nothing is transacted in this build — the escrow is the engine's own deterministic ledger and the signature is a plain sign-in challenge. Swapping that ledger for real ERC-8183 escrow on BSC testnet is one module (`server/engine/escrow.js`). See `scripts/bag-adapter.md`.

## Invites

**Invite** shows the room code and every LAN URL this machine answers on. Anyone who can reach the server opens one of those links and sits down in a free seat — their cards become theirs to configure, and they cannot touch yours.

---

## Relationship to BNB Agent Studio (`bag`)

The demo is grown from bag's protocol shape, not skinned with it.

| Here | In bag |
|---|---|
| `protocol/a2a.js` negotiate / notify_funded DataParts | The seller runtime's two fixed skills — byte for byte |
| `terms.deliverables` / `terms.quality_standards` | Required quote fields (omitting either gets the quote refused, `reason_code 0x04`) |
| `signing.js` bound signed quotes (chain id, contract, asset, amount, TTL) | `signing.ts` `signQuote` — EIP-191, replay-proof |
| `escrow.js` states | ERC-8183 `OPEN → FUNDED → SUBMITTED → COMPLETED/REJECTED/EXPIRED` |
| **brain proposes → gate adjudicates → fixed code executes** | bag's *"signing is fixed handler code, never an LLM-callable tool"* |
| Quotes cost no gas | bag's negotiate path is off-chain, which is what makes bidding free and the game's tempo possible |

### Plugging in a live bag agent

```powershell
.\scripts\scaffold-bag-agents.ps1          # one real bag workspace per card
$env:BAG_ENDPOINT_A_ACCOUNTANT = "http://localhost:9001"
node server/index.js
```

That card's quotes now come from a live `bag dev` agent — **and still pass through the same deterministic gate**. A live agent that undercuts its own price floor gets blocked exactly like a local one. Details in `scripts/bag-adapter.md`.

### Going on-chain

| Route | What it means |
|---|---|
| **Game settlement (current)** | Local deterministic ledger. The real contract's dispute window is a hard-coded 24 hours, which cannot run a 90-second round. This layer is a swappable module. |
| **Parameterised contract** | Deploy an ERC-8183-compatible contract with a 30-second dispute window and override the three `ERC8183_*_ADDRESS` values. The `escrow.js` state machine already matches. |
| **Live-chain proof** | Buy a real job the day *before* the demo. By demo time the 24h window has elapsed, so you can hit `approve` on stage and show the explorer. |

---

## File map

```
server/
  index.js              HTTP + SSE + static files. No /api/sign, no /api/pay — only the engine moves money
  protocol/
    a2a.js              A2A message shapes, identical to bag's
    bagClient.js        The seam that lets a real bag agent quote for a card
  engine/
    state.js            Model, archetypes, seat rosters, immutable updates
    events.js           Append-only log (the UI is a read-only projection of it)
    data.js             Seeded data generation + the four real algorithms
    checkers.js         Executable checkers, hashes, evidence bundles
    policy.js           The deterministic gate
    brains.js           Proposals, pricing stance, and the actual work
    market.js           Job templates, per-table plans, deterministic award
    escrow.js           Escrow state machine (ERC-8183 shaped)
    money.js            Money primitives, four buckets, pure functions
    signing.js          Fixed-code signing — unreachable from any model
    verify.js           Checker replay, evidence, reputation
    game.js             Four-phase round orchestration
web/                    The table (no build step)
scripts/
  smoke.js              Full matches + invariant checks
  scenarios.js          The two demo moments
  balance.js            Prize-money spread across many matches
  probe.js              Prints every bid and award for one round
  scaffold-bag-agents.ps1
  bag-adapter.md
```

---

## Deliberately out of scope

Better to state the boundary than pretend there isn't one.

- **No LLM in the loop.** Card brains are deterministic strategies running real algorithms. The hook to swap in a model is `brains.proposeBid` (bag's `runWork` position) — but **the price path must never include a model**. That is a security boundary, not an unfinished feature.
- **No real chain.** Escrow is the local ledger. The on-chain path is documented above.
- **Multiplayer is LAN, not internet.** No accounts, no auth — seat ownership is a client id in `localStorage`. Fine for a table in one room; not for a public server.
- **Reputation does not persist across matches.**
- **The fault is armed by hand**, because a rational card only wins jobs it can deliver.
