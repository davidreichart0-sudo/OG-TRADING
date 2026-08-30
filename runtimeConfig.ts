import { prisma } from "../db/prisma.js";
import { config } from "../config/index.js";

/**
 * Risk/buy thresholds start from .env (config.risk.*) but can be tuned
 * live — without a restart — via the MCP server's `update_risk_thresholds`
 * tool. Values are stored in the RuntimeConfig table; anything not
 * explicitly overridden there falls back to the .env default.
 */

const OVERRIDABLE_KEYS = [
  "risk_score_max_to_buy",
  "social_score_min_to_buy",
  "min_liquidity_sol",
  "min_holders",
  "min_smart_wallet_co_buys",
] as const;
export type OverridableKey = (typeof OVERRIDABLE_KEYS)[number];

export interface EffectiveRiskThresholds {
  maxRiskScoreToBuy: number;
  minSocialScoreToBuy: number;
  minLiquiditySol: number;
  minHolders: number;
  minSmartWalletCoBuys: number;
}

export async function getEffectiveRiskThresholds(): Promise<EffectiveRiskThresholds> {
  const rows = await prisma.runtimeConfig.findMany({ where: { key: { in: [...OVERRIDABLE_KEYS] } } });
  const overrides = new Map(rows.map((r) => [r.key, r.value]));

  return {
    maxRiskScoreToBuy: Number(overrides.get("risk_score_max_to_buy") ?? config.risk.maxRiskScoreToBuy),
    minSocialScoreToBuy: Number(overrides.get("social_score_min_to_buy") ?? config.risk.minSocialScoreToBuy),
    minLiquiditySol: Number(overrides.get("min_liquidity_sol") ?? config.risk.minLiquiditySol),
    minHolders: Number(overrides.get("min_holders") ?? config.risk.minHolders),
    minSmartWalletCoBuys: Number(overrides.get("min_smart_wallet_co_buys") ?? config.risk.minSmartWalletCoBuys),
  };
}

export async function setRiskThreshold(key: OverridableKey, value: number): Promise<void> {
  await prisma.runtimeConfig.upsert({
    where: { key },
    update: { value: String(value) },
    create: { key, value: String(value) },
  });
}

export function isOverridableKey(key: string): key is OverridableKey {
  return (OVERRIDABLE_KEYS as readonly string[]).includes(key);
}
