import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { config } from "../config/index.js";
import { getEffectiveRiskThresholds, setRiskThreshold, isOverridableKey } from "../core/runtimeConfig.js";

/**
 * This MCP server is READ + SAFE-CONFIG ONLY, by design:
 *   - It can show you positions, token reports, alerts, and current risk
 *     thresholds.
 *   - It can adjust risk/social/liquidity/holder thresholds live.
 *   - It CANNOT flip the bot into live trading, place a manual trade, or
 *     touch the wallet in any way.
 *
 * That boundary is deliberate. An MCP tool is something any connected
 * LLM client can decide to call on its own — that's fine for "show me my
 * open positions", but "spend real SOL" should never be one casual chat
 * message away from happening. Going live is a decision you make in
 * .env (LIVE_TRADING + I_UNDERSTAND_THE_RISK) and a restart, on purpose.
 */

const server = new McpServer({ name: "solana-fomo-sniper-bot", version: "0.1.0" });

server.tool("get_bot_status", "Overall bot status: mode, RPC config, open position count", {}, async () => {
  const openCount = await prisma.trade.count({ where: { status: "OPEN" } });
  const status = {
    liveTradingEnabled: config.trading.liveTradingEnabled,
    listenerMode: config.solana.listenerMode,
    openPositions: openCount,
    maxOpenPositions: config.trading.maxOpenPositions,
    maxPositionSol: config.trading.maxPositionSol,
  };
  return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
});

server.tool("list_open_positions", "Lists all currently open trades (paper and live)", {}, async () => {
  const trades = await prisma.trade.findMany({
    where: { status: "OPEN" },
    include: { token: true },
    orderBy: { openedAt: "desc" },
  });
  const summary = trades.map((t) => ({
    mint: t.token.mint,
    symbol: t.token.symbol,
    mode: t.mode,
    entrySol: t.entrySol,
    entryPriceSol: t.entryPriceSol,
    remainingPct: t.remainingPct,
    realizedPnlSol: t.realizedPnlSol,
    openedAt: t.openedAt,
  }));
  return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
});

server.tool(
  "get_token_report",
  "Gets the latest stored analysis (risk score, social score, on-chain flags) for a token by mint address",
  { mint: z.string().describe("The token's mint address") },
  async ({ mint }) => {
    const token = await prisma.token.findUnique({ where: { mint } });
    if (!token) {
      return { content: [{ type: "text", text: `No analysis found for ${mint}` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(token, null, 2) }] };
  }
);

server.tool("get_risk_config", "Gets the current (possibly live-overridden) risk/buy thresholds", {}, async () => {
  const thresholds = await getEffectiveRiskThresholds();
  return { content: [{ type: "text", text: JSON.stringify(thresholds, null, 2) }] };
});

server.tool(
  "update_risk_thresholds",
  "Updates one risk/buy threshold used for future buy decisions. Does NOT affect live-trading permission — that only changes via .env + restart.",
  {
    key: z
      .enum(["risk_score_max_to_buy", "social_score_min_to_buy", "min_liquidity_sol", "min_holders", "min_smart_wallet_co_buys"])
      .describe("Which threshold to change"),
    value: z.number().describe("New numeric value"),
  },
  async ({ key, value }) => {
    if (!isOverridableKey(key)) {
      return { content: [{ type: "text", text: `Unknown key: ${key}` }], isError: true };
    }
    await setRiskThreshold(key, value);
    const updated = await getEffectiveRiskThresholds();
    return { content: [{ type: "text", text: `Updated ${key} = ${value}\n\n${JSON.stringify(updated, null, 2)}` }] };
  }
);

server.tool(
  "list_recent_alerts",
  "Lists the most recent alerts (new buys, take-profits, risk warnings, whale moves)",
  { limit: z.number().min(1).max(50).default(10) },
  async ({ limit }) => {
    const alerts = await prisma.alert.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    return { content: [{ type: "text", text: JSON.stringify(alerts, null, 2) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
