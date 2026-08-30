import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { prisma } from "../db/prisma.js";
import { config } from "../config/index.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("api");

export async function buildDashboardSnapshot() {
  const [openTrades, closedTrades, tokens, alerts] = await Promise.all([
    prisma.trade.findMany({ where: { status: "OPEN" }, include: { token: true }, orderBy: { openedAt: "desc" } }),
    prisma.trade.findMany({ where: { status: "CLOSED" }, include: { token: true }, orderBy: { closedAt: "desc" }, take: 20 }),
    prisma.token.findMany({ orderBy: { firstSeenAt: "desc" }, take: 25 }),
    prisma.alert.findMany({ orderBy: { createdAt: "desc" }, take: 25, include: { token: true } }),
  ]);

  const totalPnl = closedTrades.reduce((sum, t) => sum + t.realizedPnlSol, 0);
  const wins = closedTrades.filter((t) => t.realizedPnlSol > 0).length;

  return {
    stats: {
      openPositions: openTrades.length,
      closedTrades: closedTrades.length,
      totalPnlSol: totalPnl,
      winRate: closedTrades.length > 0 ? wins / closedTrades.length : 0,
      liveTradingEnabled: config.trading.liveTradingEnabled,
    },
    openTrades: openTrades.map(formatTrade),
    closedTrades: closedTrades.map(formatTrade),
    tokens: tokens.map((t) => ({
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      riskScore: t.riskScore,
      socialScore: t.socialScore,
      holderCount: t.holderCount,
      firstSeenAt: t.firstSeenAt,
    })),
    alerts: alerts.map((a) => ({ type: a.type, message: a.message, symbol: a.token?.symbol, createdAt: a.createdAt })),
  };
}

function formatTrade(t: any) {
  return {
    id: t.id,
    mint: t.token.mint,
    symbol: t.token.symbol,
    mode: t.mode,
    status: t.status,
    entrySol: t.entrySol,
    entryPriceSol: t.entryPriceSol,
    remainingPct: t.remainingPct,
    realizedPnlSol: t.realizedPnlSol,
    exitReason: t.exitReason,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
  };
}

export function startApiServer() {
  const app = express();
  app.use(express.static("dashboard"));

  app.get("/api/snapshot", async (_req, res) => {
    res.json(await buildDashboardSnapshot());
  });

  app.get("/api/tokens/:mint", async (req, res) => {
    const token = await prisma.token.findUnique({ where: { mint: req.params.mint } });
    if (!token) return res.status(404).json({ error: "not found" });
    res.json(token);
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const clients = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  });

  // Simple poll-and-push loop — far less code and less to keep in sync
  // than wiring bespoke event emission through every module, at the cost
  // of a few seconds of dashboard latency (fine for this use case).
  setInterval(async () => {
    if (clients.size === 0) return;
    const snapshot = await buildDashboardSnapshot();
    const payload = JSON.stringify({ type: "snapshot", data: snapshot });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }, 4000);

  httpServer.listen(config.api.port, () => {
    log.info({ port: config.api.port }, "Dashboard API listening");
  });

  return httpServer;
}
