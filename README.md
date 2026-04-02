# anchorwatch

P2A anchor fee-bumping service paid with Lightning.

Monitors the Bitcoin mempool for transactions with P2A (Pay-to-Anchor) outputs and offers CPFP fee bumping as a paid service. Users submit a stuck transaction's txid, receive a Lightning invoice, and upon payment the service broadcasts a child transaction that bumps the package to the target fee rate.

P2A outputs (`OP_1 OP_PUSHBYTES_2 4e73`) are anyone-can-spend anchor outputs used by Lightning commitment transactions and other protocols to allow third-party fee bumping via CPFP. Requires Bitcoin Core 28+ for relay.

## Architecture

```
  bitcoind ──ZMQ──> scanner ──/api/p2a──> frontend
     ^                                       |
     |  RPC                        /api/bump/quote
     |                             /api/bump/pay
     v                                       |
  bump-service <─────────────────────────────┘
     |
     |  RPC
     v
  CLN (Lightning)
```

- **scanner** — Subscribes to bitcoind ZMQ streams (`rawtx`, `hashblock`). Parses every mempool transaction for P2A outputs. Serves a live list of bumpable transactions. Cleans up confirmed or evicted transactions on each new block.

- **bump-service** — Accepts bump requests. Calculates the CPFP fee deficit to reach the target fee rate, adds a service fee (default 1%, minimum 100 sats), generates a Lightning invoice via CLN, and upon payment constructs and broadcasts the CPFP child transaction.

- **frontend** — Single-page web UI. Shows P2A transactions in the mempool, accepts a txid, displays a fee quote, and presents a Lightning invoice for payment.

## Requirements

- Bitcoin Core 28+ (P2A relay, ZMQ enabled)
- Core Lightning (CLN) with a funded channel
- Node.js 18+

## Setup

```bash
git clone https://github.com/8144225309/anchorwatch.git
cd anchorwatch

# Scanner
cd scanner && npm install && npm start

# Bump service (separate terminal)
cd bump-service && npm install && npm start
```

Bitcoin Core must have ZMQ enabled:

```ini
# bitcoin.conf
zmqpubrawtx=tcp://127.0.0.1:28334
zmqpubhashblock=tcp://127.0.0.1:28335
```

Create and fund a wallet for the CPFP child transactions:

```bash
bitcoin-cli createwallet anchorwatch
bitcoin-cli -rpcwallet=anchorwatch getnewaddress
```

The frontend is a static HTML file — serve it with any web server or open directly in a browser.

Both services bind to `127.0.0.1` only. Do not expose them to the public internet without a reverse proxy and authentication.

## Configuration

Environment variables for both services:

### Scanner

| Variable | Default | Description |
|---|---|---|
| `ZMQ_TX` | `tcp://127.0.0.1:28334` | bitcoind ZMQ rawtx endpoint |
| `ZMQ_BLOCK` | `tcp://127.0.0.1:28335` | bitcoind ZMQ hashblock endpoint |
| `RPC_HOST` | `127.0.0.1` | bitcoind RPC host |
| `RPC_PORT` | `8332` | bitcoind RPC port |
| `RPC_COOKIE` | `/var/lib/bitcoind/.cookie` | RPC cookie file (used if `RPC_USER` not set) |
| `RPC_USER` / `RPC_PASS` | — | RPC credentials (alternative to cookie) |
| `API_PORT` | `4000` | Scanner API port |

### Bump Service

| Variable | Default | Description |
|---|---|---|
| `API_PORT` | `4100` | Bump service API port |
| `RPC_USER` / `RPC_PASS` | — | bitcoind RPC credentials |
| `RPC_PORT` | `8332` | bitcoind RPC port |
| `RPC_WALLET` | `anchorwatch` | bitcoind wallet for CPFP child transactions |
| `CLN_DIR` | `/var/lib/cln-mainnet` | CLN data directory |
| `SERVICE_FEE_RATE` | `0.01` | Service fee as fraction of fee deficit (1%) |
| `MIN_SERVICE_FEE` | `100` | Minimum service fee in sats |

## API

### Scanner

- `GET /api/p2a` — List P2A transactions in the mempool, sorted by fee rate (lowest first)
- `GET /api/health` — Health check

### Bump Service

- `POST /api/bump/quote` — Get a fee bump quote
  - Body: `{ "txid": "...", "targetFeeRate": 50 }`
  - `targetFeeRate` in sat/vB; omit for next-block estimate
- `POST /api/bump/pay` — Request a bump, returns a Lightning invoice
  - Body: `{ "txid": "...", "targetFeeRate": 50 }`
  - Returns: `{ "bolt11": "...", "quote": {...}, "paymentHash": "..." }`
- `GET /api/bump/status/:id` — Order status by payment hash or parent txid
- `GET /api/bump/health` — Health check

Invoices expire after 10 minutes. Orders are cleaned up after 24 hours.

## How It Works

1. Scanner watches the mempool via ZMQ for transactions with P2A outputs
2. User submits a txid to the bump service
3. Service finds the P2A output, calculates the CPFP fee deficit to the target rate, adds a service fee
4. Lightning invoice is generated for the total amount
5. Upon payment, a child transaction spending the P2A output plus a service wallet UTXO is broadcast
6. The CPFP child pulls the parent up to the target fee rate

## License

MIT
