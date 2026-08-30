import { config } from "./config/index.js";
import { childLogger } from "./utils/logger.js";
import { prisma, disconnectPrisma } from "./db/prisma.js";
import { redis } from "./db/redis.js";
import { listenerEvents, startListener, type NewTokenEvent } from "./core/listener.js";
import { analyzeToken } from "./core/tokenAnalyzer.js";
import { shouldBuy } from "./trading/strategy.js";
import { openPosition, startPositionMonitor } from "./trading/positionManager.js";
import { refreshSmartWalletScores } from "./analysis/smartMoney.js";
import { startApiServer } from "./api/server.js";

const log = childLogger("main");

function printStartupBanner() {
  const mode = config.trading.liveTradingEnabled ? "🔴 LIVE TRADING" : "🟡 PAPER TRADING";
  // eslint-disable-next-line no-console
  console.log(`
========================================================
 Solana FOMO Sniper Bot
 Mode: ${mode}
 Listener: ${config.solana.listenerMode.toUpperCase()}
--------------------------------------------------------
 Memecoins are extremely high risk. Most new tokens lose
 most or all of their value, including ones that pass
 every automated check in this bot. Nothing here is
 financial advice, and no risk score is a guarantee.
 Only trade what you are fully prepared to lose, and
 keep this wallet funded with trading money only.
========================================================
`);
  if (config.trading.liveTradingEnabled) {
    log.warn("LIVE TRADING IS ENABLED — real funds will be used for buys and sells.");
  } else {
    log.info("Running in paper trading mode — no real funds will move.");
  }
}

async function handleNewToken(event: NewTokenEvent) {
  const latencyMs = Date.now() - event.detectedAt;
  log.info({ mint: event.mint, source: event.source, latencyMs }, "Analyzing new token");

  try {
    const report = await analyzeToken(event);
    const decision = await shouldBuy(report);

    if (!decision.buy) {
      log.info({ mint: event.mint, reasons: decision.reasons }, "Skipping — did not meet buy criteria");
      return;
    }

    const mode = config.trading.liveTradingEnabled ? "LIVE" : "PAPER";
    await openPosition(report, decision, mode);
  } catch (err) {
    log.error({ err: (err as Error).message, mint: event.mint }, "Failed to process new token");
  }
}

async function main() {
  printStartupBanner();

  listenerEvents.on("newToken", (event: NewTokenEvent) => {
    handleNewToken(event).catch((err) => log.error({ err: (err as Error).message }, "Unhandled error in handleNewToken"));
  });

  await startListener();
  startPositionMonitor();
  startApiServer();

  // Smart-wallet win-rate/hold-time stats don't change fast enough to
  // justify recomputing per-token — refresh on a slow, independent cadence.
  setInterval(() => {
    refreshSmartWalletScores().catch((err) => log.warn({ err: (err as Error).message }, "Smart wallet refresh failed"));
  }, 60 * 60 * 1000);

  log.info("Bot is running.");
}

async function shutdown(signal: string) {
  log.info({ signal }, "Shutting down");
  await disconnectPrisma();
  redis.disconnect();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  log.error({ reason }, "Unhandled promise rejection");
});

main().catch((err) => {
  log.error({ err: (err as Error).message }, "Fatal startup error");
  process.exit(1);
});
