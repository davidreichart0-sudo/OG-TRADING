import { config } from "../config/index.js";
import type { TokenReport } from "../core/tokenAnalyzer.js";
import { getEffectiveRiskThresholds, type EffectiveRiskThresholds } from "../core/runtimeConfig.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("strategy");

export interface BuyDecision {
  buy: boolean;
  reasons: string[]; // why (or why not) — always populated, for logs/alerts/dashboard
  positionSizeSol: number;
}

/**
 * Nur kaufen wenn: Liquidität ausreichend, Holder ausreichend, Risiko
 * niedrig, Momentum positiv, Community wächst, Whale-Käufe vorhanden.
 * Every gate below is a direct implementation of one of those conditions.
 * `liquiditySol === null` (unknown) is treated as failing the liquidity
 * gate — we never buy on "we couldn't check", only on "we checked and
 * it's fine". Thresholds are read live (see core/runtimeConfig.ts) so the
 * MCP server's `update_risk_thresholds` tool can retune this without a
 * restart.
 */
export async function shouldBuy(report: TokenReport): Promise<BuyDecision> {
  const thresholds = await getEffectiveRiskThresholds();
  const reasons: string[] = [];
  let eligible = true;

  if (report.risk.autoDisqualified) {
    reasons.push("Auto-disqualified: near-certain rug/honeypot signal");
    eligible = false;
  }
  if (report.risk.score > thresholds.maxRiskScoreToBuy) {
    reasons.push(`Risk score ${report.risk.score} exceeds max ${thresholds.maxRiskScoreToBuy}`);
    eligible = false;
  }
  if (report.social.score < thresholds.minSocialScoreToBuy) {
    reasons.push(`Social score ${report.social.score} below min ${thresholds.minSocialScoreToBuy}`);
    eligible = false;
  }
  if (report.liquiditySol === null || report.liquiditySol < thresholds.minLiquiditySol) {
    reasons.push(
      report.liquiditySol === null
        ? "Liquidity could not be confirmed"
        : `Liquidity ${report.liquiditySol.toFixed(2)} SOL below min ${thresholds.minLiquiditySol}`
    );
    eligible = false;
  }
  if (report.onchain.holderCount < thresholds.minHolders) {
    reasons.push(`Holder count ${report.onchain.holderCount} below min ${thresholds.minHolders}`);
    eligible = false;
  }
  if (report.onchain.buySellRatio1m !== null && report.onchain.buySellRatio1m < 1) {
    reasons.push(`Buy/sell ratio ${report.onchain.buySellRatio1m.toFixed(2)} is not positive momentum`);
    eligible = false;
  }
  if (thresholds.minSmartWalletCoBuys > 0 && report.smartMoney.coBuyCount < thresholds.minSmartWalletCoBuys) {
    reasons.push(`Only ${report.smartMoney.coBuyCount} smart-money co-buys, need ${thresholds.minSmartWalletCoBuys}`);
    eligible = false;
  }

  if (eligible) {
    reasons.push("All buy conditions met");
  }

  const positionSizeSol = eligible ? sizePosition(report, thresholds) : 0;

  log.info({ mint: report.mint, buy: eligible, reasons, positionSizeSol }, "Buy decision");

  return { buy: eligible, reasons, positionSizeSol };
}

/** Scales the position down as risk score rises, within the configured
 * cap — a token that just barely clears the risk threshold gets a smaller
 * bet than one that looks very clean. Never exceeds MAX_POSITION_SOL. */
function sizePosition(report: TokenReport, thresholds: EffectiveRiskThresholds): number {
  const riskFraction = report.risk.score / Math.max(1, thresholds.maxRiskScoreToBuy); // 0..1
  const scaled = config.trading.maxPositionSol * (1 - 0.5 * riskFraction);
  return Math.max(config.trading.maxPositionSol * 0.2, Math.min(config.trading.maxPositionSol, scaled));
}
