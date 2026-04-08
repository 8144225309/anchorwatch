const zmq = require("zeromq");
const http = require("http");
const express = require("express");
const cors = require("cors");

// --- Config ---
const ZMQ_TX = process.env.ZMQ_TX || "tcp://127.0.0.1:28334";
const ZMQ_BLOCK = process.env.ZMQ_BLOCK || "tcp://127.0.0.1:28335";
const ZMQ_BLOCK_TOPIC = process.env.ZMQ_BLOCK_TOPIC || "hashblock"; // "hashblock" or "rawblock"
const RPC_HOST = process.env.RPC_HOST || "127.0.0.1";
const RPC_PORT = process.env.RPC_PORT || "8332";
const RPC_COOKIE = process.env.RPC_COOKIE || "/var/lib/bitcoind/.cookie";
const RPC_USER = process.env.RPC_USER || "";
const RPC_PASS = process.env.RPC_PASS || "";
const API_PORT = process.env.API_PORT || 4000;
const NETWORK = process.env.NETWORK || "mainnet";

// P2A scriptPubKey: OP_1 OP_PUSHBYTES_2 4e73 (BIP 433)
const P2A_SCRIPT = Buffer.from("51024e73", "hex");

// --- State ---
const p2aTxs = new Map(); // txid -> { txid, feeRate, size, age, vout, value }
let lastBlockSeen = 0;       // timestamp of last ZMQ block
let lastRpcSuccess = 0;      // timestamp of last successful RPC call
let rpcFailCount = 0;        // consecutive RPC failures

// --- RPC helper ---
const fs = require("fs");
let rpcAuth = null;

function getRpcAuth() {
  if (rpcAuth) return rpcAuth;
  if (RPC_USER && RPC_PASS) {
    rpcAuth = { user: RPC_USER, pass: RPC_PASS };
    return rpcAuth;
  }
  try {
    const cookie = fs.readFileSync(RPC_COOKIE, "utf8").trim();
    const [user, pass] = cookie.split(":");
    rpcAuth = { user, pass };
    return rpcAuth;
  } catch {
    rpcAuth = null;
    return null;
  }
}

async function rpcCall(method, params = []) {
  const auth = getRpcAuth();
  if (!auth) throw new Error("Cannot read RPC cookie");
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const resp = await fetch(`http://${RPC_HOST}:${RPC_PORT}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64"),
    },
    body,
  });
  const json = await resp.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

// --- Tx parsing ---
// Minimal raw tx decoder - just enough to find scriptPubKeys and compute txid
function decodeTxOutputs(raw) {
  const buf = Buffer.from(raw);
  let offset = 0;

  function readUint32() {
    const v = buf.readUInt32LE(offset);
    offset += 4;
    return v;
  }
  function readVarInt() {
    const first = buf[offset++];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = buf.readUInt16LE(offset);
      offset += 2;
      return v;
    }
    if (first === 0xfe) {
      const v = buf.readUInt32LE(offset);
      offset += 4;
      return v;
    }
    const v = Number(buf.readBigUInt64LE(offset));
    offset += 8;
    return v;
  }
  function readBytes(n) {
    const b = buf.subarray(offset, offset + n);
    offset += n;
    return b;
  }

  // Version
  readUint32();

  // Check for segwit marker
  let isSegwit = false;
  const marker = buf[offset];
  if (marker === 0x00) {
    offset++; // marker
    offset++; // flag
    isSegwit = true;
  }

  // Inputs
  const nInputs = readVarInt();
  for (let i = 0; i < nInputs; i++) {
    readBytes(32); // prevhash
    readUint32(); // previndex
    const scriptLen = readVarInt();
    readBytes(scriptLen);
    readUint32(); // sequence
  }

  // Outputs
  const nOutputs = readVarInt();
  const outputs = [];
  for (let i = 0; i < nOutputs; i++) {
    const valueBuf = readBytes(8);
    const value = Number(valueBuf.readBigUInt64LE(0));
    const scriptLen = readVarInt();
    const script = readBytes(scriptLen);
    outputs.push({ vout: i, value, script: Buffer.from(script) });
  }

  return outputs;
}

function hasP2AOutput(rawHex) {
  try {
    const outputs = decodeTxOutputs(Buffer.from(rawHex, "hex"));
    for (const out of outputs) {
      if (out.script.length === P2A_SCRIPT.length && out.script.equals(P2A_SCRIPT)) {
        return { vout: out.vout, value: out.value };
      }
    }
  } catch {
    // Malformed tx, skip
  }
  return null;
}

function txidFromRaw(rawBuf) {
  const crypto = require("crypto");
  // For txid, we need to hash the non-witness serialization
  // But ZMQ gives us the txid in the topic, so we'll use that instead
  // This is just a fallback
  const hash1 = crypto.createHash("sha256").update(rawBuf).digest();
  const hash2 = crypto.createHash("sha256").update(hash1).digest();
  return Buffer.from(hash2).reverse().toString("hex");
}

// --- ZMQ subscribers ---
async function subscribeTx() {
  const sock = new zmq.Subscriber();
  sock.connect(ZMQ_TX);
  sock.subscribe("rawtx");
  console.log(`[zmq] subscribed to rawtx at ${ZMQ_TX}`);

  for await (const [topic, rawBuf, seqBuf] of sock) {
    const rawHex = rawBuf.toString("hex");
    const p2a = hasP2AOutput(rawHex);
    if (!p2a) continue;

    // Get txid via RPC decoderawtransaction for accuracy
    try {
      const decoded = await rpcCall("decoderawtransaction", [rawHex]);
      const txid = decoded.txid;
      const size = decoded.vsize || decoded.size;
      // Fee requires knowing input values, use getmempoolentry instead
      let feeRate = null;
      try {
        const entry = await rpcCall("getmempoolentry", [txid]);
        const feeSats = Math.round(entry.fees.base * 1e8);
        feeRate = Math.round((feeSats / size) * 10) / 10; // keep 1 decimal for sub-1 rates
        lastRpcSuccess = Date.now();
        rpcFailCount = 0;
      } catch {
        // Tx may have confirmed already, or RPC is down — feeRate stays null
      }

      p2aTxs.set(txid, {
        txid,
        feeRate,
        size,
        value: p2a.value,
        vout: p2a.vout,
        firstSeen: Date.now(),
      });
      console.log(`[p2a] + ${txid} (${feeRate} sat/vB, ${size} vB)`);
    } catch (err) {
      console.error("[p2a] decode error:", err.message);
    }
  }
}

async function subscribeBlock() {
  const sock = new zmq.Subscriber();
  sock.connect(ZMQ_BLOCK);
  sock.subscribe(ZMQ_BLOCK_TOPIC);
  console.log(`[zmq] subscribed to ${ZMQ_BLOCK_TOPIC} at ${ZMQ_BLOCK}`);

  for await (const [topic] of sock) {
    lastBlockSeen = Date.now();
    console.log(`[block] new block received (${NETWORK})`);
    // Invalidate RPC cookie cache in case of restart
    rpcAuth = null;
    await cleanupConfirmed();
  }
}

async function cleanupConfirmed() {
  if (p2aTxs.size === 0) return;
  try {
    const mempool = await rpcCall("getrawmempool");
    lastRpcSuccess = Date.now();
    rpcFailCount = 0;
    const mempoolSet = new Set(mempool);
    let removed = 0;
    for (const txid of p2aTxs.keys()) {
      if (!mempoolSet.has(txid)) {
        p2aTxs.delete(txid);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[cleanup] removed ${removed} confirmed/evicted txs, ${p2aTxs.size} remaining`);
    }
  } catch (err) {
    rpcFailCount++;
    console.error(`[cleanup] error (fail #${rpcFailCount}):`, err.message);
  }
}

// --- Periodic reconciliation (independent of ZMQ) ---
setInterval(async () => {
  try {
    await cleanupConfirmed();
  } catch {}
}, 30000);

// --- Initial mempool scan ---
async function scanExistingMempool() {
  console.log("[scan] scanning existing mempool for P2A outputs...");
  try {
    const txids = await rpcCall("getrawmempool");
    lastRpcSuccess = Date.now();
    rpcFailCount = 0;
    console.log(`[scan] ${txids.length} txs in mempool`);
    let found = 0;
    // Process in batches to avoid overwhelming RPC
    for (let i = 0; i < txids.length; i += 50) {
      const batch = txids.slice(i, i + 50);
      await Promise.all(
        batch.map(async (txid) => {
          try {
            const rawHex = await rpcCall("getrawtransaction", [txid]);
            const p2a = hasP2AOutput(rawHex);
            if (!p2a) return;
            const entry = await rpcCall("getmempoolentry", [txid]);
            const decoded = await rpcCall("decoderawtransaction", [rawHex]);
            const size = decoded.vsize || decoded.size;
            const feeSats = Math.round(entry.fees.base * 1e8);
            const feeRate = Math.round(feeSats / size);
            p2aTxs.set(txid, {
              txid,
              feeRate,
              size,
              value: p2a.value,
              vout: p2a.vout,
              firstSeen: entry.time * 1000,
            });
            found++;
          } catch {
            // tx may have been confirmed between getrawmempool and getrawtransaction
          }
        })
      );
    }
    console.log(`[scan] found ${found} P2A txs in existing mempool`);
  } catch (err) {
    console.error("[scan] error:", err.message);
  }
}

// --- API ---
const app = express();
app.use(cors());

app.get("/api/p2a", (req, res) => {
  const now = Date.now();
  const stale = lastBlockSeen > 0 && (now - lastBlockSeen) > 30 * 60 * 1000; // >30min since last block
  const degraded = rpcFailCount >= 3;
  const txs = Array.from(p2aTxs.values())
    .filter((tx) => tx.feeRate !== null) // don't serve entries where fee lookup failed
    .map((tx) => ({
      txid: tx.txid,
      feeRate: tx.feeRate,
      size: tx.size,
      value: tx.value,
      vout: tx.vout,
      age: formatAge(now - tx.firstSeen),
      ageMs: now - tx.firstSeen,
    }))
    .sort((a, b) => a.feeRate - b.feeRate); // lowest fee first (most need bumping)

  res.json({
    count: txs.length,
    totalBumpable: txs.reduce((s, t) => s + t.size * t.feeRate, 0),
    avgFeeRate:
      txs.length > 0
        ? +(txs.reduce((s, t) => s + t.feeRate, 0) / txs.length).toFixed(1)
        : 0,
    stale,
    degraded,
    lastBlockSeen: lastBlockSeen || null,
    txs,
  });
});

app.get("/api/health", (req, res) => {
  const now = Date.now();
  const stale = lastBlockSeen > 0 && (now - lastBlockSeen) > 30 * 60 * 1000;
  const degraded = rpcFailCount >= 3;
  const status = degraded ? "degraded" : stale ? "stale" : "ok";
  res.json({
    status,
    p2aCount: p2aTxs.size,
    uptime: process.uptime(),
    lastBlockSeen: lastBlockSeen || null,
    lastRpcSuccess: lastRpcSuccess || null,
    rpcFailCount,
  });
});

function formatAge(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

// --- Start ---
async function main() {
  console.log(`anchorwatch scanner starting (${NETWORK})...`);
  app.listen(API_PORT, "127.0.0.1", () => {
    console.log(`[api] listening on 127.0.0.1:${API_PORT}`);
  });

  // Scan existing mempool first
  await scanExistingMempool();

  // Then subscribe to live updates
  subscribeTx().catch((err) => console.error("[zmq-tx] fatal:", err));
  subscribeBlock().catch((err) => console.error("[zmq-block] fatal:", err));
}

main().catch(console.error);
