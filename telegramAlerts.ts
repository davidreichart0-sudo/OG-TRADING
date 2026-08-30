import { prisma } from "../db/prisma.js";
import { telegramBot } from "../analysis/telegram.js";
import { config } from "../config/index.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("alerts");

export type AlertType = "new_buy" | "take_profit" | "risk_detected" | "whale_move";

const TEMPLATES: Record<AlertType, (mint: string, payload: any) => string> = {
  new_buy: (mint, p) =>
    `🟢 *New buy* — ${p.symbol}\n` +
    `Amount: ${p.amountSol} SOL (${p.mode})\n` +
    `Risk score: ${p.riskScore} · Social score: ${p.socialScore}\n` +
    `\`${mint}\``,
  take_profit: (mint, p) =>
    `💰 *Take-profit hit* — ${p.symbol}\n` + `Sold ${p.sellPercent}% · PnL: ${p.pnlSol.toFixed(4)} SOL\n` + `\`${mint}\``,
  risk_detected: (mint, p) => `⚠️ *Risk detected* — ${p.symbol}\n${p.reason}\n\`${mint}\``,
  whale_move: (mint, p) => `🐋 *Whale move* — ${p.symbol}\n${p.description}\n\`${mint}\``,
};

/** Sends a Telegram alert (if TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID
 * are configured — this is 100% free, no paid tier exists for the Bot
 * API) and always records the alert in the DB so the dashboard/MCP server
 * can show history even without Telegram configured. */
export async function sendAlert(type: AlertType, mint: string | null, payload: Record<string, any>): Promise<void> {
  const message = TEMPLATES[type](mint ?? "unknown", payload);

  try {
    const token = mint ? await prisma.token.findUnique({ where: { mint } }) : null;
    await prisma.alert.create({
      data: { type, message, tokenId: token?.id },
    });
  } catch (err) {
    log.warn({ err: (err as Error).message }, "Failed to persist alert");
  }

  if (!telegramBot || !config.social.telegramAlertChatId) return;
  try {
    await telegramBot.sendMessage(config.social.telegramAlertChatId, message, { parse_mode: "Markdown" });
  } catch (err) {
    log.warn({ err: (err as Error).message, type }, "Failed to send Telegram alert");
  }
}
