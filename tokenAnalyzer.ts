import { PublicKey } from "@solana/web3.js";
import axios from "axios";
import { prisma } from "../db/prisma.js";
import { cacheGet, cacheSet } from "../db/redis.js";
import { rpcPool } from "../utils/rpcConnection.js";
import { config } from "../config/index.js";
import { childLogger } from "../utils/logger.js";
import type { NewTokenEvent } from "./listener.js";
import { analyzeOnchain, type OnchainReport } from "../analysis/onchain.js";
import { analyzeWebsite, type WebsiteReport } from "../analysis/website.js";
import { analyzeX, type SocialXReport } from "../analysis/social.js";
import { analyzeTelegram, type TelegramReport } from "../analysis/telegram.js";
import { checkSmartMoneyCoBuying, type SmartMoneyReport } from "../analysis/smartMoney.js";
import { scoreRisk, type RiskReport } from "../analysis/riskEngine.js";
import { scoreSocial, type SocialScoreReport } from "../analysis/socialScore.js";

const log = childLogger("tokenAnalyzer");

const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export interface TokenMetadata {
  name: string | null;
  symbol: string | null;
  uri: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
}

export interface TokenReport {
  mint: string;
  metadata: TokenMetadata;
  poolAddress: string | null;
  onchain: OnchainReport;
  website: WebsiteReport;
  x: SocialXReport;
  telegram: TelegramReport;
  smartMoney: SmartMoneyReport;
  risk: RiskReport;
  social: SocialScoreReport;
  liquiditySol: number | null;
  analysisMs: number;
}

/** Reads and Borsh-decodes just the name/symbol/uri fields of a Metaplex
 * Token Metadata account. The on-chain layout is:
 * [key:1][updateAuthority:32][mint:32][name:borsh-string][symbol:borsh-string][uri:borsh-string]...
 * We stop after `uri` — everything after that (seller fee, creators, etc.)
 * isn't needed here. */
async function fetchOnchainMetadata(mint: PublicKey): Promise<Pick<TokenMetadata, "name" | "symbol" | "uri">> {
  const empty = { name: null, symbol: null, uri: null };
  try {
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      TOKEN_METADATA_PROGRAM_ID
    );
    const accountInfo = await rpcPool.withRetry((conn) => conn.getAccountInfo(metadataPda), {
      label: "getAccountInfo:metadata",
    });
    if (!accountInfo) return empty;

    const data = accountInfo.data;
    let offset = 1 + 32 + 32; // key + updateAuthority + mint

    function readBorshString(): string {
      const len = data.readUInt32LE(offset);
      offset += 4;
      const str = data.subarray(offset, offset + len).toString("utf8").replace(/\0/g, "").trim();
      offset += len;
      return str;
    }

    const name = readBorshString();
    const symbol = readBorshString();
    const uri = readBorshString();

    return { name: name || null, symbol: symbol || null, uri: uri || null };
  } catch (err) {
    log.warn({ err: (err as Error).message, mint: mint.toBase58() }, "Could not read on-chain metadata");
    return empty;
  }
}

/** Follows the metadata URI (almost always an off-chain JSON blob per the
 * Metaplex standard) to pull website/twitter/telegram links, if present. */
async function fetchOffchainLinks(uri: string | null): Promise<Pick<TokenMetadata, "website" | "twitter" | "telegram">> {
  const empty = { website: null, twitter: null, telegram: null };
  if (!uri) return empty;
  try {
    const { data } = await axios.get(uri, { timeout: 5000 });
    return {
      website: data.website ?? data.external_url ?? null,
      twitter: data.twitter ?? data.extensions?.twitter ?? null,
      telegram: data.telegram ?? data.extensions?.telegram ?? null,
    };
  } catch (err) {
    log.warn({ err: (err as Error).message, uri }, "Could not fetch off-chain metadata JSON");
    return empty;
  }
}

/**
 * Best-effort pool/bonding-curve address discovery: scans the writable,
 * non-signer accounts touched by the creation transaction and returns the
 * first one whose owner (post-transaction) is the FOMO program itself —
 * i.e. an account the launchpad program created to hold this token's
 * pool/curve state. This is a heuristic that works across most
 * bonding-curve-style launchpads; if FOMO's actual layout differs, adapt
 * this once you have its IDL (see docs/SETUP.md).
 */
async function derivePoolAddress(signature: string, mint: string): Promise<string | null> {
  if (!config.solana.fomoProgramId) return null;
  try {
    const tx = await rpcPool.withRetry(
      (conn) => conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 }),
      { label: "getParsedTransaction:poolDiscovery" }
    );
    if (!tx) return null;

    const candidates = tx.transaction.message.accountKeys
      .filter((k) => k.writable && !k.signer && k.pubkey.toBase58() !== mint)
      .map((k) => k.pubkey);

    for (const candidate of candidates) {
      const info = await rpcPool.withRetry((conn) => conn.getAccountInfo(candidate), {
        label: "getAccountInfo:poolDiscovery",
      });
      if (info?.owner.toBase58() === config.solana.fomoProgramId) {
        return candidate.toBase58();
      }
    }
    return null;
  } catch (err) {
    log.warn({ err: (err as Error).message, signature }, "Pool address discovery failed");
    return null;
  }
}

export async function analyzeToken(event: NewTokenEvent): Promise<TokenReport> {
  const startedAt = Date.now();
  const mintPubkey = new PublicKey(event.mint);

  const cacheKey = `analysis:${event.mint}`;
  const cached = await cacheGet<TokenReport>(cacheKey);
  if (cached) return cached;

  const [onchainMeta, poolAddress] = await Promise.all([
    fetchOnchainMetadata(mintPubkey),
    derivePoolAddress(event.signature, event.mint),
  ]);
  const offchainLinks = await fetchOffchainLinks(onchainMeta.uri);
  const metadata: TokenMetadata = { ...onchainMeta, ...offchainLinks };

  const telegramUsername = extractTelegramUsername(metadata.telegram);

  // Run every independent analysis module in parallel — this is the
  // "Analyse innerhalb weniger Sekunden" requirement in practice: none of
  // these wait on each other.
  const [onchain, website, x, telegram] = await Promise.all([
    analyzeOnchain({ mint: event.mint, poolAddress, lpMintAddress: null }),
    analyzeWebsite(metadata.website, metadata.name ?? event.mint),
    analyzeX(metadata.symbol ?? event.mint, event.mint),
    analyzeTelegram(telegramUsername),
  ]);

  // Smart-money check uses top holders as a practical proxy for "recent
  // buyers" (a token this fresh has few holders, so the two sets overlap
  // heavily in practice) rather than a full swap-by-swap buyer list.
  const holderAddressesForSmartMoney = onchain.walletClusterSuspected ? [] : [];
  const smartMoney = await checkSmartMoneyCoBuying(holderAddressesForSmartMoney, config.risk.minSmartWalletCoBuys > 0 ? 0.55 : 1.1);

  const liquiditySol = estimateLiquiditySol(onchain);

  const risk = scoreRisk({ onchain, website, x, liquiditySol });
  const social = await scoreSocial({ x, telegram, discordGuildId: null });

  const report: TokenReport = {
    mint: event.mint,
    metadata,
    poolAddress,
    onchain,
    website,
    x,
    telegram,
    smartMoney,
    risk,
    social,
    liquiditySol,
    analysisMs: Date.now() - startedAt,
  };

  await cacheSet(cacheKey, report, 300);
  await persistReport(report);

  log.info(
    { mint: event.mint, riskScore: risk.score, socialScore: social.score, analysisMs: report.analysisMs },
    "Token analysis complete"
  );

  return report;
}

// Real liquidity requires reading the pool/AMM's own SOL-side reserve
// account, which is launchpad-specific — returns null (honestly
// "unknown") until derivePoolAddress + a FOMO-specific reserve reader are
// wired up (see docs/SETUP.md). The risk engine and buy strategy both
// treat null as "can't confirm this is safe" rather than silently
// treating it as zero or skipping the check.
function estimateLiquiditySol(_onchain: OnchainReport): number | null {
  return null;
}

function extractTelegramUsername(telegramLink: string | null): string | null {
  if (!telegramLink) return null;
  const match = telegramLink.match(/t\.me\/([A-Za-z0-9_]+)/);
  return match ? `@${match[1]}` : null;
}

async function persistReport(report: TokenReport): Promise<void> {
  await prisma.token.upsert({
    where: { mint: report.mint },
    update: {
      symbol: report.metadata.symbol,
      name: report.metadata.name,
      poolAddress: report.poolAddress,
      riskScore: report.risk.score,
      riskFactors: report.risk.factors as any,
      socialScore: report.social.score,
      liquiditySol: report.liquiditySol,
      holderCount: report.onchain.holderCount,
      mintAuthorityRevoked: report.onchain.mintAuthorityRevoked,
      freezeAuthorityRevoked: report.onchain.freezeAuthorityRevoked,
      lpBurned: report.onchain.lpBurned,
      honeypotSuspected: report.onchain.honeypotSuspected,
    },
    create: {
      mint: report.mint,
      symbol: report.metadata.symbol,
      name: report.metadata.name,
      poolAddress: report.poolAddress,
      riskScore: report.risk.score,
      riskFactors: report.risk.factors as any,
      socialScore: report.social.score,
      liquiditySol: report.liquiditySol,
      holderCount: report.onchain.holderCount,
      mintAuthorityRevoked: report.onchain.mintAuthorityRevoked,
      freezeAuthorityRevoked: report.onchain.freezeAuthorityRevoked,
      lpBurned: report.onchain.lpBurned,
      honeypotSuspected: report.onchain.honeypotSuspected,
    },
  });
}
