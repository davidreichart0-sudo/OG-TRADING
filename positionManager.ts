import { prisma } from "../db/prisma.js";
import { cacheGet, cacheSet } from "../db/redis.js";
import { config } from "../config/index.js";
import { childLogger } from "../utils/logger.js";
import { executeBuy, executeSell, getQuote } from "./executor.js";
import { analyzeOnchain } from "../analysis/onchain.js";
import type { TokenReport } from "../core/tokenAnalyzer.js";
import type { BuyDecision } from "./strategy.js";
import { sendAlert } from "../alerts/telegramAlerts.js";

const log = childLogger("positionManager");

const SOL_MINT = "So11111111111111111111111111111111111111112";
let monitorHandle: NodeJS.Timeout | null = null;

/** Opens a new position: executes the buy, records the Trade row, and
 * sends the "new buy" alert. Position monitoring itself happens in the
 * shared interval started by `startPositionMonitor`, not per-trade. */
export async function openPosition(report: TokenReport, decision: BuyDecision, mode: "PAPER" | "LIVE") {
  const openCount = await prisma.trade.count({ where: { status: "OPEN" } });
  if (openCount >= config.trading.maxOpenPositions) {
    log.info({ mint: report.mint, openCount }, "Skipping buy — MAX_OPEN_POSITIONS reached");
    return null;
  }

  const result = await executeBuy(report.mint, decision.positionSizeSol, mode);
  if (!result.success) {
    log.warn({ mint: report.mint, error: result.error }, "Buy failed");
    return null;
  }

  const token = await prisma.token.upsert({
    where: { mint: report.mint },
    update: {},
    create: { mint: report.mint, symbol: report.metadata.symbol, name: report.metadata.name },
  });

  const trade = await prisma.trade.create({
    data: {
      tokenId: token.id,
      mode,
      status: "OPEN",
      entrySol: decision.positionSizeSol,
      entryPriceSol: result.priceSol,
      entryTxSig: result.txSig,
    },
  });

  await sendAlert("new_buy", report.mint, {
    symbol: report.metadata.symbol ?? report.mint.slice(0, 6),
    amountSol: decision.positionSizeSol,
    riskScore: report.risk.score,
    socialScore: report.social.score,
    mode,
  });

  log.info({ tradeId: trade.id, mint: report.mint, mode }, "Position opened");
  return trade;
}

/** Starts the shared interval that checks every open position for
 * take-profit / trailing-stop / stop-loss / emergency-exit conditions.
 * Called once from index.ts. */
export function startPositionMonitor(intervalMs = 8000) {
  if (monitorHandle) return;
  monitorHandle = setInterval(() => {
    checkAllOpenPositions().catch((err) => log.error({ err: (err as Error).message }, "Position monitor tick failed"));
  }, intervalMs);
  log.info({ intervalMs }, "Position monitor started");
}

export function stopPositionMonitor() {
  if (monitorHandle) clearInterval(monitorHandle);
  monitorHandle = null;
}

async function checkAllOpenPositions() {
  const openTrades = await prisma.trade.findMany({ where: { status: "OPEN" }, include: { token: true } });
  for (const trade of openTrades) {
    try {
      await checkPosition(trade);
    } catch (err) {
      log.warn({ err: (err as Error).message, tradeId: trade.id }, "Failed to check position");
    }
  }
}

async function checkPosition(trade: Awaited<ReturnType<typeof prisma.trade.findMany>>[number] & { token: { mint: string; symbol: string | null } }) {
  const currentPriceSol = await getCurrentPrice(trade.token.mint);
  if (currentPriceSol === null) return;

  const gainPercent = ((currentPriceSol - trade.entryPriceSol) / trade.entryPriceSol) * 100;

  // --- Stop loss ---
  if (gainPercent <= -config.trading.stopLossPercent) {
    await closePosition(trade, currentPriceSol, "stop_loss");
    return;
  }

  // --- Trailing stop (peak tracked in Redis — losing it just means a
  // momentarily looser trail, never a crash) ---
  const peakKey = `trade:peak:${trade.id}`;
  const previousPeak = (await cacheGet<number>(peakKey)) ?? trade.entryPriceSol;
  const peak = Math.max(previousPeak, currentPriceSol);
  await cacheSet(peakKey, peak, 3600 * 6);

  const drawdownFromPeakPercent = ((peak - currentPriceSol) / peak) * 100;
  if (gainPercent > 0 && drawdownFromPeakPercent >= config.trading.trailingStopPercent) {
    await closePosition(trade, currentPriceSol, "trailing_stop");
    return;
  }

  // --- Emergency exit on strongly negative on-chain signals ---
  const onchain = await analyzeOnchain({ mint: trade.token.mint, poolAddress: null, lpMintAddress: null });
  if (onchain.buySellRatio1m !== null && onchain.buySellRatio1m < 0.15) {
    await closePosition(trade, currentPriceSol, "risk_exit");
    await sendAlert("risk_detected", trade.token.mint, { symbol: trade.token.symbol, reason: "Heavy sell pressure detected" });
    return;
  }

  // --- Tiered take-profit (partial sells) ---
  for (const level of config.trading.takeProfitLevels) {
    const levelKey = `trade:tp:${trade.id}:${level.gainPercent}`;
    const alreadyTriggered = await cacheGet<boolean>(levelKey);
    if (alreadyTriggered) continue;

    if (gainPercent >= level.gainPercent && trade.remainingPct > 0) {
      await partialTakeProfit(trade, currentPriceSol, level.sellPercent);
      await cacheSet(levelKey, true, 3600 * 24);
    }
  }
}

async function getCurrentPrice(mint: string): Promise<number | null> {
  try {
    const quote = await getQuote(mint, SOL_MINT, "1000000"); // 1 token unit at 6 decimals, adjust per-mint decimals in production
    return Number(quote.outAmount) / 1_000_000_000;
  } catch {
    return null;
  }
}

async function partialTakeProfit(
  trade: { id: string; mode: "PAPER" | "LIVE"; remainingPct: number; entrySol: number; token: { mint: string; symbol: string | null } },
  priceSol: number,
  sellPercent: number
) {
  const soldFraction = Math.min(trade.remainingPct, sellPercent) / 100;
  const tokensToSell = ((trade.entrySol * soldFraction) / priceSol).toString();

  const result = await executeSell(trade.token.mint, tokensToSell, trade.mode);
  if (!result.success) {
    log.warn({ tradeId: trade.id, error: result.error }, "Partial take-profit sell failed");
    return;
  }

  const pnlSol = result.priceSol * Number(tokensToSell) - trade.entrySol * soldFraction;
  const newRemainingPct = trade.remainingPct - sellPercent;

  await prisma.$transaction([
    prisma.trade.update({
      where: { id: trade.id },
      data: { remainingPct: Math.max(0, newRemainingPct), realizedPnlSol: { increment: pnlSol } },
    }),
    prisma.tradeEvent.create({
      data: { tradeId: trade.id, kind: "partial_take_profit", pctSold: sellPercent, priceSol, pnlSol, txSig: result.txSig },
    }),
  ]);

  await sendAlert("take_profit", trade.token.mint, { symbol: trade.token.symbol, sellPercent, pnlSol });

  if (newRemainingPct <= 0) {
    await prisma.trade.update({ where: { id: trade.id }, data: { status: "CLOSED", closedAt: new Date() } });
  }
}

async function closePosition(
  trade: { id: string; mode: "PAPER" | "LIVE"; remainingPct: number; entrySol: number; token: { mint: string; symbol: string | null } },
  priceSol: number,
  reason: string
) {
  if (trade.remainingPct <= 0) return;
  const tokensToSell = ((trade.entrySol * trade.remainingPct) / 100 / priceSol).toString();
  const result = await executeSell(trade.token.mint, tokensToSell, trade.mode);

  const pnlSol = result.success ? result.priceSol * Number(tokensToSell) - (trade.entrySol * trade.remainingPct) / 100 : 0;

  await prisma.$transaction([
    prisma.trade.update({
      where: { id: trade.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        remainingPct: 0,
        exitReason: reason,
        realizedPnlSol: { increment: pnlSol },
      },
    }),
    prisma.tradeEvent.create({
      data: { tradeId: trade.id, kind: "full_exit", pctSold: trade.remainingPct, priceSol, pnlSol, txSig: result.txSig },
    }),
  ]);

  log.info({ tradeId: trade.id, reason, pnlSol }, "Position closed");
}
