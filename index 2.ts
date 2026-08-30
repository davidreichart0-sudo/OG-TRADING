import "dotenv/config";
import { z } from "zod";

/**
 * All runtime configuration is parsed and validated here, once, at process
 * start. Nothing else in the codebase should read `process.env` directly —
 * this keeps every config value typed, documented in one place, and fails
 * loudly (instead of silently misbehaving) if something required is missing.
 */

// "50:25,100:25,200:50" -> [{ gainPercent: 50, sellPercent: 25 }, ...]
function parseTakeProfitLevels(raw: string): { gainPercent: number; sellPercent: number }[] {
  if (!raw.trim()) return [];
  return raw.split(",").map((part) => {
    const [gain, sell] = part.split(":").map(Number);
    if (Number.isNaN(gain) || Number.isNaN(sell)) {
      throw new Error(`Invalid TAKE_PROFIT_LEVELS entry: "${part}"`);
    }
    return { gainPercent: gain, sellPercent: sell };
  });
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  SOLANA_RPC_URLS: z.string().min(1),
  SOLANA_WS_URL: z.string().min(1),
  LISTENER_MODE: z.enum(["rpc", "grpc"]).default("rpc"),
  YELLOWSTONE_GRPC_ENDPOINT: z.string().default(""),
  YELLOWSTONE_GRPC_TOKEN: z.string().default(""),
  FOMO_PROGRAM_ID: z.string().default(""),

  WALLET_PRIVATE_KEY: z.string().default(""),

  LIVE_TRADING: z.string().default("false"),
  I_UNDERSTAND_THE_RISK: z.string().default("false"),
  MAX_POSITION_SOL: z.coerce.number().positive().default(0.05),
  MAX_DAILY_LOSS_SOL: z.coerce.number().positive().default(0.2),
  MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(3),
  SLIPPAGE_BPS: z.coerce.number().int().positive().default(150),
  TAKE_PROFIT_LEVELS: z.string().default("50:25,100:25,200:50"),
  TRAILING_STOP_PERCENT: z.coerce.number().positive().default(20),
  STOP_LOSS_PERCENT: z.coerce.number().positive().default(35),

  RISK_SCORE_MAX_TO_BUY: z.coerce.number().min(0).max(100).default(40),
  SOCIAL_SCORE_MIN_TO_BUY: z.coerce.number().min(0).max(100).default(30),
  MIN_LIQUIDITY_SOL: z.coerce.number().min(0).default(5),
  MIN_HOLDERS: z.coerce.number().int().min(0).default(30),
  MIN_SMART_WALLET_CO_BUYS: z.coerce.number().int().min(0).default(0),

  JUPITER_API_KEY: z.string().default(""),

  TWITTER_BEARER_TOKEN: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_ALERT_CHAT_ID: z.string().default(""),
  HELIUS_API_KEY: z.string().default(""),
  DISCORD_WIDGET_IDS: z.string().default(""),

  API_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment configuration:\n", parsed.error.format());
  process.exit(1);
}

const env = parsed.data;

export const config = {
  db: {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
  },

  solana: {
    rpcUrls: env.SOLANA_RPC_URLS.split(",").map((s) => s.trim()).filter(Boolean),
    wsUrl: env.SOLANA_WS_URL,
    listenerMode: env.LISTENER_MODE,
    grpcEndpoint: env.YELLOWSTONE_GRPC_ENDPOINT,
    grpcToken: env.YELLOWSTONE_GRPC_TOKEN,
    fomoProgramId: env.FOMO_PROGRAM_ID,
  },

  wallet: {
    privateKey: env.WALLET_PRIVATE_KEY,
  },

  trading: {
    // Both flags must be true — a deliberate double opt-in before any real
    // funds can move. See docs/SETUP.md "Going live" checklist.
    liveTradingEnabled: env.LIVE_TRADING === "true" && env.I_UNDERSTAND_THE_RISK === "true",
    maxPositionSol: env.MAX_POSITION_SOL,
    maxDailyLossSol: env.MAX_DAILY_LOSS_SOL,
    maxOpenPositions: env.MAX_OPEN_POSITIONS,
    slippageBps: env.SLIPPAGE_BPS,
    takeProfitLevels: parseTakeProfitLevels(env.TAKE_PROFIT_LEVELS),
    trailingStopPercent: env.TRAILING_STOP_PERCENT,
    stopLossPercent: env.STOP_LOSS_PERCENT,
  },

  risk: {
    maxRiskScoreToBuy: env.RISK_SCORE_MAX_TO_BUY,
    minSocialScoreToBuy: env.SOCIAL_SCORE_MIN_TO_BUY,
    minLiquiditySol: env.MIN_LIQUIDITY_SOL,
    minHolders: env.MIN_HOLDERS,
    minSmartWalletCoBuys: env.MIN_SMART_WALLET_CO_BUYS,
  },

  jupiter: {
    apiKey: env.JUPITER_API_KEY || undefined,
  },

  social: {
    twitterBearerToken: env.TWITTER_BEARER_TOKEN || undefined,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramAlertChatId: env.TELEGRAM_ALERT_CHAT_ID || undefined,
    heliusApiKey: env.HELIUS_API_KEY || undefined,
    discordWidgetIds: env.DISCORD_WIDGET_IDS.split(",").map((s) => s.trim()).filter(Boolean),
  },

  api: {
    port: env.API_PORT,
  },

  logLevel: env.LOG_LEVEL,
} as const;

export type AppConfig = typeof config;
