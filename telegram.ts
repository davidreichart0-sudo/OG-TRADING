import TelegramBot from "node-telegram-bot-api";
import { config } from "../config/index.js";
import { childLogger } from "../utils/logger.js";
import { pushTimeseriesEvent, countTimeseriesEvents, redis } from "../db/redis.js";

const log = childLogger("social:telegram");

/**
 * Single shared bot instance (also reused by alerts/telegramAlerts.ts for
 * sending outbound messages) — a second `polling: true` instance on the
 * same token would fight the first one for getUpdates and cause 409
 * errors from Telegram's API.
 *
 * IMPORTANT LIMITATION: the Bot API only sees messages sent *after* the
 * bot was added to a group (and only if group privacy mode is disabled, or
 * the bot is an admin). There is no way to pull a group's message history
 * from before the bot joined — unlike a full MTProto user-client
 * (e.g. gramjs), which can but requires logging in with a real phone
 * number/session and is a heavier, more sensitive integration. This module
 * intentionally sticks to the Bot API and builds up its own rolling stats
 * in Redis as messages arrive live.
 */
export const telegramBot = config.social.telegramBotToken
  ? new TelegramBot(config.social.telegramBotToken, { polling: true })
  : null;

export interface TelegramReport {
  available: boolean;
  memberCount: number | null;
  messageRatePerMin: number;
  spamRatioEstimate: number; // 0-1, share of recent messages that look duplicated/templated
  memberGrowthKnown: boolean;
}

if (telegramBot) {
  telegramBot.on("message", async (msg) => {
    if (!msg.chat?.id || !msg.text) return;
    const chatKey = `tg:msgs:${msg.chat.id}`;
    const dupKey = `tg:dup:${msg.chat.id}:${hashText(msg.text)}`;

    await pushTimeseriesEvent(chatKey, 300); // 5 min rolling window
    // Track how many times near-identical text appears — a common spam/
    // pump-bot pattern ("🚀🚀🚀 BUY NOW 🚀🚀🚀" spammed by many accounts).
    await redis.incr(dupKey);
    await redis.expire(dupKey, 300);
  });

  telegramBot.on("polling_error", (err) => log.warn({ err: err.message }, "Telegram polling error"));
}

function hashText(text: string): string {
  // Cheap normalization, not cryptographic — just enough to group
  // near-identical spam messages together.
  return text.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
}

/** Registers a chat for live monitoring. The bot must already be a member
 * of the chat (add it manually, or via an invite link) — this call does
 * not join groups on your behalf. */
export async function watchTelegramChat(chatId: string): Promise<void> {
  if (!telegramBot) return;
  try {
    await telegramBot.getChat(chatId);
    log.info({ chatId }, "Watching Telegram chat");
  } catch (err) {
    log.warn({ err: (err as Error).message, chatId }, "Could not access Telegram chat — is the bot a member?");
  }
}

export async function analyzeTelegram(chatId: string | null): Promise<TelegramReport> {
  if (!telegramBot || !chatId) {
    return { available: false, memberCount: null, messageRatePerMin: 0, spamRatioEstimate: 0, memberGrowthKnown: false };
  }

  try {
    const memberCount = await telegramBot.getChatMemberCount(chatId);
    const chatKey = `tg:msgs:${chatId}`;
    const messages5min = await countTimeseriesEvents(chatKey, 300);
    const messageRatePerMin = messages5min / 5;

    // Spam estimate: fraction of tracked dedupe-buckets with >3 hits in the
    // same 5-minute window, out of total messages seen — a rough proxy,
    // not exact per-message classification.
    const dupKeys = await redis.keys(`tg:dup:${chatId}:*`);
    let spammyBuckets = 0;
    for (const key of dupKeys) {
      const count = Number(await redis.get(key));
      if (count > 3) spammyBuckets++;
    }
    const spamRatioEstimate = dupKeys.length > 0 ? spammyBuckets / dupKeys.length : 0;

    return { available: true, memberCount, messageRatePerMin, spamRatioEstimate, memberGrowthKnown: false };
  } catch (err) {
    log.warn({ err: (err as Error).message, chatId }, "Telegram analysis failed");
    return { available: false, memberCount: null, messageRatePerMin: 0, spamRatioEstimate: 0, memberGrowthKnown: false };
  }
}
