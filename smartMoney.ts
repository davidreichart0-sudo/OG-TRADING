import axios from "axios";
import { prisma } from "../db/prisma.js";
import { rpcPool } from "../utils/rpcConnection.js";
import { config } from "../config/index.js";
import { childLogger } from "../utils/logger.js";
import { PublicKey } from "@solana/web3.js";

const log = childLogger("smartMoney");

export interface SmartMoneyReport {
  coBuyingWallets: { address: string; winRate: number }[];
  coBuyCount: number;
}

/**
 * Reconstructs a wallet's recent SOL-denominated buy/sell pairs per token
 * from its transaction history to estimate a rough win rate and average
 * hold time. This is intentionally approximate (native SOL balance deltas,
 * not full swap-instruction decoding) and RPC-expensive per wallet.
 *
 * For production-scale tracking of many wallets, use a real indexer
 * instead of raw RPC parsing — if HELIUS_API_KEY is set, this function
 * prefers Helius's parsed transaction history endpoint (pre-decoded swaps,
 * far fewer round trips) and only falls back to raw RPC parsing otherwise.
 */
export async function evaluateWallet(address: string): Promise<{
  totalTrades: number;
  wins: number;
  winRate: number;
  avgHoldTimeSec: number | null;
} | null> {
  try {
    if (config.social.heliusApiKey) {
      return await evaluateWalletViaHelius(address);
    }
    return await evaluateWalletViaRpc(address);
  } catch (err) {
    log.warn({ err: (err as Error).message, address }, "Wallet evaluation failed");
    return null;
  }
}

async function evaluateWalletViaHelius(address: string) {
  const { data } = await axios.get(
    `https://api.helius.xyz/v0/addresses/${address}/transactions`,
    { params: { "api-key": config.social.heliusApiKey, type: "SWAP", limit: 100 }, timeout: 8000 }
  );

  const swaps: any[] = Array.isArray(data) ? data : [];
  // Group by the non-SOL token mint involved in each swap to pair
  // buy -> sell per token.
  const byMint = new Map<string, any[]>();
  for (const swap of swaps) {
    const mint = swap.tokenTransfers?.find((t: any) => t.mint !== "So11111111111111111111111111111111111111112")?.mint;
    if (!mint) continue;
    if (!byMint.has(mint)) byMint.set(mint, []);
    byMint.get(mint)!.push(swap);
  }

  return summarizeTradePairs(byMint);
}

async function evaluateWalletViaRpc(address: string) {
  const pubkey = new PublicKey(address);
  const sigs = await rpcPool.withRetry((conn) => conn.getSignaturesForAddress(pubkey, { limit: 100 }), {
    label: "getSignaturesForAddress:smartMoney",
  });

  // Without decoded swap events, we approximate using net SOL balance
  // delta per signature — a coarse proxy for "profit on this tx", grouped
  // only at the wallet level (not per-token) in the fallback path.
  let wins = 0;
  let total = 0;
  const timestamps: number[] = [];

  for (const sig of sigs) {
    const tx = await rpcPool.withRetry(
      (conn) => conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 }),
      { label: "getParsedTransaction:smartMoney" }
    );
    if (!tx?.meta || !sig.blockTime) continue;
    const idx = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === address);
    if (idx === -1) continue;

    const delta = (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0);
    total++;
    if (delta > 0) wins++;
    timestamps.push(sig.blockTime);
  }

  const avgHoldTimeSec =
    timestamps.length > 1
      ? Math.round(
          timestamps
            .slice(1)
            .reduce((sum, t, i) => sum + Math.abs(t - timestamps[i]!), 0) / (timestamps.length - 1)
        )
      : null;

  return { totalTrades: total, wins, winRate: total > 0 ? wins / total : 0, avgHoldTimeSec };
}

function summarizeTradePairs(byMint: Map<string, any[]>) {
  let wins = 0;
  let total = 0;
  const holdTimes: number[] = [];

  for (const [, swaps] of byMint) {
    swaps.sort((a, b) => a.timestamp - b.timestamp);
    const buy = swaps.find((s) => s.type === "SWAP" && s.source !== "SELL");
    const sell = swaps.reverse().find((s) => s.type === "SWAP");
    if (!buy || !sell || buy === sell) continue;

    total++;
    if ((sell.nativeInput?.amount ?? 0) === 0) wins++; // placeholder heuristic if fee-adjusted values absent
    holdTimes.push(Math.abs((sell.timestamp ?? 0) - (buy.timestamp ?? 0)));
  }

  const avgHoldTimeSec = holdTimes.length > 0 ? Math.round(holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length) : null;
  return { totalTrades: total, wins, winRate: total > 0 ? wins / total : 0, avgHoldTimeSec };
}

/** Re-evaluates and upserts every tracked wallet. Run this periodically
 * (e.g. hourly, from index.ts) rather than per-token-analysis — wallet
 * histories don't change fast enough to justify re-fetching on every new
 * token. */
export async function refreshSmartWalletScores(): Promise<void> {
  const wallets = await prisma.smartWallet.findMany({ where: { isActive: true } });
  for (const wallet of wallets) {
    const result = await evaluateWallet(wallet.address);
    if (!result) continue;
    await prisma.smartWallet.update({
      where: { id: wallet.id },
      data: {
        totalTrades: result.totalTrades,
        wins: result.wins,
        winRate: result.winRate,
        avgHoldTimeSec: result.avgHoldTimeSec ?? undefined,
        lastEvaluatedAt: new Date(),
      },
    });
  }
}

/** Cross-references a token's recent buyer wallets against the tracked
 * smart-wallet table. `recentBuyerAddresses` typically comes from the
 * on-chain buy/sell analysis (see analysis/onchain.ts). */
export async function checkSmartMoneyCoBuying(
  recentBuyerAddresses: string[],
  minWinRate = 0.55
): Promise<SmartMoneyReport> {
  if (recentBuyerAddresses.length === 0) return { coBuyingWallets: [], coBuyCount: 0 };

  const matches = await prisma.smartWallet.findMany({
    where: { address: { in: recentBuyerAddresses }, isActive: true, winRate: { gte: minWinRate } },
  });

  return {
    coBuyingWallets: matches.map((w) => ({ address: w.address, winRate: w.winRate })),
    coBuyCount: matches.length,
  };
}

/** Adds a wallet to the watchlist (manually curated, or auto-promoted
 * elsewhere once it's shown repeated early, profitable buys). */
export async function addSmartWalletCandidate(address: string, label?: string): Promise<void> {
  await prisma.smartWallet.upsert({
    where: { address },
    update: { label },
    create: { address, label },
  });
}
