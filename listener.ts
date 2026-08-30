import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { EventEmitter } from "node:events";
import { config } from "../config/index.js";
import { rpcPool } from "../utils/rpcConnection.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("listener");

export interface NewTokenEvent {
  mint: string;
  signature: string;
  detectedAt: number; // Date.now() — used to measure end-to-end latency
  source: "rpc" | "grpc";
}

/**
 * Central event bus for "a brand-new token just appeared" — index.ts wires
 * this to the analyzer. Keeping this as an EventEmitter (rather than a
 * direct function call) means the RPC listener and the gRPC listener are
 * fully interchangeable: both just emit "newToken" on the same bus.
 */
export const listenerEvents = new EventEmitter();

// Simple in-memory de-dupe: a single tx can trigger multiple log lines /
// gRPC messages for the same mint (e.g. once "processed", once "confirmed").
const seenMints = new Set<string>();
function markSeen(mint: string): boolean {
  if (seenMints.has(mint)) return false;
  seenMints.add(mint);
  // Unbounded growth guard — good enough for a long-running process; a
  // production build might move this to Redis with a TTL instead.
  if (seenMints.size > 50_000) seenMints.clear();
  return true;
}

/**
 * Baseline listener: subscribes to the configured launchpad program's logs
 * over a standard JSON-RPC websocket (`onLogs`). Works against any RPC
 * provider, including free/public ones — but public RPC nodes are
 * frequently 1-3+ seconds behind the actual chain state under load, and
 * that gap is exactly the head start a *paid* sniper is trying to buy.
 * For real competitive speed, see `startGrpcListener` below.
 */
export function startRpcListener(): void {
  if (!config.solana.fomoProgramId) {
    log.error(
      "FOMO_PROGRAM_ID is not set — the RPC listener cannot subscribe to anything. " +
        "See docs/SETUP.md to find the correct program ID."
    );
    return;
  }

  const programId = new PublicKey(config.solana.fomoProgramId);
  const connection = rpcPool.primary;

  log.info({ programId: programId.toBase58() }, "Starting RPC log listener");

  connection.onLogs(
    programId,
    async (logInfo) => {
      if (logInfo.err) return;

      // Heuristic: a fresh SPL mint creation logs an InitializeMint(2)
      // instruction. This is the common thread across bonding-curve
      // launchpads (pump.fun-style platforms, and very likely FOMO's own
      // fomopad, which explicitly launches "your own bonding curve").
      const looksLikeNewMint = logInfo.logs.some(
        (line) => line.includes("InitializeMint") || line.includes("initializeMint")
      );
      if (!looksLikeNewMint) return;

      try {
        const mint = await extractNewMintFromSignature(logInfo.signature);
        if (!mint) return;
        if (!markSeen(mint)) return;

        const event: NewTokenEvent = {
          mint,
          signature: logInfo.signature,
          detectedAt: Date.now(),
          source: "rpc",
        };
        log.info({ mint, signature: logInfo.signature }, "New token detected (RPC)");
        listenerEvents.emit("newToken", event);
      } catch (err) {
        log.warn({ err: (err as Error).message, signature: logInfo.signature }, "Failed to parse candidate tx");
      }
    },
    "processed"
  );
}

/**
 * Given a signature that logged an InitializeMint instruction, fetch the
 * parsed transaction and pull out the mint address that was actually
 * created (as opposed to any *existing* mint referenced elsewhere in the
 * same tx, e.g. the SOL/WSOL side of the pool).
 */
async function extractNewMintFromSignature(signature: string): Promise<string | null> {
  const tx = await rpcPool.withRetry(
    (conn) =>
      conn.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      }),
    { label: "getParsedTransaction:newMint" }
  );
  if (!tx) return null;

  const allInstructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions?.flatMap((i) => i.instructions) ?? []),
  ];

  for (const ix of allInstructions) {
    if (!("parsed" in ix) || ix.programId.toBase58() !== TOKEN_PROGRAM_ID.toBase58()) continue;
    const parsed = (ix as any).parsed;
    if (parsed?.type === "initializeMint" || parsed?.type === "initializeMint2") {
      return parsed.info.mint as string;
    }
  }
  return null;
}

/**
 * Professional-grade path: a persistent gRPC stream (Yellowstone /
 * "Dragon's Mouth") pushed directly from a validator's Geyser plugin,
 * filtered server-side to just the target program. This is what actual
 * competitive sniper bots run on — sub-second, no polling, no public-RPC
 * queueing. Requires a provider that offers Yellowstone access (Helius
 * LaserStream, Triton, QuickNode's Yellowstone add-on, or your own
 * validator) — this is a paid tier everywhere it's offered.
 */
export async function startGrpcListener(): Promise<void> {
  if (!config.solana.grpcEndpoint || !config.solana.fomoProgramId) {
    log.error("YELLOWSTONE_GRPC_ENDPOINT or FOMO_PROGRAM_ID missing — cannot start gRPC listener.");
    return;
  }

  // Imported dynamically so the (optional, heavier) gRPC dependency is only
  // loaded when LISTENER_MODE=grpc is actually used.
  const { default: Client, CommitmentLevel } = await import("@triton-one/yellowstone-grpc");

  const client = new Client(config.solana.grpcEndpoint, config.solana.grpcToken || undefined, {
    "grpc.max_receive_message_length": 64 * 1024 * 1024,
  });

  const stream = await client.subscribe();

  stream.on("data", async (data: any) => {
    if (!data.transaction) return;
    const meta = data.transaction.transaction?.meta;
    if (meta?.err) return;

    const logs: string[] = meta?.logMessages ?? [];
    const looksLikeNewMint = logs.some((line) => line.includes("InitializeMint"));
    if (!looksLikeNewMint) return;

    const signature: string | undefined = data.transaction.transaction?.signature
      ? Buffer.from(data.transaction.transaction.signature).toString("base64")
      : undefined;
    if (!signature) return;

    try {
      const mint = await extractNewMintFromSignature(signature);
      if (!mint || !markSeen(mint)) return;

      const event: NewTokenEvent = { mint, signature, detectedAt: Date.now(), source: "grpc" };
      log.info({ mint, signature }, "New token detected (gRPC)");
      listenerEvents.emit("newToken", event);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "Failed to parse candidate tx from gRPC stream");
    }
  });

  stream.on("error", (err: Error) => log.error({ err: err.message }, "Yellowstone gRPC stream error"));

  await new Promise<void>((resolve, reject) => {
    stream.write(
      {
        transactions: {
          fomo: {
            accountInclude: [config.solana.fomoProgramId],
            accountExclude: [],
            accountRequired: [],
          },
        },
        commitment: CommitmentLevel.PROCESSED,
        accounts: {},
        slots: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
      },
      (err: Error | null) => (err ? reject(err) : resolve())
    );
  });

  log.info("Yellowstone gRPC listener subscribed");
}

export async function startListener(): Promise<void> {
  if (config.solana.listenerMode === "grpc") {
    await startGrpcListener();
  } else {
    startRpcListener();
  }
}
