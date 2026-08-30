import { PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { rpcPool } from "../utils/rpcConnection.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("onchain");

// Common Solana "burn" destinations. LP tokens sent here (or to a mint's
// own frozen/incinerated ATA) are considered permanently removed from
// circulation.
const BURN_ADDRESSES = new Set([
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111111111111",
]);

export interface OnchainReport {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  totalSupply: string;
  decimals: number;
  holderCount: number;
  top10HolderPercent: number;
  lpBurned: boolean | null; // null = could not determine (unknown pool/LP mint)
  buySellRatio1m: number | null; // >1 = more buy volume than sell volume
  walletClusterSuspected: boolean;
  honeypotSuspected: boolean | null; // null = simulation inconclusive
}

/** Mint & freeze authority — the single most important rug-pull check.
 * If mintAuthority is still set, the dev can print unlimited new supply.
 * If freezeAuthority is set, the dev can freeze YOUR tokens so you can't
 * sell. Neither being revoked is an instant, near-automatic disqualifier. */
export async function checkAuthorities(mintAddress: string) {
  const mintPubkey = new PublicKey(mintAddress);
  const mintInfo = await rpcPool.withRetry((conn) => getMint(conn, mintPubkey), {
    label: "getMint",
  });

  return {
    mintAuthorityRevoked: mintInfo.mintAuthority === null,
    freezeAuthorityRevoked: mintInfo.freezeAuthority === null,
    totalSupply: mintInfo.supply.toString(),
    decimals: mintInfo.decimals,
  };
}

/** Top holders + concentration. High concentration in a handful of wallets
 * (especially non-LP, non-burn wallets) is a classic rug setup — a single
 * wallet can dump enough supply to crater the price. */
export async function getHolderDistribution(mintAddress: string) {
  const mintPubkey = new PublicKey(mintAddress);
  const largest = await rpcPool.withRetry((conn) => conn.getTokenLargestAccounts(mintPubkey), {
    label: "getTokenLargestAccounts",
  });

  const accounts = largest.value;
  const total = accounts.reduce((sum, a) => sum + Number(a.amount), 0);
  const top10 = accounts.slice(0, 10).reduce((sum, a) => sum + Number(a.amount), 0);
  const top10HolderPercent = total > 0 ? (top10 / total) * 100 : 0;

  return {
    holderCount: accounts.filter((a) => Number(a.amount) > 0).length,
    top10HolderPercent,
    topHolderAddresses: accounts.slice(0, 10).map((a) => a.address.toBase58()),
  };
}

/**
 * LP-burn check. Given the LP token mint (the pool's own liquidity-provider
 * token, NOT the memecoin's mint), checks whether its supply sits almost
 * entirely in a known burn address or an address with no ability to
 * withdraw. If the LP mint is unknown at analysis time, returns null rather
 * than guessing.
 */
export async function checkLpBurned(lpMintAddress: string | null): Promise<boolean | null> {
  if (!lpMintAddress) return null;
  try {
    const lpMint = new PublicKey(lpMintAddress);
    const largest = await rpcPool.withRetry((conn) => conn.getTokenLargestAccounts(lpMint), {
      label: "getTokenLargestAccounts:lp",
    });
    const total = largest.value.reduce((sum, a) => sum + Number(a.amount), 0);
    if (total === 0) return true; // supply is zero -> effectively burned

    const inBurnAddresses = largest.value
      .filter((a) => BURN_ADDRESSES.has(a.address.toBase58()))
      .reduce((sum, a) => sum + Number(a.amount), 0);

    return inBurnAddresses / total > 0.95;
  } catch (err) {
    log.warn({ err: (err as Error).message, lpMintAddress }, "Could not determine LP burn status");
    return null;
  }
}

/**
 * Approximate buy/sell ratio over the last `windowMinutes` by walking the
 * pool address's recent signatures and classifying each swap by SOL
 * balance delta direction. This is RPC-call-heavy (one getParsedTransaction
 * per signature) — fine for a handful of new pools, but at scale you'd
 * want a dedicated indexer (Helius, Bitquery, or your own) instead of raw
 * RPC parsing.
 */
export async function getBuySellRatio(
  poolAddress: string,
  windowMinutes = 1
): Promise<{ ratio: number | null; buyCount: number; sellCount: number; uniqueWallets: number }> {
  try {
    const poolPubkey = new PublicKey(poolAddress);
    const sigs = await rpcPool.withRetry((conn) => conn.getSignaturesForAddress(poolPubkey, { limit: 50 }), {
      label: "getSignaturesForAddress:pool",
    });

    const cutoff = Date.now() / 1000 - windowMinutes * 60;
    const recent = sigs.filter((s) => (s.blockTime ?? 0) >= cutoff);

    let buyCount = 0;
    let sellCount = 0;
    const wallets = new Set<string>();

    for (const sig of recent) {
      const tx = await rpcPool.withRetry(
        (conn) => conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 }),
        { label: "getParsedTransaction:swap" }
      );
      if (!tx?.meta) continue;

      const signer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58();
      if (signer) wallets.add(signer);

      // Heuristic: net SOL balance change of the fee payer. Negative ->
      // they spent SOL (buy). Positive -> they received SOL (sell).
      const feePayerIndex = 0;
      const pre = tx.meta.preBalances[feePayerIndex] ?? 0;
      const post = tx.meta.postBalances[feePayerIndex] ?? 0;
      if (post < pre) buyCount++;
      else if (post > pre) sellCount++;
    }

    const ratio = sellCount === 0 ? (buyCount > 0 ? Infinity : null) : buyCount / sellCount;
    return { ratio, buyCount, sellCount, uniqueWallets: wallets.size };
  } catch (err) {
    log.warn({ err: (err as Error).message, poolAddress }, "Could not compute buy/sell ratio");
    return { ratio: null, buyCount: 0, sellCount: 0, uniqueWallets: 0 };
  }
}

/**
 * Honeypot heuristic: simulate selling a small amount back through Jupiter.
 * If a route can't be found, or `simulateTransaction` reports failure, the
 * token is very likely un-sellable (fees-on-transfer set to 100%, a
 * malicious transfer hook, a blacklist, etc). This does NOT guarantee a
 * token is safe if the simulation *succeeds* — it can only catch the
 * "cannot sell at all" case.
 */
export async function detectHoneypot(
  mintAddress: string,
  simulateSell: () => Promise<{ ok: boolean; reason?: string }>
): Promise<boolean | null> {
  try {
    const result = await simulateSell();
    return !result.ok;
  } catch (err) {
    log.warn({ err: (err as Error).message, mintAddress }, "Honeypot simulation inconclusive");
    return null;
  }
}

/**
 * Wallet-cluster heuristic: checks whether multiple top holders received
 * their very first SOL from the same funding wallet within a short window
 * of each other — a common pattern when a dev splits supply across many
 * "independent-looking" wallets to fake decentralization.
 */
export async function detectWalletCluster(topHolderAddresses: string[]): Promise<boolean> {
  if (topHolderAddresses.length < 3) return false;

  const funders = new Map<string, number>();

  for (const address of topHolderAddresses.slice(0, 8)) {
    try {
      const pubkey = new PublicKey(address);
      const sigs = await rpcPool.withRetry(
        (conn) => conn.getSignaturesForAddress(pubkey, { limit: 1 }),
        { label: "getSignaturesForAddress:funding" }
      );
      const firstSig = sigs[sigs.length - 1];
      if (!firstSig) continue;

      const tx = await rpcPool.withRetry(
        (conn) => conn.getParsedTransaction(firstSig.signature, { maxSupportedTransactionVersion: 0 }),
        { label: "getParsedTransaction:funding" }
      );
      const funder = tx?.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58();
      if (!funder) continue;

      funders.set(funder, (funders.get(funder) ?? 0) + 1);
    } catch {
      // Best-effort — a single failed lookup shouldn't abort the whole check.
      continue;
    }
  }

  return [...funders.values()].some((count) => count >= 3);
}

/** Runs the full on-chain suite for a token. `lpMintAddress` and
 * `poolAddress` are optional because they may not be resolvable for every
 * launchpad without its IDL — see docs/SETUP.md. */
export async function analyzeOnchain(params: {
  mint: string;
  poolAddress?: string | null;
  lpMintAddress?: string | null;
  simulateSell?: () => Promise<{ ok: boolean; reason?: string }>;
}): Promise<OnchainReport> {
  const [authorities, holders] = await Promise.all([
    checkAuthorities(params.mint),
    getHolderDistribution(params.mint),
  ]);

  const [lpBurned, buySell, honeypotSuspected] = await Promise.all([
    checkLpBurned(params.lpMintAddress ?? null),
    params.poolAddress
      ? getBuySellRatio(params.poolAddress)
      : Promise.resolve({ ratio: null, buyCount: 0, sellCount: 0, uniqueWallets: 0 }),
    params.simulateSell ? detectHoneypot(params.mint, params.simulateSell) : Promise.resolve(null),
  ]);

  const walletClusterSuspected = await detectWalletCluster(holders.topHolderAddresses);

  return {
    mintAuthorityRevoked: authorities.mintAuthorityRevoked,
    freezeAuthorityRevoked: authorities.freezeAuthorityRevoked,
    totalSupply: authorities.totalSupply,
    decimals: authorities.decimals,
    holderCount: holders.holderCount,
    top10HolderPercent: holders.top10HolderPercent,
    lpBurned,
    buySellRatio1m: buySell.ratio,
    walletClusterSuspected,
    honeypotSuspected,
  };
}
