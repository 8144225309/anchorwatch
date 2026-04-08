const express = require("express");
const cors = require("cors");
const { execSync } = require("child_process");
const crypto = require("crypto");

// --- Config ---
const API_PORT = process.env.API_PORT || 4100;
const NETWORK = process.env.NETWORK || "mainnet";
const RPC_USER = process.env.RPC_USER || "";
const RPC_PASS = process.env.RPC_PASS || "";
const RPC_PORT = process.env.RPC_PORT || "8332";
const RPC_WALLET = process.env.RPC_WALLET || "anchorwatch";
const CLN_DIR = process.env.CLN_DIR || "/var/lib/cln-mainnet";
const SERVICE_FEE_RATE = parseFloat(process.env.SERVICE_FEE_RATE || "0.01"); // 1%
const MIN_SERVICE_FEE = parseInt(process.env.MIN_SERVICE_FEE || "100"); // 100 sats
const CHILD_VSIZE = 120; // estimated CPFP child vsize

// P2A scriptPubKey
const P2A_SPK = "51024e73";

// --- Orders ---
// Map<paymentHash, Order>
const orders = new Map();

// --- CLI helpers ---
function bitcoinCli(cmd, useWallet = false) {
  const rpcArgs = RPC_USER
    ? `-rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -rpcport=${RPC_PORT}`
    : `-datadir=/var/lib/bitcoind -rpcport=${RPC_PORT}`;
  const walletArg = useWallet && RPC_WALLET ? `-rpcwallet=${RPC_WALLET}` : "";
  const full = `bitcoin-cli ${rpcArgs} ${walletArg} ${cmd}`;
  try {
    return execSync(full, { timeout: 15000, encoding: "utf8" }).trim();
  } catch (err) {
    throw new Error(`bitcoin-cli ${cmd.split(" ")[0]}: ${err.stderr || err.message}`);
  }
}

function lightningCli(cmd) {
  const full = `lightning-cli --lightning-dir=${CLN_DIR} ${cmd}`;
  try {
    return execSync(full, { timeout: 15000, encoding: "utf8" }).trim();
  } catch (err) {
    throw new Error(`lightning-cli ${cmd.split(" ")[0]}: ${err.stderr || err.message}`);
  }
}

function btcRpc(method, ...params) {
  const paramStr = params.map((p) => typeof p === "object" ? "'" + JSON.stringify(p) + "'" : String(p)).join(" ");
  const result = bitcoinCli(`${method} ${paramStr}`, false);
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

function walletRpc(method, ...params) {
  const paramStr = params.map((p) => typeof p === "object" ? "'" + JSON.stringify(p) + "'" : String(p)).join(" ");
  const result = bitcoinCli(`${method} ${paramStr}`, true);
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

function lnRpc(method, ...params) {
  const paramStr = params.join(" ");
  const result = lightningCli(`${method} ${paramStr}`);
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

// --- P2A detection ---
function findP2AOutput(tx) {
  for (const vout of tx.vout) {
    if (vout.scriptPubKey && vout.scriptPubKey.hex === P2A_SPK) {
      return { vout: vout.n, value: Math.round(vout.value * 1e8) };
    }
  }
  return null;
}

// --- Quote calculation ---
function calculateQuote(parentTx, mempoolEntry, targetFeeRate) {
  const parentVsize = parentTx.vsize || parentTx.size;
  const parentFeeSats = Math.round(mempoolEntry.fees.base * 1e8);
  const packageVsize = parentVsize + CHILD_VSIZE;
  const totalFeeNeeded = targetFeeRate * packageVsize;
  const feeDeficit = Math.max(0, totalFeeNeeded - parentFeeSats);
  const serviceFee = Math.max(MIN_SERVICE_FEE, Math.round(feeDeficit * SERVICE_FEE_RATE));
  return {
    parentVsize,
    parentFeeSats,
    parentFeeRate: Math.round(parentFeeSats / parentVsize * 10) / 10,
    childVsize: CHILD_VSIZE,
    targetFeeRate,
    feeDeficit: Math.round(feeDeficit),
    serviceFee,
    totalSats: Math.round(feeDeficit) + serviceFee,
  };
}

// --- Fee rate estimation ---
function estimateFeeRate(target) {
  try {
    const est = btcRpc("estimatesmartfee", target);
    if (est.feerate) {
      return Math.ceil(est.feerate * 1e8 / 1000); // BTC/kvB to sat/vB
    }
  } catch {}
  return 10; // fallback
}

// --- CPFP builder ---
function buildCpfpChild(parentTxid, p2aVout, p2aValue, feeDeficit) {
  // Get a UTXO from our wallet
  const utxos = walletRpc("listunspent", 1, 9999999);
  if (!utxos || utxos.length === 0) {
    throw new Error("No UTXOs available in anchorwatch wallet");
  }

  // Pick smallest UTXO that covers the fee
  const sorted = utxos.sort((a, b) => a.amount - b.amount);
  const needed = feeDeficit + 1000; // fee + dust buffer for change
  const utxo = sorted.find((u) => Math.round(u.amount * 1e8) >= needed);
  if (!utxo) {
    throw new Error(`No UTXO large enough (need ${needed} sats)`);
  }

  const utxoSats = Math.round(utxo.amount * 1e8);
  const changeAddr = walletRpc("getnewaddress");
  const totalIn = p2aValue + utxoSats;
  const changeSats = totalIn - feeDeficit;

  if (changeSats < 546) {
    throw new Error(`Change too small (${changeSats} sats), need larger UTXO`);
  }

  // Create raw tx
  const inputs = [
    { txid: parentTxid, vout: p2aVout },
    { txid: utxo.txid, vout: utxo.vout },
  ];
  const outputs = [{ [changeAddr]: changeSats / 1e8 }];
  const rawTx = btcRpc("createrawtransaction", inputs, outputs);

  // Sign - bitcoind signs our wallet input, leaves P2A unsigned
  const signed = walletRpc("signrawtransactionwithwallet", rawTx);

  if (!signed.hex) {
    throw new Error("Failed to sign transaction");
  }

  // Try broadcasting. Bitcoin Core 28+ handles P2A witness (empty witness for v1 anyone-can-spend)
  try {
    const childTxid = btcRpc("sendrawtransaction", signed.hex);
    return { childTxid, hex: signed.hex };
  } catch (err) {
    console.error("[cpfp] broadcast failed:", err.message);
    const decoded = btcRpc("decoderawtransaction", signed.hex);
    console.log("[cpfp] vin witnesses:", JSON.stringify(decoded.vin.map(v => v.txinwitness)));
    throw new Error(`CPFP broadcast failed: ${err.message}`);
  }
}

// --- Classify errors as retryable or permanent ---
function isRetryable(errMsg) {
  if (errMsg.includes("No UTXOs available")) return true;
  if (errMsg.includes("No UTXO large enough")) return true;
  if (errMsg.includes("ETIMEDOUT") || errMsg.includes("timeout")) return true;
  if (errMsg.includes("Connection refused")) return true;
  return false;
}

// --- Invoice polling ---
setInterval(async () => {
  for (const [paymentHash, order] of orders.entries()) {
    // Process invoiced orders — check for payment
    if (order.status === "invoiced") {
      try {
        const inv = lnRpc("listinvoices", `payment_hash=${paymentHash}`);
        const invoice = inv.invoices && inv.invoices[0];
        if (invoice && invoice.status === "paid") {
          console.log(`[bump] payment received for ${paymentHash}`);
          order.status = "paid";
          order.paidAt = Date.now();
          order.retryCount = 0;
        }
      } catch (err) {
        // CLN might be temporarily unavailable
      }
    }

    // Process paid/retry orders — attempt CPFP
    if (order.status === "paid" || order.status === "retry") {
      // Pre-flight: verify parent is still in mempool
      try {
        btcRpc("getmempoolentry", order.parentTxid);
      } catch {
        order.status = "parent_confirmed";
        console.log(`[bump] parent ${order.parentTxid.slice(0, 16)}... no longer in mempool, skipping CPFP`);
        continue;
      }

      try {
        const result = buildCpfpChild(
          order.parentTxid,
          order.p2aVout,
          order.p2aValue,
          order.quote.feeDeficit
        );
        order.status = "bumped";
        order.childTxid = result.childTxid;
        order.bumpedAt = Date.now();
        console.log(`[bump] CPFP broadcast: ${result.childTxid}`);
      } catch (err) {
        order.retryCount = (order.retryCount || 0) + 1;
        if (isRetryable(err.message) && order.retryCount < 3) {
          order.status = "retry";
          console.warn(`[bump] CPFP attempt ${order.retryCount}/3 failed for ${paymentHash}: ${err.message}`);
        } else {
          order.status = "error";
          order.error = err.message;
          console.error(`[bump] CPFP failed permanently for ${paymentHash}:`, err.message);
        }
      }
    }

    // Track bumped orders — verify child confirms or detect eviction
    if (order.status === "bumped" && order.childTxid) {
      try {
        btcRpc("getmempoolentry", order.childTxid);
        // Still in mempool — waiting for confirmation, that's fine
      } catch {
        // Not in mempool — either confirmed or evicted
        try {
          const rawHex = btcRpc("getrawtransaction", order.childTxid);
          // If getrawtransaction succeeds (with txindex), it confirmed
          order.status = "confirmed";
          order.confirmedAt = Date.now();
          console.log(`[bump] child ${order.childTxid.slice(0, 16)}... confirmed`);
        } catch {
          // Not in mempool AND not on chain — evicted
          order.status = "stuck";
          order.error = "CPFP child evicted from mempool without confirming";
          console.warn(`[bump] child ${order.childTxid.slice(0, 16)}... evicted — order stuck`);
        }
      }
    }
  }
}, 2000);

// --- Cleanup old orders (24h) ---
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [hash, order] of orders.entries()) {
    if (order.createdAt < cutoff) {
      orders.delete(hash);
    }
  }
}, 60000);

// --- API ---
const app = express();
app.use(cors());
app.use(express.json());

// POST /api/bump/quote
app.post("/api/bump/quote", (req, res) => {
  const { txid, targetFeeRate: rawTarget } = req.body;
  if (!txid || !/^[a-f0-9]{64}$/i.test(txid)) {
    return res.status(400).json({ error: "Invalid txid" });
  }

  let targetFeeRate = parseInt(rawTarget);

  try {
    // Look up the tx
    let rawHex;
    try {
      rawHex = btcRpc("getrawtransaction", txid);
    } catch {
      return res.status(404).json({ error: "Transaction not found in mempool" });
    }
    const parentTx = btcRpc("decoderawtransaction", rawHex);
    const p2a = findP2AOutput(parentTx);
    if (!p2a) {
      return res.status(400).json({ error: "Transaction has no P2A anchor output" });
    }

    // Get mempool entry for fee info
    let mempoolEntry;
    try {
      mempoolEntry = btcRpc("getmempoolentry", txid);
    } catch {
      return res.status(400).json({ error: "Transaction not in mempool (may have confirmed)" });
    }

    // Resolve target fee rate
    if (!targetFeeRate || targetFeeRate <= 0) {
      // "next block" default
      targetFeeRate = estimateFeeRate(1);
    }

    const quote = calculateQuote(parentTx, mempoolEntry, targetFeeRate);

    if (quote.feeDeficit <= 0) {
      return res.status(400).json({
        error: "Transaction already meets target fee rate",
        currentRate: quote.parentFeeRate,
        targetRate: targetFeeRate,
      });
    }

    res.json({ txid, p2aVout: p2a.vout, p2aValue: p2a.value, quote });
  } catch (err) {
    console.error("[quote] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bump/pay
app.post("/api/bump/pay", (req, res) => {
  const { txid, targetFeeRate: rawTarget } = req.body;
  if (!txid || !/^[a-f0-9]{64}$/i.test(txid)) {
    return res.status(400).json({ error: "Invalid txid" });
  }

  let targetFeeRate = parseInt(rawTarget);

  try {
    // Recalculate quote (fresh data)
    let rawHex;
    try {
      rawHex = btcRpc("getrawtransaction", txid);
    } catch {
      return res.status(404).json({ error: "Transaction not found in mempool" });
    }
    const parentTx = btcRpc("decoderawtransaction", rawHex);
    const p2a = findP2AOutput(parentTx);
    if (!p2a) {
      return res.status(400).json({ error: "Transaction has no P2A anchor output" });
    }

    let mempoolEntry;
    try {
      mempoolEntry = btcRpc("getmempoolentry", txid);
    } catch {
      return res.status(400).json({ error: "Transaction not in mempool" });
    }

    if (!targetFeeRate || targetFeeRate <= 0) {
      targetFeeRate = estimateFeeRate(1);
    }

    const quote = calculateQuote(parentTx, mempoolEntry, targetFeeRate);
    if (quote.feeDeficit <= 0) {
      return res.status(400).json({ error: "Transaction already meets target fee rate" });
    }

    // Check for existing active invoice for this txid (prevent spam)
    const MAX_ACTIVE_PER_TXID = 2;
    const activeForTxid = Array.from(orders.values()).filter(
      (o) => o.parentTxid === txid && o.status === "invoiced" && (Date.now() - o.createdAt) < 600000
    );
    if (activeForTxid.length >= MAX_ACTIVE_PER_TXID) {
      // Return the most recent existing invoice instead of creating a new one
      const existing = activeForTxid[activeForTxid.length - 1];
      return res.json({
        paymentHash: existing.paymentHash,
        bolt11: existing.bolt11,
        quote: existing.quote,
        expiresAt: existing.createdAt + 600000,
        reused: true,
      });
    }

    // Generate Lightning invoice
    const label = `bump-${txid.slice(0, 8)}-${Date.now()}`;
    const description = `AnchorWatch bump: ${txid.slice(0, 16)}... to ${targetFeeRate} sat/vB`;
    const inv = lnRpc("invoice", `${quote.totalSats * 1000}msat`, label, `"${description}"`);

    if (!inv.payment_hash) {
      throw new Error("Failed to generate invoice");
    }

    // Store order
    const order = {
      paymentHash: inv.payment_hash,
      parentTxid: txid,
      p2aVout: p2a.vout,
      p2aValue: p2a.value,
      quote,
      bolt11: inv.bolt11,
      label,
      status: "invoiced",
      createdAt: Date.now(),
    };
    orders.set(inv.payment_hash, order);

    console.log(`[bump] order created: ${inv.payment_hash} for ${txid.slice(0, 16)}... (${quote.totalSats} sats)`);

    res.json({
      paymentHash: inv.payment_hash,
      bolt11: inv.bolt11,
      quote,
      expiresAt: Date.now() + 600000, // 10 min
    });
  } catch (err) {
    console.error("[pay] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bump/status/:id
app.get("/api/bump/status/:id", (req, res) => {
  const id = req.params.id;

  // Look up by payment hash
  let order = orders.get(id);

  // Also allow lookup by parent txid
  if (!order) {
    for (const o of orders.values()) {
      if (o.parentTxid === id) {
        order = o;
        break;
      }
    }
  }

  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  res.json({
    paymentHash: order.paymentHash,
    parentTxid: order.parentTxid,
    status: order.status,
    childTxid: order.childTxid || null,
    error: order.error || null,
    quote: order.quote,
    createdAt: order.createdAt,
    paidAt: order.paidAt || null,
    bumpedAt: order.bumpedAt || null,
    confirmedAt: order.confirmedAt || null,
    retryCount: order.retryCount || 0,
  });
});

// GET /api/bump/health
app.get("/api/bump/health", (req, res) => {
  const activeOrders = Array.from(orders.values()).filter((o) => o.status === "invoiced").length;
  res.json({ status: "ok", network: NETWORK, activeOrders, totalOrders: orders.size });
});

// --- Start ---
app.listen(API_PORT, "127.0.0.1", () => {
  console.log(`[bump] anchorwatch bump service (${NETWORK}) listening on 127.0.0.1:${API_PORT}`);
});
