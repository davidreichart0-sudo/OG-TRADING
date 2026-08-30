import { createJupiterApiClient, type QuoteResponse } from "@jup-ag/api";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config/index.js";
import { rpcPool } from "../utils/rpcConnection.js";
import { prisma } from "../db/prisma.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("executor");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;

// The @jup-ag/api client auto-selects the correct current endpoint for
// your key's tier (Lite/free vs Pro/paid) — never hardcode a raw
// quote-api.jup.ag or lite-api.jup.ag URL, both have moved/deprecated.
const jupiter = createJupiterApiClient(config.jupiter.apiKey ? { apiKey: config.jupiter.apiKey } : undefined);

let cachedKeypair: Keypair | null = null;
function getWalletKeypair(): Keypair {
  if (cachedKeypair) return cachedKeypair;
  if (!config.wallet.privateKey) {
    throw new Error("WALLET_PRIVATE_KEY is not set — required for live trading");
  }
  cachedKeypair = Keypair.fromSecretKey(bs58.decode(config.wallet.privateKey));
  return cachedKeypair;
}

export interface SwapResult {
  success: boolean;
  txSig?: string;
  priceSol: number; // effective price per token, in SOL
  outAmount: string;
  error?: string;
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps = config.trading.slippageBps
): Promise<QuoteResponse> {
  return jupiter.quoteGet({
    inputMint,
    outputMint,
    amount: Number(amountRaw),
    slippageBps,
  });
}

/**
 * Honeypot check helper (used by analysis/onchain.ts::detectHoneypot): asks
 * for a quote selling a tiny amount of the token back to SOL. If Jupiter
 * can't route it at all, that alone is a strong red flag before we even
 * get to simulateTransaction.
 */
export async function simulateSellRoute(mint: string, testAmountRaw = "1000"): Promise<{ ok: boolean; reason?: string }> {
  try {
    const quote = await getQuote(mint, SOL_MINT, testAmountRaw);
    if (!quote || !quote.outAmount || Number(quote.outAmount) === 0) {
      return { ok: false, reason: "No viable sell route found" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function checkDailyLossCap(): Promise<boolean> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const todaysTrades = await prisma.trade.findMany({
    where: { mode: "LIVE", closedAt: { gte: startOfDay } },
    select: { realizedPnlSol: true },
  });
  const todaysPnl = todaysTrades.reduce((sum, t) => sum + t.realizedPnlSol, 0);
  return todaysPnl > -config.trading.maxDailyLossSol;
}

/**
 * Buys `amountSol` worth of `mint`.
 *  - Paper mode: uses a REAL Jupiter quote (so the simulated fill price is
 *    realistic) but never touches the chain or the wallet.
 *  - Live mode: only runs if config.trading.liveTradingEnabled is true —
 *    which itself requires BOTH LIVE_TRADING=true AND
 *    I_UNDERSTAND_THE_RISK=true in .env (see config/index.ts). Also
 *    enforces MAX_POSITION_SOL and the daily loss cap before sending
 *    anything.
 */
export async function executeBuy(mint: string, amountSol: number, mode: "PAPER" | "LIVE"): Promise<SwapResult> {
  const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL).toString();

  const quote = await getQuote(SOL_MINT, mint, amountLamports);
  const priceSol = amountSol / (Number(quote.outAmount) || 1);

  if (mode === "PAPER") {
    log.info({ mint, amountSol, priceSol }, "[PAPER] Simulated buy");
    return { success: true, priceSol, outAmount: quote.outAmount, txSig: undefined };
  }

  if (!config.trading.liveTradingEnabled) {
    return { success: false, priceSol, outAmount: "0", error: "Live trading disabled (LIVE_TRADING/I_UNDERSTAND_THE_RISK not both true)" };
  }
  if (amountSol > config.trading.maxPositionSol) {
    return { success: false, priceSol, outAmount: "0", error: `amountSol ${amountSol} exceeds MAX_POSITION_SOL ${config.trading.maxPositionSol}` };
  }
  if (!(await checkDailyLossCap())) {
    return { success: false, priceSol, outAmount: "0", error: "Daily loss cap reached — no more live buys today" };
  }

  return sendSwap(quote);
}

export async function executeSell(mint: string, amountTokensRaw: string, mode: "PAPER" | "LIVE"): Promise<SwapResult> {
  const quote = await getQuote(mint, SOL_MINT, amountTokensRaw);
  const priceSol = Number(quote.outAmount) / LAMPORTS_PER_SOL / (Number(amountTokensRaw) || 1);

  if (mode === "PAPER") {
    log.info({ mint, amountTokensRaw, priceSol }, "[PAPER] Simulated sell");
    return { success: true, priceSol, outAmount: quote.outAmount, txSig: undefined };
  }

  if (!config.trading.liveTradingEnabled) {
    return { success: false, priceSol, outAmount: "0", error: "Live trading disabled" };
  }

  return sendSwap(quote);
}

async function sendSwap(quote: QuoteResponse): Promise<SwapResult> {
  try {
    const wallet = getWalletKeypair();

    const swapResponse = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      },
    });

    const tx = VersionedTransaction.deserialize(Buffer.from(swapResponse.swapTransaction, "base64"));
    tx.sign([wallet]);

    const txSig = await rpcPool.withRetry(
      (conn) => conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }),
      { label: "sendRawTransaction", maxSweeps: 2 }
    );

    await rpcPool.primary.confirmTransaction(txSig, "confirmed");

    const priceSol = Number(quote.inAmount) / LAMPORTS_PER_SOL / (Number(quote.outAmount) || 1);
    log.info({ txSig }, "Live swap confirmed");
    return { success: true, txSig, priceSol, outAmount: quote.outAmount };
  } catch (err) {
    log.error({ err: (err as Error).message }, "Live swap failed");
    return { success: false, priceSol: 0, outAmount: "0", error: (err as Error).message };
  }
}
