import pino from "pino";
import { config } from "../config/index.js";

/**
 * Structured logger. `redact` guarantees that even if a secret accidentally
 * ends up in a logged object (e.g. someone spreads `config.wallet` into a
 * log call by mistake), pino replaces it with "[Redacted]" instead of
 * printing it — this is a hard requirement (private keys, tokens must never
 * be logged), not just a formatting nicety.
 */
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "privateKey",
      "*.privateKey",
      "walletPrivateKey",
      "*.walletPrivateKey",
      "WALLET_PRIVATE_KEY",
      "authorization",
      "*.authorization",
      "twitterBearerToken",
      "*.twitterBearerToken",
      "telegramBotToken",
      "*.telegramBotToken",
      "apiKey",
      "*.apiKey",
    ],
    censor: "[Redacted]",
  },
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
});

export function childLogger(scope: string) {
  return logger.child({ scope });
}
