import type { OnchainReport } from "./onchain.js";
import type { WebsiteReport } from "./website.js";
import type { SocialXReport } from "./social.js";

export interface RiskFactor {
  code: string;
  points: number;
  detail: string;
}

export interface RiskReport {
  score: number; // 0 (safe) – 100 (max risk), clamped
  factors: RiskFactor[];
  autoDisqualified: boolean; // true if a near-certain rug/honeypot signal fired
}

/**
 * Deliberately rule-based and fully transparent — every point added is
 * traceable to a specific, named factor (`factors`), not a black-box
 * model. This is a starting point to tune, not a guarantee: passing every
 * check here does NOT mean a token can't still rug. Treat `score` as one
 * input among several (liquidity, social, smart-money — see
 * trading/strategy.ts), never as a standalone "safe to ape in" signal.
 */
export function scoreRisk(params: {
  onchain: OnchainReport;
  website: WebsiteReport;
  x: SocialXReport;
  liquiditySol: number | null; // null = not yet determinable, see tokenAnalyzer.ts
}): RiskReport {
  const { onchain, website, x, liquiditySol } = params;
  const factors: RiskFactor[] = [];

  if (!onchain.mintAuthorityRevoked) {
    factors.push({ code: "mint_authority_active", points: 25, detail: "Dev can mint unlimited new supply" });
  }
  if (!onchain.freezeAuthorityRevoked) {
    factors.push({ code: "freeze_authority_active", points: 20, detail: "Dev can freeze holder accounts" });
  }
  if (onchain.lpBurned === false) {
    factors.push({ code: "lp_not_burned", points: 20, detail: "Liquidity can be pulled by the LP owner" });
  } else if (onchain.lpBurned === null) {
    factors.push({ code: "lp_status_unknown", points: 8, detail: "Could not verify LP burn status" });
  }
  if (onchain.top10HolderPercent > 70) {
    factors.push({ code: "extreme_concentration", points: 20, detail: `Top 10 holders own ${onchain.top10HolderPercent.toFixed(1)}%` });
  } else if (onchain.top10HolderPercent > 50) {
    factors.push({ code: "high_concentration", points: 12, detail: `Top 10 holders own ${onchain.top10HolderPercent.toFixed(1)}%` });
  }
  if (onchain.honeypotSuspected === true) {
    factors.push({ code: "honeypot_simulation_failed", points: 45, detail: "Simulated sell transaction failed" });
  }
  if (onchain.walletClusterSuspected) {
    factors.push({ code: "wallet_cluster", points: 12, detail: "Multiple top holders share a common funder" });
  }
  if (onchain.buySellRatio1m !== null && onchain.buySellRatio1m < 0.3) {
    factors.push({ code: "sell_pressure", points: 10, detail: "Sell volume heavily outweighs buy volume" });
  }
  if (onchain.holderCount < 10) {
    factors.push({ code: "very_few_holders", points: 10, detail: `Only ${onchain.holderCount} holders` });
  }
  if (liquiditySol === null) {
    factors.push({ code: "liquidity_unknown", points: 5, detail: "Could not determine pool liquidity" });
  } else if (liquiditySol < 2) {
    factors.push({ code: "very_low_liquidity", points: 15, detail: `Only ${liquiditySol.toFixed(2)} SOL liquidity` });
  }
  if (website.domainAgeDays !== null && website.domainAgeDays < 2) {
    factors.push({ code: "brand_new_domain", points: 8, detail: `Domain registered ${website.domainAgeDays.toFixed(1)} days ago` });
  }
  if (website.sslValid === false) {
    factors.push({ code: "no_valid_ssl", points: 5, detail: "Website has no valid TLS certificate" });
  }
  if (website.copycatOf) {
    factors.push({ code: "copycat_name", points: 10, detail: `Name closely resembles "${website.copycatOf}"` });
  }
  if (x.available && x.botLikelihoodAvg > 0.6) {
    factors.push({ code: "bot_driven_hype", points: 8, detail: "Mentioning accounts look mostly automated" });
  }

  const rawScore = factors.reduce((sum, f) => sum + f.points, 0);
  const score = Math.min(100, rawScore);
  const autoDisqualified = onchain.honeypotSuspected === true || (!onchain.mintAuthorityRevoked && !onchain.freezeAuthorityRevoked && onchain.top10HolderPercent > 70);

  return { score, factors, autoDisqualified };
}
